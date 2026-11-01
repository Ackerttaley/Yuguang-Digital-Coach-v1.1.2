# 启动本地服务并检查运行环境与端口。

param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root 'runtime\python\python.exe'
if (-not (Test-Path -LiteralPath $python)) { throw 'Python environment missing. Follow howtoinstall.md.' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'frontend\dist\index.html'))) { throw 'Frontend build missing. Follow howtoinstall.md.' }
$env:PYTHONHOME = Join-Path $root 'runtime\python'
$env:PYTHONPATH = Join-Path $root 'runtime\site-packages'
$env:PYTHONNOUSERSITE = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
New-Item -ItemType Directory -Force "$root\logs", "$root\videos", "$root\.run" | Out-Null
try { $health = Invoke-RestMethod 'http://127.0.0.1:8012/api/health' -TimeoutSec 2 } catch { $health = $null }
if ($health) {
    $record = Join-Path $root '.run\service.json'
    if (-not (Test-Path -LiteralPath $record)) { throw 'Port 8012 is occupied by another running service. Stop it before starting this project.' }
    $entry = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    $listener = Get-NetTCPConnection -State Listen -LocalPort 8012 -ErrorAction SilentlyContinue | Select-Object -First 1
    $running = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if (-not $listener -or -not $running -or $listener.OwningProcess -ne $running.Id -or [Math]::Abs(($running.StartTime.ToUniversalTime()-[DateTime]::Parse($entry.started_at).ToUniversalTime()).TotalSeconds) -ge 2) { throw 'Port 8012 belongs to another process. Stop it before starting this project.' }
} else {
    if (Get-NetTCPConnection -State Listen -LocalPort 8012 -ErrorAction SilentlyContinue) { throw 'Port 8012 is occupied.' }
    $process = Start-Process $python -ArgumentList '-m','uvicorn','backend.main:app','--host','127.0.0.1','--port','8012' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput "$root\logs\backend.stdout.log" -RedirectStandardError "$root\logs\backend.stderr.log" -PassThru
    @{pid=$process.Id; started_at=$process.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content "$root\.run\service.json"
    $ready = $false
    for ($i=0; $i -lt 90; $i++) {
        try { $health=Invoke-RestMethod 'http://127.0.0.1:8012/api/health' -TimeoutSec 2; if($health.service_version -eq '1.1.2'){$ready=$true;break} } catch {}
        Start-Sleep -Milliseconds 650
    }
    if (-not $ready) { throw 'Startup failed. Check logs/backend.stderr.log.' }
}
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8012' }
