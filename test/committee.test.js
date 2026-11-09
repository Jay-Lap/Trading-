import test from 'node:test';
import assert from 'node:assert/strict';
import { blend, committeeSignal } from '../src/bots/committee.js';
import { generateSignal } from '../src/bots/strategy.js';
import { backtest } from '../src/lib/simulate.js';
import { cfg, filters } from './helpers.js';

const v = (analyst, signal, confidence) => ({ analyst, signal, confidence });

test('blend = weighted mean of sign x confidence', () => {
  assert.equal(blend([v('trend', 'bullish', 100), v('breakout', 'bullish', 100), v('momentum', 'bullish', 100), v('regime', 'bullish', 100)]), 1);
  assert.equal(blend([v('trend', 'bullish', 80), v('breakout', 'bearish', 80), v('momentum', 'neutral', 50), v('regime', 'neutral', 70)]), 0);
  assert.equal(blend([v('trend', 'bearish', 40)], { trend: 1 }), -0.4);
});

function trend(n, slope, start = 100) {
  const out = []; let p = start;
  for (let i = 0; i < n; i++) { p *= 1 + slope + (i % 2 ? 0.002 : -0.002); out.push({ openTime: i * 4 * 3600e3, open: p, high: p * 1.003, low: p * 0.997, close: p, closeTime: (i + 1) * 4 * 3600e3 - 1 }); }
  return out;
}

test('strong uptrend → committee LONG with stop below; downtrend → SHORT and closes longs', () => {
  const c = { ...cfg, strategy: 'committee' };
  const up = generateSignal(trend(260, 0.004), c);
  assert.equal(up.action, 'LONG');
  assert.ok(up.stop < up.price && up.conviction >= 0.5 && up.votes.length === 4);
  const dn = committeeSignal(trend(260, -0.004), c);
  assert.equal(dn.action, 'SHORT');
  assert.equal(dn.closeSide, 'LONG');
});

test('too few candles → HOLD, and committee backtest runs', () => {
  assert.equal(committeeSignal(trend(100, 0.004), cfg).action, 'HOLD');
  const r = backtest(trend(400, 0.003), { ...cfg, strategy: 'committee' }, filters);
  assert.ok(Number.isFinite(r.endEquity));
});

test('portfolio limits: max same direction and max open', async () => {
  const { allowEntry, rankCandidates } = await import('../src/bots/risk.js');
  const c = { maxOpenPositions: 3, maxSameDirection: 2 };
  assert.equal(allowEntry('SHORT', { A: 'SHORT' }, c).ok, true);
  assert.equal(allowEntry('SHORT', { A: 'SHORT', B: 'SHORT' }, c).ok, false);
  assert.equal(allowEntry('LONG', { A: 'SHORT', B: 'SHORT' }, c).ok, true);
  assert.equal(allowEntry('LONG', { A: 'SHORT', B: 'SHORT', C: 'LONG' }, c).ok, false);
  const r = rankCandidates([{ symbol: 'A', sig: { conviction: -0.55 } }, { symbol: 'B', sig: { conviction: 0.9 } }, { symbol: 'C', sig: { conviction: -0.7 } }]);
  assert.deepEqual(r.map(x => x.symbol), ['B', 'C', 'A']);
});

test('portfolio backtest never holds more than the limits', async () => {
  const { backtestPortfolio } = await import('../src/lib/simulate.js');
  const series = { A: trend(400, -0.003), B: trend(400, -0.0031, 50), C: trend(400, -0.0029, 20) };
  const f = { A: filters, B: filters, C: filters };
  const r = backtestPortfolio(series, { ...cfg, strategy: 'committee', maxSameDirection: 2 }, f);
  assert.ok(r.blocked > 0, 'third same-direction short must be blocked');
  const r1 = backtestPortfolio(series, { ...cfg, strategy: 'committee', maxSameDirection: 1 }, f);
  assert.ok(r1.blocked >= r.blocked);
});
