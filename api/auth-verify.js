// api/auth-verify.js — user submits the emailed code; we mint a session.

import { kvGet, kvSet, kvDel } from './_kv.js';
import crypto from 'node:crypto';
import { bump, seenUser } from './_stats.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  const code = String((req.body || {}).code || '').trim();

  const rec = await kvGet(`authcode|${email}`);
  if (!rec) return res.status(400).json({ error: 'Code expired \u2014 request a new one' });
  if (rec.attempts >= 5) {
    await kvDel(`authcode|${email}`);
    return res.status(429).json({ error: 'Too many attempts \u2014 request a new code' });
  }
  if (rec.code !== code) {
    await kvSet(`authcode|${email}`, { ...rec, attempts: (rec.attempts || 0) + 1 }, 600);
    return res.status(400).json({ error: 'That code isn\u2019t right \u2014 check and try again' });
  }

  await kvDel(`authcode|${email}`);
  const token = crypto.randomBytes(24).toString('hex');
  const uid = crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
  await kvSet(`session|${token}`, { email, uid }, 90 * 24 * 3600); // 90 days
  console.log(JSON.stringify({ event: 'signed_in', uid }));
  bump('signins'); seenUser(uid);
  return res.status(200).json({ token, email });
}
