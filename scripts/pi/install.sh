#!/usr/bin/env bash
# Raspberry Pi 5 (Raspberry Pi OS 64-bit) — install the trading bot as an always-on service.
# Run inside the cloned repo:  bash scripts/pi/install.sh
# It does NOT start trading. Start only after the onpod bot is paused (see docs/RASPBERRY_PI.md).
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="$(pwd)"

echo "▸ 1/4 Node.js 확인"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "  Node.js 22 설치 (NodeSource 공식 저장소, sudo 필요)"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  sudo bash /tmp/nodesource_setup.sh
  sudo apt-get install -y nodejs
fi
node --version

echo "▸ 2/4 테스트"
npm test 2>&1 | grep -E "^# (pass|fail)"

echo "▸ 3/4 설정 파일(.env)"
if [ -f .env ]; then
  echo "  .env 가 이미 있어서 그대로 둡니다."
else
  read -r -s -p "  바이낸스 API Key 붙여넣기(화면에 안 보임): " K; echo
  read -r -s -p "  바이낸스 Secret Key 붙여넣기(화면에 안 보임): " S; echo
  umask 077
  cat > .env <<ENV
MODE=live
LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY_LOSS
BINANCE_API_KEY=$K
BINANCE_API_SECRET=$S
SYMBOLS=SOLUSDT
INTERVAL=4h
STRATEGY=committee
TAKE_PROFIT_ATR_MULT=5
MAX_STOP_PCT=6
LEVERAGE=3
MAX_OPEN_POSITIONS=1
MAX_SAME_DIRECTION=1
RISK_PER_TRADE_PCT=5
MAX_NOTIONAL_USDT=20
DAILY_MAX_LOSS_PCT=10
AUTO_TIERS=1
TIER1_RISK_PCT=6
TIER1_NOTIONAL_PCT=150
EXPAND_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
ENV
  unset K S
  chmod 600 .env
  echo "  .env 생성 (권한 600: 이 계정만 읽기 가능)"
fi

echo "▸ 4/4 자동 실행 서비스 등록 (아직 시작하지 않음)"
sed -e "s#__REPO__#$REPO#g" -e "s#__USER__#$(id -un)#g" scripts/pi/binance-team-bot.service | sudo tee /etc/systemd/system/binance-team-bot.service >/dev/null
sudo systemctl daemon-reload
echo
echo "✅ 설치 완료. 아직 봇은 꺼져 있습니다."
echo "   다음: 온팟 봇 멈추기 → 기록 옮기기 → 바이낸스 키 IP 변경 → 시작 (docs/RASPBERRY_PI.md)"
