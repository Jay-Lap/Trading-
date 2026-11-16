# 라즈베리파이 5로 봇 옮기기 (온팟 대신)

전기세 한 달 약 500~1,200원 (평균 5~6W). 지금 온팟은 한 달 약 6만 원대.

## 준비물
- 라즈베리파이 5 + **공식 27W 전원** + **쿨러**
- **SSD** (M.2 NVMe 확장 보드 또는 USB SSD) — SD 카드는 24시간 기록에 금방 고장 남
- 처음 설치용 microSD, 가능하면 **유선 랜**

## 1. OS 설치 (PC에서, 10분)
1. PC에 **Raspberry Pi Imager** 설치 → 장치 *Raspberry Pi 5*, OS *Raspberry Pi OS Lite (64-bit)*, 저장장치 *SSD*(또는 SD)
2. 설정(톱니바퀴): 사용자 이름·비밀번호, **SSH 사용** 켜기, 와이파이(필요 시), 시간대 *Asia/Seoul*
3. 꽂고 전원 → PC 터미널(PowerShell)에서 `ssh 사용자이름@raspberrypi.local`

## 2. 봇 설치 (라즈베리파이에서)
```
sudo apt-get update && sudo apt-get install -y git
git clone -b claude/sleepy-newton-qehyl7 https://github.com/jay-lap/trading-.git
cd trading-
bash scripts/pi/install.sh
```
- Node.js 22 설치 → 테스트 → 바이낸스 키 입력(화면에 안 보임, `.env` 권한 600) → 자동 실행 서비스 등록
- **이때 봇은 아직 꺼져 있음** (온팟과 동시에 돌면 주문이 겹침)

## 3. 옮기기 (순서 중요)
1. **집 IP 확인:** 라즈베리파이에서 `curl -s https://api.ipify.org`
2. **기록 복사:** 라즈베리파이에 onpod CLI 설치·로그인 후, 4시간 판단 직후(예: 13:05)에
   ```
   curl -fsSL https://onpod.ai/install.sh | sh
   onpod login --token op_u_온팟키
   bash scripts/pi/migrate-from-onpod.sh
   ```
3. **바로 온팟 봇 멈추기:** `onpod app pause binance-team-bot`
4. **바이낸스 API 키 허용 IP 변경:** `13.124.46.39` → 1번의 집 IP (출금은 계속 꺼둔 채로)
5. **라즈베리파이 봇 시작:**
   ```
   sudo systemctl enable --now binance-team-bot
   journalctl -u binance-team-bot -f      # 로그 보기 (Ctrl+C 로 나가기)
   ```
   `시작. 계좌 평가금액 …` 과 포지션·손절 주문이 그대로인지 확인
6. 며칠 문제없으면 온팟 정리: 고정 IP 끄기 `onpod app egress disable binance-team-bot`, 앱 삭제 `onpod app rm binance-team-bot`

## 자주 쓰는 명령 (라즈베리파이)
| 하고 싶은 것 | 명령 |
|---|---|
| 상태 | `systemctl status binance-team-bot` |
| 로그 | `journalctl -u binance-team-bot -n 50` |
| 멈추기 | `sudo systemctl stop binance-team-bot` |
| 다시 시작 | `sudo systemctl restart binance-team-bot` |
| 코드 업데이트 | `git pull && sudo systemctl restart binance-team-bot` |
| 거래 기록 | `cat data/live/journal.jsonl` · 일일 보고서 `ls data/live/reports` |

## 알아둘 점
- **집 IP가 바뀌면** 봇이 바이낸스 인증 오류(-2015)로 새 주문을 못 냄 → 바이낸스 키의 허용 IP만 새로 바꾸면 됨.
  이미 걸린 손절·익절은 바이낸스 서버에서 계속 작동.
- 정전·재부팅 후에는 서비스가 자동으로 다시 켜짐.
- 기록은 SSD의 `data/live/` 에 저장 (온팟 버킷은 안 씀).
