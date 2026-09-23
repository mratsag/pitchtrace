# Backup and restore

Back up both PostgreSQL databases with `pg_dump --format=custom`, the analyzer artifact volume and n8n data volume as tar archives, plus an encrypted offline record of required environment variable names and secret-manager references. Never place plaintext secrets in the archive. Write to an explicit dedicated directory, timestamp every set, generate SHA-256 checksums, and retain according to a documented policy (example: 7 daily, 4 weekly).

Restores must require `--confirm`, verify checksums, show the target database/container names, stop writers, restore databases into newly created empty databases, restore volumes, run migrations, and perform health/readiness plus a preview and inactive-workflow check. Test each backup in a temporary isolated stack before calling it valid. Never restore over an unidentified database.
