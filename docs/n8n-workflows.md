# n8n workflow guide

## Import and configuration

Import `workflows/00-analyzer-http-retry.json` first, then
`workflows/01-campaign-audit-review.json`, from the n8n editor or with
`n8n import:workflow`. The main workflow references the retry workflow by its
stable portable ID, so both must keep their source IDs; n8n 2.39's CLI rejects
imports without one. The sources contain no instance-generated ID, credential
reference, or secret. If an ID already exists, import into a clean project.
Publish the retry workflow before the main workflow.

Create one **Header Auth** credential named `PitchTrace Analyzer`:

- Header name: `X-API-Key`
- Header value: the same secret used by `ANALYZER_API_KEY`

Attach it to every HTTP Request node in both workflows (five in the main
workflow, `Analyzer Request` in the retry workflow). Credential IDs are intentionally absent
from the export. `Workflow Config` is the single place for:

- analyzer base URL (`http://analyzer:8080` inside Compose),
- polling interval (30 seconds),
- maximum attempts (120).

Validate all HTTP Request nodes after attaching the credential, save, then
publish the workflow. The Form uses n8n user authentication and execute access;
do not change it to anonymous access for production.

## Operator flow

1. Open the production Form URL while signed in to n8n.
2. Enter campaign name, sector, and city; upload a UTF-8 CSV matching
   `examples/companies.csv` (maximum 50 non-empty rows).
3. Review the analyzer's real import summary and explicitly choose **Başlat**.
4. The workflow queues idempotent campaign audits and polls every 30 seconds.
   It stops after 120 checks and reports timeout; it never uses a tight loop.
5. When terminal, one retry-safe `GET /campaigns/{id}/draft-contexts` returns
   the draft context of every company with a completed, scored audit and a
   contact. Companies that are suppressed, below the campaign's `min_score`,
   or without a completed audit are listed as skipped with their reason
   instead of failing the review.
6. For each eligible company the workflow builds a deterministic two-claim test
   draft from a real outreach-eligible finding and posts it to the analyzer,
   where V1–V16 remain authoritative. A company without such a finding or
   screenshot, or whose draft the validator rejects (`422`), is skipped with
   its reason; any other draft-creation failure stops after one call.
7. A single review page lists every draft: company/domain, recipient, score,
   rendered draft, and a screenshot from an analyzer-issued short-lived
   preview URL minted per draft. Skipped companies and their reasons are shown
   at the top.
8. Each draft needs its own explicit **Onayla** or **Reddet**; there is no
   default and no "approve all". Rejected drafts call neither approval nor
   export and stay `pending_review`. Each approved draft records approval, then
   requests `.eml`. Export repeats suppression checking; a late
   `409 SUPPRESSED` stops the workflow.
9. A successful page downloads the `.eml` (one approved draft) or a single
   `.zip` of `.eml` files (several), and states explicitly that no email was
   sent. If nothing was approved, or no draft could be built, a text page says
   so and nothing is exported.

There is no OpenAI credential or model call in this phase. Replace the
deterministic builder only in a later phase; never bypass analyzer validation.

## Screenshot preview

n8n requests `POST /artifacts/{id}/preview-access` using its server-side Header
Auth credential. The browser receives only an artifact-bound, read-only URL;
the analyzer API key is never included. The URL expires after ten minutes by
default, cannot select another artifact or path, and returns 404 after retention
deletion. After expiry, use the review form's refresh link (reloading the page
shows the same expired URL).

The runtime suite ([n8n-runtime-testing.md](n8n-runtime-testing.md)) opens the
real published Form in Chromium and verifies that the image decodes
(`naturalWidth > 0`), that the real token expires, that the refresh link mints
a new token for the same artifact only, and that no approval/export/audit/draft
call happens meanwhile. Screenshot bytes and credential IDs are not embedded in
the workflow export, and n8n does not mount the analyzer artifact volume.

## Failure behavior

The central retry policy permits only network errors/timeouts and
408/425/429/500/502/503/504, with three total attempts, capped exponential
backoff, jitter, and bounded Retry-After handling. Permanent 4xx responses
(400, 401, 403, 404, every 409, 422) stop after one call. Operators must not
enable generic retry-on-fail independently on individual nodes.

When the retry workflow gives up, it stops the calling execution with a
sanitized message such as `ANALYZER_REQUEST_FAILED (HTTP 503, 3 deneme, Get
Audit Progress): …` or `SUPPRESSED (HTTP 409, 1 deneme, …): …`. Response
bodies, headers, URLs and stack traces are not included; the main workflow
never continues with a failed analyzer result.

The main workflow calls `00-analyzer-http-retry.json` for audit start/progress,
campaign draft contexts and preview access (once per draft, through a
`Loop Over Drafts` node; n8n 2.x deprecates per-item sub-workflow mode). Campaign creation, CSV import, draft creation,
approval and `.eml` export are not automatically retried because their result
can be ambiguous or they append state. See `retry-idempotency-matrix.md`.
These behaviors are verified on real n8n 2.39.10 executions by
`npm run test:n8n-runtime`.

If a preview expires, the review form shows a refresh link bound to the same
artifact. The refresh handle can mint only a new short-lived read token, never
accepts an artifact ID or URL from the browser, and does not approve or recreate
the audit/draft. The old token remains expired.

Import validation, artifact expiry, timeout, late suppression, and export
errors remain visible in the execution; per-company skip reasons appear on the
review page. n8n execution data must be treated as sensitive and pruned/backed up
according to the installation guide.
