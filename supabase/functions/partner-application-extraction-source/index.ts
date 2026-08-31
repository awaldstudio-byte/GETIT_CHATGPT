import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.8";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 6;
const ALLOWED_MIMES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const safeString = (value: unknown, max = 500) => typeof value === "string" ? value.trim().slice(0, max) : "";
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
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

  let input: Record<string, unknown> = {};
  try { input = await req.json(); } catch { /* worker id is optional */ }
  const workerId = safeString(input.worker_id, 120) || "getit-partner-form-worker-v1";
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: job, error: claimError } = await supabase.rpc("claim_partner_application_extraction_job_v1", { p_worker_id: workerId });
  if (claimError) return reply(503, { ok: false, code: "EXTRACTION_JOB_CLAIM_FAILED", request_id: requestId });
  if (!job?.job_id) return reply(200, { ok: true, job: null, request_id: requestId });

  const failJob = async (code: string) => {
    await supabase.rpc("complete_partner_application_extraction_job_v1", {
      p_job_id: job.job_id, p_ok: false, p_fields: [], p_error_code: code,
    });
    return reply(200, { ok: false, job_id: job.job_id, code, request_id: requestId });
  };

  const files = Array.isArray(job.files) ? job.files.slice(0, MAX_FILES) : [];
  if (!files.length) return failJob("NO_EXTRACTABLE_APPLICATION_FILES");
  const documents = [];
  let totalBytes = 0;
  for (const file of files) {
    const mimeType = safeString(file?.mime_type, 120).split(";", 1)[0].toLowerCase();
    const bucket = safeString(file?.storage_bucket, 120);
    const path = safeString(file?.storage_path, 1000);
    if (!ALLOWED_MIMES.has(mimeType) || !bucket || !path) return failJob("APPLICATION_FILE_METADATA_INVALID");
    const { data, error } = await supabase.storage.from(bucket).download(path);
    if (error || !data) return failJob("APPLICATION_FILE_DOWNLOAD_FAILED");
    const bytes = new Uint8Array(await data.arrayBuffer());
    totalBytes += bytes.length;
    if (!bytes.length || totalBytes > MAX_TOTAL_BYTES) return failJob("APPLICATION_FILE_SIZE_REJECTED");
    documents.push({
      file_id: safeString(file?.file_id, 80),
      file_name: safeString(file?.file_name, 240) || null,
      mime_type: mimeType,
      content_base64: bytesToBase64(bytes),
    });
  }
  return reply(200, {
    ok: true,
    job: { job_id: job.job_id, application_id: job.application_id, documents },
    request_id: requestId,
  });
});
