// Bar-by-bar backtest using the same STRATEGY and RISK code the live bot uses.
import { generateSignal } from '../bots/strategy.js';
import { sizePosition } from '../bots/risk.js';

const FEE = 0.0005; // taker, each side

export function backtest(candles, cfg, filters, { startEquity = 1000, window = 500 } = {}) {
  let equity = startEquity, peak = startEquity, maxDD = 0, pos = null;
  const trades = [];
  const closePos = (price, reason, c) => {
    const pnl = (price - pos.entry) * pos.qty - Math.abs(pos.qty) * price * FEE;
    equity += pnl;
    trades.push({ entryTime: pos.time, exitTime: c.openTime, side: pos.qty > 0 ? 'LONG' : 'SHORT', entry: pos.entry, exit: price, pnl, reason });
    pos = null;
  };
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      const long = pos.qty > 0;
      const hitStop = long ? c.low <= pos.stop : c.high >= pos.stop;
      const hitTp = pos.tp != null && (long ? c.high >= pos.tp : c.low <= pos.tp);
      if (hitStop) closePos(pos.stop, 'stop', c);          // pessimistic: stop first if both touched
      else if (hitTp) closePos(pos.tp, 'takeProfit', c);
    }
    const sig = generateSignal(candles.slice(Math.max(0, i + 1 - window), i + 1), cfg);
    if (pos && sig.closeSide && (pos.qty > 0 ? 'LONG' : 'SHORT') === sig.closeSide) closePos(c.close, 'committee', c);
    if (sig.action !== 'HOLD') {
      const wantLong = sig.action === 'LONG';
      if (pos && (pos.qty > 0) !== wantLong) closePos(c.close, 'reverse', c);
      if (!pos) {
        const s = sizePosition({ signal: sig, equity, filters, cfg });
        if (s.ok) {
          equity -= s.qty * c.close * FEE;
          pos = { qty: wantLong ? s.qty : -s.qty, entry: c.close, stop: sig.stop, tp: sig.takeProfit, time: c.openTime };
        }
      }
    }
    const mtm = equity + (pos ? (c.close - pos.entry) * pos.qty : 0);
    peak = Math.max(peak, mtm);
    maxDD = Math.max(maxDD, (peak - mtm) / peak);
  }
  if (pos) closePos(candles.at(-1).close, 'end', candles.at(-1));
  const wins = trades.filter(t => t.pnl > 0).length;
  return {
    startEquity, endEquity: equity, returnPct: (equity / startEquity - 1) * 100,
    trades: trades.length, winRatePct: trades.length ? wins / trades.length * 100 : 0,
    maxDrawdownPct: maxDD * 100, list: trades,
  };
}

// Multi-symbol backtest sharing ONE account, with the same ranking + portfolio limits as the live chief.
// series: { SYMBOL: candles[] }, filtersBy: { SYMBOL: filters }
import { allowEntry, rankCandidates, applyTier } from '../bots/risk.js';

// htf: { SYMBOL: [{ closeTime, conviction }] } sorted — higher-timeframe committee, used only once closed.
function htfAt(list, decisionTime) {
  if (!list) return undefined;
  let lo = 0, hi = list.length - 1, ans;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].closeTime < decisionTime) { ans = list[m]; lo = m + 1; } else hi = m - 1; }
  return ans && Number.isFinite(ans.conviction) ? ans.conviction : undefined;
}

export function backtestPortfolio(series, cfg, filtersBy, { startEquity = 1000, window = 500, htf = null, tradeFrom = 0 } = {}) {
  const syms = Object.keys(series);
  const idx = Object.fromEntries(syms.map(s => [s, new Map(series[s].map((c, i) => [c.openTime, i]))]));
  const times = [...new Set(syms.flatMap(s => series[s].map(c => c.openTime)))].sort((a, b) => a - b);
  let equity = startEquity, peak = startEquity, maxDD = 0;
  const pos = {}, trades = [], perSym = Object.fromEntries(syms.map(s => [s, { n: 0, pnl: 0 }]));
  let blocked = 0;
  const close = (s, price, reason) => {
    const p = pos[s];
    const pnl = (price - p.entry) * p.qty - Math.abs(p.qty) * price * FEE;
    equity += pnl; perSym[s].n++; perSym[s].pnl += pnl;
    trades.push({ symbol: s, side: p.qty > 0 ? 'LONG' : 'SHORT', entryTime: p.time, entry: p.entry, exitTime: lastTime, exit: price, qty: Math.abs(p.qty), pnl, reason });
    delete pos[s];
  };
  const lastClose = {};
  let lastTime = 0;
  const tierState = {};
  for (const t of times) {
    const cands = [];
    for (const s of syms) {
      const i = idx[s].get(t);
      if (i === undefined) continue;
      const c = series[s][i];
      lastClose[s] = c.close; lastTime = c.closeTime;
      const p = pos[s];
      if (p) {
        const L = p.qty > 0;
        if (L ? c.low <= p.stop : c.high >= p.stop) close(s, p.stop, 'stop');
        else if (p.tp != null && (L ? c.high >= p.tp : c.low <= p.tp)) close(s, p.tp, 'takeProfit');
      }
      const hc = htf ? htfAt(htf[s], c.closeTime + 1) : undefined;
      const sig = generateSignal(series[s].slice(Math.max(0, i + 1 - window), i + 1), hc === undefined ? cfg : { ...cfg, htfConviction: hc });
      if (pos[s] && sig.closeSide && (pos[s].qty > 0 ? 'LONG' : 'SHORT') === sig.closeSide) close(s, c.close, 'committee');
      if (sig.action === 'HOLD') continue;
      if (pos[s] && (pos[s].qty > 0) === (sig.action === 'LONG')) continue;
      if (pos[s]) close(s, c.close, 'reverse');
      if (t >= tradeFrom) cands.push({ symbol: s, sig, close: c.close, time: c.closeTime });
    }
    const eff = cfg.autoTiers ? applyTier(cfg, equity, tierState).cfg : cfg;
    for (const { symbol: s, sig, close: px, time: ct } of rankCandidates(cands)) {
      if (cfg.autoTiers && eff.symbols && !eff.symbols.includes(s)) continue;
      const open = Object.fromEntries(Object.entries(pos).map(([k, p]) => [k, p.qty > 0 ? 'LONG' : 'SHORT']));
      if (!allowEntry(sig.action, open, eff).ok) { blocked++; continue; }
      const z = sizePosition({ signal: sig, equity, filters: filtersBy[s], cfg: eff });
      if (!z.ok) continue;
      equity -= z.qty * px * FEE;
      pos[s] = { qty: sig.action === 'LONG' ? z.qty : -z.qty, entry: px, stop: sig.stop, tp: sig.takeProfit, time: ct };
    }
    const mtm = equity + Object.entries(pos).reduce((a, [s, p]) => a + (lastClose[s] - p.entry) * p.qty, 0);
    peak = Math.max(peak, mtm);
    maxDD = Math.max(maxDD, (peak - mtm) / peak);
  }
  for (const s of Object.keys(pos)) close(s, lastClose[s], 'end');
  const wins = trades.filter(t => t.pnl > 0).length;
  return { startEquity, endEquity: equity, returnPct: (equity / startEquity - 1) * 100, trades: trades.length,
    winRatePct: trades.length ? wins / trades.length * 100 : 0, maxDrawdownPct: maxDD * 100, blocked, perSymbol: perSym, list: trades };
}

// Precompute higher-timeframe committee conviction for each closed HTF candle.
import { committeeConviction } from '../bots/committee.js';
export function htfSeries(candles, window = 500) {
  return candles.map((c, i) => ({ closeTime: c.closeTime, conviction: committeeConviction(candles.slice(Math.max(0, i + 1 - window), i + 1)) }));
}
