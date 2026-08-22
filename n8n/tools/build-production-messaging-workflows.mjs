import fs from 'node:fs';
import path from 'node:path';

const outputDirectory = process.argv[2];
if (!outputDirectory) throw new Error('Output directory is required.');

const SUPABASE_RPC = 'https://uoqgbaqffmxdnenxfdjr.supabase.co/rest/v1/rpc';
const EDGE_BASE = 'https://uoqgbaqffmxdnenxfdjr.supabase.co/functions/v1';
const apiKeyCredential = {
  httpHeaderAuth: { id: 'q4ozFODidcOtHk7Y', name: 'Getit Supabase Secret Key' },
};

const makeId = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  parameters,
  id: makeId(name),
  name,
  type,
  typeVersion,
  position,
  ...extra,
});
const schedule = (name, position, seconds = 1) => node(
  name,
  'n8n-nodes-base.scheduleTrigger',
  1.3,
  position,
  { rule: { interval: [{ field: 'seconds', secondsInterval: seconds }] } },
);
const manual = (name, position) => node(name, 'n8n-nodes-base.manualTrigger', 1, position, {});
const code = (name, position, jsCode) => node(
  name,
  'n8n-nodes-base.code',
  2,
  position,
  { mode: 'runOnceForAllItems', language: 'javaScript', jsCode },
);
const http = (name, position, url, jsonBody, credentials = apiKeyCredential, extra = {}) => {
  const hasCredentials = Object.keys(credentials ?? {}).length > 0;
  return node(
    name,
    'n8n-nodes-base.httpRequest',
    4.4,
    position,
    {
    method: 'POST',
    url,
    authentication: hasCredentials ? 'genericCredentialType' : 'none',
    ...(hasCredentials ? { genericAuthType: 'httpHeaderAuth' } : {}),
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody,
    options: {
      timeout: extra.timeout ?? 15000,
      response: {
        response: {
          fullResponse: false,
          neverError: Boolean(extra.neverError),
          responseFormat: extra.responseFormat ?? 'json',
          ...(extra.outputPropertyName ? { outputPropertyName: extra.outputPropertyName } : {}),
        },
      },
    },
  },
    {
    ...(hasCredentials ? { credentials } : {}),
    retryOnFail: extra.retryOnFail ?? true,
    maxTries: extra.maxTries ?? 3,
    waitBetweenTries: extra.waitBetweenTries ?? 1500,
    ...(extra.onError ? { onError: extra.onError } : {}),
    },
  );
};
const switchNode = (name, position, rules) => node(
  name,
  'n8n-nodes-base.switch',
  3.4,
  position,
  {
    rules: {
      values: rules.map(([leftValue, rightValue, outputKey]) => ({
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
          conditions: [{ leftValue, rightValue, operator: { type: 'string', operation: 'equals' } }],
          combinator: 'and',
        },
        renameOutput: true,
        outputKey,
      })),
    },
    options: { fallbackOutput: 'extra', renameFallbackOutput: 'Fallback' },
  },
);
const ifNode = (name, position, leftValue) => node(
  name,
  'n8n-nodes-base.if',
  2.3,
  position,
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [{ leftValue, rightValue: true, operator: { type: 'boolean', operation: 'true' } }],
      combinator: 'and',
    },
    options: {},
  },
);
const connections = (...edges) => {
  const result = {};
  for (const [from, output, to] of edges) {
    result[from] ??= { main: [] };
    while (result[from].main.length <= output) result[from].main.push([]);
    result[from].main[output].push({ node: to, type: 'main', index: 0 });
  }
  return result;
};
const workflow = (id, name, nodes, workflowConnections, meta) => ({
  id,
  name,
  active: true,
  nodes,
  connections: workflowConnections,
  settings: {
    executionOrder: 'v1',
    executionTimeout: 120,
    saveManualExecutions: true,
    availableInMCP: false,
  },
  pinData: {},
  staticData: null,
  meta,
  tags: [],
});

const normalizeMetaCode = String.raw`
const events = $input.all().flatMap((item) => Array.isArray(item.json) ? item.json : [item.json]);
const quarantine = (event, code, detail) => ({
  kind: 'quarantine', eventId: event.event_id, eventKey: event.event_key,
  lockToken: event.lock_token, errorCode: code, errorDetail: detail,
});
const messageBody = (message, normalized) => {
  if (typeof normalized?.body === 'string') return normalized.body;
  if (message?.type === 'interactive') {
    if (message.interactive?.type === 'nfm_reply') return message.interactive?.nfm_reply?.body || 'Submitted a Getit form';
    return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || null;
  }
  if (message?.type === 'button') return message.button?.text || null;
  if (message?.type === 'location') {
    const lat = Number(message.location?.latitude);
    const lng = Number(message.location?.longitude);
    return Number.isFinite(lat) && Number.isFinite(lng) ? 'Location pin: ' + lat + ', ' + lng : null;
  }
  if (message?.type === 'reaction') return message.reaction?.emoji || null;
  if (message?.type === 'image') return message.image?.caption || null;
  if (message?.type === 'document') return message.document?.caption || message.document?.filename || null;
  return null;
};
return events.filter((event) => event?.event_id).map((event) => {
  if (event.provider !== 'meta_whatsapp' || event.channel !== 'whatsapp') {
    return { json: quarantine(event, 'UNSUPPORTED_PROVIDER', 'Only Meta WhatsApp receipts are accepted by this worker.') };
  }
  if (event.event_type === 'message.received') {
    const normalized = event.payload?.normalized;
    const message = normalized?.message;
    if (!normalized?.externalContactKey || !normalized?.providerMessageId || !message) {
      return { json: quarantine(event, 'INVALID_INBOUND_MESSAGE', 'The persisted Meta message is missing its canonical identity.') };
    }
    return { json: {
      kind: 'inbound_message', eventId: event.event_id, eventKey: event.event_key,
      lockToken: event.lock_token, attemptNumber: event.attempt_number,
      provider: 'meta_whatsapp', channel: 'whatsapp',
      externalContactKey: String(normalized.externalContactKey),
      externalConversationKey: normalized.externalConversationKey ? String(normalized.externalConversationKey) : null,
      providerMessageId: String(normalized.providerMessageId),
      messageType: String(normalized.messageType || message.type || 'unknown').toLowerCase(),
      body: messageBody(message, normalized), profileName: normalized.profileName || null,
      interactiveReplyId: message?.interactive?.button_reply?.id || message?.interactive?.list_reply?.id || message?.button?.payload || null,
      providerTimestamp: normalized.providerTimestamp || null,
      payload: { metadata: { phone_number_id: normalized.phoneNumberId || null, display_phone_number: normalized.displayPhoneNumber || null }, message },
    } };
  }
  if (String(event.event_type).startsWith('message.status.')) {
    const status = event.payload?.status;
    if (!status?.id || !status?.status) return { json: quarantine(event, 'INVALID_STATUS_EVENT', 'The Meta status receipt is incomplete.') };
    return { json: {
      kind: 'message_status', eventId: event.event_id, eventKey: event.event_key,
      lockToken: event.lock_token, attemptNumber: event.attempt_number,
      provider: 'meta_whatsapp', providerMessageId: String(status.id),
      status: String(status.status).toLowerCase(), providerTimestamp: status.timestamp || null,
      errors: Array.isArray(status.errors) ? status.errors : [], payload: status,
    } };
  }
  return { json: quarantine(event, 'META_EVENT_REQUIRES_REVIEW', 'No automatic handler for ' + event.event_type + '.') };
});`;

const attachConversationCode = String.raw`
const source = $('Normalize Meta Events').item.json;
const raw = $input.first().json.conversation_id_raw;
let id; try { id = JSON.parse(raw); } catch { id = raw; }
if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('Supabase returned an invalid conversation ID.');
return [{ json: { ...source, conversationId: String(id) } }];`;

const attachMessageCode = String.raw`
const source = $('Attach Conversation').item.json;
const raw = $input.first().json.message_id_raw;
const messageId = Number(String(raw).replace(/"/g, ''));
if (!Number.isSafeInteger(messageId) || messageId < 1) throw new Error('Supabase returned an invalid message ID.');
return [{ json: { ...source, messageId } }];`;

const attachPartnerApplicationCode = String.raw`
const source = $('Attach Message').item.json;
const result = $input.first().json;
return [{ json: { ...source, partnerResult: result && typeof result === 'object' ? result : { handled: false } } }];`;

const buildSafetyDecisionCode = String.raw`
const source = $('Attach Partner Application').item.json;
const context = $('Fetch Messaging Context').item.json;
const grounding = $input.first().json && typeof $input.first().json === 'object' ? $input.first().json : {};
context.grounding = grounding;
const text = String(source.body || '').trim();
const lower = text.toLowerCase();
const mode = context?.conversation?.mode || 'dry_run';
const draft = context?.order_draft || { state: { stage: 'idle', orders: [] }, version: 0 };
const recent = Array.isArray(context?.recent_messages) ? context.recent_messages : [];
const catalogueCurrent = Number(grounding?.catalogue?.active_public_rows || 0) > 0;
const cataloguePriceCurrent = grounding?.catalogue?.current_price_quote_allowed === true;
const groundedSpecials = (Array.isArray(grounding?.matches) ? grounding.matches : [])
  .filter((item) => item?.price_verified === true && item?.reference_only === false && item?.price_kind === 'special' && Number.isFinite(Number(item?.effective_price)))
  .slice(0, 6);
const specialCategoryIds = {
  getit_specials_milk: 'Milk & dairy',
  getit_specials_bakery: 'Bread & bakery',
  getit_specials_meat: 'Meat & protein',
  getit_specials_drinks: 'Drinks & snacks',
  getit_specials_household: 'Household',
};
const moneyText = (value) => {
  const amount = Number(value);
  return 'R' + (Number.isInteger(amount) ? String(amount) : amount.toFixed(2));
};
const villiersCentre = { latitude: -27.029719, longitude: 28.600826 };
const villiersDeliveryRadiusKm = 12;
const distanceKm = (latitude1, longitude1, latitude2, longitude2) => {
  const radians = (degrees) => Number(degrees) * Math.PI / 180;
  const deltaLatitude = radians(latitude2 - latitude1);
  const deltaLongitude = radians(longitude2 - longitude1);
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitude1)) * Math.cos(radians(latitude2)) * Math.sin(deltaLongitude / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
const locationLatitude = Number(source.payload?.message?.location?.latitude);
const locationLongitude = Number(source.payload?.message?.location?.longitude);
const hasLocationCoordinates = source.messageType === 'location'
  && Number.isFinite(locationLatitude)
  && Number.isFinite(locationLongitude);
const locationCoordinatesInvalid = source.messageType === 'location'
  && (!hasLocationCoordinates || locationLatitude < -90 || locationLatitude > 90 || locationLongitude < -180 || locationLongitude > 180);
const locationOutsideVilliers = hasLocationCoordinates
  && distanceKm(villiersCentre.latitude, villiersCentre.longitude, locationLatitude, locationLongitude) > villiersDeliveryRadiusKm;
const specialsText = (heading) => {
  if (!groundedSpecials.length) return null;
  const lines = groundedSpecials.map((item) => '- ' + String(item.product_name || 'Special')
    + (item.size ? ' (' + String(item.size) + ')' : '')
    + ' - ' + moneyText(item.effective_price)
    + ' at ' + String(item.shop_name || 'Villiers shop'));
  const validThrough = groundedSpecials.find((item) => item.price_valid_through)?.price_valid_through;
  const dateText = validThrough
    ? new Date(String(validThrough) + 'T12:00:00Z').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : null;
  return heading + '\n\n' + lines.join('\n')
    + (dateText ? '\n\nPrices approved through ' + dateText + '.' : '')
    + ' Stock still needs confirmation from the shop. Type another product to search.';
};
const pureGreeting = /^(hi|hello|hey|hallo|good (morning|afternoon|evening))(\s+(there|getit))?[\s.!?,]*$/i.test(text);
const recipeWords = /\b(recipe|recipes|cook|cooking|meal idea|dinner idea|lunch idea|breakfast idea|what (?:can|should|are) (?:i|we) (?:make|cook)|what are we making|ingredients for)\b/i;
const explicitOrderWords = /\b(place|start|make) (?:an? )?order\b|\b(order|buy|purchase|add)\b|\b(?:please|pls)\s+ad(?:d)?\b|\bad\s+\d+\s+(?:bottles?|cans?|tins?|packs?|loaf|loaves|bars?|units?|items?)\b|\b(get|bring|deliver) me\b|\b(i need|i want|i'd like|i would like|please get|can you get|shopping list)\b/i;
const priorFoodConversation = recent.slice(-8).some((message) => recipeWords.test(String(message?.body || '')));
const explicitOrderIntent = explicitOrderWords.test(text);
const activeDraft = ['collecting','awaiting_confirmation'].includes(String(draft?.state?.stage || ''));
const typedVilliersAddress = activeDraft
  && source.messageType === 'text'
  && /\bvilliers\b/i.test(text)
  && (/\d/.test(text) || /\b(street|st|road|rd|avenue|ave|lane|ln|drive|dr|place|farm|plot|house)\b/i.test(text));
const recipeSpecialComparison = priorFoodConversation
  && /\b(specials?|on special|promotions?|deals?)\b/i.test(text)
  && /\b(recipe|ingredients|them|those|these|everything)\b/i.test(text);
const recipeHelp = !explicitOrderIntent && !recipeSpecialComparison && !typedVilliersAddress
  && (recipeWords.test(text) || (priorFoodConversation && !activeDraft));
const orderButton = source.interactiveReplyId === 'getit_order_groceries' || /^order groceries$/i.test(text);
const latestOutbound = [...recent].reverse().find((message) => message?.direction === 'outbound');
const latestVisibleList = [...recent].reverse().find((message) => {
  if (message?.direction !== 'outbound') return false;
  return String(message?.body || '').split(/\r?\n/).some((line) => /^\s*[-\u2022]\s+\S/.test(line));
});
const referentialOrder = explicitOrderIntent && (
  /\b(them|those|these|the items|all(?: of)? (?:them|it)|everything|ingredien\w*|same)\b/i.test(text)
  || (Boolean(latestVisibleList) && /\b(order|buy|get)\b[^.!?]{0,35}\b(for me|please)\b/i.test(text))
);
const explicitOrderPrompt = /what would you like to order|what do you need from the shop|send (?:me )?your shopping list/i.test(String(latestOutbound?.body || ''));
const allowDraftMutation = !recipeHelp && (activeDraft || orderButton || explicitOrderIntent || explicitOrderPrompt);
const knownOutsideArea = /\b(cape town|johannesburg|joburg|pretoria|durban|bloemfontein|soweto|polokwane|mbombela|nelspruit|kimberley|gqeberha|port elizabeth|east london|george|stellenbosch|paarl|middelburg|bethlehem|frankfort|heidelberg|vanderbijlpark|vereeniging)\b/i.test(text);
// A saved customer address is useful operator context, but never counts as
// confirmation for a new WhatsApp order. The customer must provide or confirm
// the destination in the active draft.
const customerHasConfirmedVilliersAddress = false;
const locationAnswerNeedsTownCheck = !customerHasConfirmedVilliersAddress
  && source.messageType === 'text'
  && !explicitOrderIntent
  && /where should i (?:drop|deliver)|delivery (?:address|location)|send (?:a )?(?:location|pin|address)/i.test(String(latestOutbound?.body || ''))
  && !/\bvilliers\b/i.test(text)
  && !knownOutsideArea;
const final = (decision, reasonCode, responseBody = null, extra = {}) => {
  const { safetyFlags: extraSafetyFlags = {}, ...extraFields } = extra;
  return {
    ...source, context, requiresModel: false, decision, reasonCode, responseBody,
    confidence: 1, schemaValid: true, factsValid: true, modelName: null,
    modelDigest: null, rawOutput: { source: 'deterministic_gate', decision, reason_code: reasonCode },
    applyDraft: false, submitDraft: false, draftState: null, responseUi: null,
    safetyFlags: {
      recipeHelp,
      allowDraftMutation,
      knownOutsideArea,
      catalogueCurrent,
      cataloguePriceCurrent,
      ...extraSafetyFlags,
    },
    ...extraFields,
  };
};
if (source.partnerResult?.handled) {
  const requiresHuman = source.partnerResult?.requires_human === true || !source.partnerResult?.response_body;
  return [{ json: final(requiresHuman ? 'human_review' : 'respond_now', source.partnerResult.reason_code || 'PARTNER_APPLICATION_HANDLED', source.partnerResult.response_body || null, {
    partnerHandled: true,
    partnerApplicationId: source.partnerResult.application_id || null,
    partnerApplicationType: source.partnerResult.application_type || null,
    partnerApplicationStatus: source.partnerResult.status || null,
    partnerFlowKind: source.partnerResult.flow_kind || null,
  }) }];
}
if (['human','paused'].includes(mode)) {
  return [{ json: final('no_response', 'HUMAN_OWNED') }];
}
if (source.messageType === 'reaction') return [{ json: final('no_response', 'REACTION_ONLY') }];
if (/\b(stop|unsubscribe|opt\s*out|do not message|moenie.*boodskap)\b/i.test(lower)) {
  return [{ json: final('no_response', 'CUSTOMER_OPT_OUT') }];
}
const cancelDraftIntent = /^(?:please\s+)?(?:cancel|delete|clear|discard)(?:\s+(?:that|this|my|the))?\s+(?:draft|order)[\s.!?]*$/i.test(text)
  || /^(?:never\s*mind|nevermind)(?:,?\s*(?:cancel|delete|clear|discard)(?:\s+(?:that|this|my|the))?\s+(?:draft|order))?[\s.!?]*$/i.test(text);
if (activeDraft && cancelDraftIntent) {
  return [{ json: final('respond_now', 'DRAFT_CANCELLED', 'Okay, I cancelled that draft. No order was submitted.', {
    applyDraft: true,
    draftState: { stage: 'cancelled', orders: [] },
  }) }];
}
const confirmationIntent = /^(?:yes(?: please)?|confirm(?:ed)?|correct|(?:that(?:['’]s| is)|this is) correct|that(?:['’]s| is) right|looks right|exactly|go ahead|ja|reg so)[\s.!?]*$/i.test(text);
if (draft?.state?.stage === 'cancelled' && confirmationIntent) {
  return [{ json: final('respond_now', 'NO_ACTIVE_DRAFT_TO_CONFIRM', 'There is no active draft to confirm. Tell me what you would like to order and I will start a new one.') }];
}
const businessRisk = /\b(refund|charged|chargeback|fraud|id number|identity number|unsafe|danger|threat|injur|emergency|medicine|prescription|alcohol|cigarette|tobacco)\b/i.test(lower);
const credentialRisk = /\b(otp|password)\b/i.test(lower) || (source.messageType !== 'location' && /\bpin\b/i.test(lower));
if (businessRisk || credentialRisk) {
  return [{ json: final('human_review', 'DETERMINISTIC_HIGH_RISK') }];
}
if (locationCoordinatesInvalid) {
  return [{ json: final('human_review', 'LOCATION_COORDINATES_INVALID') }];
}
if (locationOutsideVilliers) {
  return [{ json: final('human_review', 'OUTSIDE_VILLIERS', null, {
    safetyFlags: { recipeHelp, allowDraftMutation: false, knownOutsideArea: true },
  }) }];
}
if (hasLocationCoordinates && activeDraft) {
  const orders = JSON.parse(JSON.stringify(Array.isArray(draft?.state?.orders) ? draft.state.orders : []));
  let targetIndex = orders.findIndex((order) => !order?.delivery_address && !order?.delivery_location);
  if (targetIndex < 0 && orders.length === 1) targetIndex = 0;
  if (targetIndex >= 0) {
    orders[targetIndex] = {
      ...orders[targetIndex],
      delivery_location: { latitude: locationLatitude, longitude: locationLongitude },
    };
    const allOrdersReady = orders.length > 0 && orders.every((order) => {
      const items = Array.isArray(order?.items) ? order.items : [];
      return items.length > 0 && Boolean(order?.delivery_address || order?.delivery_location);
    });
    const draftState = {
      ...JSON.parse(JSON.stringify(draft.state)),
      stage: allOrdersReady ? 'awaiting_confirmation' : 'collecting',
      orders,
    };
    const summary = orders.flatMap((order) => (Array.isArray(order?.items) ? order.items : []))
      .map((item) => String(item?.quantity || 1) + ' x ' + String(item?.requested_text || '').trim())
      .filter(Boolean)
      .join(', ');
    const response = allOrdersReady
      ? 'Please confirm I understood your order:\n1. ' + summary + '\n\nVilliers delivery pin received. Reply YES to confirm. Current price and availability will be checked by staff before payment.'
      : 'I saved the Villiers delivery pin. What would you like to add to the order?';
    return [{ json: final('respond_now', allOrdersReady ? 'LOCATION_PIN_APPLIED_READY' : 'LOCATION_PIN_APPLIED', response, {
      applyDraft: true,
      draftState,
    }) }];
  }
}
if (typedVilliersAddress) {
  const orders = JSON.parse(JSON.stringify(Array.isArray(draft?.state?.orders) ? draft.state.orders : []));
  let targetIndex = orders.findIndex((order) => !order?.delivery_address && !order?.delivery_location);
  if (targetIndex < 0 && orders.length === 1) targetIndex = 0;
  if (targetIndex >= 0) {
    orders[targetIndex] = {
      ...orders[targetIndex],
      delivery_address: text.slice(0,500),
      delivery_location: null,
    };
    const allOrdersReady = orders.length > 0 && orders.every((order) => {
      const items = Array.isArray(order?.items) ? order.items : [];
      return items.length > 0 && Boolean(order?.delivery_address || order?.delivery_location);
    });
    const draftState = {
      ...JSON.parse(JSON.stringify(draft.state)),
      stage: allOrdersReady ? 'awaiting_confirmation' : 'collecting',
      orders,
    };
    const summary = orders.flatMap((order) => (Array.isArray(order?.items) ? order.items : []))
      .map((item) => String(item?.quantity || 1) + ' x ' + String(item?.requested_text || '').trim())
      .filter(Boolean)
      .join(', ');
    const response = allOrdersReady
      ? 'Please confirm I understood your order:\n1. ' + summary + ' - delivery: ' + text.slice(0,500) + '\n\nReply YES to confirm. Current price and availability will be checked by staff before payment.'
      : 'I saved the Villiers delivery address. What would you like to add to the order?';
    return [{ json: final('respond_now', allOrdersReady ? 'TYPED_VILLIERS_ADDRESS_APPLIED_READY' : 'TYPED_VILLIERS_ADDRESS_APPLIED', response, {
      applyDraft: true,
      draftState,
    }) }];
  }
}
if (knownOutsideArea) {
  return [{ json: final('human_review', 'OUTSIDE_VILLIERS', null, {
    safetyFlags: { recipeHelp, allowDraftMutation: false, knownOutsideArea: true },
  }) }];
}
if (!['text','button','interactive','location'].includes(source.messageType)) {
  return [{ json: final('human_review', 'UNSUPPORTED_MESSAGE_TYPE') }];
}
if (draft?.state?.stage === 'awaiting_confirmation' && /^(?:yes(?: please)?|confirm(?:ed)?|correct|(?:that(?:['’]s| is)|this is) correct|that(?:['’]s| is) right|looks right|exactly|go ahead|ja|reg so)[\s.!?]*$/i.test(text)) {
  if (mode !== 'automation') {
    return [{ json: final('human_review', 'DRY_RUN_DRAFT_CONFIRMATION') }];
  }
  return [{ json: final('respond_now', 'ORDER_DRAFT_CONFIRMED', 'Thanks. Your order has been sent for staff payment review. We will confirm current pricing and availability before payment.', { submitDraft: true }) }];
}
if (source.interactiveReplyId === 'getit_browse_specials') {
  const reply = cataloguePriceCurrent
    ? 'Browse this week\'s Villiers specials by category, or choose product search and type exactly what you need.'
    : 'The Villiers specials need refreshing. You can still search for an item and I will mark its price and stock for checking.';
  return [{ json: final('respond_now', 'OPEN_SPECIALS_BROWSER', reply, { responseUi: 'specials_menu' }) }];
}
if (source.interactiveReplyId === 'getit_specials_search') {
  return [{ json: final('respond_now', 'SPECIALS_PRODUCT_SEARCH', 'What product would you like to find on special? For example: milk, bread or chicken.') }];
}
if (specialCategoryIds[source.interactiveReplyId]) {
  const heading = specialCategoryIds[source.interactiveReplyId] + ' specials';
  const reply = cataloguePriceCurrent && specialsText(heading);
  return [{ json: final('respond_now', reply ? 'GROUNDED_SPECIALS_CATEGORY' : 'SPECIALS_CATEGORY_EMPTY', reply || ('I could not find a current ' + heading.toLowerCase() + ' match. Type a product name and I will search the approved Villiers specials.')) }];
}
if (recipeSpecialComparison) {
  const recipeMessage = [...recent].reverse().find((message) => message?.direction === 'outbound' && /ingredients:/i.test(String(message?.body || '')));
  const recipeBody = String(recipeMessage?.body || '');
  const ingredientSection = (recipeBody.match(/ingredients:\s*([\s\S]*?)(?=\n\s*(?:method|steps|instructions)\s*:)/i) || [])[1] || '';
  const ingredientLines = ingredientSection.split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-\u2022]\s+/, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
    .slice(0,16);
  const stopTokens = new Set(['with','from','into','about','taste','optional','using','regular','assorted','sauce','tomato','peeled','cubed','sliced','thickly','grease','dish','sugar']);
  const tokensFor = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').split(/\s+/)
    .filter((token) => token.length >= 4 && !stopTokens.has(token) && !/^\d/.test(token));
  const candidates = (Array.isArray(grounding?.matches) ? grounding.matches : [])
    .filter((item) => item?.price_kind === 'special' && item?.price_verified === true && item?.reference_only === false && Number.isFinite(Number(item?.effective_price)));
  const selected = [];
  for (const ingredient of ingredientLines) {
    const ingredientTokens = new Set(tokensFor(ingredient));
    const ranked = candidates.map((item) => {
      const productTokens = tokensFor([item?.product_name,item?.brand,item?.size].filter(Boolean).join(' '));
      const overlap = productTokens.filter((token) => ingredientTokens.has(token));
      return { item, score: overlap.length };
    }).filter((entry) => entry.score > 0)
      .sort((a,b) => b.score - a.score || Number(a.item.effective_price) - Number(b.item.effective_price));
    if (ranked[0]) selected.push(ranked[0].item);
  }
  const unique = [...new Map(selected.map((item) => [String(item.product_id || item.product_name) + ':' + String(item.shop_id || item.shop_name), item])).values()].slice(0,8);
  if (!unique.length) {
    return [{ json: final('respond_now', 'NO_GROUNDED_RECIPE_SPECIALS', 'I could not find a current special that directly matches those recipe ingredients. I can still prepare the ingredient order with prices and stock marked for staff checking.', { safetyFlags: { recipeHelp:false, recipeSpecialComparison:true, allowDraftMutation:false, catalogueCurrent, cataloguePriceCurrent } }) }];
  }
  const lines = unique.map((item) => '- ' + String(item.product_name || 'Item')
    + (item.size ? ' (' + String(item.size) + ')' : '')
    + ' - ' + moneyText(item.effective_price)
    + ' at ' + String(item.shop_name || 'Villiers shop'));
  const validThrough = unique.find((item) => item.price_valid_through)?.price_valid_through;
  const dateText = validThrough ? new Date(String(validThrough) + 'T12:00:00Z').toLocaleDateString('en-ZA', { day:'numeric', month:'short', timeZone:'UTC' }) : null;
  const response = 'These specials directly match ingredients from that recipe:\n\n' + lines.join('\n')
    + (dateText ? '\n\nPrices approved through ' + dateText + '.' : '')
    + ' Stock still needs confirmation from the shop. Reply ORDER THESE and I will keep this exact list together.';
  return [{ json: final('respond_now', 'GROUNDED_RECIPE_SPECIALS', response, { safetyFlags: { recipeHelp:false, recipeSpecialComparison:true, allowDraftMutation:false, catalogueCurrent, cataloguePriceCurrent } }) }];
}
if (allowDraftMutation && referentialOrder) {
  const latestList = latestVisibleList;
  const parsedItems = latestList
    ? String(latestList.body || '').split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^\s*[-\u2022]\s+(.+?)\s*$/);
        if (!match) return [];
        const original = match[1].replace(/\*\*/g, '').trim();
        const shopMatch = original.match(/\s+-\s+R\s?\d+(?:\.\d{1,2})?\s+at\s+(.+)$/i);
        let requestedText = original.replace(/\s+-\s+R\s?\d+(?:\.\d{1,2})?\s+at\s+.+$/i, '').trim();
        let quantity = 1;
        const quantityMatch = requestedText.match(/^(\d+)\s+(cans?|tins?|bottles?|packs?|loaf|loaves|bars?|units?|items?)\s+(.+)$/i);
        if (quantityMatch) {
          quantity = Number(quantityMatch[1]);
          requestedText = quantityMatch[3].trim();
        }
        return requestedText ? [{
          requested_text: requestedText.slice(0,500),
          quantity,
          requested_shop_name: shopMatch ? shopMatch[1].trim().slice(0,200) : null,
          substitution_allowed: false,
        }] : [];
      })
    : [];
  if (parsedItems.length > 0) {
    const existingOrder = Array.isArray(draft?.state?.orders) && draft.state.orders[0] ? draft.state.orders[0] : {};
    const existingItems = Array.isArray(existingOrder?.items) ? existingOrder.items : [];
    const itemMap = new Map();
    for (const item of [...existingItems, ...parsedItems]) {
      const key = String(item?.requested_text || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      if (key) itemMap.set(key, item);
    }
    const items = [...itemMap.values()];
    const units = items.reduce((sum,item) => sum + Number(item?.quantity || 1), 0);
    const shopNames = [...new Set([
      ...(Array.isArray(existingOrder?.shop_names) ? existingOrder.shop_names : []),
      ...items.map((item) => item?.requested_shop_name).filter(Boolean),
    ])].slice(0,4);
    if (items.some((item) => !Number.isSafeInteger(Number(item?.quantity)) || Number(item?.quantity) < 1)) {
      return [{ json: final('respond_now', 'REFERENCED_LIST_INVALID_QUANTITY', 'Each item needs a whole-number quantity between 1 and 24. Which quantity should I use?') }];
    }
    if (items.length > 16) return [{ json: final('respond_now', 'REFERENCED_LIST_OVER_ITEM_LIMIT', 'That list has more than 16 item lines. Which items should I leave out?') }];
    if (units > 24) return [{ json: final('respond_now', 'REFERENCED_LIST_OVER_UNIT_LIMIT', 'That list has more than 24 units. Which quantities should I reduce?') }];
    if (shopNames.length > 3) return [{ json: final('respond_now', 'REFERENCED_LIST_OVER_SHOP_LIMIT', 'That list uses more than three shops. Which shops should I use?') }];
    // Never silently import a customer-profile address into a new order. Only
    // an address already present in this active draft may be retained.
    const deliveryAddress = String(existingOrder?.delivery_address || '').trim() || null;
    const deliveryLocation = existingOrder?.delivery_location || null;
    const ready = Boolean(deliveryAddress || deliveryLocation);
    const draftState = {
      stage: ready ? 'awaiting_confirmation' : 'collecting',
      orders: [{
        label: existingOrder?.label || null,
        items,
        shop_names: shopNames,
        delivery_address: deliveryAddress,
        delivery_location: deliveryLocation,
        substitution_preference: existingOrder?.substitution_preference || null,
        requested_window: existingOrder?.requested_window || null,
        notes: String(existingOrder?.notes || ''),
      }],
    };
    const summary = items.map((item) => String(item.quantity || 1) + ' x ' + String(item.requested_text || '').trim()).join(', ');
    const response = ready
      ? 'Please confirm I understood your order:\n1. ' + summary + '\n\nReply YES to confirm. Current price and availability will be checked by staff before payment.'
      : 'I have kept those items together. What is the Villiers delivery address or WhatsApp location pin?';
    return [{ json: final('respond_now', ready ? 'REFERENCED_VISIBLE_LIST_READY' : 'REFERENCED_VISIBLE_LIST_NEEDS_ADDRESS', response, { applyDraft: true, draftState }) }];
  }
}
const quantityWords = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const multiQuantityPattern = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:bottles?|cans?|tins?|packs?|loaf|loaves|bars?|units?|items?)\s+(.+?)(?=\s+(?:and|n|&)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:bottles?|cans?|tins?|packs?|loaf|loaves|bars?|units?|items?)\b|\s+to\s+(?:my|the)\s+(?:shopping\s+)?(?:request|list|order)\b|[.!?]*$)/gi;
const requestedShopMentions = [...text.matchAll(/\bfrom\s+((?:OK|Usave)\s+Villiers)\b/gi)];
const globalRequestedShopMatch = requestedShopMentions.length === 1
  ? text.match(/\s+from\s+((?:OK|Usave)\s+Villiers)\s*[.!?]*$/i)
  : null;
const normaliseRequestedShopName = (value) => String(value || '')
  .replace(/^ok\b/i, 'OK')
  .replace(/^usave\b/i, 'Usave');
const globalRequestedShopName = globalRequestedShopMatch
  ? normaliseRequestedShopName(globalRequestedShopMatch[1])
  : null;
const parseRequestedItemTextAndShop = (value) => {
  const original = String(value || '').trim();
  const itemShopMatch = original.match(/\s+from\s+((?:OK|Usave)\s+Villiers)\s*[.!?]*$/i);
  return {
    requestedText: original.replace(/\s+from\s+(?:OK|Usave)\s+Villiers\s*[.!?]*$/i, '').trim(),
    requestedShopName: itemShopMatch
      ? normaliseRequestedShopName(itemShopMatch[1])
      : globalRequestedShopName,
  };
};
const multiQuantityItems = [];
for (const match of text.matchAll(multiQuantityPattern)) {
  const token = String(match[1] || '').toLowerCase();
  const quantity = /^\d+$/.test(token) ? Number(token) : quantityWords[token];
  const parsedRequest = parseRequestedItemTextAndShop(String(match[2] || '').trim().replace(/^of\s+/i, ''));
  const requestedText = parsedRequest.requestedText.slice(0,500);
  if (Number.isSafeInteger(quantity) && requestedText) {
    multiQuantityItems.push({ requested_text: requestedText, quantity, requested_shop_name: parsedRequest.requestedShopName, substitution_allowed: false });
  }
}
if (allowDraftMutation && !referentialOrder && multiQuantityItems.length >= 2) {
  if (multiQuantityItems.some((item) => item.quantity < 1 || item.quantity > 24)) {
    return [{ json: final('respond_now', 'DIRECT_MULTI_QUANTITY_INVALID', 'Each item needs a whole-number quantity between 1 and 24. Which quantities should I use?') }];
  }
  const existingOrder = Array.isArray(draft?.state?.orders) && draft.state.orders[0] ? draft.state.orders[0] : {};
  const existingItems = Array.isArray(existingOrder?.items) ? existingOrder.items : [];
  const itemMap = new Map([...existingItems, ...multiQuantityItems].map((entry) => [String(entry?.requested_text || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(), entry]));
  const items = [...itemMap.values()].filter((entry) => entry?.requested_text);
  const units = items.reduce((sum, entry) => sum + Number(entry?.quantity || 1), 0);
  const shopNames = [...new Set([
    ...(Array.isArray(existingOrder?.shop_names) ? existingOrder.shop_names : []),
    ...items.map((entry) => entry?.requested_shop_name).filter(Boolean),
  ])];
  if (items.length > 16) return [{ json: final('respond_now', 'DIRECT_MULTI_OVER_LINE_LIMIT', 'That would take the order over 16 item lines. Which existing item should I remove first?') }];
  if (units > 24) return [{ json: final('respond_now', 'DIRECT_MULTI_OVER_UNIT_LIMIT', 'That would take the order over 24 physical units. Which quantities should I reduce?') }];
  if (shopNames.length > 3) return [{ json: final('respond_now', 'DIRECT_MULTI_OVER_SHOP_LIMIT', 'That order already uses three shops. Which shop should I leave out?') }];
  const deliveryAddress = String(existingOrder?.delivery_address || '').trim() || null;
  const deliveryLocation = existingOrder?.delivery_location || null;
  const ready = Boolean(deliveryAddress || deliveryLocation);
  const draftState = {
    stage: ready ? 'awaiting_confirmation' : 'collecting',
    orders: [{
      label: existingOrder?.label || null,
      items,
      shop_names: shopNames,
      delivery_address: deliveryAddress,
      delivery_location: deliveryLocation,
      substitution_preference: existingOrder?.substitution_preference || null,
      requested_window: existingOrder?.requested_window || null,
      notes: String(existingOrder?.notes || ''),
    }],
  };
  const summary = items.map((item) => String(item.quantity || 1) + ' x ' + String(item.requested_text || '').trim()).join(', ');
  const response = ready
    ? 'Please confirm I understood your order:\n1. ' + summary + '\n\nReply YES to confirm. Current price and availability will be checked by staff before payment.'
    : 'I have kept ' + summary + ' in the draft. What is the Villiers delivery address or WhatsApp location pin?';
  return [{ json: final('respond_now', ready ? 'DIRECT_MULTI_QUANTITY_ITEMS_READY' : 'DIRECT_MULTI_QUANTITY_ITEMS_NEEDS_ADDRESS', response, { applyDraft: true, draftState }) }];
}
const directQuantityItem = text.match(/\b(?:add|buy|get|order|need|want)(?:\s+me)?\s+(\d+)\s+(?:bottles?|cans?|tins?|packs?|loaf|loaves|bars?|units?|items?)\s+(.+?)(?:\s+to\s+(?:my|the)\s+(?:shopping\s+)?(?:request|list|order))?[\s.!?]*$/i);
if (allowDraftMutation && !referentialOrder && directQuantityItem) {
  const quantity = Number(directQuantityItem[1]);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return [{ json: final('respond_now', 'DIRECT_QUANTITY_INVALID', 'Please use a whole-number quantity between 1 and 24.') }];
  }
  if (quantity > 24) {
    return [{ json: final('respond_now', 'DIRECT_QUANTITY_OVER_UNIT_LIMIT', 'One order can contain at most 24 physical units. Which quantity up to 24 should I use?') }];
  }
  const parsedRequest = parseRequestedItemTextAndShop(String(directQuantityItem[2] || '').trim().replace(/^of\s+/i, ''));
  const requestedText = parsedRequest.requestedText.slice(0,500);
  if (requestedText) {
    const existingOrder = Array.isArray(draft?.state?.orders) && draft.state.orders[0] ? draft.state.orders[0] : {};
    const existingItems = Array.isArray(existingOrder?.items) ? existingOrder.items : [];
    const item = { requested_text: requestedText, quantity, requested_shop_name: parsedRequest.requestedShopName, substitution_allowed: false };
    const itemMap = new Map([...existingItems, item].map((entry) => [String(entry?.requested_text || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(), entry]));
    const items = [...itemMap.values()].filter((entry) => entry?.requested_text);
    const units = items.reduce((sum, entry) => sum + Number(entry?.quantity || 1), 0);
    const shopNames = [...new Set([
      ...(Array.isArray(existingOrder?.shop_names) ? existingOrder.shop_names : []),
      ...items.map((entry) => entry?.requested_shop_name).filter(Boolean),
    ])];
    if (items.length > 16) {
      return [{ json: final('respond_now', 'DIRECT_ITEM_OVER_LINE_LIMIT', 'That would take the order over 16 item lines. Which existing item should I remove first?') }];
    }
    if (units > 24) {
      return [{ json: final('respond_now', 'DIRECT_ITEM_OVER_UNIT_LIMIT', 'That would take the order over 24 physical units. Which quantities should I reduce?') }];
    }
    if (shopNames.length > 3) {
      return [{ json: final('respond_now', 'DIRECT_ITEM_OVER_SHOP_LIMIT', 'That order already uses three shops. Which shop should I leave out?') }];
    }
    const deliveryAddress = String(existingOrder?.delivery_address || '').trim() || null;
    const deliveryLocation = existingOrder?.delivery_location || null;
    const ready = Boolean(deliveryAddress || deliveryLocation);
    const draftState = {
      stage: ready ? 'awaiting_confirmation' : 'collecting',
      orders: [{
        label: existingOrder?.label || null,
        items,
        shop_names: shopNames,
        delivery_address: deliveryAddress,
        delivery_location: deliveryLocation,
        substitution_preference: existingOrder?.substitution_preference || null,
        requested_window: existingOrder?.requested_window || null,
        notes: String(existingOrder?.notes || ''),
      }],
    };
    const response = ready
      ? 'Please confirm I understood your order:\n1. ' + quantity + ' x ' + requestedText + '\n\nReply YES to confirm. Current price and availability will be checked by staff before payment.'
      : 'I have kept ' + quantity + ' x ' + requestedText + ' in the draft. What is the Villiers delivery address or WhatsApp location pin?';
    return [{ json: final('respond_now', ready ? 'DIRECT_QUANTITY_ITEM_READY' : 'DIRECT_QUANTITY_ITEM_NEEDS_ADDRESS', response, { applyDraft: true, draftState }) }];
  }
}
if (pureGreeting) {
  return [{ json: final('light_ack', 'GREETING_ONLY', 'Hi! How can Getit help you today?') }];
}
if (/\b(specials?|on special|promotions?|deals?)\b/i.test(lower) && !allowDraftMutation && !recipeHelp && !recipeSpecialComparison) {
  const groundedReply = cataloguePriceCurrent ? specialsText('Matching Villiers specials') : null;
  const reply = groundedReply
    || (cataloguePriceCurrent
    ? "Best depends on what you need. Browse by category or search a product to see this week's approved Villiers prices."
    : catalogueCurrent
    ? "I can look through the Villiers catalogue, but prices and stock still need checking. What product are you looking for?"
    : "I can't truthfully list current specials yet because the Villiers catalogue needs refreshing. Tell me what product you want and I'll note it for checking.");
  return [{ json: final('respond_now', groundedReply ? 'GROUNDED_SPECIALS_SEARCH' : 'SPECIALS_BROWSER_OFFERED', reply, { responseUi: groundedReply ? null : 'specials_menu' }) }];
}
if (!catalogueCurrent && /\b(do you have|have you got|is (?:there|it|this|that)|available|in stock|stock of)\b/i.test(lower)) {
  return [{ json: final('respond_now', 'CATALOGUE_AVAILABILITY_REQUIRES_REVIEW', "I can't confirm current Villiers stock because the shop catalogues need refreshing. Would you like me to note the exact item for a staff stock check?") }];
}
if (/\b(do you|does getit|can you)\s+deliver\b/i.test(lower) && /\bvilliers\b/i.test(lower)) {
  return [{ json: final('respond_now', 'VILLIERS_DELIVERY_AREA', 'Yes, Getit delivers in Villiers. What would you like to order?') }];
}
if (/^(can you help (me )?(place|make|start) an order|i (want|would like|need) to (place|make|start) an order)[?.!\s]*$/i.test(text)) {
  return [{ json: final('respond_now', 'ORDER_START', 'Of course. What would you like to order?') }];
}
if (locationAnswerNeedsTownCheck) {
  return [{ json: final('respond_now', 'VILLIERS_LOCATION_CONFIRMATION_REQUIRED', 'Is that address in Villiers? Getit is only accepting normal orders in Villiers right now.') }];
}
if (/^(thanks|thank you|thank you so much|shot|shweet|cool|okay thanks|ok thanks)[!.\s]*$/i.test(text)) {
  return [{ json: final('no_response', 'NATURAL_CONVERSATION_END') }];
}
const responseSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['respond_now','no_response','wait_for_event','light_ack','human_review'] },
    reason_code: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
    response_body: { type: ['string','null'] }, apply_draft: { type: 'boolean' },
    draft_state: { type: ['object','null'] }, submit_draft: { type: 'boolean' },
  },
  required: ['decision','reason_code','confidence','response_body','apply_draft','draft_state','submit_draft'],
};
const system = "You are Getit's structured WhatsApp assistant for Villiers. Supabase and the supplied grounding object are authoritative. The recovered Getit Ordering Agent v1.6 and Launch Rules v1.1 are binding behaviour. Be warm, clever, patient, natural and concise; match the customer's language and energy when confident; understand obvious spelling mistakes; answer the actual question; ask one useful question at a time; and never make them repeat visible information. GENERAL HELP: you may answer harmless food, cooking and recipe questions helpfully. A meal idea, dish name or recipe conversation is NOT an order. Give a useful short recipe or suggestion when asked, then optionally offer to turn its ingredients into a Getit shopping request. Do not pivot an availability or order question into an unsolicited recipe. When safety_flags.recipeSpecialComparison is true, do not repeat or rewrite the recipe: compare its visible ingredient names with grounding.matches and mention only direct ingredient matches that have price_kind=special, price_verified=true and reference_only=false; ignore every unrelated match even if it has a price. Never set apply_draft during recipe/general conversation unless safety_flags.allow_draft_mutation is true and the customer clearly asked to order. ORDER INTENT: do not create or change a draft merely because food or a product is mentioned. Only mutate a draft when safety_flags.allow_draft_mutation is true. When the customer clearly asks to add, buy, get or order an item and allow_draft_mutation is true, you MUST set apply_draft=true, preserve the exact requested item and quantity in a collecting draft, and ask for any missing address or shop detail afterward; a missing address is not a reason to skip the draft. Never silently copy customer.default_address into a new order: a saved address is operator context only and must be supplied or explicitly confirmed in the active conversation before use. Never say added, on the list, in your order, booked, submitted or confirmed unless the matching draft mutation or real submission is being persisted. For unlisted goods preserve the customer's exact wording and say price and availability are pending. CATALOGUE: catalogue matches are hints, not proof. If active_public_rows is zero, never claim Getit currently has a product, price, special or stock. You may quote an effective_price only when that exact match has price_verified=true and reference_only=false; say when an operator-approved temporary price is valid through. Never quote any price from reference_only matches. Stock is never confirmed unless stock_verified=true, even when a price is approved. SERVICE AREA: normal launch orders are Villiers only. Any outside-area request is human_review; never accept an outside address or promise delivery there. GREETING: greet only when the current message itself is a greeting; otherwise never reopen with hi/hello/welcome or the customer's name. FORMAT: plain WhatsApp text, usually 1-4 short sentences under 600 characters; no corporate filler. Never invent a price, promotion, stock, availability, ETA, payment result, order number, status, action or successful order change. Preserve the existing draft and verified customer/order facts. Keep separate orders, addresses, shops, fees, totals and statuses separate. Limits per order: 16 item lines, 24 physical units, 1-3 shops. Fees are R35 for one shop up to 16 units, R50 for one shop with 17-24 units, and R65 for two or three shops up to 24 units, but no final total while goods prices are pending. Restricted goods, safety, disputes, refunds, payment ambiguity, direct human requests, outside Villiers, or low confidence are human_review. Use respond_now/light_ack only with a useful safe response_body; no_response/wait_for_event/human_review require null response_body. Draft state is {stage,orders}; allowed stages: idle, collecting, awaiting_confirmation, cancelled. Each order may contain label, items, shop_names, delivery_address, delivery_location, substitution_preference, requested_window, notes. Each item contains requested_text, quantity, requested_shop_name, substitution_allowed. Do not add backend-owned facts. Always submit_draft=false; confirmations are deterministic. Material changes reset confirmation. When complete, set awaiting_confirmation and summarize clearly with PRICE PENDING where needed. Output only the required JSON.";
const recipeGuidance = " RECIPE EXPERIENCE: When recipe_help is true and the customer named a dish, give a genuinely useful WhatsApp recipe rather than one compressed paragraph. Keep it under 1400 characters and use this readable structure: dish title; Serves; Ingredients with dash bullets; Method with numbered steps; one practical Tip; then exactly one relevant cooking question about portions, heat level, dietary needs, available ingredients or equipment. Use affordable, commonly available South African ingredients and mention a sensible substitution when helpful, but never claim Getit or a shop has them. If the request is broad, such as what should we make for dinner, ask one focused preference question first instead of guessing. Do not append a sales or ordering question to every recipe. Only offer to turn ingredients into a shopping request after the cooking need has been answered, and never more than one question in the reply.";
const fullSystem = system.replace('Output only the required JSON.', recipeGuidance + ' Output only the required JSON.');
const safetyFlags = { recipeHelp, recipeSpecialComparison, allowDraftMutation, knownOutsideArea: false, catalogueCurrent, cataloguePriceCurrent };
const user = { current_message: { text, type: source.messageType, payload: source.payload }, safety_flags: safetyFlags, grounding, context };
return [{ json: {
  ...source, context, grounding, safetyFlags, requiresModel: true,
  ollamaRequest: {
    model: 'qwen3.5:4b', stream: false, think: false, format: responseSchema,
    keep_alive: '30m',
    options: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 1000 },
    messages: [{ role: 'system', content: fullSystem }, { role: 'user', content: JSON.stringify(user) }],
  },
} }];`;

const finalizeDeterministicCode = String.raw`
const data = $input.first().json;
return [{ json: data }];`;

const validateModelCode = String.raw`
const source = $('Build Safety Decision').item.json;
const raw = $json?.message?.content ?? $json?.response ?? '';
let parsed = null;
try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {}
const safety = source?.safetyFlags || {};
const context = source?.context || {};
const currentText = String(source?.body || '').toLowerCase();
const recentMessages = Array.isArray(context?.recent_messages) ? context.recent_messages : [];
const currentDraftOrders = Array.isArray(context?.order_draft?.state?.orders) ? context.order_draft.state.orders : [];
const currentDraftItems = currentDraftOrders.flatMap((order) => Array.isArray(order?.items) ? order.items : []);
const hasActiveDraft = ['collecting','awaiting_confirmation'].includes(String(context?.order_draft?.state?.stage || '')) && currentDraftItems.length > 0;
const normalise = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const normalisedCurrentText = normalise(currentText);
const recentVisibleText = normalise(recentMessages.slice(-10).map((message) => message?.body || '').join(' '));
const recentInboundText = normalise(recentMessages.slice(-10).filter((message) => message?.direction === 'inbound').map((message) => message?.body || '').join(' '));
const referentialOrder = /\b(them|those|these|the items|all(?: of)? (?:them|it)|everything|ingredien\w*|same)\b/i.test(currentText);
const existingItemKeys = new Set(currentDraftItems.map((item) => normalise(item?.requested_text)));
const existingAddressKeys = new Set(currentDraftOrders.map((order) => normalise(order?.delivery_address)).filter(Boolean));
const messageTokens = new Set(normalise(currentText).split(/\s+/).filter((token) => token.length >= 3));
const decisions = new Set(['respond_now','no_response','wait_for_event','light_ack','human_review']);
let valid = parsed && decisions.has(parsed.decision) && typeof parsed.reason_code === 'string' && Number.isFinite(Number(parsed.confidence));
let decision = valid ? parsed.decision : 'human_review';
let reasonCode = valid ? parsed.reason_code.slice(0,100) : 'MODEL_OUTPUT_INVALID';
let confidence = valid ? Math.max(0,Math.min(1,Number(parsed.confidence))) : 0;
let responseBody = typeof parsed?.response_body === 'string' ? parsed.response_body.trim().slice(0,12000) : null;
let applyDraft = parsed?.apply_draft === true;
let submitDraft = false;
let draftState = applyDraft && parsed?.draft_state && typeof parsed.draft_state === 'object' ? parsed.draft_state : null;
if (confidence < 0.65) { decision='human_review'; reasonCode='LOW_MODEL_CONFIDENCE'; responseBody=null; applyDraft=false; submitDraft=false; draftState=null; }
if (['no_response','wait_for_event','human_review'].includes(decision)) responseBody=null;
if (responseBody) {
  responseBody = responseBody.replace(/^(hi|hello|hey|hallo|good (morning|afternoon|evening))(\s+[A-Za-z'-]+)?[\s,!?.-]*/i, '').trim();
}
const orderSubmissionClaim = responseBody && /\b(?:order (?:is |has been )?confirmed|your order is confirmed|prices? and stock (?:are|is) final(?:ised|ized)|order (?:was |has been )?submitted|sent (?:your |the )?order)\b/i.test(responseBody);
if (orderSubmissionClaim && !submitDraft) {
  decision='respond_now';
  reasonCode='ORDER_NOT_SUBMITTED';
  responseBody='I have not submitted the order yet. Please check the draft above and reply YES to confirm. Current price and availability will still be checked before payment.';
  applyDraft=false;
  submitDraft=false;
  draftState=null;
  valid=true;
}
if (responseBody && !hasActiveDraft && !applyDraft) {
  responseBody = responseBody
    .replace(/\byour existing order\b/gi, 'a new order')
    .replace(/\byour current order\b/gi, 'a new order');
}
if (responseBody && safety.recipeHelp !== true) {
  responseBody = responseBody.replace(/(?:\r?\n\s*)*Would you like[^?]*(?:recipe|cook)[^?]*\?\s*$/i, '').trim();
}
if (safety.recipeHelp === true) {
  applyDraft=false;
  submitDraft=false;
  draftState=null;
  if (responseBody && ['respond_now','light_ack'].includes(decision)) {
    let formatted = responseBody
      .replace(/\*\*/g, '')
      .replace(/^\s*\*\s+/gm, '- ')
      .replace(/\u2022/g, '-')
      .replace(/Ingredients\s*\([^\n:]*\)\s*:/i, 'Ingredients:')
      .replace(/;\s*Serves\s*:?\s*/i, '\nServes: ')
      .replace(/;\s*Ingredients\s*:\s*/i, '\n\nIngredients:\n')
      .replace(/;\s*Method\s*:\s*/i, '\n\nMethod:\n')
      .replace(/;\s*Tip\s*:\s*/i, '\n\nTip: ')
      .replace(/;\s*(?=\r?\n|$)/g, '')
      .replace(/\r/g, '')
      .trim();
    formatted = formatted
      .replace(/(?:\r?\n\s*)*Quick question:[\s\S]*?\?\s*$/i, '')
      .replace(/\n?\s*(Would you like|Want me to|Should I)[^?]*\?\s*$/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const ingredientBlock = formatted.match(/Ingredients:\s*([\s\S]*?)\s*\n+Method:/i);
    if (ingredientBlock && !/(^|\n)\s*-\s+/.test(ingredientBlock[1])) {
      const ingredients = ingredientBlock[1].split(/,\s*/).map((item) => item.trim()).filter(Boolean);
      if (ingredients.length > 1) {
        formatted = formatted.replace(ingredientBlock[0], 'Ingredients:\n' + ingredients.map((item) => '- ' + item.replace(/[.;]+$/, '')).join('\n') + '\n\nMethod:');
      }
    }
    const methodBlock = formatted.match(/Method:\s*([\s\S]*?)(?=\n+Tip:|$)/i);
    if (methodBlock && !/(^|\n)\s*\d+\.\s+/.test(methodBlock[1])) {
      const steps = methodBlock[1].split(/\.\s+|\n+/).map((step) => step.trim()).filter(Boolean);
      if (steps.length > 1) {
        formatted = formatted.replace(methodBlock[0], 'Method:\n' + steps.map((step,index) => String(index + 1) + '. ' + step.replace(/[.;]+$/, '') + '.').join('\n'));
      }
    }
    const portionsKnown = /\b(\d+|one|two|three|four|five|six)\s+(people|persons|servings?)\b/i.test(String(source.body || ''));
    const cookingQuestion = portionsKnown
      ? 'Do you prefer it mild, spicy, creamy or lighter?'
      : 'How many people are you cooking for, and is there anything you do not eat?';
    responseBody = formatted.slice(0,1250).trimEnd() + '\n\nQuick question: ' + cookingQuestion;
  }
  if (decision === 'human_review' && responseBody) responseBody=null;
}
if (applyDraft && safety.allowDraftMutation !== true) {
  valid=false;
  decision='human_review';
  reasonCode='ORDER_INTENT_NOT_EXPLICIT';
  responseBody=null;
  applyDraft=false;
  submitDraft=false;
  draftState=null;
}
if (applyDraft) {
  const draftIssues = [];
  const sanitiseOptionalText = (value) => typeof value === 'string' && value.trim() ? value.trim().slice(0,500) : null;
  const rawOrders = Array.isArray(draftState?.orders) ? draftState.orders : [];
  draftState = {
    stage: String(draftState?.stage || 'collecting'),
    orders: rawOrders.map((order) => ({
      label: sanitiseOptionalText(order?.label),
      items: (Array.isArray(order?.items) ? order.items : []).map((item) => ({
        requested_text: String(item?.requested_text || '').trim().slice(0,500),
        quantity: Number(item?.quantity || 1),
        requested_shop_name: sanitiseOptionalText(item?.requested_shop_name),
        substitution_allowed: item?.substitution_allowed === true,
      })),
      shop_names: (Array.isArray(order?.shop_names) ? order.shop_names : []).map((shop) => String(shop || '').trim()).filter(Boolean).slice(0,3),
      delivery_address: sanitiseOptionalText(order?.delivery_address),
      delivery_location: order?.delivery_location && Number.isFinite(Number(order.delivery_location.latitude)) && Number.isFinite(Number(order.delivery_location.longitude))
        ? { latitude: Number(order.delivery_location.latitude), longitude: Number(order.delivery_location.longitude) }
        : null,
      substitution_preference: sanitiseOptionalText(order?.substitution_preference),
      requested_window: sanitiseOptionalText(order?.requested_window),
      notes: sanitiseOptionalText(order?.notes) || '',
    })),
  };
  const allowedStages = new Set(['idle','collecting','awaiting_confirmation','cancelled']);
  const orders = Array.isArray(draftState?.orders) ? draftState.orders : [];
  if (!allowedStages.has(draftState?.stage)) { valid=false; draftIssues.push('invalid_stage'); }
  if (orders.length > 5) { valid=false; draftIssues.push('too_many_orders'); }
  if (!['idle','cancelled'].includes(draftState?.stage) && orders.length < 1) { valid=false; draftIssues.push('missing_order'); }
  for (const order of orders) {
    const items = Array.isArray(order?.items) ? order.items : [];
    const units = items.reduce((sum,item)=>sum+Number(item?.quantity||1),0);
    const shops = new Set([...(Array.isArray(order?.shop_names)?order.shop_names:[]),...items.map(item=>item?.requested_shop_name).filter(Boolean)]);
    if (items.length > 16) { valid=false; draftIssues.push('too_many_item_lines'); }
    if (units > 24) { valid=false; draftIssues.push('too_many_units'); }
    if (shops.size > 3) { valid=false; draftIssues.push('too_many_shops'); }
    if (items.some(item=>!String(item?.requested_text||'').trim() || !Number.isInteger(Number(item?.quantity||1)) || Number(item?.quantity||1)<1)) { valid=false; draftIssues.push('invalid_item'); }
    for (const item of items) {
      const itemKey = normalise(item?.requested_text);
      if (existingItemKeys.has(itemKey)) continue;
      const itemTokens = itemKey.split(/\s+/).filter((token) => token.length >= 3);
      const groundedInMessage = normalisedCurrentText.includes(itemKey) || itemTokens.some((token) => messageTokens.has(token));
      const groundedByReference = referentialOrder && recentVisibleText.includes(itemKey);
      if (!groundedInMessage && !groundedByReference) { valid=false; draftIssues.push('item_not_in_visible_chat'); }
    }
    const address = normalise(order?.delivery_address);
    const addressGroundedInActiveOrder = !address
      || existingAddressKeys.has(address)
      || normalisedCurrentText.includes(address)
      || recentInboundText.includes(address);
    if (address && !addressGroundedInActiveOrder) { valid=false; draftIssues.push('unverified_address'); }
    if (address && !/\bvilliers\b/i.test(String(order?.delivery_address || '')) && !normalisedCurrentText.includes('villiers') && !recentInboundText.includes('villiers')) { valid=false; draftIssues.push('unverified_address'); }
  }
  if (source.messageType === 'location' && orders.length) {
    const latitude = Number(source.payload?.message?.location?.latitude);
    const longitude = Number(source.payload?.message?.location?.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      const target = orders.find((order) => !order?.delivery_location) || orders[0];
      target.delivery_location = { latitude, longitude };
    }
  }
  const allOrdersReady = orders.length > 0 && orders.every((order) => {
    const items = Array.isArray(order?.items) ? order.items : [];
    return items.length > 0 && (Boolean(order?.delivery_address) || Boolean(order?.delivery_location));
  });
  if (valid && allOrdersReady && draftState.stage === 'collecting') draftState.stage = 'awaiting_confirmation';
  if (!valid) {
    const issue = draftIssues[0] || 'unsafe_draft_change';
    decision='respond_now';
    reasonCode='DRAFT_CLARIFICATION_REQUIRED';
    responseBody = issue === 'too_many_item_lines'
      ? 'That order is over the 16-item-line limit. Which items should I leave out?'
      : issue === 'too_many_units'
      ? 'That order is over the 24-unit limit. Which quantities should I reduce?'
      : issue === 'too_many_shops'
      ? 'That order uses more than three shops. Which shops should I use?'
      : issue === 'unverified_address'
      ? 'I need to confirm the delivery address is in Villiers before adding it. What is the Villiers address or WhatsApp location pin?'
      : 'I could not safely tell which earlier items you meant. Please reply to the exact item list or send the item names once, and I will keep them together.';
    applyDraft=false;
    submitDraft=false;
    draftState=null;
    valid=true;
  }
}
if (valid && applyDraft && draftState?.stage === 'awaiting_confirmation' && decision === 'respond_now') {
  const orders = Array.isArray(draftState.orders) ? draftState.orders : [];
  const summary = orders.map((order,index) => {
    const items = Array.isArray(order?.items) ? order.items : [];
    const itemText = items.map((item) => String(item.quantity || 1) + ' x ' + String(item.requested_text || '').trim()).join(', ');
    const destination = order?.delivery_address ? ' - delivery: ' + String(order.delivery_address).trim() : '';
    return String(index + 1) + '. ' + itemText + destination;
  }).join('\n');
  responseBody = 'Please confirm I understood your ' + (orders.length === 1 ? 'order' : 'separate orders') + ':\n' + summary + '\n\nReply YES to confirm. Current price and availability will be checked by staff before payment.';
  reasonCode = 'ORDER_DRAFT_READY_FOR_CONFIRMATION';
}
if (['respond_now','light_ack'].includes(decision) && !responseBody) { decision='human_review'; reasonCode='MISSING_SAFE_RESPONSE'; applyDraft=false; submitDraft=false; }
const orderMutationClaim = responseBody && /\b(added|add(?:ed)? to (?:the|your) (?:list|order)|on (?:the|your) list|in your order|order now includes|booked|order confirmed)\b/i.test(responseBody);
if (orderMutationClaim && !applyDraft) {
  decision='human_review';
  reasonCode='FALSE_ORDER_MUTATION_CLAIM';
  responseBody=null;
  applyDraft=false;
  submitDraft=false;
  draftState=null;
  valid=false;
}
const deniedAvailability = responseBody && /\b(can'?t|cannot|unable to|do not|don't)\b[^.!?]{0,80}\b(confirm|verify|know|claim)\b[^.!?]{0,80}\b(available|in stock)\b/i.test(responseBody);
const riskyClaim = responseBody && (
  /(R\s?\d|fresh specials?|discounted|on special|sale price|payment (received|successful|paid)|order\s*(number|#)|deliver(?:y|ed) (by|in \d)|deliver(?:y|ed|ing)?[^.!?]{0,35}(cape town|johannesburg|joburg|pretoria|durban|bloemfontein)|I (will|'ll) (now )?(verify|check|confirm|send|process))/i.test(responseBody)
  || (!deniedAvailability && /\b(in stock|available (now|today))\b/i.test(responseBody))
);
if (riskyClaim) { decision='human_review'; reasonCode='UNVERIFIED_FACTUAL_CLAIM'; responseBody=null; applyDraft=false; submitDraft=false; draftState=null; valid=false; }
return [{ json: {
  ...source, decision, reasonCode, confidence, responseBody, applyDraft, submitDraft, draftState,
  schemaValid: Boolean(valid), factsValid: Boolean(valid && !riskyClaim), modelName: 'qwen3.5:4b',
  modelDigest: 'qwen3.5:4b-local-structured-v1-20-0-atomic-orders', rawOutput: parsed,
  responseUi: source.responseUi || null,
} }];`;

const restoreDecisionCode = String.raw`
return [{ json: $('Route Draft Action').item.json }];`;

const classifyStatusCode = String.raw`
const source = $('Normalize Meta Events').item.json;
const raw = $input.first().json.status_raw;
let result; try { result = JSON.parse(raw); } catch { result = raw; }
const processed = ['applied','duplicate','stale'].includes(result);
return [{ json: {
  ...source, finishOutcome: processed ? 'processed' : result === 'not_found' ? 'retry' : 'quarantined',
  retryAfter: result === 'not_found' ? 15 : 0,
  finishErrorCode: processed ? null : 'STATUS_' + String(result).toUpperCase(),
  finishErrorDetail: processed ? null : 'Delivery status result: ' + result,
} }];`;

const fallbackCode = String.raw`
return $input.all().map((item) => ({ json: {
  ...item.json, kind: 'quarantine', errorCode: 'UNEXPECTED_WORKFLOW_ROUTE',
  errorDetail: 'The normalized event reached an unexpected workflow route.',
} }));`;

const inboundNodes = [
  schedule('Every Second', [-1320, -80]),
  manual('Run Inbound Worker', [-1320, 140]),
  http('Claim Messaging Events', [-1080, 20], `${SUPABASE_RPC}/claim_messaging_events`, {
    p_worker_id: 'getit-production-inbound-v1-18', p_limit: 1, p_lease_seconds: 120,
  }),
  code('Normalize Meta Events', [-820, 20], normalizeMetaCode),
  switchNode('Route Event', [-560, 20], [
    ['={{ $json.kind }}','inbound_message','Inbound message'],
    ['={{ $json.kind }}','message_status','Delivery status'],
    ['={{ $json.kind }}','quarantine','Quarantine'],
  ]),
  http('Upsert Conversation', [-300, -360], `${SUPABASE_RPC}/upsert_messaging_conversation`, '={{ JSON.stringify({ p_provider: $json.provider, p_channel: $json.channel, p_external_contact_key: $json.externalContactKey, p_external_conversation_key: $json.externalConversationKey, p_customer_id: null, p_initial_mode: "dry_run" }) }}', apiKeyCredential, { responseFormat: 'text', outputPropertyName: 'conversation_id_raw' }),
  code('Attach Conversation', [-40, -360], attachConversationCode),
  http('Upsert Customer Identity', [220, -360], `${SUPABASE_RPC}/upsert_messaging_customer_identity`, '={{ JSON.stringify({ p_conversation_id: $json.conversationId, p_phone: $json.externalContactKey, p_full_name: $json.profileName, p_preferred_language: null }) }}', apiKeyCredential, { responseFormat: 'text', outputPropertyName: 'customer_id_raw' }),
  http('Persist Inbound Message', [480, -360], `${SUPABASE_RPC}/record_inbound_message`, '={{ JSON.stringify({ p_event_id: $("Attach Conversation").item.json.eventId, p_conversation_id: $("Attach Conversation").item.json.conversationId, p_idempotency_key: "in:meta_whatsapp:" + $("Attach Conversation").item.json.providerMessageId, p_provider_message_id: $("Attach Conversation").item.json.providerMessageId, p_message_type: $("Attach Conversation").item.json.messageType, p_body: $("Attach Conversation").item.json.body, p_payload: $("Attach Conversation").item.json.payload }) }}', apiKeyCredential, { responseFormat: 'text', outputPropertyName: 'message_id_raw' }),
  code('Attach Message', [740, -360], attachMessageCode),
  http('Process Partner Application', [1000, -360], `${SUPABASE_RPC}/process_partner_application_message_v4`, '={{ JSON.stringify({ p_conversation_id:$json.conversationId, p_message_id:$json.messageId, p_message_type:$json.messageType, p_body:$json.body, p_payload:$json.payload, p_interactive_reply_id:$json.interactiveReplyId }) }}'),
  code('Attach Partner Application', [1260, -360], attachPartnerApplicationCode),
  http('Fetch Messaging Context', [1520, -360], `${SUPABASE_RPC}/get_messaging_context`, '={{ JSON.stringify({ p_conversation_id: $json.conversationId, p_message_limit: 12, p_order_limit: 5 }) }}'),
  http('Fetch Messaging Grounding', [1760, -360], `${SUPABASE_RPC}/get_messaging_grounding`, '={{ JSON.stringify({ p_query: (() => { const body=String($("Attach Partner Application").item.json.body||""); if (!/\\b(recipe|ingredients|them|those|these|everything)\\b/i.test(body)) return body; const recent=Array.isArray($json.recent_messages)?$json.recent_messages:[]; const recipe=[...recent].reverse().find(m=>m?.direction==="outbound" && /ingredients:/i.test(String(m?.body||""))); const bullets=recipe?String(recipe.body||"").split(/\\r?\\n/).filter(line=>/^\\s*[-\\u2022]\\s+\\S/.test(line)).join(" "):""; return (body+" "+bullets).slice(0,3000); })(), p_limit: 12 }) }}'),
  code('Build Safety Decision', [2000, -360], buildSafetyDecisionCode),
  http('Mark Read and Show AI Typing', [1510, -360], `${EDGE_BASE}/meta-whatsapp-presence`, '={{ JSON.stringify({ message_id:$json.providerMessageId, typing_indicator:$json.requiresModel }) }}', apiKeyCredential, { timeout: 10000, neverError: true, retryOnFail: false }),
  code('Restore Safety Decision', [1750, -360], String.raw`return [{ json: $('Build Safety Decision').item.json }];`),
  ifNode('Model Required?', [1990, -360], '={{ $json.requiresModel }}'),
  http('Ask Local Structured Model', [2250, -520], 'http://host.docker.internal:11434/api/chat', '={{ JSON.stringify($json.ollamaRequest) }}', {}, { timeout: 30000, retryOnFail: true, maxTries: 2, onError: 'continueRegularOutput' }),
  code('Validate Model Decision', [2510, -520], validateModelCode),
  code('Finalize Deterministic Decision', [2250, -220], finalizeDeterministicCode),
  switchNode('Route Draft Action', [2300, -360], [
    ['={{ $json.submitDraft ? "submit" : $json.applyDraft ? "replace" : "none" }}','submit','Submit confirmed draft'],
    ['={{ $json.submitDraft ? "submit" : $json.applyDraft ? "replace" : "none" }}','replace','Replace draft'],
  ]),
  http('Submit Confirmed Draft', [2560, -540], `${SUPABASE_RPC}/confirm_and_submit_messaging_order_draft_v1`, '={{ JSON.stringify({ p_conversation_id: $("Route Draft Action").item.json.conversationId, p_expected_version: $("Route Draft Action").item.json.context.order_draft.version, p_confirmation_message_id: $("Route Draft Action").item.json.messageId }) }}'),
  http('Replace Draft State', [2560, -360], `${SUPABASE_RPC}/replace_messaging_order_draft_state`, '={{ JSON.stringify({ p_conversation_id: $("Route Draft Action").item.json.conversationId, p_expected_version: $("Route Draft Action").item.json.context.order_draft.version, p_state: $("Route Draft Action").item.json.draftState, p_source_message_id: $("Route Draft Action").item.json.messageId }) }}'),
  http('Record Final Decision', [2820, -360], `${SUPABASE_RPC}/record_messaging_decision`, '={{ (() => { const d=$("Route Draft Action").item.json; return JSON.stringify({ p_event_id:d.eventId, p_decision:d.decision, p_reason_code:d.reasonCode, p_prompt_version:"getit-production-structured-v1-20-0", p_confidence:d.confidence, p_facts:{ conversation_mode:d.context?.conversation?.mode, message_type:d.messageType, draft_updated:d.applyDraft, draft_submitted:d.submitDraft, partner_application:d.partnerHandled||false, partner_flow_kind:d.partnerFlowKind||null, response_ui:d.responseUi||null, recipe_help:d.safetyFlags?.recipeHelp===true, explicit_order_intent:d.safetyFlags?.allowDraftMutation===true, catalogue_current:d.safetyFlags?.catalogueCurrent===true, catalogue_price_current:d.safetyFlags?.cataloguePriceCurrent===true, dry_run:d.context?.conversation?.mode==="dry_run" }, p_model_name:d.modelName, p_model_digest:d.modelDigest, p_raw_output:d.rawOutput, p_schema_valid:d.schemaValid, p_facts_valid:d.factsValid, p_is_final:true }); })() }}'),
  code('Restore Recorded Decision', [3080, -360], restoreDecisionCode),
  ifNode('Queue Customer Response?', [3340, -360], '={{ ["respond_now","light_ack"].includes($json.decision) && Boolean($json.responseBody) }}'),
  http('Queue Decision Response', [3600, -500], `${SUPABASE_RPC}/queue_decision_response_v4`, '={{ JSON.stringify({ p_event_id:$json.eventId, p_idempotency_key:"decision:" + ($json.eventKey || $json.eventId) + ":v1-20", p_body:$json.responseBody, p_payload:{ origin:"getit-production-inbound-v1-20", draft_updated:$json.applyDraft, draft_submitted:$json.submitDraft, partner_application:$json.partnerHandled||false, flow_kind:$json.partnerFlowKind||null, response_ui:$json.responseUi||null, grounded:true }, p_offer_welcome_menu:true, p_max_attempts:5 }) }}'),
  http('Finish Inbound Event', [3860, -360], `${SUPABASE_RPC}/finish_messaging_event`, '={{ JSON.stringify({ p_event_id:$("Restore Recorded Decision").item.json.eventId, p_lock_token:$("Restore Recorded Decision").item.json.lockToken, p_outcome:"processed", p_retry_after_seconds:0, p_error_code:null, p_error_detail:null }) }}', apiKeyCredential, { responseFormat: 'text', outputPropertyName: 'finish_result' }),
  http('Apply Delivery Status', [-300, 20], `${SUPABASE_RPC}/apply_messaging_delivery_status`, '={{ JSON.stringify({ p_provider:$json.provider, p_provider_message_id:$json.providerMessageId, p_status:$json.status, p_provider_timestamp:$json.providerTimestamp ? new Date(Number($json.providerTimestamp)*1000).toISOString() : null, p_error_code:$json.errors?.[0]?.code ? String($json.errors[0].code) : null, p_error_detail:$json.errors?.[0]?.title || null, p_payload:$json.payload }) }}', apiKeyCredential, { responseFormat: 'text', outputPropertyName: 'status_raw' }),
  code('Classify Delivery Status', [-40, 20], classifyStatusCode),
  http('Finish Status Event', [220, 20], `${SUPABASE_RPC}/finish_messaging_event`, '={{ JSON.stringify({ p_event_id:$json.eventId, p_lock_token:$json.lockToken, p_outcome:$json.finishOutcome, p_retry_after_seconds:$json.retryAfter, p_error_code:$json.finishErrorCode, p_error_detail:$json.finishErrorDetail }) }}', apiKeyCredential, { responseFormat: 'text', outputPropertyName: 'finish_result' }),
  http('Finish Quarantined Event', [-40, 260], `${SUPABASE_RPC}/finish_messaging_event`, '={{ JSON.stringify({ p_event_id:$json.eventId, p_lock_token:$json.lockToken, p_outcome:"quarantined", p_retry_after_seconds:0, p_error_code:$json.errorCode, p_error_detail:$json.errorDetail }) }}', apiKeyCredential, { responseFormat: 'text', outputPropertyName: 'finish_result' }),
  code('Make Fallback Quarantine', [-300, 460], fallbackCode),
];

const inboundConnections = connections(
  ['Every Second',0,'Claim Messaging Events'], ['Run Inbound Worker',0,'Claim Messaging Events'],
  ['Claim Messaging Events',0,'Normalize Meta Events'], ['Normalize Meta Events',0,'Route Event'],
  ['Route Event',0,'Upsert Conversation'], ['Upsert Conversation',0,'Attach Conversation'],
  ['Attach Conversation',0,'Upsert Customer Identity'], ['Upsert Customer Identity',0,'Persist Inbound Message'],
  ['Persist Inbound Message',0,'Attach Message'], ['Attach Message',0,'Process Partner Application'],
  ['Process Partner Application',0,'Attach Partner Application'], ['Attach Partner Application',0,'Fetch Messaging Context'],
  ['Fetch Messaging Context',0,'Fetch Messaging Grounding'], ['Fetch Messaging Grounding',0,'Build Safety Decision'], ['Build Safety Decision',0,'Mark Read and Show AI Typing'],
  ['Mark Read and Show AI Typing',0,'Restore Safety Decision'], ['Restore Safety Decision',0,'Model Required?'],
  ['Model Required?',0,'Ask Local Structured Model'], ['Ask Local Structured Model',0,'Validate Model Decision'],
  ['Validate Model Decision',0,'Route Draft Action'], ['Model Required?',1,'Finalize Deterministic Decision'],
  ['Finalize Deterministic Decision',0,'Route Draft Action'],
  ['Route Draft Action',0,'Submit Confirmed Draft'], ['Submit Confirmed Draft',0,'Record Final Decision'],
  ['Route Draft Action',1,'Replace Draft State'], ['Replace Draft State',0,'Record Final Decision'],
  ['Route Draft Action',2,'Record Final Decision'], ['Record Final Decision',0,'Restore Recorded Decision'],
  ['Restore Recorded Decision',0,'Queue Customer Response?'],
  ['Queue Customer Response?',0,'Queue Decision Response'], ['Queue Decision Response',0,'Finish Inbound Event'],
  ['Queue Customer Response?',1,'Finish Inbound Event'],
  ['Route Event',1,'Apply Delivery Status'], ['Apply Delivery Status',0,'Classify Delivery Status'],
  ['Classify Delivery Status',0,'Finish Status Event'],
  ['Route Event',2,'Finish Quarantined Event'], ['Route Event',3,'Make Fallback Quarantine'],
  ['Make Fallback Quarantine',0,'Finish Quarantined Event'],
);

const outboundNodes = [
  schedule('Every Second', [-640, -80]),
  manual('Run Outbound Worker', [-640, 120]),
  http('Claim Outbox Messages', [-380, 20], `${SUPABASE_RPC}/claim_outbox_messages`, {
    p_worker_id: 'getit-production-outbound-v1-18', p_limit: 10, p_lease_seconds: 90,
  }),
  http('Dispatch Through Protected Meta Function', [-80, 20], `${EDGE_BASE}/meta-whatsapp-dispatch`, '={{ JSON.stringify({ outbox_id:$json.outbox_id, message_id:$json.message_id, conversation_id:$json.conversation_id, destination:$json.destination, idempotency_key:$json.idempotency_key, payload:$json.payload, attempt_number:$json.attempt_number, lock_token:$json.lock_token }) }}', apiKeyCredential, { timeout: 30000, neverError: true, retryOnFail: false }),
];

const outboundConnections = connections(
  ['Every Second',0,'Claim Outbox Messages'], ['Run Outbound Worker',0,'Claim Outbox Messages'],
  ['Claim Outbox Messages',0,'Dispatch Through Protected Meta Function'],
);

const inbound = workflow(
  'GETIT_MESSAGING_INBOUND_V1_14',
  '[PRODUCTION DRY-RUN SAFE] Getit Messaging Inbound v1.20',
  inboundNodes,
  inboundConnections,
  { templateCredsSetupCompleted: true, getitBoundary: 'production-persist-decide-draft-partner-queue' },
);
const outbound = workflow(
  'GETIT_MESSAGING_OUTBOUND_V1_14',
  '[PRODUCTION SAFETY-GATED] Getit Messaging Outbound v1.18',
  outboundNodes,
  outboundConnections,
  { templateCredsSetupCompleted: true, getitBoundary: 'production-claim-authorize-dispatch' },
);

fs.mkdirSync(outputDirectory, { recursive: true });
const outputs = [
  ['getit-messaging-inbound-v1.14.json', inbound],
  ['getit-messaging-outbound-v1.14.json', outbound],
];
for (const [file, data] of outputs) {
  fs.writeFileSync(path.join(outputDirectory, file), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(outputs.map(([file, data]) => ({ file, name: data.name, nodes: data.nodes.length }))));
