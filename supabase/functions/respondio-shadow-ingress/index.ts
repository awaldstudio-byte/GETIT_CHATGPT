import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
Deno.serve(() => new Response(JSON.stringify({ accepted: false, code: 'DEPRECATED_PROVIDER_REMOVED' }), {
  status: 410,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
}));
