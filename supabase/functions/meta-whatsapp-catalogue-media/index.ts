import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.8";

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers });
const safeString = (value: unknown, max = 500) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};
const sha256Base64 = async (bytes: Uint8Array) =>
  bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
const safeName = (value: string) =>
  value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 120) || "catalogue";
const starts = (bytes: Uint8Array, signature: number[]) =>
  signature.every((value, index) => bytes[index] === value);

const detectMime = (bytes: Uint8Array, declared: string): string | null => {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 4_096)));
    const sample = new TextDecoder("latin1").decode(bytes);
    if (!tail.includes("%%EOF") || /\/(?:JavaScript|JS|OpenAction|Launch|EmbeddedFile)\b/i.test(sample)) return null;
    return "application/pdf";
  }
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 12 && starts(bytes, [0x52, 0x49, 0x46, 0x46])
      && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (declared !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return null;
    const archiveNames = new TextDecoder("latin1").decode(bytes);
    if (!archiveNames.includes("[Content_Types].xml") || !archiveNames.includes("xl/workbook.xml")
        || /vbaProject\.bin|\.exe\b|\.dll\b/i.test(archiveNames)) return null;
    return declared;
  }
  if (declared === "text/csv") {
    if (bytes.includes(0)) return null;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return "text/csv";
    } catch {
      return null;
    }
  }
  return null;
};

Deno.serve(async (req: Request) => {
  const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
  if (req.method !== "POST") return reply(405, { ok: false, code: "METHOD_NOT_ALLOWED", request_id: requestId });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const callerApiKey = safeString(req.headers.get("apikey"), 500);
  if (!supabaseUrl || !serviceRoleKey || !callerApiKey) {
    return reply(401, { ok: false, code: "SERVICE_AUTH_REQUIRED", request_id: requestId });
  }
  try {
    const authResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/verify_messaging_service_access`, {
      method: "POST",
      headers: { apikey: callerApiKey, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(8_000),
    });
    if (!authResponse.ok) return reply(401, { ok: false, code: "SERVICE_AUTH_INVALID", request_id: requestId });
  } catch {
    return reply(503, { ok: false, code: "SERVICE_AUTH_UNAVAILABLE", request_id: requestId });
  }

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return reply(400, { ok: false, code: "INVALID_JSON", request_id: requestId });
  }
  const submissionId = safeString(input.submission_id, 80);
  const applicationId = safeString(input.application_id, 80);
  const conversationId = safeString(input.conversation_id, 80);
  const messageId = Number(input.message_id);
  const mediaId = safeString(input.media_id, 80);
  const expectedSha256 = safeString(input.expected_sha256, 200);
  const suppliedName = safeString(input.file_name, 180) || "catalogue";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(submissionId) || !uuid.test(applicationId) || !uuid.test(conversationId)
      || !Number.isSafeInteger(messageId) || messageId < 1 || !/^[0-9]{6,40}$/.test(mediaId)) {
    return reply(400, { ok: false, code: "UPLOAD_CONTEXT_INVALID", request_id: requestId });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const completion = async (ok: boolean, values: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc("complete_partner_catalogue_upload_v1", {
      p_submission_id: submissionId,
      p_application_id: applicationId,
      p_conversation_id: conversationId,
      p_message_id: messageId,
      p_meta_media_id: mediaId,
      p_ok: ok,
      p_storage_bucket: values.storage_bucket ?? null,
      p_storage_path: values.storage_path ?? null,
      p_file_name: values.file_name ?? null,
      p_mime_type: values.mime_type ?? null,
      p_file_size_bytes: values.file_size_bytes ?? null,
      p_sha256: values.sha256 ?? null,
      p_error_code: values.error_code ?? null,
    });
    if (error) throw new Error(error.message);
    return data;
  };
  const terminalFail = async (code: string) => {
    try {
      const partnerResult = await completion(false, { error_code: code });
      return reply(200, { ok: false, terminal: true, code, partner_result: partnerResult, request_id: requestId });
    } catch {
      return reply(503, { ok: false, terminal: false, code: "CATALOGUE_FAILURE_RECORD_UNAVAILABLE", request_id: requestId });
    }
  };

  const { data: context, error: contextError } = await supabase.rpc("get_partner_catalogue_upload_context_v1", {
    p_submission_id: submissionId,
    p_application_id: applicationId,
    p_conversation_id: conversationId,
    p_message_id: messageId,
    p_meta_media_id: mediaId,
  });
  if (contextError || !context) return reply(403, { ok: false, code: "UPLOAD_CONTEXT_REJECTED", request_id: requestId });
  if (context.status !== "awaiting_upload" && context.existing_storage_path) {
    try {
      const partnerResult = await completion(true, {});
      return reply(200, { ok: true, already_saved: true, partner_result: partnerResult, request_id: requestId });
    } catch {
      return reply(503, { ok: false, code: "CATALOGUE_IDEMPOTENCY_CHECK_FAILED", request_id: requestId });
    }
  }

  const graphVersion = safeString(Deno.env.get("META_GRAPH_VERSION"), 40);
  const accessToken = Deno.env.get("META_WHATSAPP_ACCESS_TOKEN") || "";
  if (!graphVersion || !accessToken) return reply(503, { ok: false, terminal: false, code: "META_CONFIGURATION_MISSING", request_id: requestId });

  try {
    const metadataResponse = await fetch(`https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const metadata = await metadataResponse.json().catch(() => ({}));
    if (!metadataResponse.ok) {
      return metadataResponse.status >= 500
        ? reply(503, { ok: false, terminal: false, code: "META_MEDIA_LOOKUP_UNAVAILABLE", request_id: requestId })
        : terminalFail("META_MEDIA_LOOKUP_REJECTED");
    }
    const mediaUrl = safeString(metadata?.url, 2_000);
    const declaredMime = safeString(metadata?.mime_type, 120).split(";")[0].toLowerCase();
    const declaredSize = Number(metadata?.file_size || 0);
    if (!mediaUrl || !ALLOWED.has(declaredMime)) return terminalFail("UNSUPPORTED_CATALOGUE_TYPE");
    if (!Number.isFinite(declaredSize) || declaredSize < 1 || declaredSize > MAX_BYTES) return terminalFail("CATALOGUE_SIZE_REJECTED");

    const mediaResponse = await fetch(mediaUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!mediaResponse.ok) {
      return mediaResponse.status >= 500
        ? reply(503, { ok: false, terminal: false, code: "META_MEDIA_DOWNLOAD_UNAVAILABLE", request_id: requestId })
        : terminalFail("META_MEDIA_DOWNLOAD_REJECTED");
    }
    const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
    if (bytes.length < 1 || bytes.length > MAX_BYTES) return terminalFail("CATALOGUE_SIZE_REJECTED");
    const verifiedMime = detectMime(bytes, declaredMime);
    if (!verifiedMime || verifiedMime !== declaredMime) return terminalFail("CATALOGUE_SIGNATURE_MISMATCH");

    const actualSha256 = await sha256Base64(bytes);
    const expected = expectedSha256 || safeString(metadata?.sha256, 200);
    if (expected && actualSha256 !== expected) return terminalFail("CATALOGUE_INTEGRITY_MISMATCH");

    const extension: Record<string, string> = {
      "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
      "application/pdf": ".pdf", "text/csv": ".csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    };
    const base = safeName(suppliedName.replace(/\.[^.]+$/, ""));
    const storagePath = `${context.storage_prefix}${base}${extension[verifiedMime]}`;
    const { error: uploadError } = await supabase.storage.from(context.storage_bucket).upload(
      storagePath,
      bytes,
      { upsert: false, contentType: verifiedMime, cacheControl: "0" },
    );
    if (uploadError) return reply(503, { ok: false, terminal: false, code: "CATALOGUE_STORAGE_UNAVAILABLE", request_id: requestId });

    try {
      const partnerResult = await completion(true, {
        storage_bucket: context.storage_bucket,
        storage_path: storagePath,
        file_name: `${base}${extension[verifiedMime]}`,
        mime_type: verifiedMime,
        file_size_bytes: bytes.length,
        sha256: actualSha256,
      });
      return reply(200, { ok: true, partner_result: partnerResult, request_id: requestId });
    } catch {
      await supabase.storage.from(context.storage_bucket).remove([storagePath]);
      return reply(503, { ok: false, code: "CATALOGUE_FINALISE_FAILED", request_id: requestId });
    }
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === "TimeoutError";
    return reply(503, { ok: false, terminal: false, code: timeout ? "CATALOGUE_MEDIA_TIMEOUT" : "CATALOGUE_MEDIA_ERROR", request_id: requestId });
  }
});
