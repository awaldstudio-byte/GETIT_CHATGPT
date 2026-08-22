import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/aac', 'audio/amr', 'audio/mp4', 'audio/mpeg', 'audio/ogg',
  'audio/opus', 'audio/wav', 'audio/x-wav',
]);

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders });
const safeString = (value: unknown, max = 500) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};
const sha256Base64 = async (bytes: Uint8Array) =>
  bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));

Deno.serve(async (req: Request) => {
  const requestId = req.headers.get('x-request-id') || crypto.randomUUID();
  if (req.method !== 'POST') {
    return reply(405, { ok: false, code: 'METHOD_NOT_ALLOWED', request_id: requestId });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
  const callerApiKey = safeString(req.headers.get('apikey'), 500);
  if (!supabaseUrl || !callerApiKey) {
    return reply(401, { ok: false, code: 'SERVICE_AUTH_REQUIRED', request_id: requestId });
  }

  try {
    const authResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/verify_messaging_service_access`, {
      method: 'POST',
      headers: { apikey: callerApiKey, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8_000),
    });
    if (!authResponse.ok) {
      return reply(401, { ok: false, code: 'SERVICE_AUTH_INVALID', request_id: requestId });
    }
  } catch {
    return reply(503, { ok: false, code: 'SERVICE_AUTH_UNAVAILABLE', request_id: requestId });
  }

  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return reply(400, { ok: false, code: 'INVALID_JSON', request_id: requestId });
  }

  const mediaId = safeString(input.media_id, 80);
  const expectedSha256 = safeString(input.expected_sha256, 200);
  if (!/^[0-9]{6,40}$/.test(mediaId)) {
    return reply(400, { ok: false, code: 'INVALID_MEDIA_ID', request_id: requestId });
  }

  const graphVersion = safeString(Deno.env.get('META_GRAPH_VERSION'), 40);
  const accessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
  if (!graphVersion || !accessToken) {
    return reply(503, { ok: false, code: 'META_CONFIGURATION_MISSING', request_id: requestId });
  }

  try {
    const metadataResponse = await fetch(
      `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(mediaId)}`,
      { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) },
    );
    const metadata = await metadataResponse.json().catch(() => ({}));
    if (!metadataResponse.ok) {
      return reply(metadataResponse.status, { ok: false, code: 'META_MEDIA_LOOKUP_FAILED', request_id: requestId });
    }

    const mediaUrl = safeString(metadata?.url, 2_000);
    const mimeType = safeString(metadata?.mime_type, 120).split(';')[0].toLowerCase();
    const declaredSize = Number(metadata?.file_size || 0);
    if (!mediaUrl || !ALLOWED_AUDIO_TYPES.has(mimeType)) {
      return reply(415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', request_id: requestId });
    }
    if (!Number.isFinite(declaredSize) || declaredSize < 1 || declaredSize > MAX_AUDIO_BYTES) {
      return reply(413, { ok: false, code: 'AUDIO_SIZE_REJECTED', request_id: requestId });
    }

    const mediaResponse = await fetch(mediaUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!mediaResponse.ok) {
      return reply(mediaResponse.status, { ok: false, code: 'META_MEDIA_DOWNLOAD_FAILED', request_id: requestId });
    }

    const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_AUDIO_BYTES) {
      return reply(413, { ok: false, code: 'AUDIO_SIZE_REJECTED', request_id: requestId });
    }
    const actualSha256 = await sha256Base64(bytes);
    const metadataSha256 = safeString(metadata?.sha256, 200);
    const expected = expectedSha256 || metadataSha256;
    if (expected && actualSha256 !== expected) {
      return reply(409, { ok: false, code: 'AUDIO_INTEGRITY_MISMATCH', request_id: requestId });
    }

    return reply(200, {
      ok: true,
      media_id: mediaId,
      mime_type: mimeType,
      size_bytes: bytes.byteLength,
      sha256: actualSha256,
      audio_base64: bytesToBase64(bytes),
      request_id: requestId,
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return reply(503, {
      ok: false,
      code: timedOut ? 'META_MEDIA_TIMEOUT' : 'META_MEDIA_ERROR',
      request_id: requestId,
    });
  }
});
