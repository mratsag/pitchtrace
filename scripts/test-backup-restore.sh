#!/usr/bin/env sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd -P)
root_docker=$(cygpath -m "$root")
tmp=$(mktemp -d); suffix=$(date +%s)-$$; src=ptdrill-src-$suffix; dst=ptdrill-dst-$suffix
compose="$tmp/compose.yml"; backup_root="$tmp/backups"
cleanup(){ docker compose -p "$src" -f "$compose" down -v --remove-orphans >/dev/null 2>&1 || true; docker compose -p "$dst" -f "$compose" down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf -- "$tmp"; }
trap cleanup EXIT INT TERM
cat > "$compose" <<EOF
services:
  postgres:
    image: postgres:16-alpine
    environment: { POSTGRES_USER: pitchtrace, POSTGRES_PASSWORD: drill-password, POSTGRES_DB: pitchtrace }
    healthcheck: { test: [CMD-SHELL, "pg_isready -U pitchtrace -d pitchtrace"], interval: 1s, timeout: 2s, retries: 30 }
  n8n-postgres:
    image: postgres:17-alpine
    environment: { POSTGRES_USER: n8n, POSTGRES_PASSWORD: drill-password, POSTGRES_DB: n8n }
    healthcheck: { test: [CMD-SHELL, "pg_isready -U n8n -d n8n"], interval: 1s, timeout: 2s, retries: 30 }
  analyzer:
    build: "$root_docker/services/analyzer"
    environment:
      DATABASE_URL: postgres://pitchtrace:drill-password@postgres:5432/pitchtrace
      ANALYZER_API_KEY: drill-api-key-000000000000000000000000
      PREVIEW_TOKEN_SECRET: drill-preview-key-000000000000000000000
      NODE_ENV: production
      ARTIFACT_ROOT: /data
    volumes: [artifacts:/data]
    command: [node, -e, "require('http').createServer((q,r)=>{r.end(q.url==='/livez'||q.url==='/readyz'?'ok':'no')}).listen(8080)"]
    depends_on: { postgres: { condition: service_healthy } }
    healthcheck: { test: [CMD, node, -e, "fetch('http://127.0.0.1:8080/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: 1s, timeout: 2s, retries: 30 }
  n8n:
    image: docker.n8n.io/n8nio/n8n:2.39.10
    environment:
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: n8n-postgres
      DB_POSTGRESDB_DATABASE: n8n
      DB_POSTGRESDB_USER: n8n
      DB_POSTGRESDB_PASSWORD: drill-password
      N8N_ENCRYPTION_KEY: drill-encryption-key-000000000000000000
    volumes: [n8n-data:/home/node/.n8n]
    depends_on: { n8n-postgres: { condition: service_healthy } }
    healthcheck: { test: [CMD, node, -e, "fetch('http://127.0.0.1:5678/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], interval: 2s, timeout: 3s, retries: 60 }
volumes: { artifacts: {}, n8n-data: {} }
EOF
dc(){ p=$1; shift; docker compose -p "$p" -f "$compose" "$@"; }
dc "$src" up -d --build --wait
dc "$src" exec -T postgres psql -U pitchtrace -d pitchtrace -v ON_ERROR_STOP=1 -c 'CREATE SCHEMA IF NOT EXISTS pitchtrace; CREATE TABLE IF NOT EXISTS pitchtrace.schema_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())' >/dev/null
for f in "$root"/database/migrations/*.sql; do dc "$src" exec -T postgres psql -U pitchtrace -d pitchtrace -v ON_ERROR_STOP=1 < "$f" >/dev/null; name=$(basename "$f"); dc "$src" exec -T postgres psql -U pitchtrace -d pitchtrace -v ON_ERROR_STOP=1 -c "INSERT INTO pitchtrace.schema_migrations(filename) VALUES ('$name') ON CONFLICT DO NOTHING" >/dev/null; done
dc "$src" exec -T postgres psql -U pitchtrace -d pitchtrace -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
WITH cam AS (INSERT INTO pitchtrace.campaigns(name,sector,city,max_companies,min_score) VALUES('Backup Drill','fixture','test',1,50) RETURNING id),
co AS (INSERT INTO pitchtrace.companies(campaign_id,name,submitted_url,normalized_domain,source) SELECT id,'Reserved Fixture','https://example.invalid','example.invalid','manual' FROM cam RETURNING id),
au AS (INSERT INTO pitchtrace.audits(company_id,status,page_limit,entry_url,final_url,analyzer_version,finished_at) SELECT id,'completed',1,'https://example.invalid','https://example.invalid','drill',now() FROM co RETURNING id,company_id),
ar AS (INSERT INTO pitchtrace.artifacts(audit_id,kind,rel_path,mime,bytes,sha256) SELECT id,'screenshot','drill.png','image/png',13,'c16a40a4584e5bccc84b45172fcdfa922f59ff1edebf3adba7b8266ea04eb39a' FROM au RETURNING id,audit_id),
fi AS (INSERT INTO pitchtrace.findings(audit_id,company_id,code,category,severity,confidence,url,evidence,artifact_id) SELECT au.id,au.company_id,'TECH_NO_HTTPS','TECH','high','observed','https://example.invalid','{}',ar.id FROM au,ar RETURNING audit_id,company_id)
INSERT INTO pitchtrace.scores(audit_id,company_id,total,breakdown,details,rule_version) SELECT audit_id,company_id,50,'{}','{}','drill' FROM fi;
SQL
dc "$src" exec -T -u 0 analyzer sh -c "printf 'fixture-bytes' > /data/drill.png && chown pwuser:pwuser /data/drill.png"
dc "$src" exec -T n8n n8n import:workflow --input=/dev/stdin < "$root/workflows/00-analyzer-http-retry.json" >/dev/null
backup=$($root/scripts/backup.sh --target "$backup_root" --project "$src" --compose "$compose")
[ -f "$backup/manifest.json" ] && (cd "$backup" && sha256sum -c SHA256SUMS >/dev/null)
dc "$src" down
dc "$dst" up -d postgres n8n-postgres
dc "$dst" create analyzer n8n >/dev/null
export N8N_ENCRYPTION_KEY=drill-encryption-key-000000000000000000
$root/scripts/restore.sh --source "$backup" --project "$dst" --compose "$compose" --confirm >/dev/null
dc "$dst" up -d --wait
[ "$(dc "$dst" exec -T postgres psql -U pitchtrace -d pitchtrace -Atc "select count(*) from pitchtrace.findings where code='TECH_NO_HTTPS'")" = 1 ]
[ "$(dc "$dst" exec -T n8n-postgres psql -U n8n -d n8n -Atc "select count(*) from workflow_entity")" -ge 1 ]
dc "$dst" exec -T analyzer sh -c "sha256sum /data/drill.png" | grep -q '^c16a40a4'
dc "$dst" exec -T analyzer node -e "Promise.all(['/livez','/readyz'].map(p=>fetch('http://127.0.0.1:8080'+p).then(r=>{if(!r.ok)throw Error(p)})))"
# Negative restore gates.
! "$root/scripts/restore.sh" --source "$backup" --project "$dst" --compose "$compose" >/dev/null 2>&1
bad="$tmp/bad"; cp -R "$backup" "$bad"; printf x >> "$bad/analyzer.dump"; ! "$root/scripts/restore.sh" --source "$bad" --project "$dst" --compose "$compose" --confirm >/dev/null 2>&1
rm -f "$bad/manifest.json"; ! "$root/scripts/restore.sh" --source "$bad" --project "$dst" --compose "$compose" --confirm >/dev/null 2>&1
echo "backup/restore drill passed: isolated projects $src -> $dst"
