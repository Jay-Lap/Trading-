// 6) REPORTER bot — console log, trade journal (JSONL), persistent state.
import fs from 'node:fs';
import path from 'node:path';

export class Reporter {
  constructor(dir = path.resolve(process.cwd(), 'data'), { quiet = false } = {}) {
    this.dir = dir; this.quiet = quiet;
    fs.mkdirSync(dir, { recursive: true });
    this.statePath = path.join(dir, 'state.json');
    this.journalPath = path.join(dir, 'journal.jsonl');
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
    const pnl = obj.event === 'CLOSE' && obj.entry ? ` 손익≈${((obj.price - obj.entry) * obj.qty * (obj.side === 'SELL' ? 1 : -1)).toFixed(2)} USDT` : '';
    this.info(`거래 ${obj.event} ${obj.symbol} ${obj.side} ${obj.qty} @ ${obj.price} (${obj.reason})${pnl}`);
  }
  save() {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }
}
