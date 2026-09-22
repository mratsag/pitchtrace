$ErrorActionPreference = 'Stop'
$env:SMOKE_POSTGRES_PASSWORD = [Guid]::NewGuid().ToString('N')
$env:SMOKE_API_KEY = [Guid]::NewGuid().ToString('N')

try {
  docker compose -f docker-compose.yml -f docker-compose.smoke.yml up --build --abort-on-container-exit --exit-code-from smoke smoke
  if ($LASTEXITCODE -ne 0) { throw "Smoke test failed with exit code $LASTEXITCODE" }
}
finally {
  docker compose -f docker-compose.yml -f docker-compose.smoke.yml down --remove-orphans
  Remove-Item Env:SMOKE_POSTGRES_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:SMOKE_API_KEY -ErrorAction SilentlyContinue
}
