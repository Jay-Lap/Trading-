# 윈도우 PC에서 실행하기 (하루 6번 자동 실행)

봇은 4시간봉이 마감된 직후(한국 시간 1:07, 5:07, 9:07, 13:07, 17:07, 21:07)에 한 번씩 깨어나 판단하고 꺼집니다.
그 사이에는 **바이낸스 서버에 걸어 둔 손절·익절 주문**이 포지션을 지킵니다.

| PC 상태 | 결과 |
|---|---|
| 켜져 있음 / 절전 | 그 시각에 깨어나 실행 |
| 완전히 꺼짐 | 그 회차는 건너뜀 → 다음에 켜지면 바로 한 번 실행(밀린 회차 1번) |
| 꺼져 있는 동안 손절가 도달 | 바이낸스가 바로 청산 (PC와 무관) |

## 1. 설치 (처음 한 번)

1. **Node.js** 설치: https://nodejs.org → **LTS** 버전 다운로드 → 기본값으로 설치
2. 이 저장소 내려받기: GitHub 페이지 → 초록색 **Code** → **Download ZIP** → 압축 풀기
   (예: `C:\bot` 에 풀기. 경로에 한글/공백이 없으면 편합니다)
3. 그 폴더에서 주소창에 `cmd` 입력 후 엔터 → 검은 창(명령 프롬프트)이 열림
4. 차례로 입력:
   ```
   node --version
   copy .env.example .env
   npm test
   ```
   `node --version` 이 v20 이상, `npm test` 가 `fail 0` 이면 정상.

## 2. 가상 돈으로 PC에서 확인 (키 필요 없음)

```
npm run check
npm run once
```
- `npm run check`: 바이낸스 선물 시세에 연결되는지 확인 (✅ 가 나와야 함)
- `npm run once`: 한 번 판단해 보기. `data\paper\` 에 기록이 생깁니다.

## 3. 데모 계좌 (가짜 돈, 실제 주문 흐름 확인) — 실계좌 전에 꼭

1. 바이낸스 **Demo Trading** 에서 데모용 API 키 만들기
2. 메모장으로 `.env` 열기 → 수정:
   ```
   MODE=testnet
   BINANCE_API_KEY=데모키
   BINANCE_API_SECRET=데모시크릿
   ```
3. `npm run check` → 모든 줄이 ✅ 인지 확인 (특히 "포지션 모드: 단방향")
4. `scripts\windows\run-now.cmd` 더블클릭 → 진입이 생기면 바이낸스 데모 화면의
   **조건부 주문(손절/익절)** 목록에 주문이 생겼는지 확인

## 4. 자동 실행 등록

명령 프롬프트(봇 폴더)에서:
```
powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1
```
- "등록 완료" 와 실행 시각이 나오면 끝
- 기록 보기: `data\scheduled-run.log` (메모장으로 열기), 거래 내역: `data\<모드>\journal.jsonl`
- 확인: 시작 메뉴 → **작업 스케줄러** → `BinanceTeamBot`
- 해제: `powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall-task.ps1`

절전에서 깨우기가 안 되면: 제어판 → 전원 옵션 → 고급 설정 → 절전 → **절전 모드 해제 타이머 허용: 사용**.

## 5. 실계좌로 바꾸기

1. 실계좌 API 키: **Enable Futures 만**, **출금 끔**, **IP 제한**
   - 집 인터넷 IP 확인: 브라우저에서 "내 IP" 검색. 집 IP 는 공유기 재시작 등으로 바뀔 수 있어요.
     바뀌면 봇이 인증 오류로 멈추고(주문 못 냄), 이미 걸린 손절 주문은 계속 작동합니다 → 키의 IP 를 새로 등록하면 됨.
2. 잃어도 되는 소액만 USDT 로 입금 → **USDⓈ-M 선물 지갑**으로 이체
3. `.env` 수정:
   ```
   MODE=live
   LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY_LOSS
   BINANCE_API_KEY=실계좌키
   BINANCE_API_SECRET=실계좌시크릿
   MAX_NOTIONAL_USDT=50
   RISK_PER_TRADE_PCT=0.5
   ```
4. `npm run check` → 전부 ✅ → `scripts\windows\run-now.cmd` 로 한 번 직접 실행해 확인
5. 자동 실행은 이미 등록돼 있으면 그대로 실계좌로 돕니다 (.env 를 읽기 때문)

## 긴급 정지

- 봇 폴더에 `STOP` 이라는 이름의 빈 파일을 만들면 → 다음 실행 때 모든 포지션 청산 후 정지
- 지금 당장: 바이낸스 앱에서 직접 포지션 청산 (봇은 다음 실행 때 상황을 따라갑니다)
- 자동 실행 끄기: `uninstall-task.ps1`

## 나중에 서버로 옮길 때 (온팟 또는 가상 서버)

옮기기 전 확인할 것:
1. 서버에서 키 없이 `npm run check` → 바이낸스 선물 시세가 ✅ 인지 (지역 차단 HTTP 451 이면 그 서버는 불가)
2. 항상 켜져 있는 플랜인지 (온팟 무료 플랜은 30분 무요청 시 절전 → 봇이 멈춤)
3. 고정 IP — 온팟은 공유 고정 IP(유료), 일반 가상 서버는 전용 IP
4. API 키의 IP 제한을 새 서버 IP 로 바꾸고, PC 의 자동 실행은 해제 (두 곳에서 동시에 돌리면 안 됨)
