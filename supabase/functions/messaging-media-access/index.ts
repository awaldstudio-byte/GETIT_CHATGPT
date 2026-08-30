import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.8";

const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_ORIGINS = new Set([
  "https://getitcontrolcentrev14cumulative.vercel.app",
  "http://localhost:3000",
  "http://localhost:3001",
]);
const safeString = (value: unknown, max = 500) => typeof value === "string" ? value.trim().slice(0, max) : "";
const corsHeaders = (req: Request) => {
  const origin = req.headers.get("origin") || "";
  return ALLOWED_ORIGINS.has(origin) ? {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, apikey, content-type, x-request-id",
    "access-control-max-age": "600",
    vary: "Origin",
  } : {};
};
const json = (req: Request, status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(req) },
});
const baseMime = (value: string) => value.split(";")[0].trim().toLowerCase();

Deno.serve(async (req: Request) => {
  const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (!["GET", "POST"].includes(req.method)) return json(req, 405, { ok: false, code: "METHOD_NOT_ALLOWED", request_id: requestId });
  const url = new URL(req.url);
  let attachmentId = url.searchParams.get("attachment_id") || "";
  let download = url.searchParams.get("download") === "1";
  const signed = url.searchParams.get("signed") === "1";
  if (req.method === "POST") {
    try {
      const body = await req.json();
      attachmentId = safeString(body?.attachment_id, 80);
      download = Boolean(body?.download);
    } catch { return json(req, 400, { ok: false, code: "INVALID_JSON", request_id: requestId }); }
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) {
    return json(req, 400, { ok: false, code: "INVALID_ATTACHMENT_ID", request_id: requestId });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const authHeader = req.headers.get("authorization") || "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !authHeader.startsWith("Bearer ")) {
    return json(req, 401, { ok: false, code: "STAFF_AUTH_REQUIRED", request_id: requestId });
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: access, error: accessError } = await userClient.rpc("get_messaging_attachment_access_v2", { p_attachment_id: attachmentId });
  if (accessError || !access) {
    return json(req, accessError?.code === "42501" ? 403 : 404, { ok: false, code: accessError?.code === "42501" ? "STAFF_ACCESS_REQUIRED" : "ATTACHMENT_NOT_FOUND", request_id: requestId });
  }

  const fileName = safeString(access.file_name, 180) || `getit-${access.attachment_type || "attachment"}-${attachmentId}`;
  const requestedMime = baseMime(safeString(access.mime_type, 160)) || "application/octet-stream";
  if (signed) {
    if (access.retrieval_status !== "available" || !access.storage_bucket || !access.storage_path) {
      return json(req, 409, { ok: false, code: "ARCHIVED_MEDIA_REQUIRED", request_id: requestId });
    }
    const service = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const [preview, downloadable] = await Promise.all([
      service.storage.from(access.storage_bucket).createSignedUrl(access.storage_path, 900),
      service.storage.from(access.storage_bucket).createSignedUrl(access.storage_path, 900, { download: fileName }),
    ]);
    if (preview.error || downloadable.error || !preview.data?.signedUrl || !downloadable.data?.signedUrl) {
      return json(req, 503, { ok: false, code: "ARCHIVED_MEDIA_URL_UNAVAILABLE", request_id: requestId });
    }
    return json(req, 200, {
      ok: true,
      attachment_id: attachmentId,
      preview_url: preview.data.signedUrl,
      download_url: downloadable.data.signedUrl,
      mime_type: safeString(access.mime_type, 160) || requestedMime,
      expires_in: 900,
      request_id: requestId,
    });
  }
  let bytes: Uint8Array;
  let mime = requestedMime;

  if (access.retrieval_status === "available" && access.storage_bucket && access.storage_path) {
    const service = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await service.storage.from(access.storage_bucket).download(access.storage_path);
    if (error || !data) return json(req, 503, { ok: false, code: "ARCHIVED_MEDIA_UNAVAILABLE", request_id: requestId });
    bytes = new Uint8Array(await data.arrayBuffer());
    mime = baseMime(data.type || requestedMime) || requestedMime;
  } else {
    const mediaId = safeString(access.media_id, 80);
    const graphVersion = safeString(Deno.env.get("META_GRAPH_VERSION"), 40);
    const accessToken = Deno.env.get("META_WHATSAPP_ACCESS_TOKEN") || "";
    if (!mediaId || !graphVersion || !accessToken) return json(req, 503, { ok: false, code: "MEDIA_CONFIGURATION_MISSING", request_id: requestId });
    try {
      const metadataResponse = await fetch(`https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(mediaId)}`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
      const metadata = await metadataResponse.json().catch(() => ({}));
      if (!metadataResponse.ok) return json(req, metadataResponse.status, { ok: false, code: "META_MEDIA_LOOKUP_FAILED", request_id: requestId });
      const mediaUrl = safeString(metadata?.url, 2000);
      mime = baseMime(safeString(metadata?.mime_type, 160) || requestedMime) || requestedMime;
      const declaredSize = Number(metadata?.file_size || 0);
      if (!mediaUrl || !Number.isFinite(declaredSize) || declaredSize < 1 || declaredSize > MAX_BYTES) {
        return json(req, declaredSize > MAX_BYTES ? 413 : 415, { ok: false, code: declaredSize > MAX_BYTES ? "MEDIA_SIZE_REJECTED" : "MEDIA_METADATA_INVALID", request_id: requestId });
      }
      const mediaResponse = await fetch(mediaUrl, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
      if (!mediaResponse.ok) return json(req, mediaResponse.status, { ok: false, code: "META_MEDIA_DOWNLOAD_FAILED", request_id: requestId });
      bytes = new Uint8Array(await mediaResponse.arrayBuffer());
    } catch (error) {
      const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
      return json(req, 503, { ok: false, code: timeout ? "META_MEDIA_TIMEOUT" : "META_MEDIA_ERROR", request_id: requestId });
    }
  }

  if (bytes.length < 1 || bytes.length > MAX_BYTES) return json(req, 413, { ok: false, code: "MEDIA_SIZE_REJECTED", request_id: requestId });
  const canInline = mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || mime === "application/pdf";
  const disposition = `${download || !canInline ? "attachment" : "inline"}; filename="${fileName.replace(/["\\\r\n]/g, "_")}"`;
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(bytes.length),
      "content-disposition": disposition,
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
      ...corsHeaders(req),
    },
  });
});
