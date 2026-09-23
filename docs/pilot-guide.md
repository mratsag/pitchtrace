# Controlled pilot guide

Start with `config/pilot.example.yml`: at most 20 companies, score threshold 50, five pages, one request/domain/second, ten drafts/day, human approval and `.eml`-only output. `AUDIT_ENABLED` and `DRAFT_EXPORT_ENABLED` are kill switches and begin false; automatic sending must remain false.

Record aggregate counts for imported, valid, duplicate and suppressed companies; successful/failed audits and average duration; finding/score distributions; reviewed, approved and rejected drafts; exports; and manually marked sent, positive/negative reply, opt-out, bounce and complaint outcomes. Export never means sent. Do not include email addresses in reports. A complaint or bounce pauses draft/export; opt-out must enter suppression before any later draft/export.

This phase does not add automatic reply tracking or sending. Operators remain responsible for lawful basis, notice, suppression and recipient rights. PitchTrace does not guarantee KVKK, İYS, GDPR or other legal compliance.
