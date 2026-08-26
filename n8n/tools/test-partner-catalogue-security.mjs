import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const json = (path) => JSON.parse(read(path));

const workflow = json('n8n/workflows/getit-messaging-inbound-v1.14.json');
const builder = read('n8n/tools/build-production-messaging-workflows.mjs');
const media = read('supabase/functions/meta-whatsapp-catalogue-media/index.ts');
const importer = read('supabase/functions/import-catalogue-batch/index.ts');
const publisher = read('supabase/functions/publish-catalogue/index.ts');
const flow = json('supabase/whatsapp-flows/getit-shop-application-v1.json');
const sql = [
  read('supabase/GETIT_PARTNER_CATALOGUE_ONBOARDING_v1_22_0.sql'),
  read('supabase/GETIT_PARTNER_CATALOGUE_INTAKE_HARDENING_v1_22_2.sql'),
  read('supabase/GETIT_PARTNER_CATALOGUE_IMPORT_LINK_v1_22_3.sql'),
].join('\n');
const regressionSql = read('supabase/tests/GETIT_PARTNER_CATALOGUE_SECURITY_REGRESSIONS.sql');

const results = [];
const check = (name, condition) => {
  assert.ok(condition, name);
  results.push(name);
};
const includes = (source, needle) => source.includes(needle);
const node = (name) => workflow.nodes.find((entry) => entry.name === name);

check('workflow calls partner processor v5', includes(builder, 'process_partner_application_message_v5'));
check('catalogue upload session command is explicit', includes(sql, 'UPLOAD CATALOGUE'));
check('catalogue upload session has a 30 minute expiry', /interval\s+'30 minutes'/i.test(sql));
check('inbound lease allows long media transfers', includes(builder, 'p_lease_seconds: 600'));

const mediaNode = node('Save Partner Catalogue Media');
check('workflow contains the dedicated catalogue media node', Boolean(mediaNode));
check('catalogue media node fails closed', mediaNode?.parameters?.options?.response?.response?.neverError === false);
check('catalogue media node retries transient failures', mediaNode?.retryOnFail === true && mediaNode?.maxTries === 3);
check('catalogue media node has bounded timeout', mediaNode?.parameters?.options?.timeout === 45000);

check('media endpoint requires service authentication', includes(media, 'SERVICE_AUTH_REQUIRED'));
check('media endpoint verifies the service credential', includes(media, 'verify_messaging_service_access'));
check('upload context identifiers are validated', includes(media, 'UPLOAD_CONTEXT_INVALID'));
check('upload context is verified server side', includes(media, 'get_partner_catalogue_upload_context_v1'));
check('catalogues are capped at 25 MiB', includes(media, '25 * 1024 * 1024'));
check('only approved catalogue MIME types are allowed', includes(media, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
check('PDF active content is rejected', /JavaScript\|JS\|OpenAction\|Launch\|EmbeddedFile/.test(media));
check('PDF requires an EOF marker', includes(media, '%%EOF'));
check('XLSX requires workbook structure', includes(media, '[Content_Types].xml') && includes(media, 'xl/workbook.xml'));
check('XLSX macro payloads are rejected', includes(media, 'vbaProject'));
check('CSV rejects NUL bytes', includes(media, 'bytes.includes(0)'));
check('CSV requires valid UTF-8', includes(media, 'new TextDecoder("utf-8", { fatal: true })'));
check('terminal validation failures are acknowledged once', includes(media, 'terminal: true') && includes(media, 'reply(200'));
check('missing Meta configuration remains retryable', includes(media, 'META_CONFIGURATION_MISSING') && includes(media, 'terminal: false'));
check('Meta lookup 5xx remains retryable', includes(media, 'META_MEDIA_LOOKUP_UNAVAILABLE'));
check('Meta download 5xx remains retryable', includes(media, 'META_MEDIA_DOWNLOAD_UNAVAILABLE'));
check('storage outage remains retryable', includes(media, 'CATALOGUE_STORAGE_UNAVAILABLE'));
check('finalisation failure removes the orphaned object', includes(media, '.remove([storagePath])'));
check('saved uploads are idempotent', includes(media, 'already_saved: true'));

check('import endpoint authenticates staff', includes(importer, 'Staff catalogue access required'));
check('dispatcher may stage but not publish', includes(importer, 'owner", "admin", "service_role') && includes(importer, 'Owner or admin approval is required'));
check('partner import requires ready-for-review state', includes(importer, 'data.status !== "ready_for_review"'));
check('partner import requires explicit new source and shop', includes(importer, 'Partner catalogue imports require a new source with an explicit shop_id'));
check('special dates inherit reviewed submission dates', includes(importer, 'data.valid_from') && includes(importer, 'data.valid_to'));
check('specials require start and end dates', includes(importer, 'has a special price without start and end dates'));
check('special dates cannot escape source window', includes(importer, 'outside the approved source validity window'));
check('cross-shop items are rejected', includes(importer, 'cannot target a different shop'));
check('partner submission is linked to source and batch', includes(importer, 'catalogue_source_id') && includes(importer, 'import_batch_id'));

check('publisher uses the dynamic catalogue feed', includes(publisher, '/functions/v1/catalogue-feed'));
check('publisher does not write static storage objects', !includes(publisher, '.storage.'));
check('publisher checks settings mutation errors', includes(publisher, 'settingsError'));
check('publisher checks shop mutation errors', includes(publisher, 'shopUpdateError'));
check('publisher reports static exports retired', includes(publisher, 'static_exports_retired: true'));

const screens = flow?.screens ?? flow?.data?.screens ?? [];
const flowText = JSON.stringify(flow);
check('shop application uses constrained business categories', includes(flowText, 'Grocery / supermarket / general dealer'));
check('shop application includes an Other category', includes(flowText, 'Other'));
check('regulated shops are visibly separated', includes(flowText, 'Licensed liquor') && includes(flowText, 'Pharmacy'));
check('application warns that submission is not activation', /does not (?:activate|make the shop live)|not active/i.test(flowText));

check('completion RPC is revoked from anonymous roles', /revoke (?:all|execute) on function public\.complete_partner_catalogue_upload_v1[\s\S]*from public, anon, authenticated/i.test(sql));
check('private submissions use row-level security', /alter table public\.partner_catalogue_submissions enable row level security/i.test(sql));
check('unsolicited catalogue media has an adversarial SQL test', includes(regressionSql, 'unsolicited media created a catalogue submission'));
check('expired upload sessions have an adversarial SQL test', includes(regressionSql, 'expired upload session accepted media'));
check('duplicate delivery has an idempotency SQL test', includes(regressionSql, 'catalogue replay was not idempotent'));
check('IDOR completion has an adversarial SQL test', includes(regressionSql, 'application IDOR was accepted'));
check('path escape has an adversarial SQL test', includes(regressionSql, 'storage path escape was accepted'));
check('unreviewed uploads cannot become live', includes(regressionSql, 'unreviewed partner upload was promoted into the live catalogue'));

console.log(`Partner catalogue security regression checks passed: ${results.length}`);
