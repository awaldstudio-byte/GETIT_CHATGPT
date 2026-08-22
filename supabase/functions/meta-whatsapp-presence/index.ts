import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
const safeString = (value: unknown, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  const requestId = req.headers.get('x-request-id') || crypto.randomUUID();
  if (req.method !== 'POST') return reply(405, { ok: false, code: 'METHOD_NOT_ALLOWED', request_id: requestId });

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return reply(503, { ok: false, code: 'DATABASE_CREDENTIAL_UNAVAILABLE', request_id: requestId });

  let authorised = false;
  const authorization = safeString(req.headers.get('authorization'), 4000);
  if (authorization.toLowerCase().startsWith('bearer ')) {
    const staffClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData } = await staffClient.auth.getUser();
    if (userData.user) {
      const { data: role } = await staffClient.rpc('current_staff_role');
      authorised = Boolean(role && role !== 'none');
    }
  }

  if (!authorised) {
    const callerApiKey = safeString(req.headers.get('apikey'), 500);
    if (callerApiKey) {
      try {
        const authResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/verify_messaging_service_access`, {
          method: 'POST',
          headers: { apikey: callerApiKey, 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(8000),
        });
        authorised = authResponse.ok;
      } catch {
        return reply(503, { ok: false, code: 'SERVICE_AUTH_UNAVAILABLE', request_id: requestId });
      }
    }
  }
  if (!authorised) return reply(401, { ok: false, code: 'STAFF_OR_SERVICE_AUTH_REQUIRED', request_id: requestId });

  let input: any;
  try { input = await req.json(); } catch { return reply(400, { ok: false, code: 'INVALID_JSON', request_id: requestId }); }
  const messageId = safeString(input?.message_id, 500);
  const typing = input?.typing_indicator === true;
  if (messageId.length < 8) return reply(400, { ok: false, code: 'INVALID_MESSAGE_ID', request_id: requestId });

  const graphVersion = safeString(Deno.env.get('META_GRAPH_VERSION'), 40);
  const phoneNumberId = safeString(Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID'), 120);
  const accessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
  if (!graphVersion || !phoneNumberId || !accessToken) return reply(503, { ok: false, code: 'META_CONFIGURATION_MISSING', request_id: requestId });

  const body: Record<string, unknown> = { messaging_product: 'whatsapp', status: 'read', message_id: messageId };
  if (typing) body.typing_indicator = { type: 'text' };

  try {
    const response = await fetch(`https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const raw = await response.text();
    let result: any = {};
    try { result = raw ? JSON.parse(raw) : {}; } catch {}
    if (!response.ok) {
      return reply(response.status, {
        ok: false,
        code: safeString(result?.error?.code != null ? String(result.error.code) : 'META_HTTP_ERROR', 100),
        request_id: requestId,
      });
    }
    return reply(200, { ok: true, read: true, typing, request_id: requestId });
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === 'TimeoutError';
    return reply(503, { ok: false, code: timeout ? 'META_TIMEOUT' : 'META_NETWORK_ERROR', request_id: requestId });
  }
});
