# Getit messaging production validation — 10 August 2026

## Current production state

- GETIT-CORE remains authoritative.
- Meta WhatsApp Cloud API is the only messaging transport.
- The Getit Control Centre is the only human inbox.
- Chatwoot and Respond.io callbacks return permanent HTTP 410 responses.
- New conversations default to `dry_run`.
- The production inbound and outbound n8n workers are published and are the only active n8n workflows.
- Operator messaging health is healthy with no pending work, dead letters, manual reviews, or open incidents after synthetic cleanup.

## Validated safely in dry run

- Duplicate ingress idempotency: the duplicate returned the original event and was not inserted twice.
- Two rapid messages in one conversation: both were processed in order; greeting produced a suppressed `light_ack`, opt-out produced `no_response` and no outbox row.
- Multiple customer isolation: independent conversations were persisted and decided independently.
- Human review: refund/payment language moved the conversation to `human` and `waiting_for_staff` with a handoff record and no automatic send.
- Structured order draft: a valid one-order draft reached `awaiting_confirmation`; its safe summary was suppressed in dry run.
- Dry-run confirmation: `YES` created `DRY_RUN_DRAFT_CONFIRMATION`, moved to human review, preserved the draft, and created zero orders.
- Separate orders: two addresses stayed as two separate draft orders and produced a deterministic confirmation summary.
- Location pin: coordinates were normalized without being mistaken for a security PIN; the response asked only for the missing items.
- Unverified facts: model output is prevented from asserting price, stock, payment, order number, status, or delivery timing.
- Staff reply idempotency: the same staff idempotency key created one message and one outbox record.
- Last-second sender authorization: the dispatcher accepted only a verified Supabase service `apikey` and reached the canonical authorization RPC.
- Missing Meta configuration: the sender recorded `META_CONFIGURATION_MISSING` without calling Meta.
- Unknown delivery status: the canonical status RPC returned `not_found` without contaminating message state.
- All synthetic conversations, messages, drafts, decisions, events, outbox records, incidents, and customers were removed after validation.

## Remaining launch gate

The Meta delivery secrets are not currently configured in the Supabase Edge Function secret store, and ingress explicitly reports that `META_APP_SECRET` is missing. The webhook verification-token path is present and rejects an invalid token correctly. Configure `META_APP_SECRET`, `META_GRAPH_VERSION`, `META_WHATSAPP_PHONE_NUMBER_ID`, and `META_WHATSAPP_ACCESS_TOKEN`, then verify the real Meta webhook subscription and run one controlled conversation while it remains in `dry_run`. Do not globally enable automation.

Supabase Auth leaked-password protection remains a dashboard setting to enable. Existing authenticated `SECURITY DEFINER` warnings were not blindly revoked because the operator RPCs self-check staff roles and are required by the Control Centre.
