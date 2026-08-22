# Getit production messaging workers

These workflows are the current WhatsApp automation boundary for Getit:

- `getit-messaging-inbound-v1.14.json` claims persisted Meta webhook events, serialises work per conversation, fetches service-area and catalogue grounding, runs the deterministic safety gate, uses the local structured model only for planning, validates every proposed response and draft, persists the decision and draft, and queues only authorised response decisions.
- `getit-messaging-outbound-v1.14.json` claims the canonical Supabase outbox and invokes `meta-whatsapp-dispatch`. The Edge Function performs the final authorization check immediately before any Meta request.

Supabase remains authoritative. AI output never sends directly. The default conversation mode is `dry_run`, so automatic replies are stored as suppressed and confirmations do not create orders. A staff operator must deliberately promote an individual conversation to `automation` after validation.

The human inbox is the Getit Control Centre. Chatwoot and Respond.io are removed and must not be added to either workflow.

Version 1.18 restores the full recovered Getit ordering behaviour: recipe and general food help are supported, food discussion cannot silently become an order, normal delivery is Villiers-only, order-action claims require an actual persisted draft mutation, and expired catalogue rows cannot be presented as current price or stock. Version 1.18.1 adds properly structured recipe replies and relevant cooking questions. Version 1.18.2 allows explicitly operator-approved temporary special prices to be quoted through their recorded validity date while continuing to treat stock as unverified. Run `tools/test-grounded-decision-regressions.mjs` against the configured local Ollama model before promoting any conversation from `dry_run`.

## Installation

1. Generate the workflow JSON with `tools/build-production-messaging-workflows.mjs`.
2. Validate it with `tools/validate-production-workflows.mjs`.
3. Import both JSON files into the existing Getit n8n project.
4. Bind the `Getit Supabase Secret Key` HTTP-header credential to the Supabase RPC and Edge Function request nodes.
5. Publish both workflows, restart n8n, and validate in `dry_run` before enabling any individual conversation.

The n8n credential stores only an `apikey` header. The dispatcher validates that modern `sb_secret_` key through the side-effect-free `verify_messaging_service_access` RPC; no secret belongs in a workflow file, log, or repository.
