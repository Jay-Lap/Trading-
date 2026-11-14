// RESEARCH loop (ideas adopted from the "trading-loop" skill):
//   train on everything except the most recent year → group losing trades by cause → change ONE setting
//   → keep it only if the train score clearly improves → repeat → final check on the unseen last year
//   → record changes that failed so they are never retried.
// It NEVER touches the live bot. It only writes a report; a human decides whether to deploy.
// Usage: npm run research -- [SYMBOL] [rounds]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BinanceClient } from './lib/binanceClient.js';
import { DataBot, SpotDataBot, SPOT_DATA_URL, parseKlines } from './bots/data.js';
import { backtestPortfolio, htfSeries } from './lib/simulate.js';

const SYMBOL = (process.argv[2] || 'SOLUSDT').toUpperCase();
const ROUNDS = Number(process.argv[3] || 3);
const YEARS = 3, MIN_TRADES = 10, MARGIN = 1.0;
const DIR = path.resolve(process.cwd(), 'research');
const JOURNAL = path.join(DIR, 'failure-journal.jsonl');

// Current live strategy, with neutral sizing so settings are compared fairly.
export const BASE = { strategy: 'committee', committeeThreshold: 0.5, committeeAdxMin: 20, stopAtrMult: 2, takeProfitAtrMult: 5,
  maxStopPct: 6, leverage: 3, riskPerTradePct: 2, maxNotionalUsdt: 1e9, maxOpenPositions: 1, maxSameDirection: 1 };

export const score = m => (m.trades < MIN_TRADES ? -999 : +(m.returnPct - 0.5 * m.maxDrawdownPct).toFixed(2));

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

export function diagnose(trades) {
  const losses = trades.filter(t => t.pnl < 0);
  if (!losses.length) return [];
  const tot = losses.reduce((a, t) => a - t.pnl, 0) || 1e-9;
  const stopMed = median(trades.map(t => t.ctx?.stopPct ?? 0)), barsMed = median(trades.map(t => t.bars)) || 1;
  const B = {
    counter_regime: ['장기 추세(EMA200)와 반대 방향으로 들어간 거래', t => t.ctx?.withRegime === false],
    weak_signal: ['위원회 확신이 약할 때(|확신| < 0.6) 들어간 거래', t => Math.abs(t.ctx?.conviction ?? 1) < 0.6],
    low_adx: ['추세 강도가 약할 때(ADX < 25) 들어간 거래', t => (t.ctx?.adx ?? 99) < 25],
    high_vol: ['평소보다 크게 출렁일 때 들어간 거래', t => (t.ctx?.stopPct ?? 0) > stopMed * 1.3],
    stopped: ['들어가서 손절로 끝난 거래', t => t.reason === 'stop'],
    held_long: ['오래 들고 있다가 결국 잃은 거래', t => t.bars > barsMed * 2 && t.reason !== 'stop'],
  };
  return Object.entries(B).map(([cause, [label, fn]]) => {
    const g = losses.filter(fn);
    return { cause, label, losingTrades: g.length, lossSharePct: Math.round(g.reduce((a, t) => a - t.pnl, 0) / tot * 100) };
  }).filter(x => x.losingTrades).sort((a, b) => b.lossSharePct - a.lossSharePct);
}

export const CANDIDATES = [
  { id: 'threshold=0.6', fixes: ['weak_signal'], text: '위원회 확신 기준 0.5 → 0.6', patch: { committeeThreshold: 0.6 } },
  { id: 'threshold=0.7', fixes: ['weak_signal'], text: '위원회 확신 기준 0.5 → 0.7', patch: { committeeThreshold: 0.7 } },
  { id: 'adxMin=25', fixes: ['low_adx'], text: '추세 강도 기준 ADX 20 → 25', patch: { committeeAdxMin: 25 } },
  { id: 'adxMin=30', fixes: ['low_adx'], text: '추세 강도 기준 ADX 20 → 30', patch: { committeeAdxMin: 30 } },
  { id: 'requireRegime', fixes: ['counter_regime'], text: '장기 추세(EMA200)와 같은 방향일 때만 진입', patch: { requireRegime: true } },
  { id: 'htf=1d', fixes: ['counter_regime'], text: '일봉 위원회와 같은 방향일 때만 진입', patch: { htfInterval: '1d' } },
  { id: 'maxStopPct=5', fixes: ['high_vol'], text: '변동성 필터 손절폭 6% → 5%', patch: { maxStopPct: 5 } },
  { id: 'maxStopPct=4', fixes: ['high_vol'], text: '변동성 필터 손절폭 6% → 4%', patch: { maxStopPct: 4 } },
  { id: 'stopAtr=1.5', fixes: ['stopped'], text: '손절 2 ATR → 1.5 ATR', patch: { stopAtrMult: 1.5 } },
  { id: 'stopAtr=2.5', fixes: ['stopped'], text: '손절 2 ATR → 2.5 ATR', patch: { stopAtrMult: 2.5 } },
  { id: 'tpAtr=4', fixes: ['held_long', 'stopped'], text: '익절 5 ATR → 4 ATR', patch: { takeProfitAtrMult: 4 } },
  { id: 'tpAtr=6', fixes: ['held_long'], text: '익절 5 ATR → 6 ATR', patch: { takeProfitAtrMult: 6 } },
];

const key = (overrides, id) => crypto.createHash('sha1').update(JSON.stringify([SYMBOL, '4h', Object.entries(overrides).sort(), id])).digest('hex').slice(0, 12);

async function load() {
  let d = new DataBot(new BinanceClient({ baseUrl: 'https://fapi.binance.com' }));
  try { await d.symbolFilters([SYMBOL]); } catch { d = new SpotDataBot(new BinanceClient({ baseUrl: SPOT_DATA_URL })); }
  const f = await d.symbolFilters([SYMBOL]);
  const get = async (iv, days) => { const now = Date.now(); let st = now - days * 864e5, c = [];
    while (st < now) { const r = await d.klinesRange(SYMBOL, iv, st); if (!r.length) break; c.push(...parseKlines(r)); st = r.at(-1)[6] + 1; } return c; };
  return { filters: f, c4: await get('4h', YEARS * 365 + 100), d1: await get('1d', YEARS * 365 + 400), source: d.source };
}

function run(cfg, data, from, to) {
  const ser = { [SYMBOL]: data.c4.filter(x => x.openTime < to) };
  const htf = cfg.htfInterval ? { [SYMBOL]: htfSeries(data.d1) } : null;
  const r = backtestPortfolio(ser, cfg, data.filters, { startEquity: 1000, window: 300, tradeFrom: from, htf });
  const m = { returnPct: +r.returnPct.toFixed(1), maxDrawdownPct: +r.maxDrawdownPct.toFixed(1), trades: r.trades, winRatePct: Math.round(r.winRatePct) };
  return { m: { ...m, score: score(m) }, trades: r.list };
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const journal = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const failed = new Set(journal.filter(j => j.verdict === '실패' && j.key).map(j => j.key));
  const data = await load();
  const now = Date.now(), split = now - 365 * 864e5, start = now - YEARS * 365 * 864e5;
  let overrides = {}, cur = { ...BASE };
  let base = run(cur, data, start, split); const first = base.m;
  const rounds = [], added = []; let skipped = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    const dg = diagnose(base.trades);
    if (!dg.length) { rounds.push({ round: r, note: '잃은 거래가 없어 더 고치지 않음' }); break; }
    const top = dg.slice(0, 2).map(d => d.cause), tried = [];
    for (const scope of [c => c.fixes.some(f => top.includes(f)), () => true]) {
      for (const c of CANDIDATES) {
        if (!scope(c) || tried.some(t => t.id === c.id) || Object.entries(c.patch).every(([k, v]) => cur[k] === v)) continue;
        const k = key(overrides, c.id);
        if (failed.has(k)) { skipped++; continue; }
        const res = run({ ...cur, ...c.patch }, data, start, split);
        tried.push({ ...c, k, res });
      }
      if (tried.some(t => t.res.m.score > base.m.score + MARGIN)) break;
    }
    const best = tried.filter(t => t.res.m.score > base.m.score + MARGIN).sort((a, b) => b.res.m.score - a.res.m.score)[0];
    for (const t of tried) if (t !== best && t.res.m.score <= base.m.score + MARGIN) {
      const j = { key: t.k, when: new Date().toISOString().slice(0, 10), symbol: SYMBOL, base: { ...overrides }, tried: t.text, verdict: '실패',
        why: t.res.m.trades < MIN_TRADES ? `거래 ${t.res.m.trades}회뿐이라 믿기 어려움` : `학습구간 점수 ${base.m.score} → ${t.res.m.score} (수익 ${base.m.returnPct}% → ${t.res.m.returnPct}%, 낙폭 ${base.m.maxDrawdownPct}% → ${t.res.m.maxDrawdownPct}%)` };
      added.push(j); failed.add(t.k);
    }
    const rd = { round: r, before: base.m, causes: dg.slice(0, 3), tried: tried.length };
    if (!best) { rd.note = '더 나아지는 수정이 없어 멈춤'; rounds.push(rd); break; }
    rd.fix = best.text; rd.after = best.res.m; rounds.push(rd);
    added.push({ key: best.k, when: new Date().toISOString().slice(0, 10), symbol: SYMBOL, base: { ...overrides }, tried: best.text, verdict: '학습구간 채택',
      why: `점수 ${base.m.score} → ${best.res.m.score}` });
    overrides = { ...overrides, ...best.patch }; cur = { ...cur, ...best.patch }; base = best.res;
  }
  const h0 = run(BASE, data, split, now + 1).m, h1 = run(cur, data, split, now + 1).m;
  const changed = Object.keys(overrides).length > 0;
  const verdict = !changed ? '바꿀 만한 설정을 찾지 못함 → 지금 설정 유지'
    : h1.trades < MIN_TRADES ? `안 본 1년에 거래가 ${h1.trades}회뿐이라 판단 보류`
    : h1.score > h0.score ? '안 본 최근 1년에서도 나아짐 → 실계좌 반영 후보' : '안 본 최근 1년에서는 나아지지 않음 → 과거에만 맞춘 수정일 수 있어 반영하지 않음';
  if (changed) added.push({ key: key(overrides, 'holdout'), when: new Date().toISOString().slice(0, 10), symbol: SYMBOL, tried: `최종 조합 ${JSON.stringify(overrides)}`,
    verdict: h1.score > h0.score && h1.trades >= MIN_TRADES ? '검증 통과' : '실패', why: `안 본 1년 점수 ${h0.score} → ${h1.score}` });
  fs.appendFileSync(JOURNAL, added.map(j => JSON.stringify(j)).join('\n') + (added.length ? '\n' : ''));
  const out = { symbol: SYMBOL, source: data.source, period: { trainFrom: new Date(start).toISOString().slice(0, 10), holdoutFrom: new Date(split).toISOString().slice(0, 10) },
    trainFirst: first, rounds, overrides, holdout: { original: h0, improved: h1, verdict }, journal: { knownBefore: journal.length, addedNow: added.length, skippedKnownFailures: skipped } };
  fs.writeFileSync(path.join(DIR, 'last-run.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  console.log('\n과거 데이터로 한 시험입니다. 실계좌는 바꾸지 않았고, 미래 수익을 뜻하지 않습니다.');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main().catch(e => { console.error(e); process.exit(1); });
