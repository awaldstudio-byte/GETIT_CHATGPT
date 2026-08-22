import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outputFile = process.argv[2];
if (!outputFile) throw new Error('Output file is required.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const shopFlow = JSON.parse(fs.readFileSync(path.join(root, 'supabase', 'whatsapp-flows', 'getit-shop-application-v1.json'), 'utf8'));
const driverFlow = JSON.parse(fs.readFileSync(path.join(root, 'supabase', 'whatsapp-flows', 'getit-driver-application-v1.json'), 'utf8'));
const endpoint = 'https://uoqgbaqffmxdnenxfdjr.supabase.co/functions/v1/meta-whatsapp-flow-admin';
const credentials = { httpHeaderAuth: { id: 'q4ozFODidcOtHk7Y', name: 'Getit Supabase Secret Key' } };

const http = (name, position, body) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  position,
  parameters: {
    method: 'POST',
    url: endpoint,
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody: JSON.stringify(body),
    options: { timeout: 30000 },
  },
  credentials,
});

const workflow = {
  id: 'GETIT_WHATSAPP_FLOW_PROVISION_ONCE',
  name: '[ONE-TIME] Getit WhatsApp Flow Provisioning',
  active: false,
  nodes: [
    {
      id: 'manual-trigger',
      name: 'Run once',
      type: 'n8n-nodes-base.manualTrigger',
      typeVersion: 1,
      position: [-800, 0],
      parameters: {},
    },
    http('Inspect Meta Account', [-560, 0], { action: 'inspect' }),
    http('Provision Shop Flow', [-300, 0], { action: 'provision_draft', name: 'Getit Shop Application v1', flow_json: shopFlow }),
    http('Provision Driver Flow', [-40, 0], { action: 'provision_draft', name: 'Getit Driver Application v1', flow_json: driverFlow }),
    http('Publish Shop Flow', [220, 0], { action: 'publish', flow_id: '1756566568719813', expected_name: 'Getit Shop Application v1' }),
    http('Publish Driver Flow', [480, 0], { action: 'publish', flow_id: '2604256086674509', expected_name: 'Getit Driver Application v1' }),
    {
      id: 'summarise-flows',
      name: 'Summarise Flows',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [740, 0],
      parameters: {
        mode: 'runOnceForAllItems',
        language: 'javaScript',
        jsCode: "return [{ json: { inspect: $('Inspect Meta Account').first().json, shop: $('Publish Shop Flow').first().json, driver: $('Publish Driver Flow').first().json } }];",
      },
    },
  ],
  connections: {
    'Run once': { main: [[{ node: 'Inspect Meta Account', type: 'main', index: 0 }]] },
    'Inspect Meta Account': { main: [[{ node: 'Provision Shop Flow', type: 'main', index: 0 }]] },
    'Provision Shop Flow': { main: [[{ node: 'Provision Driver Flow', type: 'main', index: 0 }]] },
    'Provision Driver Flow': { main: [[{ node: 'Publish Shop Flow', type: 'main', index: 0 }]] },
    'Publish Shop Flow': { main: [[{ node: 'Publish Driver Flow', type: 'main', index: 0 }]] },
    'Publish Driver Flow': { main: [[{ node: 'Summarise Flows', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1', saveManualExecutions: true, availableInMCP: false },
  pinData: {},
  staticData: null,
  meta: { getitPurpose: 'One-time Meta WhatsApp Flow provisioning; never activate.' },
  tags: [],
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
