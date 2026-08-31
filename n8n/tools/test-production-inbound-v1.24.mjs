import fs from 'node:fs';
import path from 'node:path';

const workflowPath = process.argv[2] || path.resolve('n8n/workflows/getit-messaging-inbound-v1.24.json');
const parsed = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const workflow = Array.isArray(parsed) ? parsed[0] : parsed;
const testModel = process.env.TEST_OLLAMA_MODEL || null;
const testNumCtx = Number(process.env.TEST_OLLAMA_NUM_CTX || 0) || null;
const testKeepAlive = process.env.TEST_OLLAMA_KEEP_ALIVE || null;

const nodeCode = (name) => {
  const match = workflow.nodes.find((candidate) => candidate.name === name);
  if (!match?.parameters?.jsCode) throw new Error(`Missing Code node: ${name}`);
  return match.parameters.jsCode;
};

const buildCode = nodeCode('Build Safety Decision');
const validateCode = nodeCode('Validate Model Decision');
const voiceCode = nodeCode('Attach Voice Transcript');

const clone = (value) => JSON.parse(JSON.stringify(value));
const executeCode = (code, namedItems, inputJson = {}, currentJson = {}) => {
  const getNamed = (name) => {
    if (!(name in namedItems)) throw new Error(`Missing test input for node: ${name}`);
    return { item: { json: namedItems[name] } };
  };
  const input = { first: () => ({ json: inputJson }) };
  return new Function('$', '$input', '$json', 'structuredClone', code)(
    getNamed,
    input,
    currentJson,
    undefined,
  );
};

const baseGrounding = {
  service_area: { launch_town: 'Villiers', normal_orders_outside_launch_town: false },
  catalogue: {
    active_public_rows: 0,
    current_price_quote_allowed: false,
    status: 'expired_or_unavailable',
  },
  matches: [],
};

const baseContext = {
  conversation: { mode: 'automation', status: 'open' },
  customer: { full_name: 'Test Customer', preferred_language: 'English', default_address: null },
  order_draft: { version: 0, state: { stage: 'idle', orders: [] } },
  recent_messages: [],
  recent_orders: [],
};

const source = (body, overrides = {}) => ({
  body,
  messageType: 'text',
  payload: {},
  waitlistResult: { handled: false },
  partnerResult: { handled: false },
  ...overrides,
});

const build = (body, context = baseContext, overrides = {}, grounding = baseGrounding) => executeCode(
  buildCode,
  {
    'Continue Partner Processing': source(body, overrides),
    'Fetch Messaging Context': clone(context),
  },
  clone(grounding),
)[0].json;

const validate = (built, modelOutput) => executeCode(
  validateCode,
  { 'Build Safety Decision': built },
  {},
  modelOutput,
)[0].json;

const validateReply = (built, reply) => validate(built, {
  message: { content: JSON.stringify(reply) },
});

const runModel = async (built) => {
  const started = Date.now();
  if (built.requiresModel === false) return { result: built, elapsedMs: Date.now() - started };
  const ollamaRequest = clone(built.ollamaRequest);
  if (testModel) ollamaRequest.model = testModel;
  if (testNumCtx) ollamaRequest.options.num_ctx = testNumCtx;
  if (testKeepAlive) ollamaRequest.keep_alive = testKeepAlive;
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ollamaRequest),
  });
  const responseText = await response.text();
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${responseText.slice(0, 500)}`);
  const payload = JSON.parse(responseText);
  const result = validate(built, payload);
  return { result, elapsedMs: Date.now() - started };
};

const results = [];
const record = (name, actual, checks, extra = {}) => {
  const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
  results.push({
    name,
    passed: failures.length === 0,
    failures,
    decision: actual?.decision,
    reasonCode: actual?.reasonCode,
    schemaValid: actual?.schemaValid,
    responseBody: actual?.responseBody || null,
    ...(failures.length ? { rawOutput: actual?.rawOutput || null } : {}),
    ...extra,
  });
};

const workflowNames = workflow.nodes.map((node) => node.name);
const workflowNameSet = new Set(workflowNames);
const structureIssues = [];
if (workflowNameSet.size !== workflowNames.length) structureIssues.push('duplicate node names');
for (const [sourceName, outputs] of Object.entries(workflow.connections || {})) {
  if (!workflowNameSet.has(sourceName)) structureIssues.push(`unknown connection source ${sourceName}`);
  for (const output of outputs.main || []) {
    for (const edge of output || []) {
      if (!workflowNameSet.has(edge.node)) structureIssues.push(`unknown connection target ${edge.node}`);
    }
  }
}
for (const codeNode of workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.code')) {
  try {
    Function(codeNode.parameters.jsCode);
  } catch (error) {
    structureIssues.push(`${codeNode.name}: ${error.message}`);
  }
}
for (const required of [
  'Process Customer Waitlist',
  'Queue Waitlist Confirmation',
  'Process Partner Application',
  'Save Partner Catalogue Media',
  'Fetch Meta Voice Audio',
  'Transcribe Voice Audio',
  'Submit Confirmed Draft',
  'Queue Decision Response',
]) {
  if (!workflowNameSet.has(required)) structureIssues.push(`missing preserved node ${required}`);
}
const askNode = workflow.nodes.find((node) => node.name === 'Ask Local Structured Model');
const recordNode = workflow.nodes.find((node) => node.name === 'Record Final Decision');
const queueNode = workflow.nodes.find((node) => node.name === 'Queue Decision Response');
const finishNode = workflow.nodes.find((node) => node.name === 'Finish Inbound Event');
record('workflow structure and retry policy validate', { decision: 'n/a', reasonCode: 'STRUCTURE' }, [
  [structureIssues.length === 0, structureIssues.join('; ') || 'workflow structure invalid'],
  [askNode?.parameters?.authentication === 'none' && !askNode?.credentials, 'local model node received credentials'],
  [askNode?.onError === 'continueRegularOutput', 'model transport error is not routed to validation'],
  [askNode?.parameters?.options?.response?.response?.neverError === true, 'model HTTP error bypasses graceful handling'],
  [/p_is_final:d\.reasonCode!=="AI_BACKEND_UNAVAILABLE"/.test(recordNode?.parameters?.jsonBody || ''), 'backend outage was recorded as a conflicting final decision'],
  [/backend-unavailable/.test(queueNode?.parameters?.jsonBody || ''), 'backend outage fallback does not have its own idempotency key'],
  [/p_outcome:retry\?"retry":"processed"/.test(finishNode?.parameters?.jsonBody || ''), 'backend outage is not requeued'],
]);

const staleContext = clone(baseContext);
staleContext.order_draft = {
  version: 4,
  state: {
    stage: 'waiting_review',
    orders: [{ items: [{ requested_text: 'Clover milk', quantity: 1 }] }],
    last_submission: { submitted_at: '2026-08-22T12:33:48Z', orders: [{ order_number: 'GET-1043' }] },
  },
};
const orderStart = build("I'd like to place an order", staleContext);
record('deterministic order start does not persist an invalid empty draft', orderStart, [
  [orderStart.requiresModel === false, 'order start still depended on the model'],
  [orderStart.reasonCode === 'ORDER_START', 'wrong order-start reason'],
  [orderStart.applyDraft === false, 'order start tried to persist an empty active draft'],
  [orderStart.draftState === null, 'order start returned empty draft state'],
  [/items and quantities/i.test(orderStart.responseBody || ''), 'order start did not ask for real items'],
  [orderStart.context?.completed_order_history?.last_submission?.orders?.[0]?.order_number === 'GET-1043', 'submitted history was not preserved separately'],
]);

const thanks = build('Thanks');
record('ordinary conversation end is acknowledged', thanks, [
  [thanks.decision === 'light_ack', 'thanks was suppressed'],
  [Boolean(thanks.responseBody), 'thanks acknowledgement was empty'],
]);

const serviceArea = build('Where does Getit deliver?');
record('public service area stays in prelaunch', serviceArea, [
  [serviceArea.decision === 'respond_now', 'service-area question was not answered'],
  [serviceArea.reasonCode === 'GETIT_PUBLIC_LAUNCH_AREA', 'service-area answer was not deterministic'],
  [/Villiers/i.test(serviceArea.responseBody || '') && /Qalabotjha/i.test(serviceArea.responseBody || ''), 'public launch towns were missing'],
  [/1 October 2026/i.test(serviceArea.responseBody || ''), 'public launch date was missing'],
  [!/right away|currently delivers|open now/i.test(serviceArea.responseBody || ''), 'prelaunch answer claimed live service'],
]);

const specialsAfterOrderPrompt = build("What's on special?", {
  ...clone(baseContext),
  recent_messages: [
    { direction: 'outbound', body: 'Send me the items and quantities you need, and I will ask for the Villiers delivery address or location pin when needed.' },
  ],
});
record('specials question overrides stale address-prompt context', specialsAfterOrderPrompt, [
  [specialsAfterOrderPrompt.decision === 'respond_now', 'specials question was not answered'],
  [specialsAfterOrderPrompt.reasonCode === 'SPECIALS_BROWSER_OFFERED', 'specials question was diverted into another flow'],
  [!/address in Villiers/i.test(specialsAfterOrderPrompt.responseBody || ''), 'specials question was mistaken for an address answer'],
]);

const specials = build('What specials do you have today?');
record('specials stay grounded when catalogue is stale', specials, [
  [specials.decision === 'respond_now', 'specials did not receive a reply'],
  [/catalogue needs refreshing/i.test(specials.responseBody || ''), 'specials response invented or obscured catalogue freshness'],
]);

const waitlist = build('Please add me to the waiting list', baseContext, {
  waitlistResult: {
    handled: true,
    reason_code: 'WAITLIST_ALREADY_ACTIVE',
    response_body: "You're already on the Getit waiting list.",
    already_active: true,
  },
});
record('deterministic waitlist remains first priority', waitlist, [
  [waitlist.requiresModel === false, 'waitlist was sent to the model'],
  [waitlist.decision === 'respond_now', 'waitlist did not reply'],
  [waitlist.waitlistAlreadyActive === true, 'waitlist idempotency state was lost'],
]);

const groceryListFalsePositive = build('Add me to a short list of groceries');
record('grocery list wording is not treated as customer waitlist', groceryListFalsePositive, [
  [groceryListFalsePositive.waitlistHandled !== true, 'grocery list was marked as waitlist handled'],
  [!/WAITLIST/.test(groceryListFalsePositive.reasonCode || ''), 'grocery list used a waitlist decision reason'],
  [groceryListFalsePositive.decision !== 'human_review', 'grocery list was handed to a person'],
]);

const payment = build('I was charged twice and need a refund');
record('real payment dispute still escalates', payment, [
  [payment.decision === 'human_review', 'payment dispute did not escalate'],
  [payment.reasonCode === 'DETERMINISTIC_HIGH_RISK', 'payment dispute used an unexpected reason'],
]);

const genericBuilt = build('Tell me something about Getit');
const lowConfidence = validateReply(genericBuilt, {
  decision: 'respond_now',
  reason_code: 'GENERAL_GETIT_HELP',
  confidence: 0.31,
  response_body: 'Getit is a local shopping and delivery service built for Villiers.',
  apply_draft: false,
  draft_state: null,
  submit_draft: false,
});
record('low confidence alone does not hand over', lowConfidence, [
  [lowConfidence.decision === 'respond_now', 'low confidence caused a handoff'],
  [lowConfidence.reasonCode === 'LOW_CONFIDENCE_REPLY_VALIDATED', 'low-confidence response was not marked as validated'],
  [Boolean(lowConfidence.responseBody), 'valid low-confidence response was discarded'],
]);

const noResponse = validateReply(genericBuilt, {
  decision: 'no_response',
  reason_code: 'NO_REPLY_NEEDED',
  confidence: 0.92,
  response_body: null,
  apply_draft: false,
  draft_state: null,
  submit_draft: false,
});
record('ordinary model no-response is blocked', noResponse, [
  [noResponse.decision === 'respond_now', 'ordinary message remained no_response'],
  [Boolean(noResponse.responseBody), 'no-response recovery was empty'],
]);

const frivolousHandoff = validateReply(genericBuilt, {
  decision: 'human_review',
  reason_code: 'UNSURE_ABOUT_COMPANY_QUESTION',
  confidence: 0.8,
  response_body: null,
  apply_draft: false,
  draft_state: null,
  submit_draft: false,
});
record('frivolous handoff is prevented', frivolousHandoff, [
  [frivolousHandoff.decision === 'respond_now', 'ordinary company question was handed off'],
  [frivolousHandoff.reasonCode === 'FRIVOLOUS_HANDOFF_PREVENTED', 'handoff prevention reason missing'],
  [Boolean(frivolousHandoff.responseBody), 'handoff prevention response was empty'],
]);

const backendFailure = validate(genericBuilt, {
  error: { message: 'connect ECONNREFUSED 192.168.65.254:11434' },
  code: 'ECONNREFUSED',
});
record('Ollama outage gets a truthful non-rephrase fallback', backendFailure, [
  [backendFailure.decision === 'respond_now', 'backend outage did not produce a reply'],
  [backendFailure.reasonCode === 'AI_BACKEND_UNAVAILABLE', 'backend outage was not identified explicitly'],
  [/temporary response problem|service recovers/i.test(backendFailure.responseBody || ''), 'backend outage response was misleading'],
  [!/rephrase|say it.*another way/i.test(backendFailure.responseBody || ''), 'backend outage blamed the customer'],
]);

const voiceSource = source('', {
  messageType: 'audio',
  payload: { message: { audio: { id: 'test-audio' } } },
});
const voiceAttached = executeCode(
  voiceCode,
  { 'Attach Conversation': voiceSource },
  { ok: true, text: 'Please add two loaves of bread', language: 'en', language_probability: 0.99 },
)[0].json;
record('voice transcript becomes the current message body', voiceAttached, [
  [voiceAttached.body === 'Please add two loaves of bread', 'voice transcript was not attached'],
  [voiceAttached.voiceTranscription?.ok === true, 'voice transcription success state was lost'],
]);

const cancellationContext = clone(baseContext);
cancellationContext.order_draft = {
  version: 2,
  state: {
    stage: 'collecting',
    orders: [{
      items: [{ requested_text: 'milk', quantity: 2, requested_shop_name: 'OK Villiers' }],
      shop_names: ['OK Villiers'],
    }],
  },
};
const cancellation = build('Cancel this order.', cancellationContext);
record('active order draft cancellation is deterministic and non-submitting', cancellation, [
  [cancellation.requiresModel === false, 'draft cancellation depended on the model'],
  [cancellation.reasonCode === 'DRAFT_CANCELLED', 'draft cancellation used the wrong reason'],
  [cancellation.applyDraft === true, 'cancelled state was not persisted'],
  [cancellation.submitDraft === false, 'draft cancellation tried to submit an order'],
  [cancellation.draftState?.stage === 'cancelled' && cancellation.draftState?.orders?.length === 0, 'cancelled draft was not cleared'],
]);

const modelCases = [
  {
    name: 'model: team question',
    built: build('How many people are in the Getit team?'),
    check: (result) => [
      [result.decision === 'respond_now', 'team question did not get a direct reply'],
      [result.schemaValid === true, 'team output failed the structured schema'],
      [/two|2|nathan|mum|mom|mother/i.test(result.responseBody || ''), 'team answer ignored supplied team knowledge'],
    ],
  },
  {
    name: 'model: general Getit question',
    built: build('What is Getit and what does it do?'),
    check: (result) => [
      [result.decision === 'respond_now', 'general Getit question did not get a reply'],
      [result.schemaValid === true, 'general output failed the structured schema'],
      [/local|shopping|collection|delivery|whatsapp/i.test(result.responseBody || ''), 'general answer missed Getit identity'],
    ],
  },
  {
    name: 'model: follow-up context',
    built: build('And who runs it?', {
      ...clone(baseContext),
      recent_messages: [
        { direction: 'inbound', body: 'What is Getit?' },
        { direction: 'outbound', body: 'Getit is a local shopping and delivery service built in Villiers.' },
      ],
    }),
    check: (result) => [
      [result.decision === 'respond_now', 'follow-up was not answered'],
      [result.schemaValid === true, 'follow-up output failed the structured schema'],
      [/nathan|mum|mom|mother|family/i.test(result.responseBody || ''), 'follow-up lost company context'],
    ],
  },
  {
    name: 'model: order follow-up after deterministic entry',
    built: build('milk and bread', {
      ...clone(baseContext),
      recent_messages: [
        { direction: 'outbound', body: 'Absolutely. Send me the items and quantities you need. You can include a preferred shop too.' },
      ],
    }),
    check: (result) => [
      [result.decision === 'respond_now', 'order follow-up was not answered'],
      [result.schemaValid === true, 'order follow-up output failed the structured schema'],
      [modelCases[3].built.safetyFlags?.orderFlowEntered === true, 'explicit item prompt did not mark the next message as order context'],
      [result.applyDraft === true, 'order follow-up did not create a grounded draft'],
      [(result.draftState?.orders?.[0]?.items?.length || 0) >= 2, 'order follow-up lost one or more visible items'],
    ],
  },
  {
    name: 'model: current payment method',
    built: build('How do I pay for my order?'),
    check: (result) => [
      [result.decision === 'respond_now', 'payment-method question was not answered'],
      [result.schemaValid === true, 'payment-method output failed the structured schema'],
      [/cash/i.test(result.responseBody || ''), 'current cash-only policy was missing'],
      [!/paystack|card|electronic payment/i.test(result.responseBody || ''), 'inactive electronic payment method was offered'],
    ],
  },
  {
    name: 'model: ambiguous but answerable input',
    built: build('Can you tell me more?', {
      ...clone(baseContext),
      recent_messages: [
        { direction: 'inbound', body: 'Why is Getit different?' },
        { direction: 'outbound', body: 'Getit is built locally for Villiers.' },
      ],
    }),
    check: (result) => [
      [result.decision === 'respond_now', 'ambiguous follow-up was suppressed or handed off'],
      [result.schemaValid === true, 'ambiguous follow-up failed factual/schema validation'],
      [Boolean(result.responseBody), 'ambiguous follow-up reply was empty'],
      [/local|villiers|whatsapp|human|family/i.test(result.responseBody || ''), 'ambiguous follow-up lost the visible Getit topic'],
    ],
  },
  {
    name: 'model: exact quantities and preferred shop',
    built: build('2 milks and 1 loaf of brown bread from OK Villiers.', {
      ...clone(baseContext),
      recent_messages: [
        { direction: 'outbound', body: 'Absolutely. Send me the items and quantities you need. You can include a preferred shop too.' },
      ],
    }),
    check: (result) => {
      const items = result.draftState?.orders?.[0]?.items || [];
      const milk = items.find((item) => /milk/i.test(item?.requested_text || ''));
      const bread = items.find((item) => /bread|loaf/i.test(item?.requested_text || ''));
      const shopText = JSON.stringify(result.draftState?.orders?.[0] || {});
      return [
        [result.decision === 'respond_now', 'exact order list was not answered'],
        [result.schemaValid === true, 'exact order list failed structured validation'],
        [result.applyDraft === true, 'exact order list did not create a draft'],
        [items.length >= 2, 'milk and bread were grouped into one line'],
        [Number(milk?.quantity) === 2, 'milk quantity was not preserved as 2'],
        [Number(bread?.quantity) === 1, 'bread quantity was not preserved as 1'],
        [/OK Villiers/i.test(shopText), 'preferred shop was not preserved'],
        [!/branch address|shop address|store address/i.test(result.responseBody || ''), 'customer was asked to provide the retailer address'],
        [/delivery address|location pin/i.test(result.responseBody || ''), 'customer was not asked for the missing delivery location'],
      ];
    },
  },
];

for (const modelCase of modelCases) {
  try {
    const { result, elapsedMs } = await runModel(modelCase.built);
    record(modelCase.name, result, modelCase.check(result), { elapsedMs });
  } catch (error) {
    results.push({
      name: modelCase.name,
      passed: false,
      failures: [error.message],
      decision: null,
      reasonCode: 'MODEL_TEST_ERROR',
      schemaValid: false,
      responseBody: null,
    });
  }
}

const modelResults = results.filter((result) => result.name.startsWith('model:'));
const structuredValid = modelResults.filter((result) => result.schemaValid === true).length;
const summary = {
  passed: results.every((result) => result.passed),
  workflow: workflow.name,
  evaluatedModel: testModel || 'workflow-default',
  evaluatedNumCtx: testNumCtx || 'workflow-default',
  noLiveSends: true,
  total: results.length,
  passedCount: results.filter((result) => result.passed).length,
  failedCount: results.filter((result) => !result.passed).length,
  modelStructuredOutput: {
    valid: structuredValid,
    total: modelResults.length,
    rate: modelResults.length ? structuredValid / modelResults.length : 0,
  },
  results,
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 1;
