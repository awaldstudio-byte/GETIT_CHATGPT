# Security policy

## Credential boundary

- The dashboard may receive only the Supabase project URL and publishable key through `NEXT_PUBLIC_` variables.
- Supabase service keys, Meta application secrets, access tokens and webhook verification tokens belong only in their managed secret stores.
- n8n uses a managed credential and must not embed its value in exported workflow JSON.

## Data and action boundary

- Supabase GETIT-CORE remains the source of truth.
- AI may propose a response or draft only through the validated worker path; it cannot send to Meta or submit an order directly.
- Order confirmation uses the atomic `confirm_and_submit_messaging_order_draft_v1` RPC and rejects missing or unconfirmed locations.
- Staff-facing `SECURITY DEFINER` RPCs must keep their internal role checks. Service-only messaging RPCs must not be granted to `anon` or `authenticated`.
- Report suspected vulnerabilities privately to the repository owner; do not include live customer data, tokens or complete webhook payloads in an issue.
