export const filters = { stepSize: '0.001', minQty: 0.001, maxQty: 1000, tickSize: '0.10', minNotional: 5 };
export const cfg = {
  mode: 'paper', strategy: 'ema', committeeThreshold: 0.5, committeeAdxMin: 20, symbols: ['BTCUSDT'], interval: '15m', emaFast: 5, emaSlow: 12, atrPeriod: 5,
  stopAtrMult: 2, takeProfitAtrMult: 3, pollSeconds: 20, riskPerTradePct: 1, leverage: 3,
  maxNotionalUsdt: 200, dailyMaxLossPct: 3, emergencyStopPct: 2, paperStartUsdt: 1000,
  liveBaseUrl: 'https://fapi.binance.com', testnetBaseUrl: 'https://demo-fapi.binance.com', apiKey: '', apiSecret: '',
};
// Down-trend then up-trend → guarantees a golden cross near the end.
export function vCandles(n = 60, start = 100) {
  const out = []; let p = start;
  for (let i = 0; i < n; i++) {
    p += i < n * 0.6 ? -0.5 : 1.2;
    out.push({ openTime: i * 900_000, open: p, high: p + 0.4, low: p - 0.4, close: p, volume: 1, closeTime: i * 900_000 + 899_999 });
  }
  return out;
}
