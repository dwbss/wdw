// api/_stats.js — lightweight self-metering. Counters land in Redis as
// events happen; /api/stats reads them for the dashboard. All calls are
// fire-and-forget so metering can never slow a search.

import { kvCmd } from './_kv.js';

export function ukDay(offset = 0) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

export function bump(field, n = 1) {
  const k = `stats|${ukDay()}`;
  kvCmd(['HINCRBY', k, field, Math.round(n)]).catch(() => {});
  kvCmd(['EXPIRE', k, 40 * 86400]).catch(() => {});
}

export function seenUser(uid) {
  if (!uid) return;
  const k = `uids|${ukDay()}`;
  kvCmd(['SADD', k, uid]).catch(() => {});
  kvCmd(['EXPIRE', k, 40 * 86400]).catch(() => {});
}

export function recErr(msg) {
  const k = `errs|${ukDay()}`;
  kvCmd(['LPUSH', k, JSON.stringify({ t: new Date().toISOString(), m: String(msg).slice(0, 200) })]).catch(() => {});
  kvCmd(['LTRIM', k, 0, 49]).catch(() => {});
  kvCmd(['EXPIRE', k, 8 * 86400]).catch(() => {});
}
