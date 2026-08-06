// api/warm.js — called on a schedule (see vercel.json) to pre-run the
// default search for each area in _areas.js, filling the shared cache so
// real users get instant results.

import { WARM_AREAS } from './_areas.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  // If a CRON_SECRET env var is set, require it (Vercel sends it automatically)
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const day = (req.query && req.query.day) === 'tomorrow' ? 'tomorrow' : 'today';
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  if (!base) return res.status(500).json({ error: 'no base url' });

  const jobs = WARM_AREAS.slice(0, 6).map(a =>
    fetch(`${base}/api/find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ loc: a.loc, cost: 'either', dist: '10', setting: 'either', day })
    })
      .then(r => r.json())
      .then(d => ({ loc: a.loc, ok: !d.error, results: (d.items || []).length, wasCached: !!d.cached }))
      .catch(e => ({ loc: a.loc, ok: false, err: e.message }))
  );

  const results = await Promise.all(jobs);
  console.log(`warm run (${day}):`, JSON.stringify(results));
  return res.status(200).json({ day, results });
}
