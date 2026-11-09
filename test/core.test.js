import test from 'node:test';
import assert from 'node:assert/strict';
import { floorToStep, roundToStep, fmt, decimalsOf } from '../src/lib/math.js';
import { ema } from '../src/lib/indicators.js';
import { generateSignal } from '../src/bots/strategy.js';
import { sizePosition, checkDailyLimit } from '../src/bots/risk.js';
import { validateConfig, LIVE_CONFIRM_PHRASE } from '../src/lib/config.js';
import { BinanceClient } from '../src/lib/binanceClient.js';
import { parseKlines } from '../src/bots/data.js';
import { backtest } from '../src/lib/simulate.js';
import { cfg, filters, vCandles } from './helpers.js';

test('step rounding', () => {
  assert.equal(floorToStep(0.12345, '0.001'), 0.123);
  assert.equal(floorToStep(0.3, '0.1'), 0.3);
  assert.equal(roundToStep(101.26, '0.10'), 101.3);
  assert.equal(fmt(0.1, '0.001'), '0.100');
  assert.equal(decimalsOf('1'), 0);
});

test('ema seeds with SMA', () => {
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3);
});

test('HMAC signature matches Binance docs example', () => {
  const q = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  assert.equal(BinanceClient.sign(q, secret), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

test('parseKlines drops the forming candle', () => {
  const rows = [[0, '1', '2', '0.5', '1.5', '10', 899], [900, '1', '2', '0.5', '1.5', '10', 1799]];
  assert.equal(parseKlines(rows, 1000).length, 1);
});

test('strategy finds golden cross with stop below price', () => {
  const c = vCandles();
  let sig;
  for (let i = 20; i <= c.length; i++) { sig = generateSignal(c.slice(0, i), cfg); if (sig.action !== 'HOLD') break; }
  assert.equal(sig.action, 'LONG');
  assert.ok(sig.stop < sig.price && sig.takeProfit > sig.price);
});

test('risk sizing respects risk %, notional cap and steps', () => {
  const s = sizePosition({ signal: { price: 100, stop: 98 }, equity: 1000, filters, cfg });
  assert.ok(s.ok);
  assert.ok(s.riskUsdt <= 10 + 1e-9);          // 1% of 1000
  assert.ok(s.notional <= 200 + 1e-9);          // cap
  assert.equal(s.qty, 2);                        // 200 / 100
});

test('risk vetoes stop too close to liquidation and tiny accounts', () => {
  assert.equal(sizePosition({ signal: { price: 100, stop: 80 }, equity: 1000, filters, cfg }).ok, false);
  assert.equal(sizePosition({ signal: { price: 100000, stop: 99000 }, equity: 1, filters, cfg }).ok, false);
});

test('daily circuit breaker halts and resets next day', () => {
  const st = {};
  checkDailyLimit(st, 1000, cfg, new Date('2026-01-01T01:00:00Z'));
  assert.equal(checkDailyLimit(st, 969, cfg, new Date('2026-01-01T05:00:00Z')).halted, true);
  assert.equal(checkDailyLimit(st, 969, cfg, new Date('2026-01-02T00:01:00Z')).halted, false);
});

test('config guards: live needs confirm phrase, leverage capped', () => {
  const base = { ...cfg, mode: 'live', apiKey: 'k', apiSecret: 's' };
  delete process.env.LIVE_CONFIRM;
  assert.throws(() => validateConfig(base), /LIVE_CONFIRM/);
  process.env.LIVE_CONFIRM = LIVE_CONFIRM_PHRASE;
  assert.doesNotThrow(() => validateConfig(base));
  delete process.env.LIVE_CONFIRM;
  assert.throws(() => validateConfig({ ...cfg, leverage: 20 }), /LEVERAGE/);
  assert.throws(() => validateConfig({ ...cfg, mode: 'testnet' }), /API_KEY/);
});

test('backtest runs and accounts fees', () => {
  const r = backtest(vCandles(200), cfg, filters);
  assert.ok(r.trades >= 1);
  assert.ok(Number.isFinite(r.endEquity));
});

test('adx stays in 0..100 and trend filter can block entries', async () => {
  const { adx } = await import('../src/lib/indicators.js');
  const c = vCandles(120);
  const a = adx(c, 5).filter(Number.isFinite);
  assert.ok(a.length && a.every(x => x >= 0 && x <= 100));
  let opened = 0, blocked = 0;
  for (let i = 20; i <= c.length; i++) {
    if (generateSignal(c.slice(0, i), cfg).action !== 'HOLD') opened++;
    const s = generateSignal(c.slice(0, i), { ...cfg, adxMin: 101 });
    assert.equal(s.action, 'HOLD');
    if (/ADX/.test(s.reason)) blocked++;
  }
  assert.ok(opened > 0 && blocked === opened);
});
