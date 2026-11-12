// 6) REPORTER bot — console log, trade journal (JSONL), persistent state.
import fs from 'node:fs';
import path from 'node:path';

export class Reporter {
  constructor(dir = path.resolve(process.cwd(), 'data'), { quiet = false } = {}) {
    this.dir = dir; this.quiet = quiet;
    fs.mkdirSync(dir, { recursive: true });
    this.statePath = path.join(dir, 'state.json');
    this.journalPath = path.join(dir, 'journal.jsonl');
    this.decisionsPath = path.join(dir, 'decisions.jsonl');
    this.state = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, 'utf8')) : {};
    this.state.positions ??= {};
    this.state.lastCandle ??= {};
  }
  #out(level, msg) {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    if (!this.quiet) (level === 'ERROR' ? console.error : console.log)(line);
    fs.appendFileSync(path.join(this.dir, 'bot.log'), line + '\n');
  }
  info(m) { this.#out('INFO', m); }
  warn(m) { this.#out('WARN', m); }
  error(m) { this.#out('ERROR', m); }
  trade(obj) {
    const rec = { time: new Date().toISOString(), ...obj };
    fs.appendFileSync(this.journalPath, JSON.stringify(rec) + '\n');
    this.journalDirty = true;
    const pnlVal = obj.pnl ?? (obj.event === 'CLOSE' && obj.entry ? (obj.price - obj.entry) * obj.qty * (obj.side === 'SELL' ? 1 : -1) : null);
    const pnl = obj.event === 'CLOSE' && pnlVal != null ? ` 손익 ${pnlVal >= 0 ? '+' : ''}${Number(pnlVal).toFixed(3)} USDT` : '';
    const fee = obj.fee != null ? ` · 수수료 ${Number(obj.fee).toFixed(4)}` : '';
    const slip = obj.slippagePct != null ? ` · 슬리피지 ${obj.slippagePct.toFixed(3)}%` : '';
    this.info(`거래 ${obj.event} ${obj.symbol} ${obj.side} ${obj.qty} @ ${obj.price} (${obj.reason})${pnl}${fee}${slip}`);
  }
  readJournal() {
    if (!fs.existsSync(this.journalPath)) return [];
    return fs.readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  async saveReport(day, md) {
    const dir = path.join(this.dir, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${day}.md`), md);
    if (this.store) {
      try { await this.store.put(`${this.prefix}/reports/${day}.md`, md, 'text/markdown; charset=utf-8'); }
      catch (e) { this.warn(`보고서 업로드 실패: ${e.message}`); }
    }
  }

  // Every 4h decision (enter / hold / keep / veto) with its reasons — not only trades.
  decision(obj) {
    fs.appendFileSync(this.decisionsPath, JSON.stringify({ time: new Date().toISOString(), ...obj }) + '\n');
    this.decisionsDirty = true;
  }

  save() {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
    this.dirty = true;
  }

  // ---- optional remote copy (onpod bucket) so state + trade log survive server restarts ----
  attachStore(store, prefix) { this.store = store; this.prefix = prefix.replace(/\/$/, ''); }

  async restore() {
    if (!this.store) return false;
    const [state, journal, decisions] = await Promise.all([
      this.store.get(`${this.prefix}/state.json`), this.store.get(`${this.prefix}/journal.jsonl`),
      this.store.get(`${this.prefix}/decisions.jsonl`).catch(() => null)]);
    if (decisions) fs.writeFileSync(this.decisionsPath, decisions);
    if (state) {
      this.state = JSON.parse(state);
      this.state.positions ??= {};
      this.state.lastCandle ??= {};
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    }
    if (journal) fs.writeFileSync(this.journalPath, journal);
    return Boolean(state || journal);
  }

  // Upload state (and journal if it changed). Never throws: storage trouble must not stop trading.
  async flush({ force = false } = {}) {
    if (!this.store || (!this.dirty && !this.journalDirty && !this.decisionsDirty)) return;
    // State changes every tick (timestamps); upload it at most every 5 minutes unless something real happened.
    if (!force && !this.journalDirty && !this.decisionsDirty && Date.now() - (this.lastFlush ?? 0) < 5 * 60e3) return;
    this.lastFlush = Date.now();
    try {
      if (this.dirty) await this.store.put(`${this.prefix}/state.json`, JSON.stringify(this.state, null, 2));
      if (this.journalDirty && fs.existsSync(this.journalPath))
        await this.store.put(`${this.prefix}/journal.jsonl`, fs.readFileSync(this.journalPath, 'utf8'), 'application/x-ndjson');
      if (this.decisionsDirty && fs.existsSync(this.decisionsPath))
        await this.store.put(`${this.prefix}/decisions.jsonl`, fs.readFileSync(this.decisionsPath, 'utf8'), 'application/x-ndjson');
      this.dirty = false; this.journalDirty = false; this.decisionsDirty = false;
    } catch (e) {
      this.warn(`기록 저장소(버킷) 업로드 실패, 다음 틱에 재시도: ${e.message}`);
    }
  }
}
