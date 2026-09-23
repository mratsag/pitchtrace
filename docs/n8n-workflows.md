# n8n workflow guide

## Import and configuration

Import `workflows/01-campaign-audit-review.json` from the n8n editor. The source
contains a stable portable workflow ID because n8n 2.39's CLI rejects imports
without one; it contains no instance-generated ID, credential reference, or
secret. If the ID already exists, import into a clean project or duplicate the
workflow in the editor.

Create one **Header Auth** credential named `PitchTrace Analyzer`:

- Header name: `X-API-Key`
- Header value: the same secret used by `ANALYZER_API_KEY`

Attach it to every HTTP Request node. Credential IDs are intentionally absent
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
5. When terminal, failed audit count remains visible. The workflow chooses the
   first newly imported company with a completed, scored audit and contact.
6. It obtains draft context and builds a deterministic two-claim test draft.
   The claim uses a real outreach-eligible finding ID and is posted to the
   analyzer, where V1–V16 remain authoritative.
7. The review page shows company/domain, result summary, rendered draft, and—if
   available—the screenshot fetched from `GET /artifacts/{id}`. The artifact ID
   comes only from analyzer context. Users cannot supply an arbitrary URL.
8. **Reddet** calls neither approval nor export. **Onayla** records approval,
   then requests `.eml`. Export repeats suppression checking; a late
   `409 SUPPRESSED` stops the workflow.
9. A successful page downloads the `.eml` and states explicitly that no email
   was sent.

There is no OpenAI credential or model call in this phase. Replace the
deterministic builder only in a later phase; never bypass analyzer validation.

## Screenshot prototype result

A real n8n 2.39.10 browser run proved that Form sanitization removes `data:`
image sources. The workflow therefore uses the documented alternative openly:
a second GET webhook accepts only a UUID artifact ID, fetches only
`GET /artifacts/{id}` with n8n's Header Auth credential, and streams that binary
image to the review page. It cannot proxy an arbitrary URL or filesystem path.
The artifact UUID is a bearer capability and the analyzer's 30-day retention
still applies; do not use this preview for screenshots containing secrets.

The headless browser check verifies that the image decodes (`naturalWidth > 0`)
inside the live Form. Screenshot bytes and credential IDs are not embedded in
the workflow export, and n8n does not mount the analyzer artifact volume.

## Failure behavior

Analyzer 4xx responses fail the responsible HTTP node and are not retried.
Network/5xx retry is intentionally not hidden in Code nodes; operators may set
the HTTP Request node's bounded retry-on-fail setting after testing their n8n
version. Import validation, no eligible company/finding, draft validation,
artifact expiry, timeout, suppression, and export errors remain visible in the
execution. n8n execution data must be treated as sensitive and pruned/backed up
according to the installation guide.
