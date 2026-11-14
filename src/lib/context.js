// Market context at entry, so losing trades can later be grouped by cause.
export function entryContext(candles, sig) {
  const i = candles.length - 1, c = candles[i];
  const back = candles[Math.max(0, i - 24)];
  const regime = sig.votes?.find(v => v.analyst === 'regime')?.signal ?? null;
  const want = sig.action === 'LONG' ? 'bullish' : sig.action === 'SHORT' ? 'bearish' : null;
  return {
    conviction: sig.conviction != null ? +sig.conviction.toFixed(3) : null,
    adx: sig.adx != null ? +sig.adx.toFixed(1) : null,
    atrPct: sig.atr && c?.close ? +(sig.atr / c.close * 100).toFixed(3) : null,
    stopPct: sig.stop && sig.price ? +(Math.abs(sig.price - sig.stop) / sig.price * 100).toFixed(3) : null,
    ret24Pct: back?.close ? +((c.close / back.close - 1) * 100).toFixed(2) : null,
    regime, withRegime: want ? regime === want : null,
  };
}
