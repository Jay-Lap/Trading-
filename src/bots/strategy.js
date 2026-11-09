// 2) STRATEGY bot — EMA crossover trend-following with ATR-based stop/target.
// Returns a signal on the LAST CLOSED candle only. It does not size or place anything.
import { ema, atr, adx } from '../lib/indicators.js';

export function generateSignal(candles, p) {
  const trendEma = p.trendEma || 0, adxMin = p.adxMin || 0, adxPeriod = p.adxPeriod || 14;
  const need = Math.max(p.emaSlow, p.atrPeriod, trendEma + 5, adxMin ? adxPeriod * 2 + 1 : 0) + 2;
  if (candles.length < need) return { action: 'HOLD', reason: `캔들 부족 (${candles.length}/${need})` };
  const closes = candles.map(c => c.close);
  const f = ema(closes, p.emaFast), s = ema(closes, p.emaSlow), a = atr(candles, p.atrPeriod);
  const i = candles.length - 1;
  const last = candles[i];
  const atrNow = a[i];
  const crossUp = f[i - 1] <= s[i - 1] && f[i] > s[i];
  const crossDown = f[i - 1] >= s[i - 1] && f[i] < s[i];
  // Trend filter: only trade with the long-term trend, and only when the trend is strong.
  let filterReason = '';
  if (crossUp || crossDown) {
    if (trendEma) {
      const t = ema(closes, trendEma);
      const rising = t[i] > t[i - 5], falling = t[i] < t[i - 5];
      if (crossUp && !(last.close > t[i] && rising)) filterReason = `장기 추세(EMA${trendEma}) 하락/횡보라 롱 보류`;
      if (crossDown && !(last.close < t[i] && falling)) filterReason = `장기 추세(EMA${trendEma}) 상승/횡보라 숏 보류`;
    }
    if (!filterReason && adxMin) {
      const ax = adx(candles, adxPeriod)[i];
      if (!(ax >= adxMin)) filterReason = `추세 강도 ADX ${ax.toFixed(1)} < ${adxMin} 보류`;
    }
  }
  const base = { price: last.close, atr: atrNow, candleTime: last.openTime, emaFast: f[i], emaSlow: s[i] };
  if (filterReason) return { ...base, action: 'HOLD', trend: f[i] > s[i] ? 'UP' : 'DOWN', reason: filterReason };
  if (crossUp) return { ...base, action: 'LONG', stop: last.close - p.stopAtrMult * atrNow, takeProfit: last.close + p.takeProfitAtrMult * atrNow, reason: 'EMA 골든크로스' };
  if (crossDown) return { ...base, action: 'SHORT', stop: last.close + p.stopAtrMult * atrNow, takeProfit: last.close - p.takeProfitAtrMult * atrNow, reason: 'EMA 데드크로스' };
  return { ...base, action: 'HOLD', trend: f[i] > s[i] ? 'UP' : 'DOWN', reason: '교차 없음' };
}
