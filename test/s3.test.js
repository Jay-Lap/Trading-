import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { signV4, S3Store } from '../src/lib/s3.js';
import { Reporter } from '../src/bots/reporter.js';

test('SigV4 matches AWS documented example (GET bucket lifecycle)', () => {
  const auth = signV4({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/', query: 'lifecycle=',
    payloadHash: crypto.createHash('sha256').update('').digest('hex'), amzDate: '20130524T000000Z', region: 'us-east-1',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });
  assert.equal(auth, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
});

test('fromEnv needs all variables', () => {
  assert.equal(S3Store.fromEnv({}), null);
  const s = S3Store.fromEnv({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b', AWS_ENDPOINT_URL_S3: 'https://api.onpod.ai/s3', S3_BUCKET: 'bk' });
  assert.ok(s);
  assert.ok(s.sign('PUT', 'trading-bot/paper/state.json', '{}').url.startsWith('https://api.onpod.ai/s3/bk/trading-bot/paper/state.json'));
});

test('reporter restores state + journal from the store after a "restart"', async () => {
  const mem = new Map();
  const fake = { bucket: 'bk', get: async k => mem.get(k) ?? null, put: async (k, v) => { mem.set(k, v); } };
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'r1-'));
  const r1 = new Reporter(d1, { quiet: true });
  r1.attachStore(fake, 'trading-bot/paper');
  r1.state.paper = { cash: 987 };
  r1.trade({ event: 'OPEN', symbol: 'BTCUSDT', side: 'SELL', qty: 0.002, price: 70000, reason: 't' });
  r1.save(); await r1.flush();
  assert.ok(mem.has('trading-bot/paper/state.json') && mem.has('trading-bot/paper/journal.jsonl'));

  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-')); // fresh container, empty disk
  const r2 = new Reporter(d2, { quiet: true });
  r2.attachStore(fake, 'trading-bot/paper');
  assert.equal(await r2.restore(), true);
  assert.equal(r2.state.paper.cash, 987);
  assert.equal(fs.readFileSync(path.join(d2, 'journal.jsonl'), 'utf8').trim().split('\n').length, 1);
});

test('flush never throws when storage fails', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-'));
  const r = new Reporter(d, { quiet: true });
  r.attachStore({ bucket: 'x', put: async () => { throw new Error('down'); } }, 'p');
  r.save();
  await r.flush();
  assert.equal(r.dirty, true); // will retry next tick
});
