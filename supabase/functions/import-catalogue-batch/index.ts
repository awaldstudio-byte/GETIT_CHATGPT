import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.8";

type SourceInput = {
  shop_id: string;
  source_type: "flyer" | "manager_csv" | "manager_excel" | "manager_pdf" | "store_api" | "website" | "manual" | "receipt";
  title: string;
  source_url?: string | null;
  region?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  villiers_comparison_status?: "pending" | "matched" | "different" | "not_required";
  local_copy_path?: string | null;
  notes?: string | null;
};

type ItemInput = {
  shop_id?: string;
  raw_text?: string | null;
  product_name: string;
  brand?: string | null;
  size?: string | null;
  category?: string | null;
  search_aliases?: string[];
  barcode?: string | null;
  shop_sku?: string | null;
  normal_price?: number | null;
  special_price?: number | null;
  special_starts?: string | null;
  special_ends?: string | null;
  in_stock?: boolean;
  source_page?: number | null;
  source_image_url?: string | null;
  match_product_id?: string | null;
  review_status?: "pending" | "accepted" | "rejected" | "needs_correction";
  review_note?: string | null;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), {
  status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  },
});

const validDate = (value: string | null | undefined): boolean =>
  !value || /^\d{4}-\d{2}-\d{2}$/.test(value);

const authorisedRole = new Set(["owner", "admin", "dispatcher"]);
const authoriseCaller = async (
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceRoleKey: string,
): Promise<string | null> => {
  const authorization = (req.headers.get("authorization") || "").trim();
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (token && token === serviceRoleKey) return "service_role";
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return null;
  const { data: role, error: roleError } = await caller.rpc("current_staff_role");
  const roleName = String(role || "");
  return !roleError && authorisedRole.has(roleName) ? roleName : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) return json({ error: "Supabase environment is not configured" }, 500);

  const callerRole = await authoriseCaller(req, supabaseUrl, anonKey, serviceRoleKey);
  if (!callerRole) {
    return json({ error: "Staff catalogue access required" }, 403);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let payload: {
    source_id?: string;
    source?: SourceInput;
    items?: ItemInput[];
    auto_accept?: boolean;
    publish_now?: boolean;
    partner_catalogue_submission_id?: string | null;
    batch_notes?: string | null;
  };

  try {
    payload = await req.json();
  } catch {
    return json({ error: "Body must be valid JSON" }, 400);
  }

  if (!payload.source_id && !payload.source) {
    return json({ error: "Provide source_id or source" }, 400);
  }

  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return json({ error: "At least one catalogue item is required" }, 400);
  }

  if (payload.items.length > 2000) {
    return json({ error: "A single import batch may contain at most 2,000 items" }, 400);
  }
  if ((payload.auto_accept || payload.publish_now) && !["owner", "admin", "service_role"].includes(callerRole)) {
    return json({ error: "Owner or admin approval is required to auto-accept or publish catalogue items" }, 403);
  }
  if (payload.publish_now && !payload.auto_accept) {
    return json({ error: "publish_now requires auto_accept=true" }, 400);
  }

  let sourceId = payload.source_id ?? null;
  let source: SourceInput | null = payload.source ?? null;
  let partnerSubmission: Record<string, unknown> | null = null;
  if (payload.partner_catalogue_submission_id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.partner_catalogue_submission_id)) {
      return json({ error: "partner_catalogue_submission_id is invalid" }, 400);
    }
    const { data, error } = await supabase
      .from("partner_catalogue_submissions")
      .select("id,status,catalogue_kind,valid_from,valid_to,expected_refresh_on,storage_bucket,storage_path,original_file_name,answers")
      .eq("id", payload.partner_catalogue_submission_id)
      .single();
    if (error || !data || data.status !== "ready_for_review" || !data.storage_path) {
      return json({ error: "Partner catalogue submission is not ready for staff import" }, 409);
    }
    if (!source || sourceId) {
      return json({ error: "Partner catalogue imports require a new source with an explicit shop_id" }, 400);
    }
    partnerSubmission = data;
    source = {
      ...source,
      title: source.title || String(data.original_file_name || "Partner catalogue"),
      valid_from: String(data.catalogue_kind) === "regular" ? (source.valid_from ?? null) : String(data.valid_from || "") || null,
      valid_to: String(data.catalogue_kind) === "regular" ? (source.valid_to ?? null) : String(data.valid_to || "") || null,
      local_copy_path: String(data.storage_path),
      notes: [source.notes, `Partner submission ${data.id}`, data.expected_refresh_on ? `Next update expected ${data.expected_refresh_on}` : null]
        .filter(Boolean).join(" · "),
    };
  }

  if (source) {
    if (!source.shop_id || !source.source_type || !source.title?.trim()) {
      return json({ error: "source.shop_id, source.source_type and source.title are required" }, 400);
    }
    if (!validDate(source.valid_from) || !validDate(source.valid_to)) {
      return json({ error: "Source dates must use YYYY-MM-DD" }, 400);
    }
    if (source.valid_from && source.valid_to && source.valid_to < source.valid_from) {
      return json({ error: "source.valid_to cannot be earlier than source.valid_from" }, 400);
    }

    let existingQuery = supabase
      .from("catalogue_sources")
      .select("id, shop_id, title, valid_from, valid_to")
      .eq("shop_id", source.shop_id)
      .eq("source_type", source.source_type);
    existingQuery = source.valid_from ? existingQuery.eq("valid_from", source.valid_from) : existingQuery.is("valid_from", null);
    existingQuery = source.valid_to ? existingQuery.eq("valid_to", source.valid_to) : existingQuery.is("valid_to", null);

    if (source.source_url) existingQuery = existingQuery.eq("source_url", source.source_url);
    else existingQuery = existingQuery.is("source_url", null);

    const { data: existingSource } = await existingQuery.maybeSingle();

    if (existingSource) {
      sourceId = existingSource.id;
    } else {
      const { data: insertedSource, error: sourceError } = await supabase
        .from("catalogue_sources")
        .insert({
          shop_id: source.shop_id,
          source_type: source.source_type,
          title: source.title.trim(),
          source_url: source.source_url ?? null,
          region: source.region ?? null,
          valid_from: source.valid_from ?? null,
          valid_to: source.valid_to ?? null,
          villiers_comparison_status: source.villiers_comparison_status ?? "pending",
          local_copy_path: source.local_copy_path ?? null,
          notes: source.notes ?? null,
        })
        .select("id")
        .single();

      if (sourceError || !insertedSource) {
        return json({ error: `Could not create catalogue source: ${sourceError?.message ?? "unknown error"}` }, 500);
      }
      sourceId = insertedSource.id;
    }
  }

  if (!sourceId) return json({ error: "Could not resolve catalogue source" }, 400);

  const { data: sourceRow, error: sourceFetchError } = await supabase
    .from("catalogue_sources")
    .select("id, shop_id, valid_from, valid_to, title")
    .eq("id", sourceId)
    .single();

  if (sourceFetchError || !sourceRow) {
    return json({ error: "Catalogue source does not exist" }, 404);
  }

  for (const [index, item] of payload.items.entries()) {
    const effectiveSpecialStart = item.special_starts ?? (item.special_price != null ? sourceRow.valid_from : null);
    const effectiveSpecialEnd = item.special_ends ?? (item.special_price != null ? sourceRow.valid_to : null);
    if (!item.product_name?.trim()) {
      return json({ error: `Item ${index + 1} has no product_name` }, 400);
    }
    if (item.normal_price == null && item.special_price == null) {
      return json({ error: `Item ${index + 1} must have a normal_price or special_price` }, 400);
    }
    if ((item.normal_price ?? 0) < 0 || (item.special_price ?? 0) < 0) {
      return json({ error: `Item ${index + 1} contains a negative price` }, 400);
    }
    if (!validDate(item.special_starts) || !validDate(item.special_ends)) {
      return json({ error: `Item ${index + 1} special dates must use YYYY-MM-DD` }, 400);
    }
    if (item.special_price != null && (!effectiveSpecialStart || !effectiveSpecialEnd)) {
      return json({ error: `Item ${index + 1} has a special price without start and end dates` }, 400);
    }
    if (item.shop_id && item.shop_id !== sourceRow.shop_id) {
      return json({ error: `Item ${index + 1} cannot target a different shop` }, 400);
    }
    if ((item.normal_price != null && (!Number.isFinite(item.normal_price) || item.normal_price > 1_000_000))
      || (item.special_price != null && (!Number.isFinite(item.special_price) || item.special_price > 1_000_000))) {
      return json({ error: `Item ${index + 1} contains an invalid price` }, 400);
    }
    if (effectiveSpecialStart && effectiveSpecialEnd && effectiveSpecialEnd < effectiveSpecialStart) {
      return json({ error: `Item ${index + 1} special end date is before its start date` }, 400);
    }
    if ((sourceRow.valid_from && effectiveSpecialStart && effectiveSpecialStart < sourceRow.valid_from)
      || (sourceRow.valid_to && effectiveSpecialEnd && effectiveSpecialEnd > sourceRow.valid_to)) {
      return json({ error: `Item ${index + 1} special dates fall outside the approved source validity window` }, 400);
    }
    if (item.product_name.trim().length > 300
      || (item.raw_text?.length ?? 0) > 4_000
      || (item.review_note?.length ?? 0) > 2_000
      || (item.search_aliases?.length ?? 0) > 30) {
      return json({ error: `Item ${index + 1} exceeds catalogue field limits` }, 400);
    }
  }

  const { data: batch, error: batchError } = await supabase
    .from("catalogue_import_batches")
    .insert({
      source_id: sourceId,
      status: payload.auto_accept ? "reviewing" : "imported",
      notes: payload.batch_notes ?? null,
    })
    .select("id")
    .single();

  if (batchError || !batch) {
    return json({ error: `Could not create import batch: ${batchError?.message ?? "unknown error"}` }, 500);
  }

  const stagingRows = payload.items.map((item) => ({
    batch_id: batch.id,
    shop_id: sourceRow.shop_id,
    raw_text: item.raw_text ?? null,
    product_name: item.product_name.trim(),
    brand: item.brand?.trim() || null,
    size: item.size?.trim() || null,
    category: item.category?.trim() || "Uncategorised",
    search_aliases: Array.isArray(item.search_aliases) ? item.search_aliases : [],
    barcode: item.barcode?.trim() || null,
    shop_sku: item.shop_sku?.trim() || null,
    normal_price: item.normal_price ?? null,
    special_price: item.special_price ?? null,
    special_starts: item.special_starts ?? (item.special_price != null ? sourceRow.valid_from : null),
    special_ends: item.special_ends ?? (item.special_price != null ? sourceRow.valid_to : null),
    in_stock: item.in_stock ?? true,
    source_page: item.source_page ?? null,
    source_image_url: item.source_image_url ?? null,
    match_product_id: item.match_product_id ?? null,
    review_status: payload.auto_accept ? "accepted" : (item.review_status ?? "pending"),
    review_note: item.review_note ?? null,
  }));

  const { error: itemError } = await supabase
    .from("catalogue_staging_items")
    .insert(stagingRows);

  if (itemError) {
    await supabase.from("catalogue_import_batches").delete().eq("id", batch.id);
    return json({ error: `Could not import catalogue items: ${itemError.message}` }, 500);
  }

  let publishResult: unknown = null;
  let publicPublishResult: unknown = null;

  if (payload.publish_now) {
    const { data: promoted, error: promoteError } = await supabase
      .rpc("publish_catalogue_batch", { p_batch_id: batch.id });

    if (promoteError) {
      return json({
        error: `Items were staged but could not be promoted: ${promoteError.message}`,
        batch_id: batch.id,
      }, 500);
    }
    publishResult = promoted;

    const publishResponse = await fetch(`${supabaseUrl}/functions/v1/publish-catalogue`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "catalogue_batch_published", batch_id: batch.id }),
    });

    const publishText = await publishResponse.text();
    try {
      publicPublishResult = JSON.parse(publishText);
    } catch {
      publicPublishResult = publishText;
    }

    if (!publishResponse.ok) {
      return json({
        error: "Catalogue rows were promoted, but the public files could not be refreshed",
        batch_id: batch.id,
        promotion: publishResult,
        publisher_response: publicPublishResult,
      }, 502);
    }
  }

  if (partnerSubmission) {
    const { error: linkError } = await supabase
      .from("partner_catalogue_submissions")
      .update({
        status: "imported",
        current_step: "imported",
        answers: {
          ...((partnerSubmission as { answers?: Record<string, unknown> }).answers || {}),
          catalogue_source_id: sourceId,
          import_batch_id: batch.id,
          imported_at: new Date().toISOString(),
        },
      })
      .eq("id", String(partnerSubmission.id));
    if (linkError) {
      return json({ error: "Items were staged but the partner submission could not be linked", batch_id: batch.id }, 500);
    }
  }

  return json({
    success: true,
    source_id: sourceId,
    batch_id: batch.id,
    imported_items: stagingRows.length,
    review_status: payload.auto_accept ? "accepted" : "pending",
    promotion: publishResult,
    public_catalogue: publicPublishResult,
  });
});
