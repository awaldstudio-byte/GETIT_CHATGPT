import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.8";

type CatalogueRow = {
  shop_id: string;
  shop_name: string;
  town: string;
  product_id: string;
  product_name: string;
  brand: string | null;
  size: string | null;
  category: string;
  search_aliases: string[];
  normal_price: number | null;
  current_special_price: number | null;
  current_special_starts: string | null;
  current_special_ends: string | null;
  effective_price: number;
  in_stock: boolean;
  source: string | null;
  source_url: string | null;
  source_region: string | null;
  last_checked: string | null;
  notes: string | null;
  regional_scope: "store" | "regional" | "national";
  local_verification_status: "verified" | "awaiting_local_comparison";
  advertised_only: boolean;
  barcode: string | null;
  shop_sku: string | null;
  maximum_units: number;
  handling_type: string;
};

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const money = (value: number | null): string =>
  value === null
    ? "Price not supplied"
    : new Intl.NumberFormat("en-ZA", {
        style: "currency",
        currency: "ZAR",
        minimumFractionDigits: 2,
      }).format(value);

const csvCell = (value: unknown): string => {
  const raw = String(value ?? "");
  const safe = typeof value === "string" && /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};

const authorisedRole = new Set(["owner", "admin"]);
const authoriseCaller = async (
  req: Request,
  supabaseUrl: string,
  anonKey: string,
  serviceRoleKey: string,
): Promise<boolean> => {
  const authorization = (req.headers.get("authorization") || "").trim();
  if (!authorization.toLowerCase().startsWith("bearer ")) return false;
  const token = authorization.slice(7).trim();
  if (token && token === serviceRoleKey) return true;
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await caller.auth.getUser();
  if (userError || !userData.user) return false;
  const { data: role, error: roleError } = await caller.rpc("current_staff_role");
  return !roleError && authorisedRole.has(String(role || ""));
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

  if (!['GET', 'POST'].includes(req.method)) {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: "Supabase environment is not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!(await authoriseCaller(req, supabaseUrl, anonKey, serviceRoleKey))) {
    return new Response(JSON.stringify({ error: "Staff catalogue access required" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase
    .from("catalogue_public_rows")
    .select("*")
    .order("shop_name", { ascending: true })
    .order("category", { ascending: true })
    .order("product_name", { ascending: true });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rows = (data ?? []) as CatalogueRow[];
  const generatedAt = new Date().toISOString();
  const publicNotice =
    "Prices and availability are checked again before payment. Items marked as regional flyer specials are awaiting comparison with the Villiers store flyer.";

  const grouped = new Map<string, {
    id: string;
    name: string;
    town: string;
    products: CatalogueRow[];
  }>();

  for (const row of rows) {
    const existing = grouped.get(row.shop_id);
    if (existing) {
      existing.products.push(row);
    } else {
      grouped.set(row.shop_id, {
        id: row.shop_id,
        name: row.shop_name,
        town: row.town,
        products: [row],
      });
    }
  }

  const catalogue = {
    schema_version: "1.0",
    generated_at: generatedAt,
    currency: "ZAR",
    checkout_revalidation_required: true,
    notice: publicNotice,
    product_count: rows.length,
    shops: Array.from(grouped.values()).map((shop) => ({
      id: shop.id,
      name: shop.name,
      town: shop.town,
      product_count: shop.products.length,
      products: shop.products.map((row) => ({
        id: row.product_id,
        name: row.product_name,
        brand: row.brand,
        size: row.size,
        category: row.category,
        aliases: row.search_aliases,
        normal_price: row.normal_price,
        special_price: row.current_special_price,
        special_starts: row.current_special_starts,
        special_ends: row.current_special_ends,
        effective_price: row.effective_price,
        in_stock: row.in_stock,
        maximum_units: row.maximum_units,
        handling_type: row.handling_type,
        advertised_only: row.advertised_only,
        verification: row.local_verification_status,
        source_scope: row.regional_scope,
        source: row.source,
        source_url: row.source_url,
        source_region: row.source_region,
        last_checked: row.last_checked,
        notes: row.notes,
        barcode: row.barcode,
        shop_sku: row.shop_sku,
      })),
    })),
  };

  const textParts: string[] = [
    "GETIT PRODUCT CATALOGUE",
    `Published: ${generatedAt}`,
    `Currency: South African rand (ZAR)`,
    "",
    `IMPORTANT: ${publicNotice}`,
    "",
  ];

  for (const shop of grouped.values()) {
    textParts.push(`${shop.name.toUpperCase()} — ${shop.town}`);
    let currentCategory = "";
    for (const row of shop.products) {
      if (row.category !== currentCategory) {
        currentCategory = row.category;
        textParts.push("", `[${currentCategory}]`);
      }

      const description = [row.brand, row.product_name, row.size]
        .filter(Boolean)
        .join(" ");
      const priceText = row.current_special_price !== null
        ? `${money(row.current_special_price)} special until ${row.current_special_ends}; normal price ${money(row.normal_price)}`
        : money(row.normal_price);
      const verification = row.local_verification_status === "awaiting_local_comparison"
        ? "Regional flyer item — Villiers comparison pending; confirm before payment"
        : "Villiers/store verified";

      textParts.push(
        `- ${description}: ${priceText}. ${row.in_stock ? "Listed as available" : "Listed as unavailable"}. ${verification}.`,
      );
    }
    textParts.push("", "---", "");
  }

  const textOutput = textParts.join("\n");

  const shopSections = Array.from(grouped.values()).map((shop) => {
    const categories = new Map<string, CatalogueRow[]>();
    for (const row of shop.products) {
      const list = categories.get(row.category) ?? [];
      list.push(row);
      categories.set(row.category, list);
    }

    const categoryHtml = Array.from(categories.entries()).map(([category, products]) => `
      <section class="category">
        <h3>${escapeHtml(category)}</h3>
        <div class="products">
          ${products.map((row) => {
            const title = [row.brand, row.product_name, row.size].filter(Boolean).join(" ");
            const provisional = row.local_verification_status === "awaiting_local_comparison";
            return `
              <article class="product">
                <div>
                  <strong>${escapeHtml(title)}</strong>
                  <div class="meta">${escapeHtml(row.in_stock ? "Listed as available" : "Listed as unavailable")}</div>
                </div>
                <div class="price">
                  ${row.current_special_price !== null
                    ? `<span class="special">${escapeHtml(money(row.current_special_price))}</span><small>Special ends ${escapeHtml(row.current_special_ends)}</small>${row.normal_price !== null ? `<small>Normal ${escapeHtml(money(row.normal_price))}</small>` : ""}`
                    : `<span>${escapeHtml(money(row.normal_price))}</span>`}
                </div>
                ${provisional ? `<div class="badge">Regional flyer — Villiers comparison pending</div>` : `<div class="badge verified">Villiers/store verified</div>`}
              </article>`;
          }).join("")}
        </div>
      </section>`).join("");

    return `<section class="shop"><h2>${escapeHtml(shop.name)} <small>${escapeHtml(shop.town)}</small></h2>${categoryHtml}</section>`;
  }).join("");

  const htmlOutput = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Getit Product Catalogue</title>
  <style>
    :root { font-family: Inter, system-ui, sans-serif; color: #10213d; background: #f4f7fb; }
    body { margin: 0; }
    header { background: #10213d; color: white; padding: 32px 20px; }
    header div, main { max-width: 1100px; margin: auto; }
    h1 { margin: 0 0 8px; }
    .notice { margin-top: 18px; background: #fff4cc; color: #634b00; padding: 14px 16px; border-radius: 12px; }
    main { padding: 24px 20px 60px; }
    .shop { background: white; border-radius: 18px; padding: 22px; margin-bottom: 24px; box-shadow: 0 8px 30px rgba(16,33,61,.08); }
    h2 small { color: #6b7b92; font-size: .55em; font-weight: 500; }
    .category { margin-top: 24px; }
    .products { display: grid; gap: 10px; }
    .product { display: grid; grid-template-columns: 1fr auto; gap: 8px 18px; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; }
    .meta, small { color: #6b7b92; }
    .price { text-align: right; display: flex; flex-direction: column; }
    .special { color: #087443; font-weight: 800; }
    .badge { grid-column: 1 / -1; justify-self: start; background: #fff4cc; color: #634b00; border-radius: 999px; padding: 5px 9px; font-size: 12px; }
    .badge.verified { background: #dcfce7; color: #166534; }
    footer { text-align: center; padding: 25px; color: #6b7b92; }
    @media (max-width: 600px) { .product { grid-template-columns: 1fr; } .price { text-align: left; } }
  </style>
</head>
<body>
  <header><div><h1>Getit Product Catalogue</h1><p>Updated ${escapeHtml(generatedAt)}</p><div class="notice">${escapeHtml(publicNotice)}</div></div></header>
  <main>${shopSections || "<p>No approved live catalogue items have been published yet.</p>"}</main>
  <footer>Getit — Villiers, Free State</footer>
</body>
</html>`;

  const csvHeader = [
    "shop_name", "town", "product_name", "brand", "size", "category",
    "normal_price", "special_price", "special_starts", "special_ends",
    "effective_price", "in_stock", "verification", "source_scope", "source",
  ].map(csvCell).join(",");
  const csvRows = rows.map((row) => [
    row.shop_name, row.town, row.product_name, row.brand, row.size, row.category,
    row.normal_price, row.current_special_price, row.current_special_starts,
    row.current_special_ends, row.effective_price, row.in_stock,
    row.local_verification_status, row.regional_scope, row.source,
  ].map(csvCell).join(","));
  const csvOutput = [csvHeader, ...csvRows].join("\n");

  // The catalogue-feed Edge Function reads the local-date-filtered view on
  // every request. Generated static exports were retired because a special
  // could otherwise remain visible after its Villiers expiry date.
  const dynamicCatalogueUrl = `${supabaseUrl}/functions/v1/catalogue-feed`;
  const { error: settingsError } = await supabase.from("app_settings").upsert([
    {
      key: "catalogue_last_published_at",
      value: generatedAt,
      description: "Timestamp of the most recent successful catalogue publication",
    },
    {
      key: "catalogue_published_product_count",
      value: rows.length,
      description: "Number of currently published shop-product rows",
    },
    { key: "catalogue_public_url", value: dynamicCatalogueUrl, description: "Live date-filtered catalogue endpoint" },
    { key: "catalogue_json_url", value: dynamicCatalogueUrl, description: "Live date-filtered catalogue endpoint" },
    { key: "catalogue_text_url", value: dynamicCatalogueUrl, description: "Live date-filtered catalogue endpoint" },
  ], { onConflict: "key" });
  if (settingsError) {
    return new Response(JSON.stringify({ error: `Could not update catalogue settings: ${settingsError.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { error: shopUpdateError } = await supabase
    .from("shops")
    .update({
      catalogue_url: dynamicCatalogueUrl,
    })
    .in("id", Array.from(grouped.keys()));
  if (shopUpdateError) {
    return new Response(JSON.stringify({ error: `Could not update shop catalogue links: ${shopUpdateError.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    success: true,
    generated_at: generatedAt,
    product_count: rows.length,
    shop_count: grouped.size,
    dynamic_catalogue_url: dynamicCatalogueUrl,
    static_exports_retired: true,
  }, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
