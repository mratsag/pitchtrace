#!/usr/bin/env sh
set -eu

export SMOKE_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
export SMOKE_API_KEY="$(openssl rand -hex 24)"

cleanup() {
  docker compose -f docker-compose.yml -f docker-compose.smoke.yml down --remove-orphans
}
trap cleanup EXIT INT TERM

docker compose -f docker-compose.yml -f docker-compose.smoke.yml up \
  --build --abort-on-container-exit --exit-code-from smoke smoke
