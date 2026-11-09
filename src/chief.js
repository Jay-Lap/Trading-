// CHIEF — coordinates the 6 role bots. It never decides size or places orders itself:
// DATA → STRATEGY → RISK (veto/size) → EXECUTION → EXIT (protect/close) → REPORTER.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, baseUrlFor } from './lib/config.js';
import { BinanceClient } from './lib/binanceClient.js';
import { DataBot, SpotDataBot, SPOT_DATA_URL } from './bots/data.js';
import { generateSignal } from './bots/strategy.js';
import { sizePosition, checkDailyLimit, allowEntry, rankCandidates, reanchor } from './bots/risk.js';
import { ExchangeBroker, PaperBroker } from './bots/execution.js';
import { ExitBot } from './bots/exit.js';
import { Reporter } from './bots/reporter.js';

const STOP_FILE = path.resolve(process.cwd(), 'STOP');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function buildTeam(cfg, { reporter, dataClient, tradeClient } = {}) {
  const r = reporter ?? new Reporter(path.resolve(process.cwd(), 'data', cfg.mode));
  const tc = tradeClient ?? new BinanceClient({ baseUrl: baseUrlFor(cfg), apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });
  // paper mode reads real (mainnet) public prices; testnet/live read from the exchange they trade on.
  const dc = dataClient ?? (cfg.mode === 'paper' ? new BinanceClient({ baseUrl: cfg.liveBaseUrl }) : tc);
  let data = new DataBot(dc);
  let filters;
  try { filters = await data.symbolFilters(cfg.symbols); }
  catch (e) {
    if (cfg.mode !== 'paper' || dataClient) throw e;
    r.warn(`선물 시세 접속 불가 (${e.message}) → 페이퍼 모드는 현물 시세(${SPOT_DATA_URL})로 대체`);
    data = new SpotDataBot(new BinanceClient({ baseUrl: SPOT_DATA_URL }));
    filters = await data.symbolFilters(cfg.symbols);
  }
  let broker;
  if (cfg.mode === 'paper') {
    r.state.paper ??= {};
    broker = new PaperBroker(cfg.paperStartUsdt, s => data.markPrice(s), r.state.paper);
    // drop stop records for symbols the fake account does not hold
    for (const s of Object.keys(r.state.positions)) if (!r.state.paper.pos[s]) delete r.state.positions[s];
  } else broker = new ExchangeBroker(tc, r);
  await broker.init(cfg.symbols, cfg.leverage);
  return { cfg, r, data, broker, filters, exit: new ExitBot(broker, r, cfg) };
}

export async function tick(team) {
  const { cfg, r, data, broker, filters, exit } = team;

  if (fs.existsSync(STOP_FILE)) {
    r.warn('STOP 파일 감지 → 모든 포지션 청산 후 종료');
    for (const s of cfg.symbols) {
      const pos = await broker.position(s);
      if (pos) await exit.close(s, pos, filters[s], '긴급 정지(STOP 파일)');
      else await broker.cancelProtection(s);
    }
    r.save();
    return 'STOPPED';
  }

  const equity = await broker.equity();
  const daily = checkDailyLimit(r.state, equity, cfg);
  if (daily.halted) r.warn(`일일 손실 ${daily.lossPct.toFixed(2)}% ≥ 한도 ${cfg.dailyMaxLossPct}% → 오늘(UTC) 신규 진입 중단`);

  // Pass 1: protect/close existing positions and collect fresh entry candidates.
  const candidates = [];
  const open = {}; // symbol -> 'LONG' | 'SHORT'
  for (const symbol of cfg.symbols) {
    const f = filters[symbol];
    try {
      let pos = await broker.position(symbol);
      if (pos && broker.kind === 'paper' && r.state.paper.lastCheck) {
        const since = await data.candlesSince(symbol, '5m', r.state.paper.lastCheck);
        if (await exit.paperCatchUp(symbol, pos, f, since)) pos = null;
      }
      if (pos && await exit.manage(symbol, pos, f)) pos = null;
      if (pos) open[symbol] = pos.qty > 0 ? 'LONG' : 'SHORT';

      const candles = await data.candles(symbol, cfg.interval);
      const last = candles.at(-1);
      if (!last || r.state.lastCandle[symbol] === last.openTime) continue; // only act once per closed candle
      r.state.lastCandle[symbol] = last.openTime;

      const sig = generateSignal(candles, cfg);
      if (pos && sig.closeSide && open[symbol] === sig.closeSide) {
        await exit.close(symbol, pos, f, `위원회 반대 전환 (확신 ${sig.conviction.toFixed(2)})`); pos = null; delete open[symbol];
      }
      if (sig.action === 'HOLD') { r.info(`${symbol} 대기: ${sig.reason}${sig.trend ? ` (추세 ${sig.trend})` : ''} 가격 ${sig.price ?? '-'}`); continue; }
      if (pos && open[symbol] === sig.action) { r.info(`${symbol} 이미 같은 방향 포지션 보유`); continue; }
      if (pos) { await exit.close(symbol, pos, f, `반대 신호(${sig.reason})`); pos = null; delete open[symbol]; }
      candidates.push({ symbol, sig });
    } catch (e) {
      r.error(`${symbol} 처리 중 오류: ${e.message}`);
    }
  }

  // Pass 2: RISK bot ranks candidates by conviction and enforces portfolio limits.
  for (const { symbol, sig: raw } of rankCandidates(candidates)) {
    const f = filters[symbol];
    try {
      const sig = reanchor(raw, await data.markPrice(symbol));
      if (daily.halted) continue;
      const gate = allowEntry(sig.action, open, cfg);
      if (!gate.ok) { r.warn(`${symbol} ${sig.action} 보류: ${gate.reason}`); continue; }

      const sizing = sizePosition({ signal: sig, equity: await broker.equity(), filters: f, cfg });
      if (!sizing.ok) { r.warn(`${symbol} 리스크 봇 거부: ${sizing.reason}`); continue; }

      const side = sig.action === 'LONG' ? 'BUY' : 'SELL';
      // Record intended stop BEFORE ordering, so a crash mid-way still leaves a stop to enforce.
      r.state.positions[symbol] = { stop: sig.stop, takeProfit: sig.takeProfit, side, signalPrice: sig.signalPrice ?? sig.price, openedAt: new Date().toISOString() };
      r.save();
      let res;
      try { res = await broker.market(symbol, side, sizing.qty, f); }
      catch (e) {
        if (!(await broker.position(symbol))) delete r.state.positions[symbol];
        throw e;
      }
      open[symbol] = sig.action;
      const fill = Number(res.avgPrice) || sig.price;
      r.trade({ event: 'OPEN', symbol, side, qty: sizing.qty, price: fill, reason: sig.reason, stop: sig.stop, takeProfit: sig.takeProfit, riskUsdt: +sizing.riskUsdt.toFixed(2) });

      const now = await broker.position(symbol);
      if (now) await exit.manage(symbol, now, f); // places exchange stop/TP, or flattens if it can't
    } catch (e) {
      r.error(`${symbol} 처리 중 오류: ${e.message}`);
    }
  }
  if (broker.kind === 'paper') {
    r.state.paper.lastCheck = Date.now();
    r.state.paper.equity = +(await broker.equity()).toFixed(2);
    r.info(`가상 계좌: 평가금액 ${r.state.paper.equity} USDT (시작 ${r.state.paper.startUsdt}) · 보유 ${Object.entries(r.state.paper.pos).map(([k, p]) => `${k} ${p.qty > 0 ? '롱' : '숏'} ${Math.abs(p.qty)}@${p.entryPrice}`).join(', ') || '없음'}`);
  }
  r.save();
  return 'OK';
}

async function main() {
  const once = process.argv.includes('--once');
  const cfg = loadConfig();
  console.log(`\n=== 바이낸스 선물 팀 봇 | 모드: ${cfg.mode.toUpperCase()} | 종목 ${cfg.symbols.join(',')} | ${cfg.interval} | 레버리지 ${cfg.leverage}x ===`);
  console.log(`리스크: 1회 ${cfg.riskPerTradePct}% · 포지션 최대 ${cfg.maxNotionalUsdt} USDT · 일일 손실 한도 ${cfg.dailyMaxLossPct}%`);
  if (cfg.mode === 'live') {
    console.log('\n⚠️  실제 돈으로 주문합니다. 10초 안에 Ctrl+C 를 누르면 취소됩니다.');
    await sleep(10_000);
  }
  const team = await buildTeam(cfg);
  team.r.info(`시세 출처: ${team.data.source === 'spot' ? '바이낸스 현물(대체)' : '바이낸스 선물'}`);
  team.r.info(`시작. 계좌 평가금액 ${(await team.broker.equity()).toFixed(2)} USDT. 긴급 정지: 이 폴더에 STOP 파일 생성.`);
  process.on('SIGINT', () => { team.r.save(); team.r.info('Ctrl+C 로 종료. 열린 포지션은 거래소 손절 주문이 계속 보호합니다.'); process.exit(0); });
  for (;;) {
    let status;
    try { status = await tick(team); } catch (e) { team.r.error(`틱 오류: ${e.message}`); }
    if (status === 'STOPPED' || once) break;
    await sleep(cfg.pollSeconds * 1000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('\n실행 실패:', e.message); process.exit(1); });
}
