import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

const MAX_BODY_BYTES = 900 * 1024;
const DB_TIMEOUT_MS = 4500;
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const encoder = new TextEncoder();

const response = (status: number, body: unknown, extra: Record<string,string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...extra },
  });

const constantTimeEqual = (left: string, right: string) => {
  const a = encoder.encode(left || '');
  const b = encoder.encode(right || '');
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
};

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
const sha256Hex = async (bytes: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const hmacHex = async (secret: string, bytes: Uint8Array) => {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes)));
};

const verifySignature = async (header: string | null, body: Uint8Array, secrets: string[]) => {
  if (!header?.startsWith('sha256=')) return false;
  const supplied = header.slice(7).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;
  for (const secret of secrets.filter(Boolean)) {
    const expected = await hmacHex(secret, body);
    if (constantTimeEqual(supplied, expected)) return true;
  }
  return false;
};

const safePart = (value: unknown, fallback: string, max = 300) => {
  const clean = String(value ?? '').trim().replace(/[^a-zA-Z0-9._:-]/g, '_');
  return (clean || fallback).slice(0, max);
};

const getText = (message: any) => {
  if (message?.type === 'text') return typeof message?.text?.body === 'string' ? message.text.body : null;
  if (message?.type === 'button') return typeof message?.button?.text === 'string' ? message.button.text : null;
  if (message?.type === 'interactive') {
    return message?.interactive?.button_reply?.title ?? message?.interactive?.list_reply?.title ?? null;
  }
  return null;
};

Deno.serve(async (req: Request) => {
  const requestId = req.headers.get('x-request-id') || crypto.randomUUID();
  const url = new URL(req.url);
  const verifyTokens = [Deno.env.get('META_WHATSAPP_VERIFY_TOKEN') || '', Deno.env.get('META_WHATSAPP_VERIFY_TOKEN_PREVIOUS') || ''];
  const appSecrets = [Deno.env.get('META_APP_SECRET') || '', Deno.env.get('META_APP_SECRET_PREVIOUS') || ''];

  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token') || '';
    const challenge = url.searchParams.get('hub.challenge');
    if (mode !== 'subscribe' || challenge === null || !verifyTokens.some(v => v && constantTimeEqual(v, token))) {
      return response(403, { accepted: false, code: 'WEBHOOK_VERIFICATION_FAILED', request_id: requestId });
    }
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }

  if (req.method !== 'POST') return response(405, { accepted: false, code: 'METHOD_NOT_ALLOWED' }, { allow: 'GET, POST' });

  const declared = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return response(413, { accepted: false, code: 'PAYLOAD_TOO_LARGE' });
  if (!appSecrets.some(Boolean)) return response(503, { accepted: false, code: 'META_APP_SECRET_NOT_CONFIGURED' });

  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return response(413, { accepted: false, code: 'PAYLOAD_TOO_LARGE' });
  if (!(await verifySignature(req.headers.get('x-hub-signature-256'), raw, appSecrets))) {
    console.warn(JSON.stringify({ request_id: requestId, outcome: 'invalid_meta_signature' }));
    return response(401, { accepted: false, code: 'INVALID_SIGNATURE', request_id: requestId });
  }

  let envelope: any;
  try {
    envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object') throw new Error('object required');
  } catch {
    return response(400, { accepted: false, code: 'INVALID_JSON', request_id: requestId });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return response(503, { accepted: false, code: 'DATABASE_CREDENTIAL_UNAVAILABLE' });
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const fingerprint = await sha256Hex(raw);
  const events: Array<{ key: string; type: string; payload: any }> = [];

  const entries = Array.isArray(envelope.entry) ? envelope.entry : [];
  for (let ei = 0; ei < entries.length; ei += 1) {
    const entry = entries[ei] || {};
    const entryId = safePart(entry.id, `entry-${ei}`, 100);
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (let ci = 0; ci < changes.length; ci += 1) {
      const change = changes[ci] || {};
      const value = change.value && typeof change.value === 'object' ? change.value : {};
      const metadata = value.metadata || {};
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const profileByWaId = new Map(contacts.map((c: any) => [String(c?.wa_id || ''), c?.profile?.name || null]));
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      const errors = Array.isArray(value.errors) ? value.errors : [];

      for (let mi = 0; mi < messages.length; mi += 1) {
        const m = messages[mi] || {};
        const providerMessageId = safePart(m.id, `${fingerprint.slice(0,16)}-${ei}-${ci}-${mi}`, 360);
        const waId = String(m.from || contacts[0]?.wa_id || '').trim();
        events.push({
          key: `message:${entryId}:${providerMessageId}`,
          type: 'message.received',
          payload: {
            normalized: {
              externalContactKey: waId,
              externalConversationKey: `${metadata.phone_number_id || 'wa'}:${waId}`,
              providerMessageId: m.id || providerMessageId,
              messageType: m.type || 'unknown',
              body: getText(m),
              providerTimestamp: m.timestamp || null,
              profileName: profileByWaId.get(waId) || contacts[0]?.profile?.name || null,
              phoneNumberId: metadata.phone_number_id || null,
              displayPhoneNumber: metadata.display_phone_number || null,
              message: m,
            },
            entry_id: entry.id || null,
            field: change.field || null,
            fingerprint,
            received_via: 'meta-whatsapp-ingress-v1',
          },
        });
      }

      for (let si = 0; si < statuses.length; si += 1) {
        const s = statuses[si] || {};
        const state = safePart(s.status, 'unknown', 64).toLowerCase();
        const id = safePart(s.id, `missing-${si}`, 300);
        const ts = safePart(s.timestamp, `${fingerprint.slice(0,12)}-${si}`, 80);
        events.push({
          key: `status:${entryId}:${id}:${state}:${ts}`,
          type: `message.status.${state}`,
          payload: { status: s, metadata, entry_id: entry.id || null, fingerprint, received_via: 'meta-whatsapp-ingress-v1' },
        });
      }

      for (let xi = 0; xi < errors.length; xi += 1) {
        const e = errors[xi] || {};
        events.push({
          key: `error:${entryId}:${safePart(e.code, `unknown-${xi}`, 80)}:${fingerprint.slice(0,16)}:${ci}:${xi}`,
          type: 'webhook.error',
          payload: { error: e, metadata, entry_id: entry.id || null, fingerprint, received_via: 'meta-whatsapp-ingress-v1' },
        });
      }

      if (!messages.length && !statuses.length && !errors.length) {
        events.push({
          key: `change:${entryId}:${safePart(change.field, 'unknown', 80)}:${fingerprint.slice(0,16)}:${ci}`,
          type: 'webhook.unclassified_change',
          payload: { value, entry_id: entry.id || null, field: change.field || null, fingerprint, received_via: 'meta-whatsapp-ingress-v1' },
        });
      }
    }
  }

  if (!events.length) events.push({ key: `envelope:${fingerprint}`, type: 'webhook.unclassified_envelope', payload: { envelope, fingerprint, received_via: 'meta-whatsapp-ingress-v1' } });
  if (events.length > 200) return response(413, { accepted: false, code: 'TOO_MANY_EVENTS', request_id: requestId });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  try {
    let inserted = 0;
    let duplicates = 0;
    for (const event of events) {
      const { data, error } = await supabase.rpc('ingest_messaging_event', {
        p_provider: 'meta_whatsapp',
        p_event_key: event.key,
        p_event_type: event.type,
        p_channel: 'whatsapp',
        p_payload: event.payload,
      }).abortSignal(controller.signal);
      if (error) throw error;
      const receipt = Array.isArray(data) ? data[0] : data;
      if (receipt?.inserted === false) duplicates += 1; else inserted += 1;
    }
    console.info(JSON.stringify({ request_id: requestId, outcome: 'persisted_before_ack', event_count: events.length, inserted, duplicates }));
    return response(200, { accepted: true, event_count: events.length, inserted, duplicates, request_id: requestId });
  } catch (error) {
    const timeoutHit = error instanceof DOMException && error.name === 'AbortError';
    console.error(JSON.stringify({ request_id: requestId, outcome: 'retry_required', code: timeoutHit ? 'DATABASE_TIMEOUT' : 'PERSISTENCE_FAILED' }));
    return response(503, { accepted: false, code: timeoutHit ? 'DATABASE_TIMEOUT' : 'PERSISTENCE_FAILED', request_id: requestId }, { 'retry-after': '5' });
  } finally {
    clearTimeout(timeout);
  }
});
