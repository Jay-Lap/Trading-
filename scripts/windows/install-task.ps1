# Registers a Windows scheduled task that runs the bot once right after every 4h candle close
# (00:07, 04:07, 08:07, 12:07, 16:07, 20:07 UTC), converted to this PC's local time.
# Usage (PowerShell, in the repo folder):
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cmd  = Join-Path $PSScriptRoot 'run-once.cmd'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치하세요.' }
if (-not (Test-Path (Join-Path $repo '.env'))) { throw '.env 파일이 없습니다. 먼저: copy .env.example .env' }

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`"" -WorkingDirectory $repo

$triggers = @()
foreach ($h in 0, 4, 8, 12, 16, 20) {
  $utc   = [DateTime]::SpecifyKind([DateTime]::UtcNow.Date.AddHours($h).AddMinutes(7), [DateTimeKind]::Utc)
  $local = $utc.ToLocalTime()
  $triggers += New-ScheduledTaskTrigger -Daily -At $local
}

$settings = New-ScheduledTaskSettingsSet `
  -WakeToRun `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'BinanceTeamBot' -Action $action -Trigger $triggers -Settings $settings `
  -Description 'Binance futures team bot: one decision after each 4h candle close' -Force | Out-Null

Write-Host '등록 완료: 작업 이름 BinanceTeamBot'
Write-Host ('실행 시각(이 PC 기준): ' + (($triggers | ForEach-Object { ([DateTime]$_.StartBoundary).ToString('HH:mm') }) -join ', '))
Write-Host '기록: data\scheduled-run.log'
