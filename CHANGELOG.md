# Changelog

Notable changes to PitchTrace are recorded here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/) pre-release conventions.

## [Unreleased]

### Added

- `GET /campaigns/{id}/draft-contexts`: draft context for every eligible
  company in a campaign, with a reason (`SUPPRESSED`, `SCORE_BELOW_THRESHOLD`,
  `DRAFT_CONTEXT_NOT_FOUND`) for each skipped one, and the screenshot artifact
  to preview.

### Changed

- The n8n review now covers the whole campaign instead of only the first
  imported company. One page shows every draft with its own preview and
  requires an explicit Onayla/Reddet per draft; approved drafts download as one
  `.eml` or, when several, as a single `.zip`. Companies without an eligible
  finding or screenshot, or whose draft the validator rejects, are skipped with
  their reason instead of failing the execution.
- The unused `rejection_note` field was removed from the review form; it was
  never sent to the analyzer.

## [0.1.0-alpha.8] - 2026-09-26

First end-to-end human-reviewed alpha and the first tagged GitHub pre-release.
Earlier `0.1.0-alpha.1` to `0.1.0-alpha.7` values were in-repository
development markers only; they were never tagged or published as releases, so
this entry summarizes everything up to this point. Release notes:
[docs/releases/v0.1.0-alpha.8.md](docs/releases/v0.1.0-alpha.8.md).

### Added

- Fastify analyzer API with API-key protection, idempotent PostgreSQL migrations
  and sanitized `/livez` and `/readyz` probes.
- PostgreSQL audit worker queue (`FOR UPDATE SKIP LOCKED`, concurrency capped at
  two, stale-lock recovery, graceful shutdown).
- Robots-aware crawler of at most five pages (home, contact, about, two sitemap
  selections) with per-domain pacing and transfer budgets.
- Playwright mobile audit at 375×812 with screenshot artifacts.
- Finding catalog of 28 codes across mobile, technical, performance, SEO,
  conversion and contact observations, with page- and site-level semantics.
- Artifact storage with API-key protected access.
- LCP, TTFB and page-weight measurements; optional PageSpeed Insights enrichment.
- Deterministic `scoring.v1` opportunity scoring (0–100).
- CSV import of at most 50 companies per file with per-row result codes,
  deduplication, suppression checks and partial success.
- Campaign-wide audit orchestration and aggregate progress polling.
- Evidence-linked structured draft model with V1–V16 claim validation and
  server-side body rendering.
- Human approval gate and `.eml` export.
- n8n 2.39.10 infrastructure behind an optional Compose profile with its own
  PostgreSQL database.
- Human-approved n8n campaign workflow: CSV → audit → evidence draft → review →
  `.eml`.
- Status-aware analyzer HTTP retry sub-workflow (`00-analyzer-http-retry.json`).
- Short-lived artifact preview tokens with same-artifact refresh.
- Backup/restore scripts and an isolated restore drill.
- Pilot readiness check (`npm run pilot:check`).
- GitHub Actions CI, Docker smoke workflow and real n8n runtime tests.

### Security

- Rejection of private, loopback, link-local, reserved and metadata IPv4/IPv6
  targets, including IPv4-mapped IPv6, NAT64 and 6to4.
- SSRF validation on every redirect hop.
- SSRF protection for every browser subresource request.
- DNS pinning to the validated address to mitigate rebinding, preserving the
  original Host header and TLS SNI.
- WebSockets and service workers blocked; popups and downloads closed or
  cancelled.
- Artifact path traversal protection.
- CSV formula injection protection (`=`, `+`, `-`, `@` cells rejected).
- Preview tokens scoped to a single artifact with a short expiry.
- The analyzer API key is never exposed to the browser.
- Committed workflow exports contain no secrets or credential data.
- Fail-closed analyzer retry behavior with sanitized errors.
- Suppression re-checked late, at `.eml` export time.

### Changed

- Analyzer failures in the n8n workflow stop the run with a sanitized error
  instead of silently continuing.
- `409 SUPPRESSED` is handled as an explicit business outcome and is never
  retried.
- Runtime readiness is reported separately from production readiness;
  `production_ready` stays `false` until deployment gates are verified.
- n8n uses a database and credentials isolated from the analyzer database.

### Known limitations

- No real LLM/OpenAI integration; drafts are deterministic.
- No automatic email sending.
- No reply tracking.
- No production deployment has been performed.
- Host/cloud egress firewall must be enforced in the target environment.
- n8n editor access policy must be decided in the target environment.
- The external task-runner staging decision is pending.
- CLS is experimental and excluded from outreach claims and scoring.
- Score thresholds are not yet calibrated with real pilot data.

[0.1.0-alpha.8]: https://github.com/mratsag/pitchtrace/releases/tag/v0.1.0-alpha.8
