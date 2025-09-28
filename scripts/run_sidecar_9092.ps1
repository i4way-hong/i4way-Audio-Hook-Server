param(
  [string]$Port = "9092"
)
$env:MRCP_SIDECAR_PORT=$Port
Write-Host "Starting sidecar on port $Port..."
npm run sidecar
