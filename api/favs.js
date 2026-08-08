// api/favs.js — favourites that follow the signed-in user across devices.

import { getSession, kvGet, kvSet } from './_kv.js';
import { bump, seenUser } from './_stats.js';

export default async function handler(req, res) {
  const session = await getSession(req);
  if (!session) return res.status(401).json({ error: 'not signed in' });
  const key = `favs|${session.uid}`;

  if (req.method === 'GET') {
    const items = (await kvGet(key)) || [];
    return res.status(200).json({ items });
  }
  if (req.method === 'POST') {
    let items = (req.body || {}).items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'bad payload' });
    items = items.slice(0, 100).map(it => ({
      name: String(it.name || '').slice(0, 120),
      category: String(it.category || '').slice(0, 40),
      blurb: String(it.blurb || '').slice(0, 200),
      cost: String(it.cost || '').slice(0, 40),
      setting: String(it.setting || '').slice(0, 20),
      area: String(it.area || '').slice(0, 60),
      url: String(it.url || '').slice(0, 500),
      time: String(it.time || '').slice(0, 40),
      gem: !!it.gem,
      savedLoc: String(it.savedLoc || '').slice(0, 80),
      savedDay: String(it.savedDay || '').slice(0, 20)
    }));
    await kvSet(key, items, 365 * 24 * 3600);
    console.log(JSON.stringify({ event: 'favs_saved', uid: session.uid, count: items.length, at: new Date().toISOString() }));
    bump('favs_saved'); seenUser(session.uid);
    return res.status(200).json({ ok: true, count: items.length });
  }
  return res.status(405).json({ error: 'method not allowed' });
}
