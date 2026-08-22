import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

Deno.serve((req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify({
    accepted: false,
    code: 'CHATWOOT_REMOVED',
    message: 'Chatwoot is not part of the Getit production architecture. Use the Getit Control Centre messaging inbox.',
  }), { status: 410, headers });
});
