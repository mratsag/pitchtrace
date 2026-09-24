# Incident response

Stop the pilot with both kill switches, deactivate the workflow, preserve logs and database snapshots, and record a UTC timeline. For suspected preview leakage, rotate `PREVIEW_TOKEN_SECRET` (invalidates all preview URLs), redact proxy logs and review access. For API exposure rotate `ANALYZER_API_KEY`; for n8n exposure rotate its encryption key only by the supported n8n procedure and revalidate credentials.

Suppress affected recipients/domains, investigate complaints/bounces, and do not resume until containment, recovery verification and an owner-approved post-incident review are complete. Never put credentials or personal email addresses in tickets or aggregate reports.
