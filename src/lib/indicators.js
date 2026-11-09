export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder ATR. candles: [{high, low, close}]
export function atr(candles, period) {
  const out = new Array(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => i === 0 ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Wilder ADX — trend strength (0..100). >20~25 usually means a real trend.
export function adx(candles, period) {
  const n = candles.length, out = new Array(n).fill(NaN);
  if (n <= period * 2) return out;
  const tr = [0], pdm = [0], ndm = [0];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, dn = p.low - c.low;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let sTr = 0, sP = 0, sN = 0;
  for (let i = 1; i <= period; i++) { sTr += tr[i]; sP += pdm[i]; sN += ndm[i]; }
  const dx = new Array(n).fill(NaN);
  for (let i = period; i < n; i++) {
    if (i > period) { sTr = sTr - sTr / period + tr[i]; sP = sP - sP / period + pdm[i]; sN = sN - sN / period + ndm[i]; }
    const pdi = sTr ? 100 * sP / sTr : 0, ndi = sTr ? 100 * sN / sTr : 0;
    dx[i] = pdi + ndi ? 100 * Math.abs(pdi - ndi) / (pdi + ndi) : 0;
  }
  let a = 0;
  for (let i = period; i < period * 2; i++) a += dx[i];
  a /= period; out[period * 2 - 1] = a;
  for (let i = period * 2; i < n; i++) { a = (a * (period - 1) + dx[i]) / period; out[i] = a; }
  return out;
}
