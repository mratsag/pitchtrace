# Upgrade procedure

Read analyzer, PostgreSQL, Playwright and n8n release notes. Back up and restore-test first. Pin image versions; never use `latest`. Upgrade in staging, validate Compose, apply migrations twice (second run must skip), import the workflow, run policy/analyzer/full smoke tests, and verify liveness/readiness, queue recovery and preview expiry.

Upgrade n8n main/worker/runner components together if runners are later enabled. Roll back only with a compatible database backup and image set. Rotate secrets separately from software upgrades so failures remain attributable.
