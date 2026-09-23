$ErrorActionPreference = 'Stop'
$env:SMOKE_POSTGRES_PASSWORD = [Guid]::NewGuid().ToString('N')
$env:SMOKE_API_KEY = [Guid]::NewGuid().ToString('N')
$env:PREVIEW_TOKEN_SECRET = [Guid]::NewGuid().ToString('N')
# Required by docker-compose.yml interpolation only; filled when unset.
if (-not $env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD = [Guid]::NewGuid().ToString('N'); $setPostgres = $true }
if (-not $env:ANALYZER_API_KEY) { $env:ANALYZER_API_KEY = [Guid]::NewGuid().ToString('N'); $setApiKey = $true }

try {
  docker compose -f docker-compose.yml -f docker-compose.smoke.yml up --build --abort-on-container-exit --exit-code-from smoke smoke
  if ($LASTEXITCODE -ne 0) { throw "Smoke test failed with exit code $LASTEXITCODE" }
  docker run --rm -e N8N_ENCRYPTION_KEY=smoke-import-validation-key-32chars -v "${PWD}/workflows:/workflows:ro" docker.n8n.io/n8nio/n8n:2.39.10 import:workflow --separate --input=/workflows
  if ($LASTEXITCODE -ne 0) { throw "n8n workflow import check failed with exit code $LASTEXITCODE" }
}
finally {
  docker compose -f docker-compose.yml -f docker-compose.smoke.yml down --remove-orphans
  Remove-Item Env:SMOKE_POSTGRES_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:SMOKE_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PREVIEW_TOKEN_SECRET -ErrorAction SilentlyContinue
  if ($setPostgres) { Remove-Item Env:POSTGRES_PASSWORD -ErrorAction SilentlyContinue }
  if ($setApiKey) { Remove-Item Env:ANALYZER_API_KEY -ErrorAction SilentlyContinue }
}
