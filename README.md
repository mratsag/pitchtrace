# PitchTrace

Open-source, evidence-linked website auditing and human-approved outreach workflows.

> **Core principle:** Every factual outreach claim must trace back to a recorded website finding.

PitchTrace crawls a small, robots-aware sample of a website, records reproducible findings and screenshots, calculates a deterministic opportunity score, and builds outreach drafts only from linked evidence. It never sends email automatically.

Current version: `0.1.0-alpha.7` · Status: public alpha

## What works today

- Docker Compose stack with PostgreSQL 16 and the analyzer service.
- API-key protected Fastify API and idempotent PostgreSQL migrations.
- PostgreSQL job queue using `FOR UPDATE SKIP LOCKED`, concurrency capped at two, stale-lock recovery, and graceful shutdown.
- SSRF controls for every browser HTTP/HTTPS request and every redirect hop, with DNS validation and connection pinning to a validated IP.
- WebSockets and service workers blocked; popups and downloads disabled.
- Robots-aware crawler of up to five pages: home, contact, about, and two sitemap selections.
- Per-domain request pacing, bounded redirects, response limits, retries, and an audit-wide transfer budget.
- Mobile Chromium rendering at 375×812 with screenshot artifacts.
- 28 finding codes covering mobile, technical, performance, SEO, conversion, and contact observations.
- Page-level versus site-level finding semantics.
- LCP, TTFB, and transfer measurements; optional PageSpeed Insights enrichment.
- Deterministic `scoring.v1` opportunity scoring from 0–100.
- Evidence-linked structured draft output, V1–V16 validation, server-side body rendering, human approval, suppression checks, and `.eml` export.
- No automatic email delivery.

## Experimental features

`PERF_CLS_HIGH` is recorded as experimental because Chromium did not emit reliable `layout-shift` entries in the tested Windows and Linux environments. It cannot be used in outreach claims and does not affect scoring.

## Not completed

- CSV campaign import and campaign-level audit orchestration.
- n8n service integration and the five planned n8n workflows.
- n8n Form review UI and binary screenshot prototype.
- Contact discovery persistence, dashboard, and the 50-company pilot.
- Automatic email sending is intentionally out of scope for v0.1.

## Responsible use

PitchTrace is not a spam tool. It is designed for small, deliberate, human-reviewed outreach. Operators are responsible for robots directives, applicable privacy and marketing laws, suppression requests, and recipient consent requirements. A person must approve every export.

## Security boundaries

- Only HTTP and HTTPS crawl targets are accepted.
- Private, loopback, link-local, reserved, metadata, IPv4-mapped IPv6, NAT64, and 6to4 targets are rejected in production.
- Every browser resource and redirect hop is fetched through a validating, IP-pinned transport. A blocked subresource is recorded without failing the whole audit; an unsafe main document fails the audit.
- DNS rebinding is mitigated by connecting to the exact address returned by the validated lookup while preserving the original Host and TLS SNI.
- WebSockets are blocked in v0.1. Service workers are disabled. Popup pages and downloads are closed or cancelled.
- Application controls do not replace host-level egress filtering. Production operators should still restrict analyzer container egress to public HTTP/HTTPS destinations and deny private, link-local, metadata, and control-plane networks.
- Chromium currently runs with `--no-sandbox` inside the non-root Playwright container. Treat the analyzer as an isolated, disposable service with no secrets beyond its own database/API credentials.

Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Installation

Requirements: Docker and Docker Compose.

```sh
cp .env.example .env
```

Replace `POSTGRES_PASSWORD` and `ANALYZER_API_KEY` in `.env`, then start the stack:

```sh
docker compose up -d --build
```

The default stack does not publish analyzer or PostgreSQL ports. For local development only:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Health check:

```sh
curl http://127.0.0.1:8080/healthz
```

## Development and tests

The integration tests expect PostgreSQL on `127.0.0.1:5433` with database `pitchtrace_test` owned by `pitchtrace`. With the development stack running:

```sh
docker exec pitchtrace-postgres psql -U pitchtrace -d postgres -c "CREATE DATABASE pitchtrace_test OWNER pitchtrace"
cd services/analyzer
npm ci
npm run build
npm run typecheck
npm test
```

Tests use local HTTP/HTTPS fixtures and do not require internet access. The full Docker smoke script is `scripts/smoke.ps1`.

## API overview

- `GET /healthz`
- `POST /campaigns`
- `POST /campaigns/{id}/companies`
- `POST /audits`
- `GET /audits/{id}`
- `POST /audits/{id}/score`
- `GET /artifacts/{id}`
- `GET /drafts/context?company_id=…`
- `POST /drafts`
- `POST /drafts/{id}/approval`
- `GET /drafts/{id}/export?format=eml`
- `POST /suppression`

All endpoints except `/healthz` require `X-API-Key`.

## Documentation

- [Design](docs/design/v0.1-design.md)
- [Finding codes](docs/finding-codes.md)
- [Security notes](docs/security-notes.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

PitchTrace source code and documentation are licensed under the [MIT License](LICENSE). n8n is not included in this repository; see [NOTICE.md](NOTICE.md).
