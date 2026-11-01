# 停止本项目服务并检查端口状态。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$record = Join-Path $root '.run\service.json'
if (Test-Path -LiteralPath $record) {
    $entry = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
    $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if ($process -and [Math]::Abs(($process.StartTime.ToUniversalTime() - [DateTime]::Parse($entry.started_at).ToUniversalTime()).TotalSeconds) -lt 2) {
        Stop-Process -Id $process.Id -ErrorAction Stop
        if (-not $process.WaitForExit(60000)) { throw '服务在 60 秒内未停止，未清理数据。' }
        Write-Host '平台服务已停止。'
    }
    Remove-Item -LiteralPath $record -Force
}
if (Get-NetTCPConnection -State Listen -LocalPort 8012 -ErrorAction SilentlyContinue) {
    throw '端口 8012 仍被占用，无法确认平台服务已停止，未清理数据。'
}
foreach ($name in @('data', 'videos')) {
    $target = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $item = Get-Item -LiteralPath $target -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "拒绝清理非普通目录：$target" }
    $resolvedRoot = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
    $resolvedTarget = [IO.Path]::GetFullPath($item.FullName)
    if (-not $resolvedTarget.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "目录不在项目内：$target" }
    Get-ChildItem -LiteralPath $target -Force | Remove-Item -Recurse -Force -ErrorAction Stop
    Write-Host "已清空：$name"
}
Write-Host '已清除视频、分析结果、姿态缓存和本地数据库。'
