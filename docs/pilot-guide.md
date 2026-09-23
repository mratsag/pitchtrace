# Controlled pilot guide

Start with `config/pilot.example.yml`: at most 20 companies, score threshold 50, five pages, one request/domain/second, ten drafts/day, human approval and `.eml`-only output. `AUDIT_ENABLED` and `DRAFT_EXPORT_ENABLED` are kill switches and begin false; automatic sending must remain false.

Record aggregate counts for imported, valid, duplicate and suppressed companies; successful/failed audits and average duration; finding/score distributions; reviewed, approved and rejected drafts; exports; and manually marked sent, positive/negative reply, opt-out, bounce and complaint outcomes. Export never means sent. Do not include email addresses in reports. A complaint or bounce pauses draft/export; opt-out must enter suppression before any later draft/export.

This phase does not add automatic reply tracking or sending. Operators remain responsible for lawful basis, notice, suppression and recipient rights. PitchTrace does not guarantee KVKK, İYS, GDPR or other legal compliance.

`npm run pilot:check -- --json` reports `runtime_ready` separately from
`production_ready`. A test configuration may be runtime-ready, but production
remains false until backup/restore, host egress firewall, editor access policy,
workflow import and HTTPS gates are explicitly verified.

Before a pilot, run `npm run test:n8n-runtime` (see
[n8n-runtime-testing.md](n8n-runtime-testing.md)). It proves, on a real
disposable n8n 2.39.10 instance, that the shared retry workflow retries only
transient failures, that the main workflow's Form reaches draft review, and
that preview expiry and same-artifact refresh work in Chromium without
exposing the analyzer key or calling approval/export. It uses only fictional
data and test-only TTL/polling values; it never touches existing volumes.
This is runtime evidence for the workflows, not a production gate: egress
firewall, editor access policy, the external task-runner staging decision and
HTTPS must still be verified in the target environment before
`production_ready` can become true.
