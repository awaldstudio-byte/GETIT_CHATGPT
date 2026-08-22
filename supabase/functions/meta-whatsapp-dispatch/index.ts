import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.8';

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });
const safeString = (value: unknown, max = 5000) => typeof value === 'string' ? value.slice(0, max) : '';

Deno.serve(async (req: Request) => {
  const requestId = req.headers.get('x-request-id') || crypto.randomUUID();
  if (req.method !== 'POST') return reply(405, { ok: false, code: 'METHOD_NOT_ALLOWED', request_id: requestId });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) return reply(503, { ok: false, code: 'DATABASE_CREDENTIAL_UNAVAILABLE', request_id: requestId });

  // Modern sb_secret_ keys are intentionally sent only as an apikey header. The
  // side-effect-free RPC proves the caller is service_role before any outbox data
  // is read or mutated. Customer and staff credentials cannot execute the probe.
  const callerApiKey = safeString(req.headers.get('apikey'), 500);
  if (!callerApiKey) return reply(401, { ok: false, code: 'SERVICE_AUTH_REQUIRED', request_id: requestId });
  try {
    const authResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/verify_messaging_service_access`, {
      method: 'POST',
      headers: { apikey: callerApiKey, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (!authResponse.ok) return reply(401, { ok: false, code: 'SERVICE_AUTH_INVALID', request_id: requestId });
  } catch {
    return reply(503, { ok: false, code: 'SERVICE_AUTH_UNAVAILABLE', request_id: requestId });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let input: any;
  try { input = await req.json(); } catch { return reply(400, { ok: false, code: 'INVALID_JSON', request_id: requestId }); }

  const outboxId = Number(input?.outbox_id);
  const lockToken = safeString(input?.lock_token, 100);
  const destination = safeString(input?.destination, 100);
  const payload = input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
  const attemptNumber = Math.max(1, Number(input?.attempt_number || 1));
  if (!Number.isSafeInteger(outboxId) || outboxId <= 0 || !lockToken || !destination) {
    return reply(400, { ok: false, code: 'INVALID_DISPATCH_INPUT', request_id: requestId });
  }

  const { data: authData, error: authError } = await supabase.rpc('authorize_outbox_send', { p_outbox_id: outboxId, p_lock_token: lockToken });
  if (authError) return reply(409, { ok: false, code: 'AUTHORIZATION_CHECK_FAILED', request_id: requestId });
  if (!authData?.allowed) {
    const reason = safeString(authData?.reason || 'send no longer authorised', 500);
    await supabase.rpc('cancel_claimed_outbox_message', { p_outbox_id: outboxId, p_lock_token: lockToken, p_reason: reason });
    return reply(200, { ok: true, outcome: 'cancelled', reason, request_id: requestId });
  }

  const graphVersion = safeString(Deno.env.get('META_GRAPH_VERSION'), 40);
  const phoneNumberId = safeString(Deno.env.get('META_WHATSAPP_PHONE_NUMBER_ID'), 120);
  const accessToken = Deno.env.get('META_WHATSAPP_ACCESS_TOKEN') || '';
  if (!graphVersion || !phoneNumberId || !accessToken) {
    const retryAfter = Math.min(900, 60 * Math.max(1, attemptNumber));
    const { data: finishData } = await supabase.rpc('finish_outbox_message', {
      p_outbox_id: outboxId, p_lock_token: lockToken, p_outcome: 'retry', p_provider_message_id: null,
      p_retry_after_seconds: retryAfter, p_http_status: null, p_error_code: 'META_CONFIGURATION_MISSING',
      p_error_detail: 'Meta WhatsApp delivery secrets are not configured.', p_safe_response_meta: { request_id: requestId },
    });
    return reply(503, { ok: false, outcome: finishData || 'retry', code: 'META_CONFIGURATION_MISSING', request_id: requestId });
  }

  const messageType = safeString(payload?.message_type || 'text', 40).toLowerCase();
  const body = safeString(payload?.body, 4096);
  const to = destination.replace(/[^0-9]/g, '');
  const supportedType = ['text','interactive_menu','interactive_specials_menu','interactive_flow'].includes(messageType);
  const validInteractiveBody = !['interactive_menu','interactive_specials_menu','interactive_flow'].includes(messageType) || body.trim().length <= 1024;
  const flowKind = safeString(payload?.flow_kind, 20).toLowerCase();
  const flowId = safeString(payload?.flow_id, 100);
  const flowScreen = safeString(payload?.flow_screen, 100);
  const flowToken = safeString(payload?.flow_token, 300);
  const expectedFlowId = flowKind === 'shop' ? '1756566568719813' : flowKind === 'driver' ? '2604256086674509' : '';
  const validFlow = messageType !== 'interactive_flow' || (
    ['shop','driver'].includes(flowKind)
    && flowId === expectedFlowId
    && flowScreen === (flowKind === 'shop' ? 'SHOP_APPLICATION' : 'DRIVER_APPLICATION')
    && new RegExp(`^getit:${flowKind}:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, 'i').test(flowToken)
  );
  if (!supportedType || !body.trim() || !validInteractiveBody || !validFlow || !/^[1-9][0-9]{7,14}$/.test(to)) {
    const code = !supportedType || !body.trim() || !validInteractiveBody || !validFlow ? 'UNSUPPORTED_OUTBOUND_MESSAGE' : 'INVALID_DESTINATION';
    const detail = code === 'UNSUPPORTED_OUTBOUND_MESSAGE'
      ? `Only non-empty text, an allowlisted Getit menu, or a configured Getit partner Flow are enabled. Received ${messageType || 'unknown'}.`
      : 'Outbound WhatsApp destination is not a valid international number.';
    const { data: finishData } = await supabase.rpc('finish_outbox_message', {
      p_outbox_id: outboxId, p_lock_token: lockToken, p_outcome: 'dead_letter', p_provider_message_id: null,
      p_retry_after_seconds: 0, p_http_status: null, p_error_code: code, p_error_detail: detail,
      p_safe_response_meta: { request_id: requestId, message_type: messageType },
    });
    return reply(422, { ok: false, outcome: finishData || 'dead_letter', code, request_id: requestId });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let httpStatus: number | null = null;
  try {
    const graphBody = messageType === 'interactive_menu'
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive: {
            type: 'list',
            body: { text: body.trim() },
            footer: { text: 'You want it. Just Getit.' },
            action: {
              button: 'Choose an option',
              sections: [{
                title: 'How can Getit help?',
                rows: [
                  { id: 'getit_order_groceries', title: 'Shop for groceries', description: 'Tell Getit what you need delivered' },
                  { id: 'getit_browse_specials', title: 'Browse specials', description: 'Browse categories or search a product' },
                  { id: 'getit_register_shop', title: 'Register my shop', description: 'Apply to list your Villiers shop' },
                  { id: 'getit_become_driver', title: 'Become a driver', description: 'Apply with your own working motorbike' },
                ],
              }],
            },
          },
        }
      : messageType === 'interactive_specials_menu'
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive: {
            type: 'list',
            header: { type: 'text', text: 'Getit specials' },
            body: { text: body.trim() },
            footer: { text: 'Prices shown are checked again when ordering.' },
            action: {
              button: 'Browse specials',
              sections: [{
                title: 'Find a special',
                rows: [
                  { id: 'getit_specials_search', title: 'Search a product', description: 'Type milk, bread, chicken or anything else' },
                  { id: 'getit_specials_milk', title: 'Milk & dairy', description: 'Milk, yoghurt, cheese and dairy' },
                  { id: 'getit_specials_bakery', title: 'Bread & bakery', description: 'Bread, rolls and bakery items' },
                  { id: 'getit_specials_meat', title: 'Meat & protein', description: 'Chicken, meat, eggs and frozen protein' },
                  { id: 'getit_specials_drinks', title: 'Drinks & snacks', description: 'Cold drinks, juice, treats and snacks' },
                  { id: 'getit_specials_household', title: 'Household', description: 'Cleaning and home essentials' },
                ],
              }],
            },
          },
        }
      : messageType === 'interactive_flow'
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'interactive',
          interactive: {
            type: 'flow',
            header: { type: 'text', text: 'Getit' },
            body: { text: body.trim() },
            footer: { text: 'You want it. Just Getit.' },
            action: {
              name: 'flow',
              parameters: {
                flow_message_version: '3',
                flow_action: 'navigate',
                flow_token: flowToken,
                flow_id: flowId,
                flow_cta: flowKind === 'shop' ? 'Open shop form' : 'Open driver form',
                flow_action_payload: { screen: flowScreen },
              },
            },
          },
        }
      : { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } };
    const graphResponse = await fetch(`https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(graphBody),
      signal: controller.signal,
    });
    httpStatus = graphResponse.status;
    const rawText = await graphResponse.text();
    let providerResponse: any = {};
    try { providerResponse = rawText ? JSON.parse(rawText) : {}; } catch { providerResponse = { non_json_response: rawText.slice(0, 500) }; }

    const providerMessageId = safeString(providerResponse?.messages?.[0]?.id, 500) || null;
    if (graphResponse.ok && providerMessageId) {
      const { data: finishData, error: finishError } = await supabase.rpc('finish_outbox_message', {
        p_outbox_id: outboxId, p_lock_token: lockToken, p_outcome: 'sent', p_provider_message_id: providerMessageId,
        p_retry_after_seconds: 0, p_http_status: httpStatus, p_error_code: null, p_error_detail: null,
        p_safe_response_meta: { request_id: requestId, provider: 'meta_whatsapp', message_type: messageType },
      });
      if (finishError) return reply(409, { ok: false, code: 'DELIVERY_RECORDED_UNCERTAIN', request_id: requestId });
      return reply(200, { ok: true, outcome: finishData || 'sent', provider_message_id: providerMessageId, request_id: requestId });
    }

    const providerCode = safeString(providerResponse?.error?.code != null ? String(providerResponse.error.code) : '', 100) || 'META_HTTP_ERROR';
    const providerMessage = safeString(providerResponse?.error?.message || `Meta returned HTTP ${httpStatus}`, 1500);
    const retryable = httpStatus === 429;
    const outcome = retryable ? 'retry' : 'dead_letter';
    const retryAfter = retryable ? Math.min(900, 30 * Math.pow(2, Math.min(attemptNumber - 1, 4))) : 0;
    const errorCode = retryable ? providerCode : `DELIVERY_UNCERTAIN_${providerCode}`;
    const { data: finishData } = await supabase.rpc('finish_outbox_message', {
      p_outbox_id: outboxId, p_lock_token: lockToken, p_outcome: outcome, p_provider_message_id: null,
      p_retry_after_seconds: retryAfter, p_http_status: httpStatus, p_error_code: errorCode, p_error_detail: providerMessage,
      p_safe_response_meta: { request_id: requestId, provider: 'meta_whatsapp', retryable },
    });
    return reply(retryable ? 503 : 422, { ok: false, outcome: finishData || outcome, code: errorCode, request_id: requestId });
  } catch (error) {
    const isTimeout = error instanceof DOMException && error.name === 'AbortError';
    const code = isTimeout ? 'DELIVERY_UNCERTAIN_META_TIMEOUT' : 'DELIVERY_UNCERTAIN_META_NETWORK_ERROR';
    const detail = isTimeout ? 'Meta WhatsApp request timed out; delivery outcome is uncertain and automatic resend is blocked.' : safeString(error instanceof Error ? error.message : String(error), 1500);
    const { data: finishData } = await supabase.rpc('finish_outbox_message', {
      p_outbox_id: outboxId, p_lock_token: lockToken, p_outcome: 'dead_letter', p_provider_message_id: null,
      p_retry_after_seconds: 0, p_http_status: httpStatus, p_error_code: code, p_error_detail: detail,
      p_safe_response_meta: { request_id: requestId, provider: 'meta_whatsapp', delivery_uncertain: true },
    });
    return reply(503, { ok: false, outcome: finishData || 'dead_letter', code, request_id: requestId });
  } finally { clearTimeout(timeout); }
});
