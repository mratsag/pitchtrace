# Backup and restore

`scripts/backup.sh --target /absolute/dedicated/path --project exact-compose-project --compose deploy/compose.production.yml` backs up both PostgreSQL databases, analyzer artifacts and n8n data, then emits a manifest and SHA-256 checksums. Partial output is removed on failure. The target must be absolute, non-root and not a symlink.

Restore with `scripts/restore.sh --source /absolute/backup --project exact-nonproduction-target --compose ... --confirm`. It rejects missing files, checksum changes, unsupported formats, missing confirmation, production-like project names and a missing `N8N_ENCRYPTION_KEY`. The archive intentionally contains no secrets. Preserve database passwords, analyzer/API preview secrets, reverse-proxy/DNS configuration and especially the original n8n encryption key in a separate secret manager; n8n credentials cannot be decrypted without that same key.

Run the isolated Docker drill with `scripts/test-backup-restore.sh`. It uses unique project/volume names, fictional `example.invalid` data, restores into a separate stack and verifies database rows, workflow metadata, artifact checksum and health endpoints. Host egress and production credentials are never involved.
