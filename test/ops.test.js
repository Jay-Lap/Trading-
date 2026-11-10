import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeFills } from '../src/bots/execution.js';
import { liquidityDrop } from '../src/bots/risk.js';
import { buildDailyReport } from '../src/bots/report.js';
import { ExitBot } from '../src/bots/exit.js';
import { Reporter } from '../src/bots/reporter.js';
import { cfg } from './helpers.js';

test('summarizeFills averages price and sums fees / realized pnl', () => {
  const s = summarizeFills([{ qty: '0.1', price: '80', commission: '0.004', realizedPnl: '0.5', commissionAsset: 'USDT' },
                            { qty: '0.03', price: '81', commission: '0.0012', realizedPnl: '0.1', commissionAsset: 'USDT' }]);
  assert.ok(Math.abs(s.avgPrice - (0.1 * 80 + 0.03 * 81) / 0.13) < 1e-9);
  assert.ok(Math.abs(s.fee - 0.0052) < 1e-12 && Math.abs(s.realizedPnl - 0.6) < 1e-12);
});

test('liquidityDrop: flags when last 6h volume < 20% of the usual 6h volume', () => {
  const k = v => ({ volume: v });
  const normal = Array.from({ length: 24 }, () => k(100));
  assert.equal(liquidityDrop([...normal, ...Array(6).fill(k(100))]).drop, false);
  const r = liquidityDrop([...normal, ...Array(6).fill(k(15))]);
  assert.equal(r.drop, true); assert.ok(Math.abs(r.ratio - 15) < 1e-9);
  assert.equal(liquidityDrop(normal).drop, false); // not enough data
});

test('exchange take-profit fill is detected, journaled, and the orphaned stop is cancelled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-'));
  const r = new Reporter(dir, { quiet: true });
  const calls = [];
  const broker = {
    kind: 'exchange',
    fills: async (sym, o) => { calls.push(['fills', o]); return summarizeFills([{ qty: '0.13', price: '77.05', commission: '0.005', realizedPnl: '1.1219', side: 'BUY' }]); },
    cancelProtection: async (sym) => calls.push(['cancel', sym]),
  };
  r.state.positions.SOLUSDT = { stop: 89.06, takeProfit: 77.05, side: 'SELL', openedAt: '2026-11-09T08:00:08.000Z', entry: 85.64 };
  const ex = new ExitBot(broker, r, cfg);
  await ex.syncExchangeClosed('SOLUSDT');
  assert.equal(r.state.positions.SOLUSDT, undefined);
  assert.deepEqual(calls.find(c => c[0] === 'cancel'), ['cancel', 'SOLUSDT']);
  assert.equal(calls[0][1].side, 'BUY');
  const j = r.readJournal().at(-1);
  assert.equal(j.event, 'CLOSE'); assert.equal(j.reason, '거래소 익절 체결'); assert.equal(j.pnl, 1.1219); assert.equal(j.fee, 0.005);
});

test('daily report lists losses first, with causes, and flags fee-eaten trades', () => {
  const day = '2026-11-12';
  const journal = [
    { time: `${day}T01:00:00Z`, event: 'OPEN', symbol: 'SOLUSDT', side: 'SELL', qty: 0.3, price: 85, fee: 0.0128, slippagePct: 0.02 },
    { time: `${day}T05:00:00Z`, event: 'CLOSE', symbol: 'SOLUSDT', side: 'BUY', qty: 0.3, price: 88, pnl: -0.9, fee: 0.0132, reason: '거래소 손절 체결' },
    { time: `${day}T06:00:00Z`, event: 'OPEN', symbol: 'SOLUSDT', side: 'BUY', qty: 0.3, price: 88, fee: 0.0132 },
    { time: `${day}T07:00:00Z`, event: 'CLOSE', symbol: 'SOLUSDT', side: 'SELL', qty: 0.3, price: 88.05, pnl: 0.015, fee: 0.0132, reason: '위원회 반대 전환' },
    { time: `${day}T08:00:00Z`, event: 'OPEN', symbol: 'SOLUSDT', side: 'BUY', qty: 0.3, price: 88, fee: 0.0132 },
    { time: `${day}T12:00:00Z`, event: 'CLOSE', symbol: 'SOLUSDT', side: 'SELL', qty: 0.3, price: 95, pnl: 2.1, fee: 0.014, reason: '거래소 익절 체결' },
  ];
  const rep = buildDailyReport({ day, journal, equityStart: 23, equityEnd: 24.1, funding: -0.001, mode: 'live' });
  assert.equal(rep.losses, 2); assert.equal(rep.wins, 1);
  const md = rep.md;
  assert.ok(md.indexOf('손실 거래') < md.indexOf('수익 거래'));
  assert.ok(/손절가까지 역행/.test(md));
  assert.ok(/수수료가 이익을 잠식/.test(md));
});
