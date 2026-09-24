#!/usr/bin/env sh
set -eu

usage(){ echo "usage: backup.sh --target ABSOLUTE_DIR --project COMPOSE_PROJECT [--compose FILE]" >&2; exit 2; }
target= project= compose=deploy/compose.production.yml
while [ "$#" -gt 0 ]; do case "$1" in --target) target=$2; shift 2;; --project) project=$2; shift 2;; --compose) compose=$2; shift 2;; *) usage;; esac; done
[ -n "$target" ] && [ -n "$project" ] || usage
case "$target" in /*) ;; *) echo "backup target must be absolute" >&2; exit 2;; esac
[ "$target" != / ] || { echo "backup target / is forbidden" >&2; exit 2; }
mkdir -p "$target"
[ ! -L "$target" ] || { echo "backup target must not be a symlink" >&2; exit 2; }
target=$(cd "$target" && pwd -P)
target_mount=$target; case "$(uname -s)" in MINGW*|MSYS*) target_mount=$(cygpath -m "$target");; esac
stamp=$(date -u +%Y%m%dT%H%M%SZ); out="$target/pitchtrace-$project-$stamp.partial"; final=${out%.partial}
mkdir "$out"
cleanup(){ [ -d "$out" ] && rm -rf -- "$out"; }; trap cleanup EXIT INT TERM
dc="docker compose -p $project -f $compose"
$dc exec -T postgres pg_dump -U pitchtrace -d pitchtrace -Fc > "$out/analyzer.dump"
$dc exec -T n8n-postgres pg_dump -U n8n -d n8n -Fc > "$out/n8n.dump"
for pair in "analyzer:artifacts:/data" "n8n:n8n-data:/home/node/.n8n"; do
  service=${pair%%:*}; rest=${pair#*:}; label=${rest%%:*}; mount=${rest#*:}
  cid=$($dc ps -aq "$service"); [ -n "$cid" ] || { echo "service container not found: $service" >&2; exit 1; }
  source=$(docker inspect "$cid" --format "{{range .Mounts}}{{if eq .Destination \"$mount\"}}{{.Name}}{{end}}{{end}}")
  [ -n "$source" ] || { echo "named volume not found for $service:$mount" >&2; exit 1; }
  out_mount=$out; case "$(uname -s)" in MINGW*|MSYS*) out_mount=$(cygpath -m "$out");; esac
  MSYS2_ARG_CONV_EXCL='*' docker run --rm --mount "type=volume,src=$source,dst=/source,readonly" --mount "type=bind,src=$out_mount,dst=/backup" alpine:3.20 tar -C /source -czf "/backup/$label.tar.gz" .
done
(cd "$out" && sha256sum analyzer.dump n8n.dump artifacts.tar.gz n8n-data.tar.gz > SHA256SUMS)
version=$(git describe --always --dirty 2>/dev/null || printf unknown)
cat > "$out/manifest.json" <<EOF
{"format_version":1,"created_at":"$stamp","project":"$project","repository_version":"$version","databases":["pitchtrace","n8n"],"files":["analyzer.dump","n8n.dump","artifacts.tar.gz","n8n-data.tar.gz","SHA256SUMS"],"secrets_included":false}
EOF
mv "$out" "$final"; trap - EXIT INT TERM
echo "$final"
