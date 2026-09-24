# Installation

Local development uses `.env.example` and the root Compose files. Production preparation lives in `deploy/`; no deployment, DNS change, or certificate issuance is performed by this repository.

Generate independent random values for database passwords, `ANALYZER_API_KEY`, `PREVIEW_TOKEN_SECRET`, and `N8N_ENCRYPTION_KEY`. Never reuse the analyzer key as a preview secret. Production startup rejects missing, short, or placeholder analyzer/preview secrets. Use HTTPS and expose only the reverse proxy.

Validate configuration before launch, import the workflow while inactive, configure its header credential in n8n, and run `npm run pilot:check`. See `deploy/README.md` and the operations guides.
