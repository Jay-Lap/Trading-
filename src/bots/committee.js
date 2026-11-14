// STRATEGY option "committee" — idea borrowed from virattt/ai-hedge-fund (MIT):
// several independent analysts each vote {signal, confidence}; votes are blended into a
// conviction score in [-1, +1]; only strong, agreed conviction becomes a trade.
// Unlike the original (company financials for stocks), these analysts read price data,
// because coins have no earnings/ROE/PER to analyse.
import { ema, atr, adx } from '../lib/indicators.js';

const SIGN = { bullish: 1, neutral: 0, bearish: -1 };
export const DEFAULT_WEIGHTS = { trend: 1, breakout: 1, momentum: 1, regime: 1 };

export function analysts(candles) {
  const i = candles.length - 1, x = candles[i].close, cl = candles.map(c => c.close);
  const e20 = ema(cl, 20), e50 = ema(cl, 50), e200 = ema(cl, 200), a = atr(candles, 14)[i];
  let hi = -Infinity, lo = Infinity;
  for (let k = i - 20; k < i; k++) { hi = Math.max(hi, candles[k].high); lo = Math.min(lo, candles[k].low); }
  const spread = (e20[i] - e50[i]) / a;
  const mom = (x - candles[i - 24].close) / a;
  const up = x > e200[i] && e200[i] > e200[i - 5], dn = x < e200[i] && e200[i] < e200[i - 5];
  return {
    atr: a,
    votes: [
      { analyst: 'trend', label: '추세(EMA20/50)', signal: spread > 0.3 ? 'bullish' : spread < -0.3 ? 'bearish' : 'neutral', confidence: Math.min(100, Math.abs(spread) * 40) },
      { analyst: 'breakout', label: '돌파(20봉 고저)', signal: x > hi ? 'bullish' : x < lo ? 'bearish' : 'neutral', confidence: 80 },
      { analyst: 'momentum', label: '모멘텀(24봉)', signal: mom > 1 ? 'bullish' : mom < -1 ? 'bearish' : 'neutral', confidence: Math.min(100, Math.abs(mom) * 20) },
      { analyst: 'regime', label: '장기국면(EMA200)', signal: up ? 'bullish' : dn ? 'bearish' : 'neutral', confidence: 70 },
    ],
  };
}

export function blend(votes, weights = DEFAULT_WEIGHTS) {
  let sw = 0, sv = 0;
  for (const v of votes) { const w = weights[v.analyst] ?? 0; sv += w * SIGN[v.signal] * v.confidence / 100; sw += w; }
  return sw ? sv / sw : 0;
}

export function committeeSignal(candles, p) {
  const need = 230;
  if (candles.length < need) return { action: 'HOLD', reason: `캔들 부족 (${candles.length}/${need})` };
  const last = candles.at(-1);
  const { votes, atr: a } = analysts(candles);
  const conviction = blend(votes);
  const strength = adx(candles, 14).at(-1);
  const th = p.committeeThreshold ?? 0.5, adxMin = p.committeeAdxMin ?? 20;
  const summary = votes.map(v => `${v.label}:${v.signal === 'bullish' ? '사자' : v.signal === 'bearish' ? '팔자' : '중립'}${Math.round(v.confidence)}`).join(' ');
  const base = { price: last.close, atr: a, candleTime: last.openTime, conviction, adx: strength, votes };
  // Committee turned against an open position → close that side.
  const closeSide = conviction <= -th / 2 ? 'LONG' : conviction >= th / 2 ? 'SHORT' : null;
  // Higher-timeframe committee (e.g. daily) must agree: only trade with the big picture.
  const htf = p.htfConviction;
  let htfBlock = '';
  if (typeof htf === 'number' && Math.abs(conviction) >= th && strength >= adxMin) {
    const need = p.htfMin ?? 0;
    if (conviction > 0 && !(htf > need)) htfBlock = `상위(${p.htfInterval || '1d'}) 위원회 ${htf.toFixed(2)} → 롱 보류`;
    if (conviction < 0 && !(htf < -need)) htfBlock = `상위(${p.htfInterval || '1d'}) 위원회 ${htf.toFixed(2)} → 숏 보류`;
  }
  // Optional: only trade in the direction of the long-term regime analyst (EMA200).
  if (!htfBlock && p.requireRegime && Math.abs(conviction) >= th && strength >= adxMin) {
    const reg = votes.find(v => v.analyst === 'regime')?.signal;
    if (reg !== (conviction > 0 ? 'bullish' : 'bearish')) htfBlock = `장기국면(EMA200)이 ${reg === 'neutral' ? '중립' : '반대'} → 진입 보류`;
  }
  const tpMult = p.takeProfitAtrMult;
  if (!htfBlock && Math.abs(conviction) >= th && strength >= adxMin) {
    const L = conviction > 0;
    return { ...base, closeSide, action: L ? 'LONG' : 'SHORT',
      stop: L ? last.close - p.stopAtrMult * a : last.close + p.stopAtrMult * a,
      takeProfit: tpMult > 0 ? (L ? last.close + tpMult * a : last.close - tpMult * a) : null,
      reason: `위원회 확신 ${conviction.toFixed(2)} (ADX ${strength.toFixed(0)})${typeof htf === 'number' ? ` · 상위 ${htf.toFixed(2)}` : ''} ${summary}` };
  }
  return { ...base, closeSide, action: 'HOLD', trend: conviction > 0 ? 'UP' : 'DOWN',
    reason: htfBlock || `위원회 확신 ${conviction.toFixed(2)} / 기준 ±${th} (ADX ${strength.toFixed(0)}) ${summary}` };
}

// Conviction only (for higher-timeframe confirmation). Returns NaN if not enough candles.
export function committeeConviction(candles) {
  if (candles.length < 230) return NaN;
  return blend(analysts(candles).votes);
}
