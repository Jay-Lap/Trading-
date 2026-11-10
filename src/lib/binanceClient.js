// Tiny signed REST client for Binance USDⓈ-M futures. No dependencies.
import crypto from 'node:crypto';

export class BinanceError extends Error {
  constructor(status, code, msg, path) {
    super(`Binance ${status} ${code ?? ''} ${msg} (${path})`);
    this.status = status; this.code = code; this.path = path;
  }
}

export class BinanceClient {
  constructor({ baseUrl, apiKey = '', apiSecret = '', recvWindow = 5000, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.recvWindow = recvWindow;
    this.fetch = fetchImpl;
    this.timeOffset = 0;
  }

  static sign(query, secret) {
    return crypto.createHmac('sha256', secret).update(query).digest('hex');
  }

  async syncTime() {
    const t0 = Date.now();
    const { serverTime } = await this.public('GET', '/fapi/v1/time');
    this.timeOffset = serverTime - Math.round((t0 + Date.now()) / 2);
    this.lastSync = Date.now();
  }

  async public(method, path, params = {}) {
    return this.#send(method, path, params, false);
  }

  async signed(method, path, params = {}) {
    if (!this.apiKey || !this.apiSecret) throw new Error('API 키가 없습니다');
    // Clocks drift over days: resync hourly, and once more if Binance says our timestamp is off (-1021).
    if (this.lastSync && Date.now() - this.lastSync > 3600e3) await this.syncTime().catch(() => {});
    try { return await this.#send(method, path, params, true); }
    catch (e) {
      if (e.code !== -1021) throw e;
      await this.syncTime();
      return this.#send(method, path, params, true);
    }
  }

  async #send(method, path, params, sign) {
    // Rate-limited (429) or IP-banned (418): stop calling until Binance's Retry-After passes.
    if (this.pausedUntil && Date.now() < this.pausedUntil)
      throw new BinanceError(429, null, `요청 한도 초과로 ${Math.ceil((this.pausedUntil - Date.now()) / 1000)}초 대기 중`, path);
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.append(k, String(v));
    if (sign) {
      p.append('recvWindow', String(this.recvWindow));
      p.append('timestamp', String(Date.now() + this.timeOffset));
      p.append('signature', BinanceClient.sign(p.toString(), this.apiSecret));
    }
    const qs = p.toString();
    const url = `${this.baseUrl}${path}${qs ? '?' + qs : ''}`;
    const headers = this.apiKey ? { 'X-MBX-APIKEY': this.apiKey } : {};
    let res;
    try { res = await this.fetch(url, { method, headers, signal: AbortSignal.timeout(15000) }); }
    catch (e) { throw new Error(`${this.baseUrl} 에 연결 실패 (${e.cause?.code ?? e.message}). 인터넷 연결, 방화벽, 또는 해당 국가/지역 접속 제한을 확인하세요.`); }
    if (res.status === 451 || res.status === 403 && !this.apiKey)
      throw new BinanceError(res.status, null, '현재 위치(IP)에서 바이낸스 접속이 제한됩니다', path);
    if (res.status === 429 || res.status === 418) {
      const wait = Number(res.headers?.get?.('retry-after')) || (res.status === 418 ? 300 : 60);
      this.pausedUntil = Date.now() + wait * 1000;
    }
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { msg: text.slice(0, 200) }; }
    if (!res.ok || (body && typeof body.code === 'number' && body.code < 0)) {
      throw new BinanceError(res.status, body?.code, body?.msg ?? text.slice(0, 200), path);
    }
    return body;
  }
}
