import fs from 'node:fs';

const workflowPath = process.argv[2] || 'n8n/workflows/getit-messaging-inbound-v1.33.json';
const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const code = (name) => workflow.nodes.find((node) => node.name === name)?.parameters?.jsCode;
const buildCode = code('Build Safety Decision');
const validateCode = code('Validate Model Decision');
if (!buildCode || !validateCode) throw new Error('Required workflow code nodes are missing.');

const execute = (script, named, input = {}, current = {}) => new Function('$','$input','$json','structuredClone',script)(
  (name) => ({ item: { json: named[name] } }),
  { first: () => ({ json: input }) },
  current,
  undefined,
);

const grounding = {
  service_area: { launch_town: 'Villiers', normal_orders_outside_launch_town: false },
  catalogue: { active_public_rows: 0, current_price_quote_allowed: false },
  matches: [],
};

const requirement = (key, title, level = 'optional') => ({
  id: key === 'catalogue_preference'
    ? '11111111-1111-4111-8111-111111111111'
    : '22222222-2222-4222-8222-222222222222',
  key, title, requirement_level: level, status: 'requested',
  guidance: key === 'catalogue_preference'
    ? 'Offer PDF, photos, spreadsheet, website/menu link, or shop-on-request.'
    : 'Help the shop send what it already has. Do not require a custom catalogue.',
});

const context = (current, next = null) => ({
  conversation: { mode: 'automation', status: 'open' },
  customer: { full_name: 'Test Shop Owner' },
  order_draft: { version: 0, state: { stage: 'idle', orders: [] } },
  recent_orders: [],
  recent_messages: [{ direction: 'outbound', body: 'I will guide you one simple step at a time. You can ask questions at any point.' }],
  partner_onboarding: {
    active: true,
    application_id: '33333333-3333-4333-8333-333333333333',
    business_name: 'Test Villiers Shop',
    state: { state: 'in_progress', customer_messaging_started: true },
    current_requirement: current,
    next_requirement: next,
    requirements: [current,next].filter(Boolean),
    verified_form_facts: [
      { field_key: 'shop_trading_name', label: 'Shop / trading name', value: 'Test Villiers Shop' },
      { field_key: 'shop_address', label: 'Full shop address', value: 'Villiers' },
    ],
    operating_facts: [
      'Getit is a local shopping, collection and delivery service. Shops remain independent and control prices, stock and trading hours.',
      'Customers ask on WhatsApp. Getit checks current shop price and availability, substitutions and the fee before the customer approves.',
      'For now customer payments are cash only.',
      'A catalogue is optional, including shop-on-request.',
      'Nothing is active until staff confirms activation in writing.',
    ],
    rules: ['Answer the shop question first.','Ask at most one next question.','Never disclose technical details.'],
  },
});

const build = (body, onboardingContext) => execute(buildCode, {
  'Continue Partner Processing': {
    body, messageType: 'text', payload: {}, messageId: 9001,
    waitlistResult: { handled: false }, partnerResult: { handled: false },
  },
  'Fetch Messaging Context': onboardingContext,
}, grounding)[0].json;

const validate = (built, payload) => execute(validateCode, { 'Build Safety Decision': built }, {}, payload)[0].json;

const run = async (name, body, onboardingContext, check) => {
  const built = build(body, onboardingContext);
  if (!built.requiresModel || built.safetyFlags?.partnerOnboarding !== true) {
    return { name, passed: false, failures: ['guided onboarding did not reach the structured model'] };
  }
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(built.ollamaRequest),
  });
  const payload = await response.json();
  const result = validate(built, payload);
  const failures = check(result).filter(Boolean);
  return {
    name, passed: failures.length === 0, failures,
    decision: result.decision, reasonCode: result.reasonCode,
    responseBody: result.responseBody, action: result.partnerOnboardingAction,
    elapsedMs: Date.now()-started,
  };
};

const preference = requirement('catalogue_preference','Choose the easiest catalogue option');
const material = requirement('catalogue_material','Receive stock list or pricing material');
const cases = [
  ['question to a question is answered first','Okay, can I send it here or write it for you?',context(material), (r) => [
    r.decision !== 'respond_now' && 'question did not receive a direct reply',
    !/here|send|write|type/i.test(r.responseBody || '') && 'reply did not answer how to provide the information',
    r.partnerOnboardingAction?.outcome === 'captured' && 'a question was incorrectly treated as a complete answer',
  ]],
  ['shop-on-request keeps catalogue optional','We do not have a catalogue. Please contact us when a customer asks for something.',context(preference,material), (r) => [
    r.partnerOnboardingAction?.outcome !== 'captured' && 'explicit shop-on-request choice was not captured',
    /must|required|need to send/i.test(r.responseBody || '') && 'optional catalogue was presented as mandatory',
  ]],
  ['public operating question is answered without confidential detail','How does it work when a customer wants something from our shop?',context(preference,material), (r) => [
    !/customer|whatsapp|getit|price|availability|shop/i.test(r.responseBody || '') && 'public process was not explained',
    /prompt|database|api|credential|n8n|supabase/i.test(r.responseBody || '') && 'technical implementation leaked',
    r.partnerOnboardingAction?.outcome === 'captured' && 'process question was incorrectly captured as preference',
  ]],
  ['existing PDF preference advances naturally','We can send our current price list as a PDF here.',context(preference,material), (r) => [
    r.partnerOnboardingAction?.outcome !== 'captured' && 'PDF preference was not captured',
    !/pdf|send|share|here/i.test(r.responseBody || '') && 'reply did not acknowledge the practical PDF route',
  ]],
  ['completed collection waits for staff activation','Is there anything else you need from us?',context(null,null), (r) => [
    /shop is (now )?(active|live)|fully onboarded/i.test(r.responseBody || '') && 'model falsely activated the shop',
    !/staff|team|review|confirm/i.test(r.responseBody || '') && 'reply did not return control to staff review',
  ]],
];

const results = [];
for (const [name,body,onboardingContext,check] of cases) {
  results.push(await run(name,body,onboardingContext,check));
}
const passed = results.filter((item) => item.passed).length;
console.log(JSON.stringify({ workflow: workflow.name, passed, total: results.length, results }, null, 2));
if (passed !== results.length) process.exitCode = 1;
