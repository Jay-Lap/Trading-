# Removes the scheduled task. Open positions keep their exchange stop/take-profit orders.
Unregister-ScheduledTask -TaskName 'BinanceTeamBot' -Confirm:$false
Write-Host '자동 실행을 해제했습니다. 열린 포지션은 바이낸스에 걸린 손절/익절 주문이 계속 보호합니다.'
