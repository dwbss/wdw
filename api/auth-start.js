// api/auth-start.js — user submits their email; we send a 6-digit code.

import { kvSet, rateLimit } from './_kv.js';
import crypto from 'node:crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  if (!process.env.RESEND_API_KEY) return res.status(500).json({ error: 'Sign-in isn\u2019t set up yet' });

  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) {
    return res.status(400).json({ error: 'That doesn\u2019t look like an email address' });
  }

  // rate limits: 3 codes per email per 10 min, 10 per IP per hour
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown';
  if (!(await rateLimit(`code-email|${email}`, 3, 600)) || !(await rateLimit(`code-ip|${ip}`, 10, 3600))) {
    return res.status(429).json({ error: 'Too many codes requested \u2014 try again in a few minutes' });
  }

  const code = String(crypto.randomInt(100000, 999999));
  await kvSet(`authcode|${email}`, { code, attempts: 0 }, 600); // valid 10 minutes

  const send = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.AUTH_EMAIL_FROM || 'Why Don\u2019t We? <onboarding@resend.dev>',
      to: email,
      subject: `${code} is your Why Don't We? sign-in code`,
      html: `<div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 4px">Why don't we<span style="color:#ff6752">?</span></h2>
        <p style="color:#555">Your sign-in code:</p>
        <p style="font-size:34px;font-weight:800;letter-spacing:6px;margin:8px 0">${code}</p>
        <p style="color:#888;font-size:13px">Valid for 10 minutes. If you didn't request this, ignore this email.</p>
      </div>`
    })
  });
  if (!send.ok) {
    console.error('resend failed:', send.status, await send.text().catch(() => ''));
    return res.status(502).json({ error: 'Couldn\u2019t send the email \u2014 try again' });
  }
  console.log(JSON.stringify({ event: 'auth_code_sent', email_hash: crypto.createHash('sha256').update(email).digest('hex').slice(0, 12) }));
  return res.status(200).json({ ok: true });
}
