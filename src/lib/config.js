import { loadEnv } from './env.js';

export const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_REAL_MONEY_LOSS';
export const HARD_MAX_LEVERAGE = 10;

const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`설정 ${name} 값이 숫자가 아닙니다: ${v}`);
  return n;
};

export function loadConfig({ env = true } = {}) {
  if (env) loadEnv();
  const mode = (process.env.MODE || 'paper').toLowerCase();
  if (!['paper', 'testnet', 'live'].includes(mode)) throw new Error(`MODE 는 paper / testnet / live 중 하나여야 합니다 (현재: ${mode})`);

  const cfg = {
    mode,
    apiKey: process.env.BINANCE_API_KEY || '',
    apiSecret: process.env.BINANCE_API_SECRET || '',
    liveBaseUrl: process.env.LIVE_BASE_URL || 'https://fapi.binance.com',
    testnetBaseUrl: process.env.TESTNET_BASE_URL || 'https://demo-fapi.binance.com',
    symbols: (process.env.SYMBOLS || 'BTCUSDT').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    interval: process.env.INTERVAL || '15m',
    emaFast: num('EMA_FAST', 20),
    emaSlow: num('EMA_SLOW', 50),
    atrPeriod: num('ATR_PERIOD', 14),
    stopAtrMult: num('STOP_ATR_MULT', 2),
    takeProfitAtrMult: num('TAKE_PROFIT_ATR_MULT', 3),
    strategy: (process.env.STRATEGY || 'ema').toLowerCase(),
    committeeThreshold: num('COMMITTEE_THRESHOLD', 0.5),
    committeeAdxMin: num('COMMITTEE_ADX_MIN', 20),
    trendEma: num('TREND_EMA', 0),
    adxPeriod: num('ADX_PERIOD', 14),
    adxMin: num('ADX_MIN', 0),
    pollSeconds: num('POLL_SECONDS', 20),
    riskPerTradePct: num('RISK_PER_TRADE_PCT', 1),
    leverage: num('LEVERAGE', 3),
    maxNotionalUsdt: num('MAX_NOTIONAL_USDT', 200),
    dailyMaxLossPct: num('DAILY_MAX_LOSS_PCT', 3),
    emergencyStopPct: num('EMERGENCY_STOP_PCT', 2),
    paperStartUsdt: num('PAPER_START_USDT', 1000),
  };
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg) {
  const errs = [];
  if (!Number.isInteger(cfg.leverage) || cfg.leverage < 1 || cfg.leverage > HARD_MAX_LEVERAGE)
    errs.push(`LEVERAGE 는 1~${HARD_MAX_LEVERAGE} 사이 정수여야 합니다 (현재 ${cfg.leverage})`);
  if (cfg.riskPerTradePct <= 0 || cfg.riskPerTradePct > 5) errs.push('RISK_PER_TRADE_PCT 는 0 초과 5 이하여야 합니다');
  if (cfg.dailyMaxLossPct <= 0 || cfg.dailyMaxLossPct > 20) errs.push('DAILY_MAX_LOSS_PCT 는 0 초과 20 이하여야 합니다');
  if (cfg.maxNotionalUsdt <= 0) errs.push('MAX_NOTIONAL_USDT 는 0보다 커야 합니다');
  if (!['ema', 'committee'].includes(cfg.strategy)) errs.push('STRATEGY 는 ema 또는 committee 여야 합니다');
  if (cfg.committeeThreshold <= 0 || cfg.committeeThreshold > 1) errs.push('COMMITTEE_THRESHOLD 는 0 초과 1 이하');
  if (cfg.emaFast >= cfg.emaSlow) errs.push('EMA_FAST 는 EMA_SLOW 보다 작아야 합니다');
  if (cfg.stopAtrMult <= 0 || cfg.takeProfitAtrMult <= 0) errs.push('ATR 배수는 0보다 커야 합니다');
  if (cfg.emergencyStopPct <= 0 || cfg.emergencyStopPct >= 100 / cfg.leverage / 2)
    errs.push('EMERGENCY_STOP_PCT 는 청산가보다 충분히 가까워야 합니다 (100/레버리지/2 미만)');
  if (cfg.pollSeconds < 5) errs.push('POLL_SECONDS 는 5 이상이어야 합니다 (API 제한)');
  if (!cfg.symbols.length) errs.push('SYMBOLS 가 비었습니다');
  if (cfg.mode !== 'paper' && (!cfg.apiKey || !cfg.apiSecret)) errs.push(`${cfg.mode} 모드는 BINANCE_API_KEY / BINANCE_API_SECRET 이 필요합니다 (.env 파일)`);
  if (cfg.mode === 'live' && process.env.LIVE_CONFIRM !== LIVE_CONFIRM_PHRASE)
    errs.push(`live 모드는 .env 에 LIVE_CONFIRM=${LIVE_CONFIRM_PHRASE} 를 정확히 적어야 켜집니다`);
  if (errs.length) throw new Error('설정 오류:\n - ' + errs.join('\n - '));
}

export function baseUrlFor(cfg) {
  return cfg.mode === 'testnet' ? cfg.testnetBaseUrl : cfg.liveBaseUrl;
}
