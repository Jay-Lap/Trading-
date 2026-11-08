// Exchange-precision helpers. Work in integer "steps" to avoid float drift.
export function decimalsOf(step) {
  const s = String(step);
  if (s.includes('e-')) return Number(s.split('e-')[1]);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.slice(i + 1).replace(/0+$/, '').length;
}
export function floorToStep(value, step) {
  const d = decimalsOf(step);
  const n = Math.floor(value / Number(step) + 1e-9);
  return Number((n * Number(step)).toFixed(d));
}
export function roundToStep(value, step) {
  const d = decimalsOf(step);
  const n = Math.round(value / Number(step));
  return Number((n * Number(step)).toFixed(d));
}
export function fmt(value, step) {
  return Number(value).toFixed(decimalsOf(step));
}
