// End-to-end tick against a fake Binance (no network): open → exchange stop → stop hit → close.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BinanceClient } from '../src/lib/binanceClient.js';
import { Reporter } from '../src/bots/reporter.js';
import { buildTeam, tick } from '../src/chief.js';
import { cfg, vCandles } from './helpers.js';

function fakeBinance(candles) {
  const st = { pos: 0, entry: 0, mark: candles.at(-1).close, algo: [], calls: [] };
  const klines = () => candles.map(c => [c.openTime, c.open, c.high, c.low, c.close, 1, c.closeTime]);
  const json = (b, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(b) });
  const fetchImpl = async (url, { method }) => {
    const u = new URL(url); const q = Object.fromEntries(u.searchParams); const p = u.pathname;
    st.calls.push(`${method} ${p}`);
    if (p === '/fapi/v1/time') return json({ serverTime: Date.now() });
    if (p === '/fapi/v1/exchangeInfo') return json({ symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', marginAsset: 'USDT', filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
      { filterType: 'MARKET_LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '120' },
      { filterType: 'PRICE_FILTER', tickSize: '0.10' }, { filterType: 'MIN_NOTIONAL', notional: '5' }] }] });
    if (p === '/fapi/v1/klines') return json(klines());
    if (p === '/fapi/v1/premiumIndex') return json({ markPrice: String(st.mark) });
    assert.ok(q.signature && q.timestamp, `unsigned private call ${p}`);
    if (p === '/fapi/v1/positionSide/dual') return json({ dualSidePosition: false });
    if (p === '/fapi/v1/marginType') return json({ code: -4046, msg: 'No need to change margin type.' }, 400);
    if (p === '/fapi/v1/leverage') return json({ leverage: Number(q.leverage) });
    if (p === '/fapi/v3/account') return json({ totalMarginBalance: '1000' });
    if (p === '/fapi/v3/positionRisk') return json(st.pos ? [{ symbol: 'BTCUSDT', positionAmt: String(st.pos), entryPrice: String(st.entry), markPrice: String(st.mark) }] : []);
    if (p === '/fapi/v1/order' && method === 'POST') {
      assert.equal(q.type, 'MARKET', 'conditional orders must go to algoOrder');
      const qty = Number(q.quantity) * (q.side === 'BUY' ? 1 : -1);
      if (q.reduceOnly === 'true') st.pos = 0; else { st.pos += qty; st.entry = st.mark; }
      return json({ status: 'FILLED', avgPrice: String(st.mark), executedQty: q.quantity });
    }
    if (p === '/fapi/v1/algoOrder') { assert.equal(q.algoType, 'CONDITIONAL'); assert.equal(q.closePosition, 'true'); st.algo.push({ ...q, orderType: q.type, algoId: st.algo.length + 1 }); return json({ algoId: st.algo.length }); }
    if (p === '/fapi/v1/openAlgoOrders') return json(st.algo);
    if (p === '/fapi/v1/openOrders') return json([]);
    if (p === '/fapi/v1/algoOpenOrders' || p === '/fapi/v1/allOpenOrders') { st.algo = []; return json({ code: 200, msg: 'ok' }); }
    return json({ code: -1, msg: `unmocked ${method} ${p}` }, 404);
  };
  return { st, fetchImpl };
}

test('team opens with exchange stop, then closes when stop is crossed', async () => {
  const all = vCandles(80);
  // find the bar where a LONG signal appears, feed candles up to it
  const { generateSignal } = await import('../src/bots/strategy.js');
  let n = 20; while (generateSignal(all.slice(0, n), cfg).action !== 'LONG') n++;
  const candles = all.slice(0, n);
  const fb = fakeBinance(candles);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-'));
  const c = { ...cfg, mode: 'testnet', apiKey: 'k', apiSecret: 's' };
  const client = new BinanceClient({ baseUrl: 'https://fake', apiKey: 'k', apiSecret: 's', fetchImpl: fb.fetchImpl });
  const team = await buildTeam(c, { reporter: new Reporter(dir, { quiet: true }), tradeClient: client, dataClient: client });

  await tick(team);
  assert.ok(fb.st.pos > 0, 'long opened');
  assert.ok(fb.st.algo.some(o => o.type === 'STOP_MARKET'), 'exchange stop placed');
  assert.ok(fb.st.algo.some(o => o.type === 'TAKE_PROFIT_MARKET'), 'exchange TP placed');
  const meta = team.r.state.positions.BTCUSDT;
  assert.ok(meta.stop < fb.st.entry);

  await tick(team); // same candle → no duplicate entry
  assert.equal(fb.st.calls.filter(x => x === 'POST /fapi/v1/order').length, 1);

  fb.st.mark = meta.stop - 1; // price crashes through stop
  await tick(team);
  assert.equal(fb.st.pos, 0, 'closed by exit bot');
  assert.equal(team.r.state.positions.BTCUSDT, undefined);
  const journal = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.map(j => j.event), ['OPEN', 'CLOSE']);
});

test('adopted position without stop gets emergency stop', async () => {
  const candles = vCandles(30);
  const fb = fakeBinance(candles);
  fb.st.pos = -0.5; fb.st.entry = fb.st.mark;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-'));
  const c = { ...cfg, mode: 'testnet', apiKey: 'k', apiSecret: 's' };
  const client = new BinanceClient({ baseUrl: 'https://fake', apiKey: 'k', apiSecret: 's', fetchImpl: fb.fetchImpl });
  const team = await buildTeam(c, { reporter: new Reporter(dir, { quiet: true }), tradeClient: client, dataClient: client });
  await tick(team);
  const stop = fb.st.algo.find(o => o.type === 'STOP_MARKET');
  assert.ok(stop && stop.side === 'BUY');
  assert.ok(Math.abs(Number(stop.triggerPrice) - fb.st.entry * 1.02) < 0.2);
});

test('paper broker round trip', async () => {
  const { PaperBroker } = await import('../src/bots/execution.js');
  let price = 100;
  const b = new PaperBroker(1000, async () => price);
  await b.market('X', 'BUY', 1, null);
  price = 110;
  assert.ok(Math.abs(await b.equity() - (1000 - 0.05 + 10)) < 1e-9);
  await b.market('X', 'SELL', 1, null, true);
  assert.equal(await b.position('X'), null);
  assert.ok(Math.abs(b.cash - (1000 - 0.05 - 0.055 + 10)) < 1e-9);
});

test('paper account persists across restarts and catches up a stop hit while asleep', async () => {
  const { PaperBroker } = await import('../src/bots/execution.js');
  const { ExitBot } = await import('../src/bots/exit.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-'));
  let price = 100;
  const r1 = new Reporter(dir, { quiet: true });
  r1.state.paper = {};
  const b1 = new PaperBroker(1000, async () => price, r1.state.paper);
  await b1.market('X', 'SELL', 1, null);                     // short 1 @ 100
  r1.state.positions.X = { stop: 105, takeProfit: 90 };
  r1.save();

  // "restart": new objects read the saved file
  const r2 = new Reporter(dir, { quiet: true });
  const b2 = new PaperBroker(1000, async () => price, r2.state.paper);
  assert.equal((await b2.position('X')).qty, -1);
  price = 101; // price now looks harmless, but a 5m candle spiked to 106 meanwhile
  const ex = new ExitBot(b2, r2, cfg);
  const pos = await b2.position('X');
  const closed = await ex.paperCatchUp('X', pos, null, [{ openTime: 0, high: 102, low: 99 }, { openTime: 300000, high: 106, low: 100 }]);
  assert.ok(closed);
  assert.equal(await b2.position('X'), null);
  // loss = 5 + fees(0.05 + 0.0525)
  assert.ok(Math.abs(r2.state.paper.cash - (1000 - 5 - 0.05 - 0.0525)) < 1e-9);
  const j = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(j.at(-1).price, 105);
});

test('e2e: stop/TP filled on the exchange → bot clears orphan orders and record', async () => {
  const all = vCandles(80);
  const { generateSignal } = await import('../src/bots/strategy.js');
  let n = 20; while (generateSignal(all.slice(0, n), cfg).action !== 'LONG') n++;
  const fb = fakeBinance(all.slice(0, n));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-'));
  const c = { ...cfg, mode: 'testnet', apiKey: 'k', apiSecret: 's' };
  const client = new BinanceClient({ baseUrl: 'https://fake', apiKey: 'k', apiSecret: 's', fetchImpl: fb.fetchImpl });
  const team = await buildTeam(c, { reporter: new Reporter(dir, { quiet: true }), tradeClient: client, dataClient: client });
  await tick(team);
  assert.ok(fb.st.pos > 0 && fb.st.algo.length === 2);
  fb.st.pos = 0; // take-profit filled by Binance; the stop order is still sitting there
  fb.st.algo = fb.st.algo.filter(o => o.type === 'STOP_MARKET');
  await tick(team);
  assert.equal(fb.st.algo.length, 0, 'orphaned stop must be cancelled');
  assert.equal(team.r.state.positions.BTCUSDT, undefined, 'stale record must be cleared');
});
