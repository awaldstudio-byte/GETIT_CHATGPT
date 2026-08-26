import fs from 'node:fs';
import path from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Workflow directory is required.');

const files = [
  'getit-messaging-inbound-v1.14.json',
  'getit-messaging-outbound-v1.14.json',
];
const prohibited = [/respond\.io/i, /respondio/i, /chatwoot/i];
const requiredInbound = [
  'Claim Messaging Events',
  'Fetch Meta Voice Audio',
  'Transcribe Voice Audio',
  'Attach Voice Transcript',
  'Restore Conversation Context',
  'Persist Inbound Message',
  'Fetch Messaging Context',
  'Build Safety Decision',
  'Record Final Decision',
  'Queue Decision Response',
  'Finish Inbound Event',
  'Apply Delivery Status',
];
const requiredOutbound = [
  'Claim Outbox Messages',
  'Dispatch Through Protected Meta Function',
];

const results = [];
for (const file of files) {
  const fullPath = path.join(directory, file);
  const raw = fs.readFileSync(fullPath, 'utf8');
  const workflow = JSON.parse(raw);
  const names = workflow.nodes.map(({ name }) => name);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) throw new Error(`${file}: duplicate node name`);

  for (const [source, outputs] of Object.entries(workflow.connections ?? {})) {
    if (!uniqueNames.has(source)) throw new Error(`${file}: unknown connection source ${source}`);
    for (const output of outputs.main ?? []) {
      for (const target of output ?? []) {
        if (!uniqueNames.has(target.node)) throw new Error(`${file}: unknown connection target ${target.node}`);
      }
    }
  }

  for (const item of workflow.nodes.filter(({ type }) => type === 'n8n-nodes-base.code')) {
    Function(item.parameters.jsCode);
  }

  for (const pattern of prohibited) {
    if (pattern.test(raw)) throw new Error(`${file}: prohibited dependency ${pattern}`);
  }
  if (/META_(?:APP_SECRET|WHATSAPP_ACCESS_TOKEN)\s*[:=]/i.test(raw)) {
    throw new Error(`${file}: possible embedded Meta secret`);
  }

  const required = file.includes('inbound') ? requiredInbound : requiredOutbound;
  for (const name of required) {
    if (!uniqueNames.has(name)) throw new Error(`${file}: missing required node ${name}`);
  }

  const modelNode = workflow.nodes.find(({ name }) => name === 'Ask Local Structured Model');
  if (modelNode) {
    if (modelNode.parameters.authentication !== 'none' || modelNode.credentials) {
      throw new Error(`${file}: local model must not receive a credential`);
    }
  }

  const inboundClaim = workflow.nodes.find(({ name }) => name === 'Claim Messaging Events');
  if (inboundClaim && inboundClaim.parameters.jsonBody?.p_limit !== 1) {
    throw new Error(`${file}: single-conversation code path requires an inbound claim limit of one`);
  }

  const dispatchNode = workflow.nodes.find(({ name }) => name === 'Dispatch Through Protected Meta Function');
  if (dispatchNode) {
    const credential = dispatchNode.credentials?.httpHeaderAuth;
    if (credential?.id !== 'q4ozFODidcOtHk7Y') {
      throw new Error(`${file}: protected dispatch is missing its service apikey credential`);
    }
  }

  results.push({ file, nodes: names.length, connections: Object.keys(workflow.connections ?? {}).length });
}

console.log(JSON.stringify({ valid: true, workflows: results }));
