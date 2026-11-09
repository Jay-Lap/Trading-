// 5) EXIT bot — guarantees every open position has a stop, and closes positions.
// Two layers: exchange-side stop order (survives if this PC crashes) + local price watch (backstop).
export class ExitBot {
  constructor(broker, reporter, cfg) { this.b = broker; this.r = reporter; this.cfg = cfg; }

  async close(symbol, pos, filters, reason, fillPrice = null) {
    const side = pos.qty > 0 ? 'SELL' : 'BUY';
    const res = await this.b.market(symbol, side, Math.abs(pos.qty), filters, true, fillPrice);
    await this.b.cancelProtection(symbol);
    const meta = this.r.state.positions[symbol];
    delete this.r.state.positions[symbol];
    this.r.trade({ event: 'CLOSE', symbol, side, qty: Math.abs(pos.qty), price: Number(res.avgPrice) || pos.markPrice, entry: pos.entryPrice, reason, meta });
    return res;
  }

  // PAPER ONLY: the bot may sleep for hours between runs. Replay 5m candles since the last check
  // and fill at the stop/target if price touched it meanwhile (stop wins if both in one candle).
  async paperCatchUp(symbol, pos, filters, candles5m) {
    const meta = this.r.state.positions[symbol];
    if (!meta) return null;
    const long = pos.qty > 0;
    for (const c of candles5m) {
      if (long ? c.low <= meta.stop : c.high >= meta.stop)
        return this.close(symbol, pos, filters, `손절가 도달(${new Date(c.openTime).toISOString().slice(5, 16)} 5분봉)`, meta.stop);
      if (meta.takeProfit && (long ? c.high >= meta.takeProfit : c.low <= meta.takeProfit))
        return this.close(symbol, pos, filters, `익절가 도달(${new Date(c.openTime).toISOString().slice(5, 16)} 5분봉)`, meta.takeProfit);
    }
    return null;
  }

  // Called every tick for a symbol that has an open position.
  async manage(symbol, pos, filters) {
    const st = this.r.state.positions;
    const long = pos.qty > 0;
    if (!st[symbol]) {
      // Unknown position (manual trade or restart) → adopt it with an emergency stop.
      const k = this.cfg.emergencyStopPct / 100;
      st[symbol] = { stop: pos.entryPrice * (long ? 1 - k : 1 + k), takeProfit: null, adopted: true };
      this.r.warn(`${symbol} 기록에 없는 포지션 발견 → 진입가 대비 ${this.cfg.emergencyStopPct}% 비상 손절 설정`);
    }
    const meta = st[symbol];
    const price = pos.markPrice;

    // Local backstop: price already beyond stop/target.
    if ((long && price <= meta.stop) || (!long && price >= meta.stop)) return this.close(symbol, pos, filters, '손절가 도달(봇 감시)');
    if (meta.takeProfit && ((long && price >= meta.takeProfit) || (!long && price <= meta.takeProfit)))
      return this.close(symbol, pos, filters, '익절가 도달(봇 감시)');

    // Make sure the exchange-side stop exists; if it cannot be placed, flatten.
    if (!(await this.b.hasStop(symbol))) {
      try {
        await this.b.placeProtection(symbol, long ? 'SELL' : 'BUY', meta.stop, meta.takeProfit, filters);
        this.r.info(`${symbol} ${this.b.kind === 'paper' ? '가상 손절·익절' : '거래소 손절 주문'} 설정 @ 손절 ${meta.stop.toFixed(4)}${meta.takeProfit ? ` / 익절 ${meta.takeProfit.toFixed(4)}` : ''}`);
      } catch (e) {
        this.r.error(`${symbol} 손절 주문을 걸 수 없음 → 안전을 위해 즉시 청산: ${e.message}`);
        return this.close(symbol, pos, filters, '손절 주문 실패로 안전 청산');
      }
    }
    return null;
  }
}
