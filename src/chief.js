// CHIEF — coordinates the 6 role bots. It never decides size or places orders itself:
// DATA → STRATEGY → RISK (veto/size) → EXECUTION → EXIT (protect/close) → REPORTER.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, baseUrlFor } from './lib/config.js';
import { BinanceClient } from './lib/binanceClient.js';
import { DataBot, SpotDataBot, SPOT_DATA_URL } from './bots/data.js';
import { generateSignal } from './bots/strategy.js';
import { committeeConviction } from './bots/committee.js';
import { sizePosition, checkDailyLimit, allowEntry, rankCandidates, reanchor, applyTier, liquidityDrop, TIERS } from './bots/risk.js';
import { buildDailyReport } from './bots/report.js';
import { entryContext } from './lib/context.js';
import { ExchangeBroker, PaperBroker } from './bots/execution.js';
import { ExitBot } from './bots/exit.js';
import { Reporter } from './bots/reporter.js';
import { S3Store } from './lib/s3.js';

const STOP_FILE = path.resolve(process.cwd(), 'STOP');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function buildTeam(cfg, { reporter, dataClient, tradeClient } = {}) {
  const r = reporter ?? new Reporter(path.resolve(process.cwd(), 'data', cfg.mode));
  const store = reporter ? null : S3Store.fromEnv();
  if (store) {
    r.attachStore(store, `trading-bot/${cfg.mode}`);
    const restored = await r.restore();
    r.info(`기록 저장소(버킷 ${store.bucket}) 연결 · ${restored ? '이전 기록 복원' : '새 기록 시작'}`);
  }
  const tc = tradeClient ?? new BinanceClient({ baseUrl: baseUrlFor(cfg), apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });
  // paper mode reads real (mainnet) public prices; testnet/live read from the exchange they trade on.
  const dc = dataClient ?? (cfg.mode === 'paper' ? new BinanceClient({ baseUrl: cfg.liveBaseUrl }) : tc);
  let data = new DataBot(dc);
  let filters;
  const allSymbols = cfg.autoTiers ? [...new Set([...cfg.symbols, ...cfg.expandSymbols])] : cfg.symbols;
  try { filters = await data.symbolFilters(allSymbols); }
  catch (e) {
    if (cfg.mode !== 'paper' || dataClient) throw e;
    r.warn(`선물 시세 접속 불가 (${e.message}) → 페이퍼 모드는 현물 시세(${SPOT_DATA_URL})로 대체`);
    data = new SpotDataBot(new BinanceClient({ baseUrl: SPOT_DATA_URL }));
    filters = await data.symbolFilters(allSymbols);
  }
  let broker;
  if (cfg.mode === 'paper') {
    r.state.paper ??= {};
    broker = new PaperBroker(cfg.paperStartUsdt, s => data.markPrice(s), r.state.paper);
    // drop stop records for symbols the fake account does not hold
    for (const s of Object.keys(r.state.positions)) if (!r.state.paper.pos[s]) delete r.state.positions[s];
  } else broker = new ExchangeBroker(tc, r);
  await broker.init(allSymbols, cfg.leverage);
  return { cfg, r, data, broker, filters, allSymbols, exit: new ExitBot(broker, r, cfg) };
}

export async function tick(team) {
  const { r, data, broker, filters, exit } = team;
  let cfg = team.cfg;

  if (fs.existsSync(STOP_FILE)) {
    r.warn('STOP 파일 감지 → 모든 포지션 청산 후 종료');
    for (const s of team.allSymbols ?? cfg.symbols) {
      const pos = await broker.position(s);
      if (pos) await exit.close(s, pos, filters[s], '긴급 정지(STOP 파일)');
      else await broker.cancelProtection(s);
    }
    r.save();
    await r.flush({ force: true });
    return 'STOPPED';
  }

  const equity = await broker.equity();
  if (cfg.autoTiers) {
    const t = applyTier(cfg, equity, r.state);
    if (t.changed) r.warn(`자동 단계 전환 → ${t.tier.name} (잔고 ${equity.toFixed(2)} USDT): 위험 ${t.cfg.riskPerTradePct}% · 종목 ${t.cfg.symbols.join(',')}`);
    cfg = t.cfg;
  }
  await maybeDailyReport(team, cfg, equity);
  const daily = checkDailyLimit(r.state, equity, cfg);
  if (daily.halted) r.warn(`일일 손실 ${daily.lossPct.toFixed(2)}% ≥ 한도 ${cfg.dailyMaxLossPct}% → 오늘(UTC) 신규 진입 중단`);

  // Pass 1: protect/close existing positions and collect fresh entry candidates.
  const candidates = [];
  const open = {}; // symbol -> 'LONG' | 'SHORT'
  for (const symbol of cfg.symbols) {
    const f = filters[symbol];
    try {
      let pos = await broker.position(symbol);
      if (!pos && broker.kind === 'exchange' && r.state.positions[symbol]) await exit.syncExchangeClosed(symbol);
      if (pos && broker.kind === 'paper' && r.state.paper.lastCheck) {
        const since = await data.candlesSince(symbol, '5m', r.state.paper.lastCheck);
        if (await exit.paperCatchUp(symbol, pos, f, since)) pos = null;
      }
      if (pos && await exit.manage(symbol, pos, f)) pos = null;
      if (pos && cfg.liqExit && Date.now() - (r.state.liqCheck?.[symbol] ?? 0) > 15 * 60e3) {
        (r.state.liqCheck ??= {})[symbol] = Date.now();
        const lq = liquidityDrop(await data.candles(symbol, '1h', 40), cfg.liqDropPct);
        if (lq.drop) { await exit.close(symbol, pos, f, `유동성 급감: 최근 6시간 거래량이 평소의 ${lq.ratio.toFixed(0)}%`); pos = null; }
      }
      if (pos) open[symbol] = pos.qty > 0 ? 'LONG' : 'SHORT';

      const candles = await data.candles(symbol, cfg.interval);
      const last = candles.at(-1);
      if (!last || r.state.lastCandle[symbol] === last.openTime) continue; // only act once per closed candle
      r.state.lastCandle[symbol] = last.openTime;

      let sCfg = cfg;
      if (cfg.htfInterval && cfg.strategy === 'committee') {
        const hc = committeeConviction(await data.candles(symbol, cfg.htfInterval, 500));
        if (Number.isFinite(hc)) sCfg = { ...cfg, htfConviction: hc };
      }
      const sig = generateSignal(candles, sCfg);
      if (pos && sig.closeSide && open[symbol] === sig.closeSide) {
        r.decision({ symbol, decision: 'CLOSE', reason: '위원회 반대 전환', ...sigInfo(sig) });
        await exit.close(symbol, pos, f, `위원회 반대 전환 (확신 ${sig.conviction.toFixed(2)})`); pos = null; delete open[symbol];
      }
      if (sig.action === 'HOLD') r.decision({ symbol, decision: pos ? 'KEEP' : 'HOLD', reason: sig.reason, ...sigInfo(sig) });
      if (sig.action === 'HOLD') { r.info(`${symbol} ${pos ? `보유 유지 (${open[symbol] === 'SHORT' ? '숏' : '롱'})` : '대기'}: ${sig.reason}${sig.trend ? ` (추세 ${sig.trend})` : ''} 가격 ${sig.price ?? '-'}`); continue; }
      if (pos && open[symbol] === sig.action) { r.decision({ symbol, decision: 'KEEP', reason: '같은 방향 신호, 이미 보유 (추가 진입 안 함)', ...sigInfo(sig) }); r.info(`${symbol} 이미 같은 방향 포지션 보유`); continue; }
      if (pos) { await exit.close(symbol, pos, f, `반대 신호(${sig.reason})`); pos = null; delete open[symbol]; }
      candidates.push({ symbol, sig, ctx: entryContext(candles.slice(-30), sig) });
    } catch (e) {
      r.error(`${symbol} 처리 중 오류: ${e.message}`);
    }
  }

  // Pass 2: RISK bot ranks candidates by conviction and enforces portfolio limits.
  for (const { symbol, sig: raw, ctx } of rankCandidates(candidates)) {
    const f = filters[symbol];
    try {
      const sig = reanchor(raw, await data.markPrice(symbol));
      if (daily.halted) { r.decision({ symbol, decision: 'VETO', want: sig.action, reason: `일일 손실 한도 도달 (${daily.lossPct.toFixed(2)}%)`, ...sigInfo(sig) }); continue; }
      const gate = allowEntry(sig.action, open, cfg);
      if (!gate.ok) { r.decision({ symbol, decision: 'VETO', want: sig.action, reason: gate.reason, ...sigInfo(sig) }); r.warn(`${symbol} ${sig.action} 보류: ${gate.reason}`); continue; }

      const sizing = sizePosition({ signal: sig, equity: await broker.equity(), filters: f, cfg });
      if (!sizing.ok) { r.decision({ symbol, decision: 'VETO', want: sig.action, reason: sizing.reason, ...sigInfo(sig) }); r.warn(`${symbol} 리스크 봇 거부: ${sizing.reason}`); continue; }
      r.decision({ symbol, decision: 'ENTER', want: sig.action, reason: sig.reason, qty: sizing.qty, notional: +sizing.notional.toFixed(2), riskUsdt: +sizing.riskUsdt.toFixed(3), ...sigInfo(sig) });

      const side = sig.action === 'LONG' ? 'BUY' : 'SELL';
      // Record intended stop BEFORE ordering, so a crash mid-way still leaves a stop to enforce.
      await broker.cancelProtection(symbol); // clear any orphaned stop/TP from a previous position
      r.state.positions[symbol] = { stop: sig.stop, takeProfit: sig.takeProfit, side, signalPrice: sig.signalPrice ?? sig.price, openedAt: new Date().toISOString() };
      r.save();
      await r.flush({ force: true });
      let res;
      try { res = await broker.market(symbol, side, sizing.qty, f); }
      catch (e) {
        if (!(await broker.position(symbol))) delete r.state.positions[symbol];
        throw e;
      }
      open[symbol] = sig.action;
      let fi = null;
      try { fi = await broker.fills(symbol, { orderId: res.orderId }); } catch { /* fee unknown */ }
      const fill = (fi?.qty ? fi.avgPrice : 0) || Number(res.avgPrice) || sig.price;
      const slippagePct = (side === 'BUY' ? fill - sig.price : sig.price - fill) / sig.price * 100; // + = worse than the decision price
      Object.assign(r.state.positions[symbol], { entry: fill, qty: sizing.qty, fee: fi?.fee ?? null });
      r.trade({ event: 'OPEN', symbol, side, qty: sizing.qty, price: +fill.toFixed(6), decisionPrice: sig.price, signalPrice: sig.signalPrice ?? sig.price, feeAsset: fi?.feeAsset,
        slippagePct: +slippagePct.toFixed(4), fee: fi ? +fi.fee.toFixed(4) : null, ctx, reason: sig.reason, stop: sig.stop, takeProfit: sig.takeProfit, riskUsdt: +sizing.riskUsdt.toFixed(2) });

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
  await r.flush();
  return 'OK';
}

// CHIEF: once per UTC day (first tick after 00:00 UTC = 09:00 KST) write a report for the day that ended.
// Compact, structured view of a signal for the decisions log.
function sigInfo(sig) {
  return { price: sig.price, conviction: sig.conviction != null ? +sig.conviction.toFixed(3) : undefined, adx: sig.adx != null ? +sig.adx.toFixed(1) : undefined,
    votes: sig.votes?.map(v => ({ a: v.analyst, s: v.signal, c: Math.round(v.confidence) })), stop: sig.stop, takeProfit: sig.takeProfit };
}

async function maybeDailyReport(team, cfg, equity) {
  const { r, broker } = team;
  const today = new Date().toISOString().slice(0, 10);
  const prev = r.state.reportDay;
  r.state.reportDay = today;
  if (!prev || prev === today) return;
  try {
    const start = Date.parse(prev + 'T00:00:00Z'), end = start + 86400e3;
    let funding = 0;
    try { funding = await broker.funding(start, end); } catch { /* ignore */ }
    const positions = [];
    for (const s of team.allSymbols ?? cfg.symbols) {
      const p = await broker.position(s);
      if (p) positions.push({ symbol: s, ...p, stop: r.state.positions[s]?.stop?.toFixed?.(4), takeProfit: r.state.positions[s]?.takeProfit?.toFixed?.(4) });
    }
    const tierName = cfg.autoTiers ? TIERS[r.state.tierHigh ?? 0].name : '';
    const rep = buildDailyReport({ day: prev, journal: r.readJournal(), equityStart: r.state.dayStartEquity, equityEnd: equity, positions, funding, tierName, mode: cfg.mode });
    await r.saveReport(prev, rep.md);
    r.info(`일일 보고서 ${prev}: 손실 ${rep.losses}건 · 수익 ${rep.wins}건 · 실현 순손익 ${rep.net >= 0 ? '+' : ''}${rep.net.toFixed(3)} USDT (reports/${prev}.md)`);
  } catch (e) { r.warn(`일일 보고서 생성 실패: ${e.message}`); }
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
  const shutdown = async (sig) => {
    team.r.save(); await team.r.flush({ force: true });
    team.r.info(`${sig} 로 종료. 열린 포지션은 거래소 손절 주문이 계속 보호합니다.`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
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
