#!/usr/bin/env bash
# Copy the live bot's records from onpod to this Pi (state, trade journal, decisions, reports).
# Needs the onpod CLI logged in on this Pi:  curl -fsSL https://onpod.ai/install.sh | sh && onpod login --token op_u_...
# Run while the onpod bot is still running (exec needs it), right after a 4h decision, then pause onpod immediately.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p data/live/reports
for f in state.json journal.jsonl decisions.jsonl; do
  onpod exec binance-team-bot -- cat "data/live/$f" > "data/live/$f.tmp" && mv "data/live/$f.tmp" "data/live/$f" && echo "✓ $f"
done
for r in $(onpod exec binance-team-bot -- ls data/live/reports 2>/dev/null); do
  onpod exec binance-team-bot -- cat "data/live/reports/$r" > "data/live/reports/$r" && echo "✓ reports/$r"
done
node -e "const s=require('./data/live/state.json');console.log('복사 확인 — 기록된 포지션:',Object.keys(s.positions||{}).join(',')||'없음','· 단계:',s.tierHigh)"
