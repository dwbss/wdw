// api/_kv.js — shared storage helpers. Speaks BOTH Redis dialects:
// direct connection (REDIS_URL, what Vercel's Redis integration provides)
// and REST (KV_REST_API_URL / UPSTASH_*), whichever is configured.

import { createClient } from 'redis';

const REDIS_URL = process.env.REDIS_URL || null;
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;

export function kvAvailable() { return !!(REDIS_URL || (KV_URL && KV_TOKEN)); }

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

let client = null;
let coolOffUntil = 0; // after a failed connect, stop trying for a while
async function tryConnect(url) {
  const c = createClient({ url, socket: { connectTimeout: 2500, reconnectStrategy: false } });
  c.on('error', e => console.error('redis:', e.message));
  await c.connect();
  return c;
}
async function getClient() {
  if (!REDIS_URL) return null;
  if (client && client.isOpen) return client;
  if (Date.now() < coolOffUntil) return null;
  try {
    client = await withTimeout(tryConnect(REDIS_URL), 3000);
    console.log('redis connected');
    return client;
  } catch (e1) {
    console.error('redis connect failed:', e1.message);
    // common cause: database requires TLS — retry once encrypted
    if (REDIS_URL.startsWith('redis://')) {
      try {
        client = await withTimeout(tryConnect(REDIS_URL.replace('redis://', 'rediss://')), 3000);
        console.log('redis connected (tls)');
        return client;
      } catch (e2) { console.error('redis tls connect failed:', e2.message); }
    }
    client = null;
    coolOffUntil = Date.now() + 60000; // give it a minute; serve uncached meanwhile
    return null;
  }
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
    if (c) { const v = await withTimeout(c.get(k), 1500); return v ? JSON.parse(v) : null; }
    if (KV_URL && KV_TOKEN) { const d = await restCmd(['GET', k]); return d && d.result ? JSON.parse(d.result) : null; }
  } catch (e) { console.error('kv get:', e.message); }
  return null;
}
export async function kvSet(k, v, ttlSec) {
  try {
    const c = await getClient();
    if (c) { await withTimeout(c.set(k, JSON.stringify(v), { EX: ttlSec }), 1500); return; }
    if (KV_URL && KV_TOKEN) { await restCmd(['SET', k, JSON.stringify(v), 'EX', String(ttlSec)]); return; }
    console.error('kv set: no storage configured');
  } catch (e) { console.error('kv set:', e.message); }
}
// generic command (HINCRBY, SADD, LPUSH...) for counters and lists
export async function kvCmd(parts) {
  try {
    const c = await getClient();
    if (c) return await withTimeout(c.sendCommand(parts.map(String)), 1500);
    if (KV_URL && KV_TOKEN) { const d = await restCmd(parts.map(String)); return d ? d.result : null; }
  } catch (e) { console.error('kv cmd:', e.message); }
  return null;
}

export async function kvDel(k) {
  try {
    const c = await getClient();
    if (c) { await withTimeout(c.del(k), 1500); return; }
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
