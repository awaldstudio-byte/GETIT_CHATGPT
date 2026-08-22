import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(here, '../workflows/getit-messaging-inbound-v1.14.json');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const deterministicOnly = process.argv.includes('--deterministic-only');

const nodeCode = (name) => {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  if (!node?.parameters?.jsCode) throw new Error(`Missing Code node: ${name}`);
  return node.parameters.jsCode;
};

const buildCode = nodeCode('Build Safety Decision');
const validateCode = nodeCode('Validate Model Decision');

const executeCode = (code, namedItems, inputJson = {}, currentJson = {}) => {
  const getNamed = (name) => {
    if (!(name in namedItems)) throw new Error(`Missing test input for node: ${name}`);
    return { item: { json: namedItems[name] } };
  };
  const input = { first: () => ({ json: inputJson }) };
  // n8n's external JavaScript task runner does not expose structuredClone.
  // Shadow it here so local tests fail if workflow code accidentally depends
  // on a host-only global that production cannot execute.
  return new Function('$', '$input', '$json', 'structuredClone', code)(getNamed, input, currentJson, undefined);
};

const grounding = {
  service_area: { launch_town: 'Villiers', normal_orders_outside_launch_town: false },
  catalogue: {
    active_public_rows: 0,
    reference_rows: 118,
    valid_through: '2026-08-10',
    status: 'expired_or_unavailable',
    current_price_or_stock_quote_allowed: false,
    requires_checkout_revalidation: true,
  },
  matches: [],
};

const baseContext = {
  conversation: { mode: 'dry_run' },
  customer: { location_confirmed: false, default_address: null },
  order_draft: { version: 0, state: { stage: 'idle', orders: [] } },
  recent_messages: [],
  recent_orders: [],
};

const source = (body, overrides = {}) => ({
  body,
  messageType: 'text',
  payload: {},
  partnerResult: { handled: false },
  ...overrides,
});

const build = (body, context = baseContext, overrides = {}, groundingInput = grounding) => executeCode(
  buildCode,
  {
    'Attach Partner Application': source(body, overrides),
    'Fetch Messaging Context': structuredClone(context),
  },
  structuredClone(groundingInput),
)[0].json;

const validate = (built, modelReply) => executeCode(
  validateCode,
  { 'Build Safety Decision': built },
  {},
  { message: { content: JSON.stringify(modelReply) } },
)[0].json;

const validateRaw = (built, raw) => executeCode(
  validateCode,
  { 'Build Safety Decision': built },
  {},
  { message: { content: raw } },
)[0].json;

const runModel = async (built) => {
  const response = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(built.ollamaRequest),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}: ${responseText.slice(0,500)}`);
  const payload = JSON.parse(responseText);
  return validate(built, JSON.parse(payload.message.content));
};
const resolveDecision = async (built) => built.requiresModel ? runModel(built) : built;

const results = [];
const record = (name, actual, checks) => {
  const failures = checks.filter(([condition]) => !condition).map(([, message]) => message);
  results.push({
    name,
    passed: failures.length === 0,
    failures,
    decision: actual.decision,
    reasonCode: actual.reasonCode,
    applyDraft: actual.applyDraft,
    responseUi: actual.responseUi || null,
    responseBody: actual.responseBody,
    rawOutput: failures.length ? actual.rawOutput : undefined,
  });
};

if (!deterministicOnly) {
  const recipeContext = {
    ...structuredClone(baseContext),
    recent_messages: [
      { direction: 'inbound', body: 'Hey girl, what are we making for dinner' },
      { direction: 'outbound', body: 'What are you craving?' },
    ],
  };
  const recipeFollowUp = await runModel(build('Some chicken wraps', recipeContext));
  record('meal discussion does not become an order', recipeFollowUp, [
    [recipeFollowUp.applyDraft === false, 'mutated a draft during meal discussion'],
    [recipeFollowUp.decision === 'respond_now', 'did not answer harmless meal discussion'],
    [!/(added|on (the|your) list|in your order)/i.test(recipeFollowUp.responseBody || ''), 'claimed an order mutation'],
    [/ingredients(?:\s*\([^)]*\))?:/i.test(recipeFollowUp.responseBody || '') && /method:/i.test(recipeFollowUp.responseBody || ''), 'did not use a readable recipe structure'],
  ]);

  const directRecipe = await runModel(build('Can you give me a simple chicken wrap recipe?'));
  record('recipe help is answered', directRecipe, [
    [directRecipe.applyDraft === false, 'mutated a draft while answering a recipe'],
    [directRecipe.decision === 'respond_now', 'did not answer the recipe request'],
    [/(chicken|wrap|ingredient|cook|fry)/i.test(directRecipe.responseBody || ''), 'recipe answer was not useful'],
    [/serves:/i.test(directRecipe.responseBody || '') && /ingredients:/i.test(directRecipe.responseBody || '') && /method:/i.test(directRecipe.responseBody || ''), 'recipe was not properly formatted'],
    [/\?\s*$/.test(directRecipe.responseBody || ''), 'recipe did not end with one useful cooking question'],
    [!/(turn these ingredients|shopping request|place an order)/i.test(directRecipe.responseBody || ''), 'recipe ended with a generic sales question'],
  ]);
}

const recipeFormattingBuilt = build('Can you give me a simple chicken wrap recipe?');
const recipeFormatting = validate(recipeFormattingBuilt, {
  decision: 'respond_now',
  reason_code: 'RECIPE_HELP',
  confidence: 0.99,
  response_body: '**Serves:** 2\n**Ingredients:**\n* Chicken\n* Wraps\n**Method:**\n1. Cook chicken.\n2. Fill wraps.\n\nQuick question: Do you want another suggestion?',
  apply_draft: false,
  draft_state: null,
  submit_draft: false,
});
record('recipe replies use clean WhatsApp formatting and one closing question', recipeFormatting, [
  [!/\*\*/.test(recipeFormatting.responseBody || ''), 'bold Markdown leaked into WhatsApp'],
  [!/^\s*\*\s+/m.test(recipeFormatting.responseBody || ''), 'asterisk bullets leaked into WhatsApp'],
  [((recipeFormatting.responseBody || '').match(/Quick question:/g) || []).length === 1, 'recipe contained more than one closing question label'],
  [/Ingredients:\n- Chicken\n- Wraps/i.test(recipeFormatting.responseBody || ''), 'ingredient list was not normalised'],
]);

const availability = await resolveDecision(build('Do you have Clover milk available?'));
record('stale catalogue cannot become an availability claim', availability, [
  [availability.applyDraft === false, 'availability question mutated a draft'],
  [availability.decision === 'respond_now', 'availability question was not answered safely'],
  [!/(yes|we have|in stock|available now|available today)/i.test(availability.responseBody || ''), 'claimed current availability'],
  [/(check|checking|confirm|refresh|current)/i.test(availability.responseBody || ''), 'did not explain that current availability needs checking'],
  [!/recipe/i.test(availability.responseBody || ''), 'offered an unrelated recipe'],
]);

const explicitOrder = await resolveDecision(build('Please add 2 bottles of Clover milk to my shopping request'));
const explicitItems = explicitOrder.draftState?.orders?.flatMap((order) => order.items || []) || [];
record('explicit order request may create a grounded draft', explicitOrder, [
  [explicitOrder.applyDraft === true, 'explicit order request did not create a draft'],
  [explicitItems.some((item) => /clover milk/i.test(item.requested_text || '') && Number(item.quantity) === 2), 'draft did not preserve the requested item and quantity'],
  [!/(in stock|available now|R\s?\d)/i.test(explicitOrder.responseBody || ''), 'draft response invented price or stock'],
]);

const directOverLimit = build('Please add 25 bottles of Clover milk to my shopping request');
record('a direct quantity above 24 is rejected instead of silently truncated', directOverLimit, [
  [directOverLimit.requiresModel === false, 'over-limit quantity reached the model'],
  [directOverLimit.applyDraft === false, 'over-limit quantity mutated the draft'],
  [directOverLimit.reasonCode === 'DIRECT_QUANTITY_OVER_UNIT_LIMIT', 'over-limit quantity used the wrong safety path'],
  [/at most 24/i.test(directOverLimit.responseBody || ''), 'customer was not told the physical-unit limit'],
]);

const directZero = build('Please add 0 bottles of Clover milk to my shopping request');
record('zero quantity is rejected instead of becoming one', directZero, [
  [directZero.requiresModel === false, 'zero quantity reached the model'],
  [directZero.applyDraft === false, 'zero quantity mutated the draft'],
  [directZero.reasonCode === 'DIRECT_QUANTITY_INVALID', 'zero quantity used the wrong safety path'],
]);

const fullUnitDraftContext = {
  ...structuredClone(baseContext),
  conversation: { mode: 'automation' },
  order_draft: {
    version: 7,
    state: { stage: 'collecting', orders: [{ items: [{ requested_text: 'Rice', quantity: 24 }], shop_names: [] }] },
  },
};
const cumulativeOverLimit = build('Please add 1 bottle of milk', fullUnitDraftContext);
record('a new item cannot push an existing draft above 24 units', cumulativeOverLimit, [
  [cumulativeOverLimit.applyDraft === false, 'cumulative over-limit change mutated the draft'],
  [cumulativeOverLimit.reasonCode === 'DIRECT_ITEM_OVER_UNIT_LIMIT', 'cumulative unit limit used the wrong path'],
  [/over 24/i.test(cumulativeOverLimit.responseBody || ''), 'cumulative unit limit was not explained'],
]);

const followUpItemContext = {
  ...structuredClone(baseContext),
  conversation: { mode: 'dry_run' },
  order_draft: {
    version: 1,
    state: {
      stage: 'collecting',
      orders: [{ items: [{ requested_text: 'Test Milk', quantity: 2 }], shop_names: [] }],
    },
  },
  recent_messages: [
    { direction: 'inbound', body: 'Please add 2 bottles of Test Milk to my shopping request' },
    { direction: 'outbound', body: 'I have kept 2 x Test Milk in the draft. What is the Villiers delivery address or WhatsApp location pin?' },
  ],
};
const followUpItem = build('Please add 1 loaf of Test Bread to my shopping request', followUpItemContext);
record('a follow-up item is not mistaken for an address answer', followUpItem, [
  [followUpItem.applyDraft === true, 'follow-up item did not update the active draft'],
  [followUpItem.reasonCode === 'DIRECT_QUANTITY_ITEM_NEEDS_ADDRESS', 'follow-up item was routed as an address answer'],
  [(followUpItem.draftState?.orders?.[0]?.items || []).length === 2, 'follow-up item did not preserve both item lines'],
  [(followUpItem.draftState?.orders?.[0]?.items || []).some((item) => /test bread/i.test(item.requested_text || '')), 'follow-up item was lost'],
]);

const misspelledFollowUpBuilt = build('also pls ad 3 tins baked beans n two packs pasta', followUpItemContext);
record('an obvious misspelled follow-up order is not mistaken for an address answer', misspelledFollowUpBuilt, [
  [misspelledFollowUpBuilt.reasonCode !== 'VILLIERS_LOCATION_CONFIRMATION_REQUIRED', 'misspelled order was routed as an address answer'],
  [misspelledFollowUpBuilt.safetyFlags?.allowDraftMutation === true, 'misspelled order was not allowed to update the active draft'],
]);

if (!deterministicOnly) {
  const misspelledFollowUp = await resolveDecision(misspelledFollowUpBuilt);
  const misspelledItems = misspelledFollowUp.draftState?.orders?.flatMap((order) => order.items || []) || [];
  record('the model preserves items and quantities from a misspelled follow-up order', misspelledFollowUp, [
    [misspelledFollowUp.applyDraft === true, 'model did not update the active draft'],
    [misspelledItems.some((item) => /baked beans/i.test(item.requested_text || '') && Number(item.quantity) === 3), 'baked beans quantity was lost'],
    [misspelledItems.some((item) => /pasta/i.test(item.requested_text || '') && Number(item.quantity) === 2), 'pasta quantity was lost'],
    [misspelledItems.some((item) => /test milk/i.test(item.requested_text || '')), 'existing draft item was lost'],
  ]);
}

const sixteenLineDraftContext = {
  ...structuredClone(baseContext),
  conversation: { mode: 'automation' },
  order_draft: {
    version: 8,
    state: {
      stage: 'collecting',
      orders: [{
        items: Array.from({ length: 16 }, (_, index) => ({ requested_text: `Existing item ${index + 1}`, quantity: 1 })),
        shop_names: [],
      }],
    },
  },
};
const seventeenthLine = build('Please add 1 bottle of milk', sixteenLineDraftContext);
record('a new item cannot create a seventeenth item line', seventeenthLine, [
  [seventeenthLine.applyDraft === false, 'seventeenth item line mutated the draft'],
  [seventeenthLine.reasonCode === 'DIRECT_ITEM_OVER_LINE_LIMIT', 'item-line limit used the wrong path'],
  [/16 item lines/i.test(seventeenthLine.responseBody || ''), 'item-line limit was not explained'],
]);

const outsideArea = build('In Cape Town please', {
  ...structuredClone(baseContext),
  recent_messages: [{ direction: 'outbound', body: 'Where should I deliver your order?' }],
});
record('Cape Town is never accepted', outsideArea, [
  [outsideArea.requiresModel === false, 'outside-area request reached the model'],
  [outsideArea.decision === 'human_review', 'outside-area request was not handed to a human'],
  [outsideArea.reasonCode === 'OUTSIDE_VILLIERS', 'wrong outside-area reason'],
]);

const invalidLocation = build('', fullUnitDraftContext, {
  messageType: 'location',
  payload: { message: { location: { latitude: 123, longitude: 456 } } },
});
record('invalid location coordinates are handed to a human', invalidLocation, [
  [invalidLocation.requiresModel === false, 'invalid location reached the model'],
  [invalidLocation.decision === 'human_review', 'invalid location was not handed to a human'],
  [invalidLocation.reasonCode === 'LOCATION_COORDINATES_INVALID', 'invalid location used the wrong reason'],
]);

const capeTownPin = build('', fullUnitDraftContext, {
  messageType: 'location',
  payload: { message: { location: { latitude: -33.9249, longitude: 18.4241 } } },
});
record('an out-of-town WhatsApp pin cannot be labelled Villiers', capeTownPin, [
  [capeTownPin.requiresModel === false, 'out-of-town pin reached the model'],
  [capeTownPin.decision === 'human_review', 'out-of-town pin was accepted'],
  [capeTownPin.reasonCode === 'OUTSIDE_VILLIERS', 'out-of-town pin used the wrong reason'],
]);

const villiersPinContext = {
  ...structuredClone(baseContext),
  conversation: { mode: 'automation' },
  order_draft: {
    version: 2,
    state: { stage: 'collecting', orders: [{ items: [{ requested_text: 'Milk', quantity: 1 }], shop_names: [] }] },
  },
};
const villiersPinBuilt = build('', villiersPinContext, {
  messageType: 'location',
  payload: { message: { location: { latitude: -27.029719, longitude: 28.600826 } } },
});
const villiersPin = villiersPinBuilt;
record('a Villiers pin is attached to the active order and reaches confirmation', villiersPin, [
  [villiersPin.requiresModel === false, 'valid Villiers pin still depended on the model'],
  [villiersPin.applyDraft === true, 'valid Villiers pin did not update the draft'],
  [villiersPin.draftState?.stage === 'awaiting_confirmation', 'valid Villiers pin did not make the complete draft confirmable'],
  [villiersPin.reasonCode === 'LOCATION_PIN_APPLIED_READY', 'valid Villiers pin used the wrong deterministic path'],
  [Number(villiersPin.draftState?.orders?.[0]?.delivery_location?.latitude) === -27.029719, 'Villiers pin latitude was lost'],
  [Number(villiersPin.draftState?.orders?.[0]?.delivery_location?.longitude) === 28.600826, 'Villiers pin longitude was lost'],
]);

const typedAddressAfterRecipe = build('35 Emmet Street, Villiers', {
  ...structuredClone(villiersPinContext),
  recent_messages: [
    { direction: 'inbound', body: 'what are we making for dinner' },
    { direction: 'outbound', body: 'Chicken wraps are a great dinner idea.' },
    { direction: 'outbound', body: 'What is the Villiers delivery address or WhatsApp location pin?' },
  ],
});
record('a typed Villiers address cannot be swallowed by earlier recipe context', typedAddressAfterRecipe, [
  [typedAddressAfterRecipe.requiresModel === false, 'typed Villiers address still depended on the model'],
  [typedAddressAfterRecipe.applyDraft === true, 'typed Villiers address did not update the draft'],
  [typedAddressAfterRecipe.draftState?.stage === 'awaiting_confirmation', 'typed Villiers address did not make the draft confirmable'],
  [typedAddressAfterRecipe.draftState?.orders?.[0]?.delivery_address === '35 Emmet Street, Villiers', 'typed Villiers address was not preserved'],
  [typedAddressAfterRecipe.reasonCode === 'TYPED_VILLIERS_ADDRESS_APPLIED_READY', 'typed address used the wrong deterministic path'],
  [typedAddressAfterRecipe.safetyFlags?.recipeHelp === false, 'typed address was still marked as recipe help'],
]);

const humanOwned = build('Please add 2 bottles of milk', {
  ...structuredClone(baseContext),
  conversation: { mode: 'human' },
});
record('human takeover suppresses automation', humanOwned, [
  [humanOwned.decision === 'no_response', 'human-owned conversation generated an automated response'],
  [humanOwned.reasonCode === 'HUMAN_OWNED', 'human takeover used the wrong reason'],
]);

const reactionOnly = build('', baseContext, { messageType: 'reaction' });
record('reaction-only events remain silent', reactionOnly, [
  [reactionOnly.decision === 'no_response', 'reaction generated a response'],
  [reactionOnly.reasonCode === 'REACTION_ONLY', 'reaction used the wrong reason'],
]);

const optOut = build('STOP, do not message me again');
record('customer opt-out remains silent', optOut, [
  [optOut.decision === 'no_response', 'opt-out generated a response'],
  [optOut.reasonCode === 'CUSTOMER_OPT_OUT', 'opt-out used the wrong reason'],
]);

for (const [name, message] of [
  ['credentials are escalated', 'My OTP is 123456'],
  ['refunds are escalated', 'I want a refund because I was charged twice'],
  ['restricted goods are escalated', 'Please deliver cigarettes and alcohol'],
  ['medicine requests are escalated', 'I need prescription medicine'],
]) {
  const result = build(message);
  record(name, result, [
    [result.decision === 'human_review', `${name} was not handed to a human`],
    [result.reasonCode === 'DETERMINISTIC_HIGH_RISK', `${name} used the wrong reason`],
    [result.responseBody === null, `${name} leaked an automated response`],
  ]);
}

const unsupportedImage = build('', baseContext, { messageType: 'image' });
record('unsupported media is escalated without guessing', unsupportedImage, [
  [unsupportedImage.decision === 'human_review', 'unsupported image was not escalated'],
  [unsupportedImage.reasonCode === 'UNSUPPORTED_MESSAGE_TYPE', 'unsupported image used the wrong reason'],
]);

const specials = build('What specials do you have?');
record('expired catalogue is disclosed', specials, [
  [specials.requiresModel === false, 'specials question reached the model'],
  [specials.decision === 'respond_now', 'specials question was not answered'],
  [/catalogue needs refreshing/i.test(specials.responseBody || ''), 'did not disclose stale catalogue'],
]);

const operatorApprovedGrounding = {
  ...structuredClone(grounding),
  catalogue: {
    active_public_rows: 118,
    reference_rows: 118,
    price_quotable_rows: 118,
    valid_through: '2026-08-17',
    status: 'operator_approved_current_rows',
    current_price_quote_allowed: true,
    current_stock_quote_allowed: false,
    requires_checkout_revalidation: true,
  },
  matches: [
    {
      product_name: 'Full Cream Milk', size: '2 L', shop_name: 'Usave Villiers',
      effective_price: 34.99, price_valid_through: '2026-08-17',
      price_kind: 'special', price_verified: true, reference_only: false, stock_verified: false,
    },
  ],
};
const approvedSpecials = build('What specials do you have?', baseContext, {}, operatorApprovedGrounding);
record('operator-approved temporary specials are recognised', approvedSpecials, [
  [approvedSpecials.requiresModel === false, 'general specials question unnecessarily reached the model'],
  [approvedSpecials.decision === 'respond_now', 'approved specials question was not answered'],
  [/Full Cream Milk/i.test(approvedSpecials.responseBody || '') && /R34\.99/i.test(approvedSpecials.responseBody || ''), 'approved special and price were not shown'],
  [/stock.*confirm/i.test(approvedSpecials.responseBody || ''), 'stock safety warning was lost'],
]);

const specialsBrowser = build('Browse specials', baseContext, { interactiveReplyId: 'getit_browse_specials' }, operatorApprovedGrounding);
record('specials browser opens from the welcome menu', specialsBrowser, [
  [specialsBrowser.requiresModel === false, 'specials browser unnecessarily reached the model'],
  [specialsBrowser.responseUi === 'specials_menu', 'specials category picker was not requested'],
  [/browse this week/i.test(specialsBrowser.responseBody || ''), 'specials browser copy was not helpful'],
]);

const milkCategory = build('Milk & dairy', baseContext, { interactiveReplyId: 'getit_specials_milk' }, operatorApprovedGrounding);
record('specials category returns grounded prices', milkCategory, [
  [milkCategory.requiresModel === false, 'specials category unnecessarily reached the model'],
  [/Full Cream Milk/i.test(milkCategory.responseBody || '') && /R34\.99/i.test(milkCategory.responseBody || ''), 'grounded category price was omitted'],
  [!/in stock/i.test(milkCategory.responseBody || ''), 'category response claimed stock'],
]);

const referencedOrderContext = {
  ...structuredClone(baseContext),
  conversation: { mode: 'automation' },
  customer: { location_confirmed: true, default_address: '35 Emmet Street, Villiers' },
  order_draft: {
    version: 1,
    state: { stage: 'collecting', orders: [{ items: [], shop_names: [], delivery_address: '35 Emmet Street, Villiers' }] },
  },
  recent_messages: [
    { direction: 'outbound', body: 'Potato bake ingredients:\n- 1kg potatoes\n- 2 cans baked beans\n- 300g brown bread' },
    { direction: 'inbound', body: 'I want everything you have on special for that recipe' },
    { direction: 'outbound', body: 'Matching recipe specials:\n- Brown Bread 700 g - R16.99 at OK Villiers\n- Baked Beans 410 g - R15.99 at OK Villiers\n- Potatoes 2 kg - R34.99 at Usave Villiers\n- Butter 500 g - R59.99 at Usave Villiers\n- Salt 500 g - R12.99 at OK Villiers\n- Black Pepper 100 g - R24.99 at OK Villiers' },
  ],
};
const referencedBuilt = build("I'd like to order them please", referencedOrderContext, {}, operatorApprovedGrounding);
const referencedOrder = await resolveDecision(referencedBuilt);
record('referenced visible items become a confirmable draft', referencedOrder, [
  [referencedBuilt.requiresModel === false, 'visible-reference order unnecessarily reached the model'],
  [referencedOrder.applyDraft === true, 'visible referenced item was rejected'],
  [referencedOrder.decision === 'respond_now', 'safe referenced order was handed to a human'],
  [referencedOrder.draftState?.stage === 'awaiting_confirmation', 'complete active draft did not reach confirmation'],
  [(referencedOrder.draftState?.orders || []).some((order) => (order.items || []).some((item) => /brown bread/i.test(item.requested_text || ''))), 'visible referenced item was lost'],
  [(referencedOrder.draftState?.orders?.[0]?.items || []).length === 6, 'not all visible referenced items were preserved'],
]);

const staleProfileAddressContext = {
  ...structuredClone(referencedOrderContext),
  customer: { location_confirmed: true, default_address: '35 Emmet Street, Villiers' },
  order_draft: { version: 0, state: { stage: 'idle', orders: [] } },
};
const orderForMe = build('Order for me please', staleProfileAddressContext, {}, operatorApprovedGrounding);
record('generic order request uses the visible list but not a saved profile address', orderForMe, [
  [orderForMe.requiresModel === false, 'generic visible-list order unnecessarily reached the model'],
  [orderForMe.applyDraft === true, 'generic order request did not preserve the visible items'],
  [orderForMe.draftState?.stage === 'collecting', 'saved profile address made a new order confirmable'],
  [orderForMe.draftState?.orders?.[0]?.delivery_address == null, 'saved profile address was silently copied'],
  [/villiers delivery address|location pin/i.test(orderForMe.responseBody || ''), 'customer was not asked for the active delivery address'],
]);

const naturalConfirmationContext = {
  ...structuredClone(baseContext),
  conversation: { mode: 'automation' },
  order_draft: {
    version: 3,
    state: {
      stage: 'awaiting_confirmation',
      orders: [{ items: [{ requested_text: 'Bananas 500 g', quantity: 1 }], delivery_address: '12 Main Street, Villiers' }],
    },
  },
};
const naturalConfirmation = build("that's correct", naturalConfirmationContext);
record('natural confirmation phrase submits the existing draft', naturalConfirmation, [
  [naturalConfirmation.requiresModel === false, 'natural confirmation unnecessarily reached the model'],
  [naturalConfirmation.submitDraft === true, 'natural confirmation did not request a real submission'],
  [naturalConfirmation.reasonCode === 'ORDER_DRAFT_CONFIRMED', 'natural confirmation used the wrong path'],
]);

const dryRunConfirmation = build('YES', {
  ...structuredClone(naturalConfirmationContext),
  conversation: { mode: 'dry_run' },
});
record('dry-run confirmation cannot submit an order', dryRunConfirmation, [
  [dryRunConfirmation.requiresModel === false, 'dry-run confirmation reached the model'],
  [dryRunConfirmation.submitDraft === false, 'dry-run confirmation requested a real submission'],
  [dryRunConfirmation.decision === 'human_review', 'dry-run confirmation was not safety-stopped'],
  [dryRunConfirmation.reasonCode === 'DRY_RUN_DRAFT_CONFIRMATION', 'dry-run confirmation used the wrong reason'],
]);

const cancelUnsubmittedDraft = build('cancel that order', naturalConfirmationContext);
record('an unsubmitted draft can be cancelled without a silent human handoff', cancelUnsubmittedDraft, [
  [cancelUnsubmittedDraft.requiresModel === false, 'draft cancellation depended on the model'],
  [cancelUnsubmittedDraft.decision === 'respond_now', 'draft cancellation did not acknowledge the customer'],
  [cancelUnsubmittedDraft.reasonCode === 'DRAFT_CANCELLED', 'draft cancellation used the wrong path'],
  [cancelUnsubmittedDraft.applyDraft === true, 'draft cancellation was not persisted'],
  [cancelUnsubmittedDraft.submitDraft === false, 'draft cancellation submitted an order'],
  [cancelUnsubmittedDraft.draftState?.stage === 'cancelled', 'draft stage was not cancelled'],
  [(cancelUnsubmittedDraft.draftState?.orders || []).length === 0, 'cancelled draft retained order lines'],
]);

const confirmationAfterCancellation = build('YES', {
  ...structuredClone(baseContext),
  conversation: { mode: 'automation' },
  order_draft: { version: 9, state: { stage: 'cancelled', orders: [] } },
});
record('confirmation after cancellation cannot revive or submit an old draft', confirmationAfterCancellation, [
  [confirmationAfterCancellation.requiresModel === false, 'post-cancellation confirmation reached the model'],
  [confirmationAfterCancellation.submitDraft === false, 'post-cancellation confirmation submitted an order'],
  [confirmationAfterCancellation.applyDraft === false, 'post-cancellation confirmation mutated a draft'],
  [confirmationAfterCancellation.reasonCode === 'NO_ACTIVE_DRAFT_TO_CONFIRM', 'post-cancellation confirmation used the wrong path'],
  [/no active draft/i.test(confirmationAfterCancellation.responseBody || ''), 'customer was not told there is no active draft'],
]);

const realCatalogueShopOrder = build('Yes please add 2 tins KOO Baked Beans 400g and 1 bottle Sunlight Dishwashing Liquid 750ml from OK Villiers');
const realCatalogueShopItems = realCatalogueShopOrder.draftState?.orders?.[0]?.items || [];
record('a trailing real shop applies to every item without contaminating product names', realCatalogueShopOrder, [
  [realCatalogueShopOrder.requiresModel === false, 'clear multi-item catalogue order reached the model'],
  [realCatalogueShopOrder.applyDraft === true, 'clear multi-item catalogue order did not create a draft'],
  [realCatalogueShopItems.length === 2, 'clear multi-item catalogue order lost an item'],
  [realCatalogueShopItems.every((item) => item.requested_shop_name === 'OK Villiers'), 'requested shop did not apply to every item'],
  [realCatalogueShopItems.every((item) => !/from OK Villiers/i.test(item.requested_text || '')), 'shop suffix contaminated a product name'],
  [(realCatalogueShopOrder.draftState?.orders?.[0]?.shop_names || []).includes('OK Villiers'), 'order-level shop list was not populated'],
]);

const realCatalogueTwoShopOrder = build('Please add 1 tin KOO Baked Beans 400g from OK Villiers and 1 tin Homegrown Baked Beans 410g from Usave Villiers');
const realCatalogueTwoShopItems = realCatalogueTwoShopOrder.draftState?.orders?.[0]?.items || [];
record('item-specific shops survive a real two-shop order', realCatalogueTwoShopOrder, [
  [realCatalogueTwoShopOrder.requiresModel === false, 'clear two-shop order reached the model'],
  [realCatalogueTwoShopOrder.applyDraft === true, 'clear two-shop order did not create a draft'],
  [realCatalogueTwoShopItems.length === 2, 'clear two-shop order lost an item'],
  [realCatalogueTwoShopItems.some((item) => /KOO Baked Beans 400g/i.test(item.requested_text || '') && item.requested_shop_name === 'OK Villiers'), 'OK item lost its shop'],
  [realCatalogueTwoShopItems.some((item) => /Homegrown Baked Beans 410g/i.test(item.requested_text || '') && item.requested_shop_name === 'Usave Villiers'), 'Usave item lost its shop'],
  [(realCatalogueTwoShopOrder.draftState?.orders?.[0]?.shop_names || []).length === 2, 'two-shop order did not retain both shops'],
  [realCatalogueTwoShopItems.every((item) => !/from (?:OK|Usave) Villiers/i.test(item.requested_text || '')), 'shop suffix contaminated a two-shop product name'],
]);

const recipeSpecialFollowUp = build('everything you have on special for that recipe', referencedOrderContext, {}, operatorApprovedGrounding);
record('recipe-specific specials stay in conversational reasoning', recipeSpecialFollowUp, [
  [recipeSpecialFollowUp.requiresModel === false, 'safe recipe-specific comparison unnecessarily reached the model'],
  [recipeSpecialFollowUp.safetyFlags?.recipeHelp === false, 'recipe comparison was mistaken for a fresh recipe request'],
  [recipeSpecialFollowUp.safetyFlags?.recipeSpecialComparison === true, 'recipe-special comparison flag was lost'],
]);
const recipeSpecialAnswer = await resolveDecision(recipeSpecialFollowUp);
record('unrelated catalogue matches are excluded from recipe specials', recipeSpecialAnswer, [
  [recipeSpecialAnswer.decision === 'respond_now', 'recipe-special comparison was not answered'],
  [recipeSpecialAnswer.applyDraft === false, 'recipe-special comparison created an order without an order request'],
  [!/full cream milk/i.test(recipeSpecialAnswer.responseBody || ''), 'unrelated milk special was presented as a recipe ingredient'],
]);

const falseClaimBuilt = build('Do you have custard tart with caviar?');
const falseClaim = validate(falseClaimBuilt, {
  decision: 'respond_now',
  reason_code: 'ITEM_ADDED',
  confidence: 0.99,
  response_body: 'Custard tart with caviar added to your order.',
  apply_draft: false,
  draft_state: null,
  submit_draft: false,
});
record('false order-action claims are blocked', falseClaim, [
  [falseClaim.decision === 'human_review', 'false mutation claim was allowed'],
  [falseClaim.reasonCode === 'FALSE_ORDER_MUTATION_CLAIM', 'wrong false-claim reason'],
  [falseClaim.responseBody === null, 'unsafe false claim was retained'],
]);

const nonexistentDraftClaim = validate(build('What is cheapest right now?'), {
  decision: 'respond_now',
  reason_code: 'SAFE_CLARIFICATION',
  confidence: 0.99,
  response_body: 'Would you like me to add bread and milk to your existing order instead?',
  apply_draft: false,
  draft_state: null,
  submit_draft: false,
});
record('the bot cannot refer to an existing order when no active draft exists', nonexistentDraftClaim, [
  [!/existing order|current order/i.test(nonexistentDraftClaim.responseBody || ''), 'response invented a current order'],
  [/new order/i.test(nonexistentDraftClaim.responseBody || ''), 'response did not offer a truthful new order'],
]);

const falseSubmission = validate(falseClaimBuilt, {
  decision: 'respond_now',
  reason_code: 'ORDER_CONFIRMED',
  confidence: 0.99,
  response_body: 'Perfect! Your order is confirmed. Prices and stock are finalised now.',
  apply_draft: true,
  draft_state: { stage: 'collecting', orders: [{ items: [{ requested_text: 'custard tart', quantity: 1 }] }] },
  submit_draft: false,
});
record('a draft can never masquerade as a submitted order', falseSubmission, [
  [falseSubmission.reasonCode === 'ORDER_NOT_SUBMITTED', 'false submission claim was not intercepted'],
  [falseSubmission.submitDraft === false, 'validator invented a submission'],
  [/not submitted/i.test(falseSubmission.responseBody || ''), 'customer did not receive a truthful correction'],
]);

const modelPath = build('Please add milk and bread to my shopping request');
const malformedModelOutput = validateRaw(modelPath, '{not valid json');
record('malformed model output fails closed', malformedModelOutput, [
  [malformedModelOutput.decision === 'human_review', 'malformed model output did not fail closed'],
  [malformedModelOutput.reasonCode === 'LOW_MODEL_CONFIDENCE' || malformedModelOutput.reasonCode === 'MODEL_OUTPUT_INVALID', 'malformed model output used an unexpected reason'],
  [malformedModelOutput.applyDraft === false, 'malformed model output mutated a draft'],
]);

const lowConfidence = validate(modelPath, {
  decision: 'respond_now', reason_code: 'ORDER_REQUEST', confidence: 0.4,
  response_body: 'I added it.', apply_draft: true,
  draft_state: { stage: 'collecting', orders: [{ items: [{ requested_text: 'milk', quantity: 1 }] }] },
  submit_draft: false,
});
record('low-confidence order output fails closed', lowConfidence, [
  [lowConfidence.decision === 'human_review', 'low-confidence output did not fail closed'],
  [lowConfidence.reasonCode === 'LOW_MODEL_CONFIDENCE', 'low-confidence output used the wrong reason'],
  [lowConfidence.applyDraft === false, 'low-confidence output mutated a draft'],
]);

const missingResponse = validate(modelPath, {
  decision: 'respond_now', reason_code: 'ORDER_REQUEST', confidence: 0.99,
  response_body: null, apply_draft: false, draft_state: null, submit_draft: false,
});
record('respond-now without a safe body fails closed', missingResponse, [
  [missingResponse.decision === 'human_review', 'empty respond-now decision was allowed'],
  [missingResponse.reasonCode === 'MISSING_SAFE_RESPONSE', 'empty respond-now used the wrong reason'],
]);

const inventedAddress = validate(modelPath, {
  decision: 'respond_now', reason_code: 'ORDER_REQUEST', confidence: 0.99,
  response_body: 'I added the items.', apply_draft: true,
  draft_state: {
    stage: 'awaiting_confirmation',
    orders: [{
      items: [{ requested_text: 'milk', quantity: 1 }, { requested_text: 'bread', quantity: 1 }],
      delivery_address: '1 Long Street, Cape Town',
    }],
  },
  submit_draft: false,
});
record('a model cannot invent or import an unverified address', inventedAddress, [
  [inventedAddress.applyDraft === false, 'invented address mutated the draft'],
  [inventedAddress.reasonCode === 'DRAFT_CLARIFICATION_REQUIRED', 'invented address used the wrong reason'],
  [/confirm the delivery address is in Villiers/i.test(inventedAddress.responseBody || ''), 'address clarification was not requested'],
]);

const modelOverUnitLimit = validate(modelPath, {
  decision: 'respond_now', reason_code: 'ORDER_REQUEST', confidence: 0.99,
  response_body: 'I added the items.', apply_draft: true,
  draft_state: {
    stage: 'collecting',
    orders: [{ items: [{ requested_text: 'milk', quantity: 13 }, { requested_text: 'bread', quantity: 12 }] }],
  },
  submit_draft: false,
});
record('model-generated drafts cannot exceed 24 units', modelOverUnitLimit, [
  [modelOverUnitLimit.applyDraft === false, 'over-unit model draft was accepted'],
  [modelOverUnitLimit.reasonCode === 'DRAFT_CLARIFICATION_REQUIRED', 'over-unit model draft used the wrong reason'],
  [/over the 24-unit limit/i.test(modelOverUnitLimit.responseBody || ''), 'model unit-limit clarification was missing'],
]);

const inventedPrice = validate(build('How much is milk?'), {
  decision: 'respond_now', reason_code: 'PRICE', confidence: 0.99,
  response_body: 'Milk is on special for R19.99 and is in stock today.',
  apply_draft: false, draft_state: null, submit_draft: false,
});
record('invented price and stock claims fail closed', inventedPrice, [
  [inventedPrice.decision === 'human_review', 'invented price/stock claim was sent'],
  [inventedPrice.reasonCode === 'UNVERIFIED_FACTUAL_CLAIM', 'invented price/stock used the wrong reason'],
  [inventedPrice.responseBody === null, 'invented price/stock response was retained'],
]);

console.log(JSON.stringify({ passed: results.every((result) => result.passed), results }, null, 2));
if (results.some((result) => !result.passed)) process.exitCode = 1;
