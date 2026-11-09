// 3) RISK bot — the only bot allowed to decide size. Can veto any trade.
import { floorToStep } from '../lib/math.js';

export function sizePosition({ signal, equity, filters, cfg }) {
  const { price, stop } = signal;
  const stopDist = Math.abs(price - stop);
  if (!(equity > 0)) return veto('계좌 잔고가 0 이하');
  if (!(stopDist > 0)) return veto('손절 거리가 0');

  // Stop must sit well inside the liquidation distance (~1/leverage of price).
  const stopFrac = stopDist / price;
  const liqFrac = 1 / cfg.leverage;
  if (stopFrac >= liqFrac * 0.5) return veto(`손절폭 ${(stopFrac * 100).toFixed(2)}% 가 청산 거리(약 ${(liqFrac * 100).toFixed(1)}%)에 너무 가까움 → 레버리지 낮추세요`);

  const riskUsdt = equity * cfg.riskPerTradePct / 100;
  let qty = riskUsdt / stopDist;
  const maxNotional = Math.min(cfg.maxNotionalUsdt, equity * cfg.leverage * 0.9);
  if (qty * price > maxNotional) qty = maxNotional / price;
  qty = Math.min(floorToStep(qty, filters.stepSize), filters.maxQty || Infinity);
  qty = floorToStep(qty, filters.stepSize);

  if (qty < filters.minQty) return veto(`수량 ${qty} < 최소 ${filters.minQty} (자금이 너무 적거나 한도가 낮음)`);
  if (qty * price < filters.minNotional) return veto(`주문금액 ${(qty * price).toFixed(2)} < 최소 ${filters.minNotional} USDT`);
  return { ok: true, qty, notional: qty * price, riskUsdt: qty * stopDist };
}

function veto(reason) { return { ok: false, reason }; }

// Daily circuit breaker. state: { day, dayStartEquity, halted }
export function checkDailyLimit(state, equity, cfg, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (state.day !== day) { state.day = day; state.dayStartEquity = equity; state.halted = false; }
  const lossPct = (state.dayStartEquity - equity) / state.dayStartEquity * 100;
  if (lossPct >= cfg.dailyMaxLossPct) state.halted = true;
  return { halted: state.halted, lossPct };
}

// Portfolio limits. Majors move together, so 3 shorts ≈ one bet at 3x size.
// open: { symbol: 'LONG' | 'SHORT' } currently held.
export function allowEntry(direction, open, cfg) {
  const held = Object.values(open);
  const maxOpen = cfg.maxOpenPositions ?? 3, maxSame = cfg.maxSameDirection ?? 2;
  if (held.length >= maxOpen) return veto(`동시 포지션 한도 ${maxOpen}개 도달`);
  const same = held.filter(d => d === direction).length;
  if (same >= maxSame) return veto(`같은 방향(${direction}) 한도 ${maxSame}개 도달 — 코인끼리 같이 움직여 위험이 겹침`);
  return { ok: true };
}

// Strongest conviction first, so limited slots go to the clearest signals.
export function rankCandidates(list) {
  return [...list].sort((a, b) => Math.abs(b.sig.conviction ?? 1) - Math.abs(a.sig.conviction ?? 1));
}

// Candle-close signals can be hours old on 4h bars. Re-anchor price, stop and target to the
// current mark price (same ATR distances) so size, notional cap and stop reflect the real fill.
export function reanchor(sig, mark) {
  if (!(mark > 0) || !(sig.price > 0)) return sig;
  const d = mark - sig.price;
  return { ...sig, signalPrice: sig.price, price: mark, stop: sig.stop + d, takeProfit: sig.takeProfit != null ? sig.takeProfit + d : sig.takeProfit };
}
