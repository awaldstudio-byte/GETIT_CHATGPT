import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.8";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_BYTES = 25 * 1024 * 1024;
const DOCUMENT_MIMES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const safeString = (value: unknown, max = 500) => typeof value === "string" ? value.trim().slice(0, max) : "";
const baseMime = (value: string) => value.split(";")[0].trim().toLowerCase();
const starts = (bytes: Uint8Array, signature: number[]) => signature.every((value, index) => bytes[index] === value);
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
};
const sha256Digests = async (bytes: Uint8Array) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    base64: bytesToBase64(digest),
    hex: Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(""),
  };
};
const allowedMime = (mime: string) =>
  mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/") || DOCUMENT_MIMES.has(mime);
const safeName = (value: string) =>
  value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 120) || "attachment";

const extensionFor = (mime: string) => ({
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
  "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/aac": ".aac",
  "audio/amr": ".amr", "audio/wav": ".wav", "video/mp4": ".mp4", "video/3gpp": ".3gp",
  "application/pdf": ".pdf", "text/plain": ".txt", "text/csv": ".csv",
  "application/msword": ".doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
} as Record<string, string>)[mime] || ".bin";

const signatureMatches = (bytes: Uint8Array, mime: string) => {
  if (mime === "image/jpeg") return starts(bytes, [0xff, 0xd8, 0xff]);
  if (mime === "image/png") return starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === "image/webp") return bytes.length >= 12 && starts(bytes, [0x52, 0x49, 0x46, 0x46]) && new TextDecoder("latin1").decode(bytes.subarray(8, 12)) === "WEBP";
  if (mime === "image/gif") return starts(bytes, [0x47, 0x49, 0x46, 0x38]);
  if (mime === "audio/ogg") return starts(bytes, [0x4f, 0x67, 0x67, 0x53]);
  if (mime === "audio/mpeg") return starts(bytes, [0x49, 0x44, 0x33]) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (mime === "audio/amr") return starts(bytes, [0x23, 0x21, 0x41, 0x4d, 0x52]);
  if (mime === "audio/wav") return bytes.length >= 12 && starts(bytes, [0x52, 0x49, 0x46, 0x46]) && new TextDecoder("latin1").decode(bytes.subarray(8, 12)) === "WAVE";
  if (["audio/mp4", "video/mp4", "video/3gpp"].includes(mime)) return bytes.length >= 12 && new TextDecoder("latin1").decode(bytes.subarray(4, 8)) === "ftyp";
  if (mime === "audio/aac") return bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0;
  if (mime === "application/pdf") {
    if (!starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return false;
    const tail = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, bytes.length - 4096)));
    const sample = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 2_000_000)));
    return tail.includes("%%EOF") && !/\/(?:JavaScript|JS|OpenAction|Launch|EmbeddedFile)\b/i.test(sample);
  }
  if (["text/plain", "text/csv"].includes(mime)) {
    if (bytes.includes(0)) return false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
  }
  if (["application/msword", "application/vnd.ms-excel"].includes(mime)) {
    return starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  }
  if (mime.includes("openxmlformats-officedocument")) {
    if (!starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return false;
    const names = new TextDecoder("latin1").decode(bytes);
    const expected = mime.includes("wordprocessingml") ? "word/document.xml" : "xl/workbook.xml";
    return names.includes("[Content_Types].xml") && names.includes(expected) && !/vbaProject\.bin|\.exe\b|\.dll\b/i.test(names);
  }
  return false;
};

Deno.serve(async (req: Request) => {
  const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
  if (req.method !== "POST") return reply(405, { ok: false, code: "METHOD_NOT_ALLOWED", request_id: requestId });

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const callerApiKey = safeString(req.headers.get("apikey"), 500);
  if (!supabaseUrl || !serviceRoleKey || !callerApiKey) return reply(401, { ok: false, code: "SERVICE_AUTH_REQUIRED", request_id: requestId });
  try {
    const access = await fetch(`${supabaseUrl}/rest/v1/rpc/verify_messaging_service_access`, {
      method: "POST",
      headers: { apikey: callerApiKey, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    });
    if (!access.ok) return reply(401, { ok: false, code: "SERVICE_AUTH_INVALID", request_id: requestId });
  } catch {
    return reply(503, { ok: false, code: "SERVICE_AUTH_UNAVAILABLE", request_id: requestId });
  }

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return reply(400, { ok: false, code: "INVALID_JSON", request_id: requestId }); }
  let attachmentId = safeString(input.attachment_id, 80);
  const conversationId = safeString(input.conversation_id, 80);
  const messageId = Number(input.message_id);
  const mediaId = safeString(input.media_id, 80);
  const expectedSha256 = safeString(input.expected_sha256, 200);
  const suppliedName = safeString(input.file_name, 180) || "attachment";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if ((attachmentId && !uuid.test(attachmentId)) || !uuid.test(conversationId) || !Number.isSafeInteger(messageId) || messageId < 1 || !/^[0-9]{6,40}$/.test(mediaId)) {
    return reply(400, { ok: false, code: "ARCHIVE_CONTEXT_INVALID", request_id: requestId });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  if (!attachmentId) {
    const { data: attachment, error } = await supabase
      .from("messaging_attachments")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("message_id", messageId)
      .eq("media_id", mediaId)
      .maybeSingle();
    if (error || !attachment?.id) return reply(404, { ok: false, code: "ATTACHMENT_NOT_FOUND", request_id: requestId });
    attachmentId = attachment.id;
  }
  const complete = async (ok: boolean, values: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc("complete_messaging_media_archive_v1", {
      p_attachment_id: attachmentId,
      p_conversation_id: conversationId,
      p_message_id: messageId,
      p_media_id: mediaId,
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
  const terminalFailure = async (code: string) => {
    try { return reply(200, { ok: false, terminal: true, code, archive: await complete(false, { error_code: code }), request_id: requestId }); }
    catch { return reply(503, { ok: false, terminal: false, code: "ARCHIVE_FAILURE_RECORD_UNAVAILABLE", request_id: requestId }); }
  };

  const { data: context, error: contextError } = await supabase.rpc("get_messaging_media_archive_context_v1", {
    p_attachment_id: attachmentId,
    p_conversation_id: conversationId,
    p_message_id: messageId,
    p_media_id: mediaId,
  });
  if (contextError || !context) return reply(403, { ok: false, code: "ARCHIVE_CONTEXT_REJECTED", request_id: requestId });
  if (context.already_archived) return reply(200, { ok: true, already_archived: true, archive: context, request_id: requestId });

  const graphVersion = safeString(Deno.env.get("META_GRAPH_VERSION"), 40);
  const accessToken = Deno.env.get("META_WHATSAPP_ACCESS_TOKEN") || "";
  if (!graphVersion || !accessToken) return reply(503, { ok: false, code: "META_CONFIGURATION_MISSING", request_id: requestId });

  try {
    const metadataResponse = await fetch(`https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const metadata = await metadataResponse.json().catch(() => ({}));
    if (!metadataResponse.ok) {
      return metadataResponse.status >= 500
        ? reply(503, { ok: false, terminal: false, code: "META_MEDIA_LOOKUP_UNAVAILABLE", request_id: requestId })
        : terminalFailure("META_MEDIA_LOOKUP_REJECTED");
    }
    const mediaUrl = safeString(metadata?.url, 2000);
    const declaredMime = baseMime(safeString(metadata?.mime_type, 160) || safeString(context.declared_mime_type, 160));
    const declaredSize = Number(metadata?.file_size || 0);
    if (!mediaUrl || !allowedMime(declaredMime)) return terminalFailure("UNSUPPORTED_MEDIA_TYPE");
    if (!Number.isFinite(declaredSize) || declaredSize < 1 || declaredSize > MAX_BYTES) return terminalFailure("MEDIA_SIZE_REJECTED");

    const mediaResponse = await fetch(mediaUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(35_000),
    });
    if (!mediaResponse.ok) {
      return mediaResponse.status >= 500
        ? reply(503, { ok: false, terminal: false, code: "META_MEDIA_DOWNLOAD_UNAVAILABLE", request_id: requestId })
        : terminalFailure("META_MEDIA_DOWNLOAD_REJECTED");
    }
    const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
    if (bytes.length < 1 || bytes.length > MAX_BYTES) return terminalFailure("MEDIA_SIZE_REJECTED");
    if (!signatureMatches(bytes, declaredMime)) return terminalFailure("MEDIA_SIGNATURE_MISMATCH");

    const actualSha256 = await sha256Digests(bytes);
    const expected = expectedSha256 || safeString(metadata?.sha256, 200) || safeString(context.declared_sha256, 200);
    const integrityMatches = !expected || (/^[0-9a-f]{64}$/i.test(expected)
      ? actualSha256.hex === expected.toLowerCase()
      : actualSha256.base64 === expected);
    if (!integrityMatches) return terminalFailure("MEDIA_INTEGRITY_MISMATCH");

    const base = safeName(suppliedName.replace(/\.[^.]+$/, ""));
    const fileName = `${base}${extensionFor(declaredMime)}`;
    const storagePath = `${context.storage_prefix}${fileName}`;
    const { error: uploadError } = await supabase.storage.from(context.storage_bucket).upload(storagePath, bytes, {
      upsert: false,
      contentType: declaredMime,
      cacheControl: "0",
    });
    if (uploadError) return reply(503, { ok: false, terminal: false, code: "MEDIA_STORAGE_UNAVAILABLE", request_id: requestId });

    try {
      const archive = await complete(true, {
        storage_bucket: context.storage_bucket,
        storage_path: storagePath,
        file_name: fileName,
        mime_type: declaredMime,
        file_size_bytes: bytes.length,
        sha256: actualSha256.base64,
      });
      return reply(200, { ok: true, already_archived: false, archive, request_id: requestId });
    } catch {
      await supabase.storage.from(context.storage_bucket).remove([storagePath]);
      return reply(503, { ok: false, terminal: false, code: "MEDIA_ARCHIVE_FINALISE_FAILED", request_id: requestId });
    }
  } catch (error) {
    const timeout = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
    return reply(503, { ok: false, terminal: false, code: timeout ? "MEDIA_ARCHIVE_TIMEOUT" : "MEDIA_ARCHIVE_ERROR", request_id: requestId });
  }
});

