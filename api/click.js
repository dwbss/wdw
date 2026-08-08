// api/click.js — records which "Details & booking" links get clicked.
// A click is the strongest preference signal a family gives; this banks it
// in the logs alongside thumbs, reports and favourites for later learning.

import { getSession } from './_kv.js';
import { bump, seenUser } from './_stats.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const b = req.body || {};
  const session = await getSession(req).catch(() => null);
  bump('booking_clicks');
  if (session) seenUser(session.uid);
  console.log(JSON.stringify({
    event: 'booking_click',
    uid: session ? session.uid : null,
    name: String(b.name || '').slice(0, 120),
    url: String(b.url || '').slice(0, 300),
    category: String(b.category || '').slice(0, 40),
    gem: !!b.gem,
    loc: String(b.loc || '').slice(0, 80),
    day: b.day === 'tomorrow' ? 'tomorrow' : 'today',
    at: new Date().toISOString()
  }));
  return res.status(204).end();
}
