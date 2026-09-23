#!/usr/bin/env sh
set -eu

export SMOKE_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export SMOKE_API_KEY="$(openssl rand -hex 24)"
export PREVIEW_TOKEN_SECRET="$(openssl rand -hex 24)"

cleanup() {
  docker compose -f docker-compose.yml -f docker-compose.smoke.yml down --remove-orphans
}
trap cleanup EXIT INT TERM

docker compose -f docker-compose.yml -f docker-compose.smoke.yml up \
  --build --abort-on-container-exit --exit-code-from smoke smoke

docker run --rm \
  -e N8N_ENCRYPTION_KEY=smoke-import-validation-key-32chars \
  -v "$(pwd)/workflows:/workflows:ro" \
  docker.n8n.io/n8nio/n8n:2.39.10 \
  import:workflow --input=/workflows/01-campaign-audit-review.json
