// 4) EXECUTION bot — the only code that sends orders. Two interchangeable brokers.
import { fmt, roundToStep } from '../lib/math.js';

const TAKER_FEE = 0.0005;

// Summarize Binance userTrades rows: average price, quantity, commission, realized PnL.
export function summarizeFills(rows = []) {
  let qty = 0, notional = 0, fee = 0, realizedPnl = 0;
  const feeAssets = new Set();
  for (const t of rows) {
    const q = Number(t.qty); qty += q; notional += q * Number(t.price);
    fee += Number(t.commission || 0); realizedPnl += Number(t.realizedPnl || 0);
    if (t.commissionAsset) feeAssets.add(t.commissionAsset);
  }
  return { qty, avgPrice: qty ? notional / qty : 0, fee, realizedPnl, feeAsset: [...feeAssets].join(',') || 'USDT', count: rows.length };
}

export class ExchangeBroker {
  constructor(client, log) { this.c = client; this.log = log; this.kind = 'exchange'; }

  async init(symbols, leverage) {
    await this.c.syncTime();
    const dual = await this.c.signed('GET', '/fapi/v1/positionSide/dual');
    if (dual.dualSidePosition) throw new Error('계정이 "헤지 모드" 입니다. 바이낸스 선물 설정에서 "단방향(One-way) 모드"로 바꾼 뒤 다시 실행하세요.');
    for (const symbol of symbols) {
      try { await this.c.signed('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' }); }
      catch (e) { if (![-4046, -4067, -4048].includes(e.code)) this.log.warn(`${symbol} 격리마진 설정 실패: ${e.message}`); }
      await this.c.signed('POST', '/fapi/v1/leverage', { symbol, leverage });
    }
  }

  async equity() {
    let a;
    try { a = await this.c.signed('GET', '/fapi/v3/account'); }
    catch { a = await this.c.signed('GET', '/fapi/v2/account'); }
    return Number(a.totalMarginBalance);
  }

  async position(symbol) {
    let rows;
    try { rows = await this.c.signed('GET', '/fapi/v3/positionRisk', { symbol }); }
    catch { rows = await this.c.signed('GET', '/fapi/v2/positionRisk', { symbol }); }
    const r = rows.find(x => x.symbol === symbol && Number(x.positionAmt) !== 0);
    return r ? { qty: Number(r.positionAmt), entryPrice: Number(r.entryPrice), markPrice: Number(r.markPrice) } : null;
  }

  async market(symbol, side, qty, filters, reduceOnly = false) {
    return this.c.signed('POST', '/fapi/v1/order', {
      symbol, side, type: 'MARKET', quantity: fmt(qty, filters.stepSize),
      reduceOnly: reduceOnly ? 'true' : undefined, newOrderRespType: 'RESULT',
    });
  }

  // Exchange-side stop / take-profit. Since 2025-12 Binance requires the Algo Order API
  // for conditional orders; fall back to the legacy endpoint for environments that still use it.
  async #conditional(symbol, side, type, triggerPrice, filters) {
    const trig = fmt(roundToStep(triggerPrice, filters.tickSize), filters.tickSize);
    try {
      const r = await this.c.signed('POST', '/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL', symbol, side, type, triggerPrice: trig,
        closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
      });
      return { id: r.algoId ?? r.orderId, via: 'algo' };
    } catch (e) {
      this.log.warn(`${symbol} ${type} algo 주문 실패 (${e.message}) → 기존 방식 재시도`);
      const r = await this.c.signed('POST', '/fapi/v1/order', {
        symbol, side, type, stopPrice: trig, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE',
      });
      return { id: r.orderId, via: 'legacy' };
    }
  }

  async placeProtection(symbol, closeSide, stop, takeProfit, filters) {
    const s = await this.#conditional(symbol, closeSide, 'STOP_MARKET', stop, filters); // throws if it fails
    let t = null;
    if (takeProfit) {
      try { t = await this.#conditional(symbol, closeSide, 'TAKE_PROFIT_MARKET', takeProfit, filters); }
      catch (e) { this.log.warn(`${symbol} 익절 주문 실패(손절은 걸림, 익절은 봇이 감시): ${e.message}`); }
    }
    return { stop: s, takeProfit: t };
  }

  // true / false, or null when it could not be checked (then the caller must NOT place duplicates).
  async hasStop(symbol) {
    const isStop = o => ['STOP_MARKET', 'STOP'].includes(o.orderType ?? o.type);
    try {
      const algo = await this.c.signed('GET', '/fapi/v1/openAlgoOrders', { symbol });
      const list = Array.isArray(algo) ? algo : (algo.orders ?? []);
      if (list.some(isStop)) return true;
      const legacy = await this.c.signed('GET', '/fapi/v1/openOrders', { symbol });
      return legacy.some(isStop);
    } catch (e) {
      this.log.warn(`${symbol} 미체결 주문 조회 실패 → 이번 틱은 손절 재설정 보류: ${e.message}`);
      return null;
    }
  }

  // Fills of one order, or trades since startTime (ms). Binance only serves a 7-day window per query,
  // so ask for the latest 7 days and filter locally (positions can be held longer than 7 days).
  async fills(symbol, { orderId, startTime, side } = {}) {
    const rows = await this.c.signed('GET', '/fapi/v1/userTrades', orderId ? { symbol, orderId } : { symbol, limit: 1000 });
    return summarizeFills(rows.filter(t => (!side || t.side === side) && (!startTime || Number(t.time) >= startTime)));
  }

  async funding(startTime, endTime) {
    const rows = await this.c.signed('GET', '/fapi/v1/income', { incomeType: 'FUNDING_FEE', startTime, endTime, limit: 1000 });
    return rows.reduce((a, x) => a + Number(x.income), 0);
  }

  async cancelProtection(symbol) {
    for (const path of ['/fapi/v1/algoOpenOrders', '/fapi/v1/allOpenOrders']) {
      try { await this.c.signed('DELETE', path, { symbol }); } catch (e) { /* nothing open is fine */ }
    }
  }
}

// Paper broker: real prices, fake money, local fills with taker fee.
export class PaperBroker {
  // store: a plain object persisted by the reporter (state.paper), so the fake account
  // survives restarts: { cash, pos: {symbol: {qty, entryPrice}}, prot: {symbol: {stop, takeProfit}} }
  constructor(startUsdt, priceFn, store = {}) {
    this.kind = 'paper';
    store.cash ??= startUsdt;
    store.startUsdt ??= startUsdt;
    store.pos ??= {};
    store.prot ??= {};
    this.store = store;
    this.priceFn = priceFn;
    this.lastPrice = {};
  }
  get cash() { return this.store.cash; }
  set cash(v) { this.store.cash = v; }
  get pos() { return this.store.pos; }
  get prot() { return this.store.prot; }
  async init() {}
  async #price(symbol) { const p = await this.priceFn(symbol); this.lastPrice[symbol] = p; return p; }
  async equity() {
    let eq = this.cash;
    for (const [s, p] of Object.entries(this.pos)) eq += (await this.#price(s) - p.entryPrice) * p.qty;
    return eq;
  }
  async position(symbol) {
    const p = this.pos[symbol];
    return p ? { ...p, markPrice: await this.#price(symbol) } : null;
  }
  async market(symbol, side, qty, _filters, reduceOnly = false, fillPrice = null) {
    const price = fillPrice ?? await this.#price(symbol);
    const signed = side === 'BUY' ? qty : -qty;
    const cur = this.pos[symbol];
    const fee = qty * price * TAKER_FEE;
    const realizedPnl = cur && Math.sign(cur.qty) !== Math.sign(signed) ? (price - cur.entryPrice) * Math.min(qty, Math.abs(cur.qty)) * Math.sign(cur.qty) : 0;
    this.lastFill = { qty, avgPrice: price, fee, realizedPnl, feeAsset: 'USDT', count: 1 };
    this.cash -= fee;
    if (!cur) {
      if (reduceOnly) return { status: 'REJECTED' };
      this.pos[symbol] = { qty: signed, entryPrice: price };
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(cur.qty)) * Math.sign(cur.qty);
      this.cash += (price - cur.entryPrice) * closing;
      const rest = cur.qty + signed;
      if (Math.abs(rest) < 1e-9) delete this.pos[symbol];
      else if (Math.sign(rest) === Math.sign(cur.qty)) cur.qty = rest;
      else if (!reduceOnly) this.pos[symbol] = { qty: rest, entryPrice: price };
      else delete this.pos[symbol];
    }
    return { status: 'FILLED', avgPrice: String(price), executedQty: String(qty) };
  }
  async placeProtection(symbol, _side, stop, takeProfit) { this.prot[symbol] = { stop, takeProfit }; return { stop: { via: 'paper' } }; }
  async hasStop(symbol) { return Boolean(this.prot[symbol]?.stop); }
  async cancelProtection(symbol) { delete this.prot[symbol]; }
  async fills() { return this.lastFill ?? summarizeFills([]); }
  async funding() { return 0; }
}
