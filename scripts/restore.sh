#!/usr/bin/env sh
set -eu
usage(){ echo "usage: restore.sh --source BACKUP_DIR --project TARGET_PROJECT --confirm [--compose FILE]" >&2; exit 2; }
source_dir= project= compose=deploy/compose.production.yml confirm=false
while [ "$#" -gt 0 ]; do case "$1" in --source) source_dir=$2; shift 2;; --project) project=$2; shift 2;; --compose) compose=$2; shift 2;; --confirm) confirm=true; shift;; *) usage;; esac; done
[ -n "$source_dir" ] && [ -n "$project" ] || usage
[ "$confirm" = true ] || { echo "restore is destructive; pass --confirm" >&2; exit 2; }
[ -d "$source_dir" ] && [ ! -L "$source_dir" ] || { echo "backup source must be a real directory" >&2; exit 2; }
source_dir=$(cd "$source_dir" && pwd -P)
source_mount=$source_dir; case "$(uname -s)" in MINGW*|MSYS*) source_mount=$(cygpath -m "$source_dir");; esac
for f in manifest.json SHA256SUMS analyzer.dump n8n.dump artifacts.tar.gz n8n-data.tar.gz; do [ -f "$source_dir/$f" ] || { echo "missing backup file: $f" >&2; exit 1; }; done
grep -q '"format_version":1' "$source_dir/manifest.json" || { echo "incompatible backup format" >&2; exit 1; }
grep -q '"secrets_included":false' "$source_dir/manifest.json" || { echo "invalid manifest" >&2; exit 1; }
(cd "$source_dir" && sha256sum -c SHA256SUMS)
case "$project" in pitchtrace|pitchtrace-production) echo "refusing ambiguous/production project name" >&2; exit 2;; esac
[ -n "${N8N_ENCRYPTION_KEY:-}" ] || { echo "N8N_ENCRYPTION_KEY is required to decrypt restored n8n credentials (value is never logged)" >&2; exit 2; }
dc="docker compose -p $project -f $compose"
$dc ps --status running --services | grep -Eq '^(postgres|n8n-postgres|analyzer|n8n)$' || { echo "target stack must be explicitly started and healthy" >&2; exit 1; }
$dc exec -T postgres pg_restore -U pitchtrace -d pitchtrace --clean --if-exists < "$source_dir/analyzer.dump"
$dc exec -T n8n-postgres pg_restore -U n8n -d n8n --clean --if-exists < "$source_dir/n8n.dump"
for pair in "analyzer:artifacts:/data" "n8n:n8n-data:/home/node/.n8n"; do service=${pair%%:*}; rest=${pair#*:}; label=${rest%%:*}; mount=${rest#*:}; cid=$($dc ps -aq "$service"); volume=$(docker inspect "$cid" --format "{{range .Mounts}}{{if eq .Destination \"$mount\"}}{{.Name}}{{end}}{{end}}"); [ -n "$volume" ] || exit 1; MSYS2_ARG_CONV_EXCL='*' docker run --rm --mount "type=volume,src=$volume,dst=/restore" --mount "type=bind,src=$source_mount,dst=/backup,readonly" alpine:3.20 sh -c "find /restore -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar -C /restore -xzf /backup/$label.tar.gz"; done
$dc exec -T postgres psql -U pitchtrace -d pitchtrace -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM pitchtrace.schema_migrations' >/dev/null
$dc exec -T n8n-postgres pg_isready -U n8n -d n8n >/dev/null
echo "restore verified for target project $project; run application /livez and /readyz after services restart"
