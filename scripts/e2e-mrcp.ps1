param(
  [string]$ProfilePath = "configs/unimrcp/client-profiles.xml",
  [string]$ProfileName = "asr-default",
  [string]$ServerIp = "127.0.0.1",
  [int]$ServerPort = 8060,
  [string]$ResourceLocation = "/unimrcp",
  [ValidateSet('PCMU','L16')]
  [string]$Codec = "PCMU",
  [ValidateSet(8000,16000,44100,48000)]
  [int]$SampleRate = 8000,
  [int]$RtpMin = 40000,
  [int]$RtpMax = 40100,
  [int]$Ptime = 20
)

# 스크립트 루트 기준 경로 보정
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath $ProfilePath)) {
  $candidate1 = Join-Path $root 'configs/unimrcp/client-profiles.xml'
  $candidate2 = Join-Path $root 'configs/unimrcp/client-profiles-sip.xml'
  if (Test-Path -LiteralPath $candidate1) {
    $ProfilePath = $candidate1
  } elseif (Test-Path -LiteralPath $candidate2) {
    $ProfilePath = $candidate2
  } else {
    throw "Profile file not found. Tried: $ProfilePath, $candidate1, $candidate2"
  }
}

# 1) client-profiles.xml 업데이트
Write-Host "[e2e-mrcp] Updating client profile: $ProfilePath"
$xml = [xml](Get-Content -LiteralPath $ProfilePath)
$clientProfile = $xml.'client-profiles'.profile | Where-Object { $_.name -eq $ProfileName }
if (-not $clientProfile) { throw "Profile '$ProfileName' not found in $ProfilePath" }

# XPath 기반 업데이트 (속성/요소 안전 설정)
$base = "/client-profiles/profile[@name='$ProfileName']"
$rtspNode = $xml.SelectSingleNode("$base/rtsp-server")
if (-not $rtspNode) { throw "XPath not found: $base/rtsp-server" }
$rtspNode.Attributes['ip'].Value = "$ServerIp"
$rtspNode.Attributes['port'].Value = "$ServerPort"
$rtspNode.Attributes['resource-location'].Value = "$ResourceLocation"

$node = $xml.SelectSingleNode("$base/rtp/local-ip"); if ($node) { $node.InnerText = '0.0.0.0' }
$node = $xml.SelectSingleNode("$base/rtp/rtp-port-min"); if ($node) { $node.InnerText = "$RtpMin" }
$node = $xml.SelectSingleNode("$base/rtp/rtp-port-max"); if ($node) { $node.InnerText = "$RtpMax" }
$node = $xml.SelectSingleNode("$base/rtp/ptime"); if ($node) { $node.InnerText = "$Ptime" }

$node = $xml.SelectSingleNode("$base/recognizer/codec"); if ($node) { $node.InnerText = "$Codec" }
$node = $xml.SelectSingleNode("$base/recognizer/sample-rate"); if ($node) { $node.InnerText = "$SampleRate" }
$node = $xml.SelectSingleNode("$base/recognizer/channel-count"); if ($node) { $node.InnerText = '1' }

$xml.Save((Resolve-Path -LiteralPath $ProfilePath))

Write-Host "[e2e-mrcp] Profile saved."

# 2) 앱 .env 업데이트 (STT_PROTOCOL=mrcp, 인코딩/레이트/모노)
$envPath = (Join-Path $root '.env')
Write-Host "[e2e-mrcp] Updating .env: $envPath"
$content = Get-Content -LiteralPath $envPath -Raw
$content = $content -replace "(?m)^STT_PROTOCOL=.*$","STT_PROTOCOL=mrcp"
$content = $content -replace "(?m)^STT_ENCODING=.*$","STT_ENCODING=$Codec"
$content = $content -replace "(?m)^STT_RATE=.*$","STT_RATE=$SampleRate"
$content = $content -replace "(?m)^STT_MONO=.*$","STT_MONO=true"
Set-Content -LiteralPath $envPath -Value $content -Encoding UTF8

# 3) MRCP 브릿지 설정 안내 (Mock 기본값)
if (-not $env:STT_MRCP_BRIDGE) {
  Write-Host "[e2e-mrcp] Using MockMrcpBridge (set STT_MRCP_BRIDGE to use a custom bridge)"
}

# 4) 서버/클라이언트 기동 안내
Write-Host ""
Write-Host "Next steps:"
Write-Host "  - Start UniMRCP Server (configured for RTSP ${ServerIp}:${ServerPort}, RTP $RtpMin-$RtpMax)"
Write-Host "  - Start AudioHook app (npm start or your runner)"
Write-Host "  - Play or stream audio into the app; watch logs for 'MRCP RTSP connected' and 'MRCP result'"
