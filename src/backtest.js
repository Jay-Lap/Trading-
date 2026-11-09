// Usage: npm run backtest -- BTCUSDT 30   (symbol, days). Uses public mainnet data, no key.
import { loadConfig } from './lib/config.js';
import { BinanceClient } from './lib/binanceClient.js';
import { DataBot, SpotDataBot, SPOT_DATA_URL, parseKlines } from './bots/data.js';
import { backtest } from './lib/simulate.js';

process.env.MODE = 'paper';
const cfg = loadConfig();
const symbol = (process.argv[2] || cfg.symbols[0]).toUpperCase();
const days = Number(process.argv[3] || 30);
let data = new DataBot(new BinanceClient({ baseUrl: cfg.liveBaseUrl }));
let filters;
try { filters = (await data.symbolFilters([symbol]))[symbol]; }
catch (e) {
  console.log(`선물 시세 접속 불가 (${e.message}) → 현물 시세로 백테스트`);
  data = new SpotDataBot(new BinanceClient({ baseUrl: SPOT_DATA_URL }));
  filters = (await data.symbolFilters([symbol]))[symbol];
}
let start = Date.now() - days * 86400_000, all = [];
while (start < Date.now()) {
  const rows = await data.klinesRange(symbol, cfg.interval, start);
  if (!rows.length) break;
  all.push(...parseKlines(rows));
  start = rows.at(-1)[6] + 1;
}
const r = backtest(all, cfg, filters, { startEquity: cfg.paperStartUsdt });
console.log(`\n[${data.source === 'spot' ? '현물' : '선물'} 시세] ${symbol} ${cfg.interval} 최근 ${days}일 (${all.length}개 캔들), 수수료 포함`);
console.log(`시작 ${r.startEquity} → 종료 ${r.endEquity.toFixed(2)} USDT (${r.returnPct.toFixed(2)}%)`);
console.log(`거래 ${r.trades}회 · 승률 ${r.winRatePct.toFixed(1)}% · 최대 낙폭 ${r.maxDrawdownPct.toFixed(2)}%`);
console.log('※ 과거 성과는 미래 수익을 보장하지 않습니다. 슬리피지·펀딩비는 반영되지 않았습니다.');
