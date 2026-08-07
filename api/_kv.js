// api/_kv.js — shared storage helpers. Speaks BOTH Redis dialects:
// direct connection (REDIS_URL, what Vercel's Redis integration provides)
// and REST (KV_REST_API_URL / UPSTASH_*), whichever is configured.

import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || null;
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;

export function kvAvailable() { return !!(REDIS_URL || (KV_URL && KV_TOKEN)); }

let client = null;
async function getClient() {
  if (!REDIS_URL) return null;
  if (client && client.isOpen) return client;
  client = createClient({ url: REDIS_URL });
  client.on('error', e => console.error('redis:', e.message));
  await client.connect();
  return client;
}

async function restCmd(parts) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(parts)
  });
  return r.json();
}

export async function kvGet(k) {
  try {
    const c = await getClient();
    if (c) { const v = await c.get(k); return v ? JSON.parse(v) : null; }
    if (KV_URL && KV_TOKEN) { const d = await restCmd(['GET', k]); return d && d.result ? JSON.parse(d.result) : null; }
  } catch (e) { console.error('kv get:', e.message); }
  return null;
}
export async function kvSet(k, v, ttlSec) {
  try {
    const c = await getClient();
    if (c) { await c.set(k, JSON.stringify(v), { EX: ttlSec }); return; }
    if (KV_URL && KV_TOKEN) { await restCmd(['SET', k, JSON.stringify(v), 'EX', String(ttlSec)]); return; }
    console.error('kv set: no storage configured');
  } catch (e) { console.error('kv set:', e.message); }
}
export async function kvDel(k) {
  try {
    const c = await getClient();
    if (c) { await c.del(k); return; }
    if (KV_URL && KV_TOKEN) { await restCmd(['DEL', k]); }
  } catch (e) { console.error('kv del:', e.message); }
}

export async function rateLimit(key, max, windowSec) {
  const k = `rl|${key}`;
  const cur = (await kvGet(k)) || 0;
  if (cur >= max) return false;
  await kvSet(k, cur + 1, windowSec);
  return true;
}

export async function getSession(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || token.length < 20) return null;
  return await kvGet(`session|${token}`);
}
