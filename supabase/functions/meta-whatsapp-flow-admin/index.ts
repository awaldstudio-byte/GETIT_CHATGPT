import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const headers = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

// The Getit shop and driver Flows are published and immutable. Provisioning was
// intentionally one-time, so the live administration endpoint stays closed.
Deno.serve(() => new Response(
  JSON.stringify({
    ok: false,
    code: 'PROVISIONING_COMPLETE',
    message: 'Getit WhatsApp partner forms are published; this administration endpoint is permanently closed.',
  }),
  { status: 410, headers },
));
