# 온팟(onpod)에서 상시 실행

- 앱 이름: `binance-team-bot` · 형태: 봇/워커(`--shape worker`) · 플랜: **hobby (0.5vCPU·512MB, 상시 가동 최저가)**
- 서버 위치: 대한민국 → 바이낸스 선물 시세 정상 접속 확인 (2026-11-09)
- 비용: 약 ₩22/시간 ≈ **월 ₩16,000**. 고정 IP·디스크·DB 는 안 씀 (최소 비용)
- 거래 기록·계좌 상태: 버킷 `trading-bot-records` 에 저장 (저장 ₩45/GB·월 — 기록은 몇 KB 라 사실상 0원)
  - `trading-bot/<모드>/journal.jsonl` (거래 기록) · `trading-bot/<모드>/state.json` (가상계좌·손절가·일일손실)
- 무료 티어는 봇에 쓸 수 없음 (30분 뒤 절전 → 다시 안 깨어남)

## CLI 준비 (윈도우 PowerShell)

```
irm https://onpod.ai/install.ps1 | iex
onpod login --token <console.onpod.ai 에서 만든 API 키>
```

## 자주 쓰는 명령

| 하고 싶은 것 | 명령 |
|---|---|
| 로그 보기 | `onpod app logs binance-team-bot --tail 100` |
| 설정 보기 (값은 가려짐) | `onpod app env list binance-team-bot` |
| 잔액·하루 비용 | `onpod balance` |
| 잠시 멈추기 (컴퓨트 요금 0) | `onpod app pause binance-team-bot` |
| 다시 켜기 | `onpod app resume binance-team-bot` |
| 코드 바꾼 뒤 반영 | 저장소 폴더에서 `onpod app update binance-team-bot --build .` |
| 완전히 지우기 | `onpod app rm binance-team-bot` (버킷 기록은 남음 · 다시 배포 시 `--attach-bucket trading-bot-records` 로 이어감) |

## 데모 계좌(testnet)로 바꾸기

```
onpod app env set binance-team-bot MODE=testnet BINANCE_API_KEY=데모키 BINANCE_API_SECRET=데모시크릿
```
→ 자동 재시작. 로그에 `시세 출처: 바이낸스 선물`, 진입 시 `거래소 손절 주문 설정` 이 나오는지 확인.

## 실계좌로 바꾸기 (데모 확인 후에만)

1. 고정 IP 켜기 — 최소 비용은 공유 IP:
   ```
   onpod app egress enable binance-team-bot shared     # 약 ₩27,000/월
   onpod app egress show binance-team-bot              # 여기 나온 IP 를 바이낸스 API 키 허용 IP 로 등록
   ```
   계좌가 커지면 전용 IP(`dedicated`, 약 ₩94,500/월)로 변경.
2. 바이낸스 실계좌 API 키: Enable Futures 만 · 출금 끔 · 위 IP 만 허용
3. 설정:
   ```
   onpod app env set binance-team-bot MODE=live LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY_LOSS BINANCE_API_KEY=... BINANCE_API_SECRET=... MAX_NOTIONAL_USDT=50 RISK_PER_TRADE_PCT=0.5
   ```

## 알아둘 점

- 서버가 재시작돼도 버킷에서 기록·상태를 복원해 이어갑니다 (가상 계좌 포함).
  매 판단 후, 거래 때, 종료 신호(SIGTERM) 때 버킷에 올립니다. 업로드가 실패해도 매매는 멈추지 않고 다음 틱에 재시도.
- 거래 기록 내려받기:
  ```
  onpod exec binance-team-bot -- cat data/paper/journal.jsonl
  ```
  (모드에 따라 paper / testnet / live)
- 긴급 정지: `onpod app pause binance-team-bot` 후 바이낸스 앱에서 직접 청산
  (pause 만 하면 포지션은 거래소 손절/익절 주문이 계속 보호)
- PC 자동 실행(`docs/WINDOWS.md`)과 **동시에 돌리지 마세요** (같은 키로 두 봇이 주문)
