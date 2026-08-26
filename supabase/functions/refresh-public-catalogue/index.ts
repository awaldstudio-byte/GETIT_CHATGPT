import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// This legacy unauthenticated writer was replaced by the staff-gated
// publish-catalogue function and the live, read-only catalogue-feed endpoint.
Deno.serve(() => new Response(JSON.stringify({
  ok: false,
  code: "LEGACY_CATALOGUE_REFRESH_RETIRED",
  use: "publish-catalogue",
}), {
  status: 410,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
}));
