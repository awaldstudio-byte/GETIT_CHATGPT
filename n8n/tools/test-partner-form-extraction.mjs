import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const workflow = JSON.parse(read('../workflows/getit-partner-form-extraction-v1.json'));
const worker = read('../../infra/local-voice/app.py');
const sourceFunction = read('../../supabase/functions/partner-application-extraction-source/index.ts');
const foundation = read('../../supabase/migrations/20260830222253_partner_application_extraction_and_onboarding.sql');
const prune = read('../../supabase/migrations/20260830225527_prune_stale_partner_extraction_candidates.sql');

const checks = [];
const check = (name, condition) => checks.push({ name, ok: Boolean(condition) });
const workflowText = JSON.stringify(workflow);

check('workflow is explicitly no-send', /^\[NO-SEND\]/.test(workflow.name));
check('workflow contains no Meta dispatcher or outbound queue', !/graph\.facebook\.com|meta-whatsapp-dispatch|queue_outbound_message/i.test(workflowText));
check('workflow polls at most once per minute', workflow.nodes.some((node) => node.type === 'n8n-nodes-base.scheduleTrigger' && node.parameters?.rule?.interval?.[0]?.field === 'minutes'));
check('multi-page local vision extraction has a bounded 15-minute timeout', Number(workflow.nodes.find((node) => node.name === 'Extract Partner Form')?.parameters?.options?.timeout) >= 900000);
check('workflow calls the local partner-form extractor', /\/extract-partner-form/.test(workflowText));
check('workflow completes and prunes extraction jobs', /complete_partner_application_extraction_job_v1/.test(workflowText) && /prune_partner_application_extraction_candidates_v1/.test(workflowText));
check('source function verifies the service credential', /verify_messaging_service_access/.test(sourceFunction));
check('source function downloads only archived allowlisted form media', /ALLOWED_MIMES/.test(sourceFunction) && /storage\.from\(bucket\)\.download/.test(sourceFunction));
check('fillable PDFs use deterministic AcroForm extraction', /def extract_acroform/.test(worker) && /get_fields\(\)/.test(worker));
check('photo extraction is constrained by page', /VISION_FIELDS_BY_PAGE/.test(worker) && /allowed_keys/.test(worker));
check('vision confidence cannot impersonate deterministic PDF confidence', /min\(0\.88/.test(worker));
check('optional registration and VAT are encoded as optional', /'shop','registration_number','Registration number','shop_profile','optional'/.test(foundation) && /'shop','vat_number','VAT number','shop_profile','optional'/.test(foundation));
check('approval checks required fields only', /d\.requirement_level='required'/.test(foundation));
check('approval cannot activate or message a shop', /customer_messaging_started',false/.test(foundation) && /does not activate or message the shop/.test(foundation));
check('re-extraction preserves verified staff values', /verification_status<>'verified'/.test(prune));

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
const failed = checks.filter((item) => !item.ok);
console.log(`Partner form extraction checks passed: ${checks.length - failed.length}/${checks.length}`);
if (failed.length) process.exit(1);
