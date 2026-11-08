// 2) STRATEGY bot — EMA crossover trend-following with ATR-based stop/target.
// Returns a signal on the LAST CLOSED candle only. It does not size or place anything.
import { ema, atr } from '../lib/indicators.js';

export function generateSignal(candles, p) {
  const need = Math.max(p.emaSlow, p.atrPeriod) + 2;
  if (candles.length < need) return { action: 'HOLD', reason: `캔들 부족 (${candles.length}/${need})` };
  const closes = candles.map(c => c.close);
  const f = ema(closes, p.emaFast), s = ema(closes, p.emaSlow), a = atr(candles, p.atrPeriod);
  const i = candles.length - 1;
  const last = candles[i];
  const atrNow = a[i];
  const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
  const crossDown = f[i - 1] >= s[i - 1] && f[i] < s[i];
  const base = { price: last.close, atr: atrNow, candleTime: last.openTime, emaFast: f[i], emaSlow: s[i] };
  if (crossUp) return { ...base, action: 'LONG', stop: last.close - p.stopAtrMult * atrNow, takeProfit: last.close + p.takeProfitAtrMult * atrNow, reason: 'EMA 골든크로스' };
  if (crossDown) return { ...base, action: 'SHORT', stop: last.close + p.stopAtrMult * atrNow, takeProfit: last.close - p.takeProfitAtrMult * atrNow, reason: 'EMA 데드크로스' };
  return { ...base, action: 'HOLD', trend: f[i] > s[i] ? 'UP' : 'DOWN', reason: '교차 없음' };
}
