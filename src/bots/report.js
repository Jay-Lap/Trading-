// CHIEF's daily report. Losses come FIRST (loss-first review), then wins, costs and state.
const KST = t => new Date(new Date(t).getTime() + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const n = (x, d = 3) => (x == null || Number.isNaN(x) ? '-' : `${x >= 0 ? '+' : ''}${Number(x).toFixed(d)}`);

function lossCause(t, openRec) {
  const causes = [];
  if (/손절/.test(t.reason)) causes.push('가격이 손절가까지 역행');
  if (/위원회 반대/.test(t.reason)) causes.push('추세 전환으로 위원회가 반대 판단');
  if (/반대 신호/.test(t.reason)) causes.push('반대 방향 강한 신호');
  if (/유동성/.test(t.reason)) causes.push('유동성 급감 청산');
  if (/수동/.test(t.reason)) causes.push('거래소에서 직접 청산됨 (봇 외부)');
  const gross = t.pnl ?? 0, fees = (t.fee ?? 0) + (openRec?.fee ?? 0);
  if (gross >= 0 && gross - fees < 0) causes.push('가격은 맞았지만 수수료가 이익을 잠식');
  else if (fees > 0 && Math.abs(gross) > 0 && fees / Math.abs(gross) > 0.3) causes.push(`수수료 비중 큼 (${(fees / Math.abs(gross) * 100).toFixed(0)}%)`);
  if (openRec?.slippagePct != null && Math.abs(openRec.slippagePct) > 0.15) causes.push(`진입 슬리피지 ${openRec.slippagePct.toFixed(2)}%`);
  return causes.join(' · ') || '분류 불가';
}

export function buildDailyReport({ day, journal, equityStart, equityEnd, positions = [], funding = 0, tierName = '', mode = '' }) {
  const inDay = r => (r.time || '').slice(0, 10) === day;
  const opens = journal.filter(r => r.event === 'OPEN');
  const lastOpenBefore = (t) => [...opens].reverse().find(o => o.symbol === t.symbol && o.time <= t.time);
  const closes = journal.filter(r => r.event === 'CLOSE' && inDay(r)).map(t => {
    const o = lastOpenBefore(t); const net = (t.pnl ?? 0) - (t.fee ?? 0) - (o?.fee ?? 0);
    return { ...t, open: o, net };
  });
  const losses = closes.filter(t => t.net < 0), wins = closes.filter(t => t.net >= 0);
  const dayOpens = journal.filter(r => r.event === 'OPEN' && inDay(r));
  const fees = closes.reduce((a, t) => a + (t.fee ?? 0), 0) + dayOpens.reduce((a, t) => a + (t.fee ?? 0), 0);
  const net = closes.reduce((a, t) => a + (t.pnl ?? 0) - (t.fee ?? 0), 0) - dayOpens.reduce((a, t) => a + (t.fee ?? 0), 0) + funding;
  const L = [];
  L.push(`# 일일 보고서 ${day} (UTC) · ${mode.toUpperCase()}`);
  L.push('');
  L.push(`## 1. 손실 거래 (${losses.length}건)`);
  if (!losses.length) L.push('- 없음');
  for (const t of losses) {
    L.push(`- **${t.symbol} ${t.side === 'BUY' ? '숏' : '롱'} 청산** ${KST(t.open?.time ?? t.time)} 진입 ${t.open?.price ?? t.entry ?? '-'} → ${KST(t.time)} 청산 ${t.price} · 순손익 **${n(t.net)} USDT** (가격손익 ${n(t.pnl)}, 수수료 ${n(-(t.fee ?? 0) - (t.open?.fee ?? 0), 4)})`);
    L.push(`  - 원인: ${lossCause(t, t.open)} · 청산 사유: ${t.reason}`);
  }
  L.push('');
  L.push(`## 2. 수익 거래 (${wins.length}건)`);
  if (!wins.length) L.push('- 없음');
  for (const t of wins) L.push(`- ${t.symbol} ${t.side === 'BUY' ? '숏' : '롱'} 청산 ${KST(t.time)} @ ${t.price} · 순손익 ${n(t.net)} USDT · ${t.reason}`);
  L.push('');
  L.push('## 3. 오늘 진입');
  if (!dayOpens.length) L.push('- 없음');
  for (const o of dayOpens) L.push(`- ${KST(o.time)} ${o.symbol} ${o.side === 'BUY' ? '롱' : '숏'} ${o.qty} @ ${o.price} · 수수료 ${o.fee ?? '-'} · 슬리피지 ${o.slippagePct != null ? o.slippagePct.toFixed(3) + '%' : '-'}`);
  L.push('');
  L.push('## 4. 비용과 결과');
  L.push(`- 수수료 합계: ${n(-fees, 4)} USDT · 펀딩비: ${n(funding, 4)} USDT`);
  L.push(`- 오늘 실현 순손익: **${n(net)} USDT**`);
  L.push(`- 잔고: ${equityStart?.toFixed?.(2) ?? '-'} → ${equityEnd?.toFixed?.(2) ?? '-'} USDT`);
  L.push('');
  L.push('## 5. 현재 상태');
  L.push(`- 단계: ${tierName || '-'}`);
  if (!positions.length) L.push('- 보유 포지션 없음');
  for (const p of positions) L.push(`- ${p.symbol} ${p.qty > 0 ? '롱' : '숏'} ${Math.abs(p.qty)} @ ${p.entryPrice} · 현재 ${p.markPrice} · 손절 ${p.stop ?? '-'} / 익절 ${p.takeProfit ?? '-'}`);
  return { md: L.join('\n'), losses: losses.length, wins: wins.length, net };
}
