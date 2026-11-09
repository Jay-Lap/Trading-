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
      const hitTp = long ? c.high >= pos.tp : c.low <= pos.tp;
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
