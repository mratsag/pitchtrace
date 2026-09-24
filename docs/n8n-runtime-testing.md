# n8n runtime verification

`npm run test:n8n-runtime` (or `bash scripts/test-n8n-runtime.sh`) proves the
committed workflows on a **real n8n 2.39.10** instance. JSON parsing and graph
checks (`npm run test:workflows`) are necessary but not sufficient: the first
real run of this suite found three defects that every static test had passed
(see [Defects found by real execution](#defects-found-by-real-execution)).

The suite needs Docker with Compose v2, `bash` and `openssl`. It needs no
repository secret, owner-configured staging instance, or Internet access at
test time (images are pulled/built beforehand).

## What the command does

1. Generates a unique Compose project name `ptn8nrt-<epoch>-<pid>` and fresh
   random values for every password, API key, encryption key, preview signing
   secret, fault-control token and n8n credential ID. Nothing is written to
   disk on the host; values are never printed.
2. Starts `tests/n8n-runtime/compose.yml`: analyzer PostgreSQL, the real
   analyzer, a loopback-only fictional website, the fault proxy, n8n
   PostgreSQL and `docker.n8n.io/n8nio/n8n:2.39.10`.
3. In a one-off n8n CLI container it binds the throwaway Header Auth
   credential into **runtime copies** of the workflows (tmpfs only), then runs
   `n8n import:credentials`, `n8n import:workflow --separate` and
   `n8n publish:workflow` for the retry workflow, the main workflow and a
   test-only webhook harness. n8n then starts and activates them.
4. Creates the owner through n8n's supported first-run endpoint
   (`POST /rest/owner/setup`) with the generated password and logs in.
5. Runs the retry scenarios, the Chromium Form flow, the non-retry failure
   flows and the refresh-handle expiry check (below).
6. Writes `test-results/n8n-runtime/report.json` (git-ignored) plus review
   screenshots, and exits non-zero if any check failed.
7. A cleanup trap runs `docker compose -p <project> down -v` on success,
   failure or interrupt.

Runtime is about 10–12 minutes, dominated by the real 60 s preview TTL and
the real 300 s refresh-handle TTL.

## Isolation

- Standalone Compose file; never combined with `docker-compose.yml` or
  `deploy/compose.production.yml`, which do not reference it.
- One `internal: true` network: no Internet egress (n8n's own update and
  registry calls fail with `EAI_AGAIN`, as intended).
- No service publishes a host port. No Docker socket or host data directory is
  mounted. Both databases and the artifact directory are tmpfs.
- No `container_name` or explicit volume/network name: every resource carries
  the unique project prefix, so existing `pitchtrace-*` volumes, the normal
  n8n and analyzer databases and backups are never touched.
- Data is fictional: campaign names are generated, the company website is
  `site.pitchtrace.test` (served on the analyzer's loopback from
  `tests/n8n-runtime/site/opportunity.html`, a page with deliberate issues so
  the audit clears the workflow's review threshold of 50), the contact is
  `review@pitchtrace.invalid`, the n8n owner is `owner@pitchtrace.test`.
- The analyzer image is built with the fixed tag
  `pitchtrace-n8n-runtime-analyzer:local` and kept as build cache; remove it
  with `docker image rm pitchtrace-n8n-runtime-analyzer:local` if unwanted.

## Fault-injection fixture (test only)

`tests/n8n-runtime/fault-proxy.mjs` exists only in the test directory. It is
not in any production image or Compose file and is started only by the
runtime Compose file.

- It holds the network alias `analyzer`, so the unmodified workflow URL
  `http://analyzer:8080` reaches it; the real analyzer runs as
  `analyzer-upstream`.
- It forwards only to the hard-coded `analyzer-upstream:8080`. It never takes
  a URL, host or port from a request or from the control API, refuses
  absolute-form targets, `CONNECT` and unknown methods, and is not an open
  proxy.
- The control API (port 8081, internal only) requires the generated token and
  accepts only a method, a path pattern (`:uuid` placeholders) and at most ten
  bounded responses: a status (optionally `Retry-After` ≤ 60 s or an
  upper-case error code), `forward: true` (forward to the real analyzer, then
  return the scripted status — an ambiguous failure after the write), or a
  held connection of ≤ 30 s. After the script, requests pass through.
- Scenarios are isolated by a unique scenario ID and by paths containing a
  freshly created campaign/company/artifact UUID; each scenario is deleted
  after use, and each run has its own proxy instance.
- It records, per scenario and per route template, attempt number, time offset,
  returned/upstream status, media type, body size and whether an `X-API-Key`
  header was present. It never records or logs header values, bodies, tokens
  or authorization data.

## Retry scenarios (real executions)

Each scenario calls the published harness webhook, which runs the real
`00-analyzer-http-retry` workflow through n8n's Execute Workflow node. The
report cross-checks the proxy's attempt log against the n8n sub-execution's
`Analyzer Request` run count.

| Scenario | Scripted responses | Expected calls | Expected outcome |
|---|---|---|---|
| `transient-500` (`POST /campaigns/{id}/audits`) | 500 (after real write) → 500 (after real write) → pass-through 202 | 3 | success; exactly 1 audit and 1 job |
| `rate-limit-429` | 429 + `Retry-After: 1` → 200 | 2 | success; second call ≥ 950 ms later |
| `timeout-then-success` | connection held past the 10 s node timeout → 200 | 2 | success |
| `max-retry-503` | 503 → 503 → 503 | 3 (no 4th after 2.5 s) | sanitized `ANALYZER_REQUEST_FAILED (HTTP 503, 3 deneme …)` |
| `permanent-400/401/403/422` | single status | 1 each | sanitized `ANALYZER_REQUEST_FAILED` |
| `permanent-409-suppressed` | 409 `{"error":"SUPPRESSED"}` | 1 | business outcome `SUPPRESSED` |
| `retry-unsafe-503` | 503 with `retry_safe=false` | 1 | no retry |

Every attempt must carry the Header Auth credential, successive attempts must
be ≥ 300 ms apart (no tight loop), and no response may contain a secret or a
stack trace.

## Main workflow, Form and preview (Chromium)

Chromium runs inside the private network and opens the **published** n8n
Form URL. It reaches n8n as `http://localhost:5678` (the runner shares n8n's
network namespace) because n8n 2.39 always marks the Form's OAuth session
cookie `Secure`, which browsers drop on non-localhost plain-http origins;
production uses HTTPS. The browser uses n8n's normal login and its "Allow
access" consent screen; no authentication is bypassed or patched.

Transient faults are armed on all four retry-safe calls of the main workflow
(audit start 500 after the real write, progress 503, draft context 502,
preview access 429 + `Retry-After`). The flow then:

1. submits a fictional campaign and the reserved-domain CSV, sees the import
   summary and chooses **Başlat**;
2. reaches the draft review page after the real audit, draft validation and
   preview minting;
3. verifies the screenshot decodes (`naturalWidth > 0`) from the
   artifact-bound URL on the preview origin;
4. waits for the real token expiry, reloads the Form, verifies the same URL now
   returns 401, the image no longer decodes and the expiry message is visible;
5. clicks the Form's refresh link, verifies the new token differs, is bound to
   the same artifact, and decodes again, while the old token stays rejected;
6. probes tampered, foreign-artifact, cross-purpose and key-less requests from
   the browser (all 401) and a refresh URL with a foreign `artifact_id` query
   (ignored);
7. confirms no approval, export, audit or draft call happened and the draft
   status is unchanged during expiry/refresh;
8. chooses **Onayla**, receives the `.eml` download (deleted after checking;
   nothing is sent);
9. reads the execution: each of the four retry-safe nodes executed the shared
   retry workflow as a sub-execution, and each recovered after exactly two
   HTTP attempts;
10. checks exactly one call each to campaign create, CSV import, draft create,
    approval and export, and exactly one campaign, company, audit, draft,
    approval and outreach-log row.

Browser checks over every request Chromium made: no API key, preview secret,
encryption key, database password, fault-control token or n8n credential ID
in any URL, header or body; no `X-API-Key` header; no request to the internal
analyzer origin or to approval/export; preview responses carry
`Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
`X-Content-Type-Options: nosniff`; no uncaught page error. Expected console
errors are reported separately: the expired image's 401, n8n Form pages
failing to resolve external hosts on the isolated network, and Chromium's
image viewer being refused inline styles by the analyzer's
`default-src 'none'` CSP. Chromium may block the expired image's cross-origin
JSON 401 (ORB) before a response is visible; the suite then confirms the 401
with a real navigation to the same URL.

Non-retry endpoints are then exercised through the real Form with a single
scripted 503 each (campaign create; CSV import, draft create, approval and
export after the real write). Each must be called exactly once, end the
execution in a controlled error, create no duplicate record and show no stack
trace. Finally, after the real 300 s refresh-handle TTL, Chromium confirms the
original refresh link is rejected with `no-store`/`no-referrer` headers.

## Test-only settings

| Setting | Runtime test | Production default |
|---|---|---|
| `PREVIEW_TOKEN_TTL_SECONDS` | 60 (analyzer minimum) | 600 |
| `PREVIEW_REFRESH_TTL_SECONDS` | 300 (analyzer minimum) | 3600 |
| `Workflow Config.pollSeconds` | 3 (runtime copy only) | 30 |
| `SSRF_ALLOW_LOOPBACK` / `NODE_ENV` | `1` / `test` (fictional loopback site) | unset / `production` |
| `PER_DOMAIN_MIN_INTERVAL_MS`, perf windows | smoke-test values | unchanged |
| Retry attempts, backoff, `Retry-After` cap, 10 s timeout | **unchanged** | 3, 500/1000 ms + jitter, 10 s, 10 s |

The overrides live only in `tests/n8n-runtime/compose.yml` and the runtime
workflow copy; the analyzer's TTL floors still apply, and the suite prints a
`TEST OVERRIDES ACTIVE` banner without values.
`tests/workflows/runtime-harness.test.mjs` asserts the committed production
values are unchanged and that no production Compose file references the
fixture.

## Defects found by real execution

1. `Increment Attempt` (Set v3.4) kept `includeOtherFields` under `options`,
   where n8n ignores it; the second attempt lost `method`/`url` and no retry
   HTTP call was made.
2. The retry workflow ended on an If node's second output, so the parent
   Execute Workflow node received its result on output 1 while the main
   workflow is wired to output 0 — the main flow would have stopped after
   `Queue Campaign Audits`. The workflow now ends in a single-output node, and
   permanent failures stop the parent with a sanitized error instead of
   continuing silently.
3. The retry workflow sent `POST` without a body; the analyzer requires a JSON
   object for `POST /campaigns/{id}/audits`, so audit start (and preview access)
   would have failed with 400. `POST` now sends `{}`; `GET` sends no body.

## Runtime readiness is not production readiness

A passing suite shows the committed workflows behave correctly on the pinned
n8n release. `npm run pilot:check` still reports `production_ready: false`
until the deployment gates are recorded for the target environment: host or
cloud egress firewall, editor access policy, the external task-runner staging
decision and HTTPS origin.
