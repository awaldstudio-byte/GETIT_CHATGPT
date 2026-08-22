# Getit Control Centre

Production operations and messaging workspace for Getit Villiers. Supabase GETIT-CORE is authoritative for customers, catalogue data, order drafts, orders, messaging state, payments and dispatch. Meta WhatsApp Cloud API is the only messaging transport; the Getit Control Centre is the human inbox.

## Safe local setup

1. Install Node.js 24 and pnpm 11.
2. Copy `.env.example` to `.env.local` and fill only the public Supabase URL and publishable key.
3. Run `pnpm install` and `pnpm dev`.

Never place a Supabase secret/service key or Meta credential in a browser environment variable, workflow JSON, Git commit or log.

## Verification

- `pnpm test:ci` regenerates and validates both production n8n workflows, then creates a production Next.js build.
- `pnpm test:decisions` runs the grounded decision regression suite against the approved local Ollama model. Ollama must be running with the configured model available.
- `pnpm audit --prod` checks production dependencies for known vulnerabilities.

New and existing conversations remain individually safety-gated. Do not globally change `messaging_default_mode` from `dry_run`; promote only a controlled conversation after a real end-to-end Meta test.

See `n8n/README.md` for worker installation and `docs/MESSAGING_VALIDATION_2026-08-22.md` for the current verified state and remaining launch gate.
