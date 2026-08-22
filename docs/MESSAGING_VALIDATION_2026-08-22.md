# Getit production validation — 22 August 2026

## Verified current state

- GETIT-CORE is active and healthy and remains authoritative.
- Meta WhatsApp Cloud API is the configured provider; Chatwoot is disabled and both retired provider callbacks return HTTP 410.
- The Meta ingress rejects an incorrect verification token and an invalid webhook signature. This confirms the application-signature secret is configured without revealing it.
- Dispatch and presence endpoints reject unauthenticated requests.
- Both n8n worker files regenerate deterministically and pass structural, syntax, provider and secret checks.
- The grounded decision suite passes all 16 scenarios with the approved local Ollama model.
- The production dashboard builds successfully on Next.js 16.3.2.
- The production dependency audit reports no known vulnerabilities.
- There are no queued, processing, retrying or dead-letter messaging records, no unresolved messaging incidents, and no active orders, pending payment reviews or partner applications.
- The two stored catalogue sources expired on 17 August 2026. The public catalogue correctly returns zero products and requires checkout revalidation; the dashboard now gives staff an expiry warning.

## Security posture

- All 38 authenticated `SECURITY DEFINER` advisories map to staff-facing RPCs that perform an internal staff-role check. Anonymous execution is absent.
- Critical order submission, event claiming and service verification RPCs are executable only by `service_role`.
- The three tables flagged for RLS without policies deliberately have no anonymous or authenticated DML grants; access is mediated by guarded RPCs or `service_role`.
- Supabase leaked-password protection remains disabled and should be enabled in the Auth dashboard.

## Remaining live launch gate

Keep global messaging mode set to `dry_run`. The remaining proof is one controlled real WhatsApp conversation using the linked Meta number: inbound receipt, ordered worker processing, suppressed dry-run response, staff takeover, controlled outbound delivery/status receipts, location confirmation and atomic order submission. This requires the real WhatsApp/Meta connection and must be performed without customer data or global automation.
