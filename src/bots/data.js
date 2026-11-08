// 1) DATA bot — fetches closed candles. Public endpoint, no key.
export function parseKlines(rows, now = Date.now()) {
  return rows
    .map(r => ({ openTime: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5], closeTime: r[6] }))
    .filter(c => c.closeTime < now); // drop the still-forming candle
}

export class DataBot {
  constructor(client) { this.client = client; }
  async candles(symbol, interval, limit = 300) {
    const rows = await this.client.public('GET', '/fapi/v1/klines', { symbol, interval, limit });
    return parseKlines(rows);
  }
  async markPrice(symbol) {
    const r = await this.client.public('GET', '/fapi/v1/premiumIndex', { symbol });
    return Number(r.markPrice);
  }
  async symbolFilters(symbols) {
    const info = await this.client.public('GET', '/fapi/v1/exchangeInfo');
    const out = {};
    for (const s of info.symbols) {
      if (!symbols.includes(s.symbol)) continue;
      if (s.status !== 'TRADING' || s.contractType !== 'PERPETUAL' || s.marginAsset !== 'USDT')
        throw new Error(`${s.symbol} 은 USDT 무기한 선물로 거래 가능한 상태가 아닙니다`);
      const f = Object.fromEntries(s.filters.map(x => [x.filterType, x]));
      const lot = f.MARKET_LOT_SIZE && Number(f.MARKET_LOT_SIZE.stepSize) > 0 ? f.MARKET_LOT_SIZE : f.LOT_SIZE;
      out[s.symbol] = {
        stepSize: lot.stepSize,
        minQty: Number(lot.minQty),
        maxQty: Number(lot.maxQty),
        tickSize: f.PRICE_FILTER.tickSize,
        minNotional: Number(f.MIN_NOTIONAL?.notional ?? 5),
      };
    }
    for (const s of symbols) if (!out[s]) throw new Error(`종목 ${s} 을(를) 바이낸스 선물에서 찾지 못했습니다`);
    return out;
  }
}
