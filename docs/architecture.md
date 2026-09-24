# Architecture and trust boundaries

Caddy is the only public container. It routes n8n UI/Form traffic to n8n and the narrow `/artifact-previews/*` path to analyzer. Analyzer API routes require `X-API-Key`; the browser never receives it. Analyzer owns crawling, findings, artifacts, scoring, suppression, approval and `.eml` export. Separate PostgreSQL databases store analyzer and n8n state.

Preview access is an HMAC-SHA-256 token containing version, `artifact_id`, read-only purpose and expiry. Default TTL is 600 seconds and the hard ceiling is 900. Signature comparison is timing-safe. Tokens are not stored, paths are resolved beneath the artifact root, only trusted raster MIME metadata is served, and responses disable caching, sniffing and referrers. A URL token can remain in browser history and proxy access logs until expiry; proxy logs should redact `/artifact-previews/*` paths.

Application SSRF defenses validate every main-document and subresource redirect, reject unsafe IPv4/IPv6/metadata destinations, pin DNS results while retaining Host/SNI, cap redirects and bytes, and block WebSocket, service worker, popup and download behavior. These controls do not replace network egress policy. Chromium currently uses `--no-sandbox`; TLS errors may be tolerated solely to record certificate findings. Domain pacing is process-local.
