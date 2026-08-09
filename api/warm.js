// api/warm.js — called on a schedule (see vercel.json) to pre-run the
// default search for each area in _areas.js, filling the shared cache so
// real users get instant results.

import { WARM_AREAS } from './_areas.js';
import { bump, recErr } from './_stats.js';

export const maxDuration = 300;

export default async function handler(req, res) {
  // If a CRON_SECRET env var is set, require it (Vercel sends it automatically)
  const auth = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const day = (req.query && req.query.day) === 'tomorrow' ? 'tomorrow' : 'today';
  // call back via the PUBLIC domain — Vercel's internal deployment URLs
  // are auth-protected and 401 any self-fetch
  const base = process.env.PUBLIC_BASE_URL || 'https://www.whydontwe.uk';

  // sequential, so parallel deep searches can't rate-limit each other
  const results = [];
  for (const a of WARM_AREAS.slice(0, 6)) {
    try {
      const r = await fetch(`${base}/api/find`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loc: a.loc, cost: 'either', dist: '10', setting: 'either', day })
      });
      const d = await r.json();
      results.push({ loc: a.loc, ok: !d.error, results: (d.items || []).length, wasCached: !!d.cached, err: d.error || undefined });
    } catch (e) {
      results.push({ loc: a.loc, ok: false, err: e.message });
    }
  }
  console.log(`warm run (${day}):`, JSON.stringify(results));
  bump('warm_runs');
  results.filter(r => !r.ok).forEach(r => recErr(`warm failed: ${r.loc} (${r.err || 'no results'})`));
  return res.status(200).json({ day, results });
}
