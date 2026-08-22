import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowPath = path.resolve(here, '../workflows/getit-messaging-inbound-v1.14.json');
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));

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
  return new Function('$', '$input', '$json', code)(getNamed, input, currentJson);
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

const outsideArea = build('In Cape Town please', {
  ...structuredClone(baseContext),
  recent_messages: [{ direction: 'outbound', body: 'Where should I deliver your order?' }],
});
record('Cape Town is never accepted', outsideArea, [
  [outsideArea.requiresModel === false, 'outside-area request reached the model'],
  [outsideArea.decision === 'human_review', 'outside-area request was not handed to a human'],
  [outsideArea.reasonCode === 'OUTSIDE_VILLIERS', 'wrong outside-area reason'],
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

console.log(JSON.stringify({ passed: results.every((result) => result.passed), results }, null, 2));
if (results.some((result) => !result.passed)) process.exitCode = 1;
