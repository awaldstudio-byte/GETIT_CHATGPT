$ErrorActionPreference = 'Stop'
$projectRoot = 'C:\Users\natha\.codex\.chatgpt-projects\g-p-6a623ffebbc08191b956dcad412a1d9d\GETIT_CHATGPT'
$nodeExe = 'C:\Users\natha\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$dockerDesktopExe = 'C:\Users\natha\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe'
$dockerExe = 'C:\Users\natha\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'
$ollamaExe = 'C:\Users\natha\AppData\Local\Programs\Ollama\ollama.exe'
$dashboardUrl = 'http://localhost:3001/dashboard'
$n8nHealthUrl = 'http://127.0.0.1:5678/healthz'
$ollamaHealthUrl = 'http://127.0.0.1:11434/api/tags'

function Test-HttpReady([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-N8nReady {
  if (Test-HttpReady $n8nHealthUrl) { return $true }
  if (-not (Test-Path -LiteralPath $dockerExe)) { return $false }

  try {
    $containerHealth = (& $dockerExe inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 'getit-local-automation-n8n-1' 2>$null).Trim()
    return $containerHealth -in @('healthy', 'running')
  } catch {
    return $false
  }
}

# The inbox depends on all three local services. Start them together so the
# dashboard cannot look healthy while messaging workers are silently offline.
$dockerReady = $false
if (Test-Path -LiteralPath $dockerExe) {
  try {
    & $dockerExe info --format '{{.ServerVersion}}' 2>$null | Out-Null
    $dockerReady = $LASTEXITCODE -eq 0
  } catch {}
}

if (-not $dockerReady -and (Test-Path -LiteralPath $dockerDesktopExe)) {
  Start-Process -FilePath $dockerDesktopExe -WindowStyle Hidden
}

if (-not (Test-HttpReady $ollamaHealthUrl) -and (Test-Path -LiteralPath $ollamaExe)) {
  Start-Process -FilePath $ollamaExe -ArgumentList @('serve') -WindowStyle Hidden
}

$alreadyRunning = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if (-not $alreadyRunning) {
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show('The bundled Node runtime could not be found. Open Codex and ask it to repair the Getit dashboard launcher.', 'Getit Dashboard')
    exit 1
  }

  Start-Process -FilePath $nodeExe -ArgumentList @('node_modules\next\dist\bin\next', 'dev', '-p', '3001') -WorkingDirectory $projectRoot -WindowStyle Hidden
}

$dashboardReady = $false
$n8nReady = $false
for ($attempt = 0; $attempt -lt 90; $attempt++) {
  if (-not $dashboardReady) { $dashboardReady = Test-HttpReady $dashboardUrl }
  if (-not $n8nReady) { $n8nReady = Test-N8nReady }

  if ($dashboardReady -and $n8nReady) { break }
  Start-Sleep -Seconds 1
}

if ($dashboardReady) {
  Start-Process $dashboardUrl
  exit 0
}

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show('The dashboard did not start. Open Codex and say: Start the Getit dashboard.', 'Getit Dashboard')
exit 1
