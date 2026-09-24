#!/usr/bin/env bash
# Real n8n 2.39.10 runtime verification (TEST ONLY).
#
# Starts a disposable, Internet-isolated Compose project, imports and publishes
# the committed workflows with the n8n CLI, runs the shared retry workflow
# against a deterministic fault proxy, drives the real n8n Form with Chromium
# through preview expiry/refresh, writes a machine-readable report to
# test-results/n8n-runtime/ (git-ignored) and removes only its own resources.
set -euo pipefail
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

project="ptn8nrt-$(date +%s)-$$"
case "$project" in ptn8nrt-[0-9]*-[0-9]*) ;; *) echo "refusing unexpected project name" >&2; exit 1 ;; esac

rand() { openssl rand -hex "$1"; }
export RT_ANALYZER_DB_PASSWORD="$(rand 24)"
export RT_N8N_DB_PASSWORD="$(rand 24)"
export RT_N8N_ENCRYPTION_KEY="$(rand 32)"
export RT_ANALYZER_API_KEY="$(rand 32)"
export RT_PREVIEW_TOKEN_SECRET="$(rand 32)"
export RT_FAULT_CONTROL_TOKEN="$(rand 32)"
export RT_N8N_OWNER_PASSWORD="Rt$(rand 12)9"
export RT_N8N_CREDENTIAL_ID="$(rand 8)"

compose=(docker compose -p "$project" -f tests/n8n-runtime/compose.yml --profile cli --profile runner)
out=test-results/n8n-runtime

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    echo "--- runtime test failed (exit $status); recent service logs ---" >&2
    "${compose[@]}" logs --no-color --tail 60 analyzer-upstream fault-proxy n8n >&2 || true
  fi
  echo "cleaning up disposable project $project"
  # `down -v` removes only this project's containers, network and anonymous
  # or project-scoped volumes. Shared images are kept as build cache.
  "${compose[@]}" down -v --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$out"
rm -f "$out"/report.json "$out"/*.png
chmod 0777 "$out"

echo "disposable project: $project (no host ports, internal network, tmpfs databases)"
"${compose[@]}" build --quiet
"${compose[@]}" up -d --wait analyzer-db analyzer-upstream site fault-proxy n8n-db

"${compose[@]}" run --rm --no-deps -T n8n-cli '
  node /work/tests/n8n-runtime/prepare-bundle.mjs
  n8n import:credentials --input=/bootstrap/credentials.json
  rm -f /bootstrap/credentials.json
  n8n import:workflow --separate --input=/bootstrap/workflows
  . /bootstrap/ids.env
  n8n publish:workflow --id="$RETRY_WORKFLOW_ID"
  n8n publish:workflow --id="$MAIN_WORKFLOW_ID"
  n8n publish:workflow --id="$HARNESS_WORKFLOW_ID"
  n8n list:workflow
'
"${compose[@]}" up -d --wait n8n

"${compose[@]}" run --rm --no-deps -T runner node tests/n8n-runtime/run.mjs
echo "report: $out/report.json"
