// api/stats.js — feeds the founder dashboard. Requires ?key= matching the
// DASH_KEY environment variable. Read-only.

import { kvCmd } from './_kv.js';
import { ukDay } from './_stats.js';

function toObj(flat) {
  // HGETALL comes back as [k,v,k,v,...] over TCP, or {k:v} over REST
  if (!flat) return {};
  if (Array.isArray(flat)) {
    const o = {};
    for (let i = 0; i < flat.length; i += 2) o[flat[i]] = Number(flat[i + 1]) || 0;
    return o;
  }
  if (typeof flat === 'object') {
    const o = {};
    for (const k of Object.keys(flat)) o[k] = Number(flat[k]) || 0;
    return o;
  }
  return {};
}

export default async function handler(req, res) {
  if (!process.env.DASH_KEY) return res.status(500).json({ error: 'DASH_KEY not configured' });
  if ((req.query && req.query.key) !== process.env.DASH_KEY) return res.status(401).json({ error: 'wrong key' });

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = ukDay(-i);
    const [stats, uniq] = await Promise.all([
      kvCmd(['HGETALL', `stats|${date}`]),
      kvCmd(['SCARD', `uids|${date}`])
    ]);
    days.push({ date, ...toObj(stats), active_users: Number(uniq) || 0 });
  }

  // month-to-date estimated spend: sum cost_cents across this month's days
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/London' }));
  let monthCents = 0;
  const monthPrefix = ukDay().slice(0, 7);
  for (let i = 0; i < 31; i++) {
    const date = ukDay(-i);
    if (!date.startsWith(monthPrefix)) break;
    if (i < 7) { monthCents += days[i].cost_cents || 0; continue; }
    const s = toObj(await kvCmd(['HGETALL', `stats|${date}`]));
    monthCents += s.cost_cents || 0;
  }

  // recent errors: today + yesterday
  const errs = [];
  for (const date of [ukDay(), ukDay(-1)]) {
    const list = await kvCmd(['LRANGE', `errs|${date}`, '0', '19']);
    (Array.isArray(list) ? list : []).forEach(x => { try { errs.push(JSON.parse(x)); } catch {} });
  }
  errs.sort((a, b) => (a.t < b.t ? 1 : -1));

  return res.status(200).json({ days, monthSpendUSD: monthCents / 100, errors: errs.slice(0, 20), generated: new Date().toISOString() });
}
