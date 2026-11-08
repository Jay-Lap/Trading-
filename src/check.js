// Connectivity check. Never prints key values.
import { loadConfig, baseUrlFor } from './lib/config.js';
import { BinanceClient } from './lib/binanceClient.js';

const cfg = loadConfig();
const pub = new BinanceClient({ baseUrl: cfg.mode === 'paper' ? cfg.liveBaseUrl : baseUrlFor(cfg) });
const step = async (name, fn) => {
  try { console.log(`✅ ${name}: ${await fn()}`); return true; }
  catch (e) { console.log(`❌ ${name}: ${e.message}`); return false; }
};
console.log(`모드 ${cfg.mode} · 주소 ${pub.baseUrl} · API 키 ${cfg.apiKey ? '설정됨' : '없음'}`);
await step('서버 시간', async () => new Date((await pub.public('GET', '/fapi/v1/time')).serverTime).toISOString());
for (const s of cfg.symbols)
  await step(`${s} 시세`, async () => (await pub.public('GET', '/fapi/v1/premiumIndex', { symbol: s })).markPrice);
if (cfg.mode !== 'paper') {
  const c = new BinanceClient({ baseUrl: baseUrlFor(cfg), apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });
  await c.syncTime().catch(() => {});
  await step('키 인증 / 잔고', async () => {
    let a; try { a = await c.signed('GET', '/fapi/v3/account'); } catch { a = await c.signed('GET', '/fapi/v2/account'); }
    return `평가금액 ${Number(a.totalMarginBalance).toFixed(2)} USDT`;
  });
  await step('포지션 모드', async () => (await c.signed('GET', '/fapi/v1/positionSide/dual')).dualSidePosition ? '헤지 모드 ❗ 단방향으로 바꾸세요' : '단방향(정상)');
}
