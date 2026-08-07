// api/_kv.js — shared Redis helpers + session handling for auth endpoints.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;

async function cmd(parts) {
  if (!KV_URL || !KV_TOKEN) throw new Error('kv not configured');
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(parts)
  });
  return r.json();
}

export async function kvGet(k) {
  try { const d = await cmd(['GET', k]); return d && d.result ? JSON.parse(d.result) : null; }
  catch (e) { console.error('kv get:', e.message); return null; }
}
export async function kvSet(k, v, ttlSec) {
  try { await cmd(['SET', k, JSON.stringify(v), 'EX', String(ttlSec)]); }
  catch (e) { console.error('kv set:', e.message); }
}
export async function kvDel(k) {
  try { await cmd(['DEL', k]); } catch (e) { console.error('kv del:', e.message); }
}

// crude but effective rate limit: max hits per key per window
export async function rateLimit(key, max, windowSec) {
  const k = `rl|${key}`;
  const cur = (await kvGet(k)) || 0;
  if (cur >= max) return false;
  await kvSet(k, cur + 1, windowSec);
  return true;
}

// resolve "Authorization: Bearer <token>" to a session, or null
export async function getSession(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token.length < 20) return null;
  return await kvGet(`session|${token}`);
}
