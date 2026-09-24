# Analyzer call retry and idempotency matrix

| Method | Endpoint | Purpose | Read-only | Idempotent | Automatic retry | Duplicate protection / recovery |
|---|---|---|---|---|---|---|
| POST | `/campaigns` | create campaign | no | no | no | ambiguous outcome: operator checks campaign list before resubmitting |
| POST | `/campaigns/{id}/companies/import` | CSV import | no | effectively | no | unique campaign/domain constraint prevents companies, but partial result makes automatic retry inappropriate |
| POST | `/campaigns/{id}/audits` | start audits | no | yes | yes | active-audit partial unique index and completed/active checks |
| GET | `/campaigns/{id}/audit-progress` | poll status | yes | yes | yes | read-only |
| GET | `/drafts/context` | draft context | yes | yes | yes | read-only |
| POST | `/drafts` | create draft | no | no | no | ambiguous outcome requires operator review; no idempotency key exists |
| POST | `/drafts/{id}/approval` | record decision | no | no | no | automatic retry forbidden because approvals are append-only |
| POST | `/artifacts/{id}/preview-access` | mint short preview | no persistent mutation | yes | yes | stateless artifact-bound token; repeated minting creates no row |
| GET | `/drafts/{id}/export?format=eml` | export | no | no | no | currently appends outreach log; operator checks draft/outreach state |

Retry-safe calls use the shared `00-analyzer-http-retry.json` workflow. It retries only network/timeout and HTTP 408, 425, 429, 500, 502, 503, 504; 400, 401, 403, 404, every 409 including `SUPPRESSED`, 422, and other permanent 4xx stop after one call. Maximum is three total attempts with capped exponential backoff, jitter, and bounded `Retry-After`. Errors are sanitized; credentials and response bodies are not logged.

## Runtime verification

`npm run test:n8n-runtime` exercises this matrix on real n8n 2.39.10
executions with a test-only fault proxy (see
[n8n-runtime-testing.md](n8n-runtime-testing.md)):

| Sequence seen by n8n | Calls | Result |
|---|---|---|
| 500 → 500 → 202 on `POST /campaigns/{id}/audits`, both failures after the real write | 3 | success; exactly one audit and one job (idempotent) |
| 429 + `Retry-After: 1` → 200 | 2 | success after ≥ 1 s |
| timeout (10 s node timeout) → 200 | 2 | success |
| 503 → 503 → 503 | 3 | sanitized `ANALYZER_REQUEST_FAILED`; no fourth call |
| 400, 401, 403, 422 | 1 each | sanitized `ANALYZER_REQUEST_FAILED` |
| 409 `SUPPRESSED` | 1 | business outcome `SUPPRESSED` |
| 503 with `retry_safe=false` | 1 | no retry |

Through the real Form, the four retry-safe main-workflow calls each recover
from one injected transient failure in their shared-retry sub-execution, and a
single 503 on campaign create, CSV import, draft create, approval or export
results in exactly one call and no duplicate record.
