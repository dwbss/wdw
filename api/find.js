// api/find.js — Vercel serverless function.
// Holds your Anthropic API key (set ANTHROPIC_API_KEY in Vercel env vars).
// Builds the search prompt server-side so the endpoint can't be abused as an open proxy.

import { VENUES } from './_venues.js';
import { SOURCE_PACKS } from './_sources.js';

// Allow up to 60s — the multi-stage search needs longer than Vercel's 10s default
export const maxDuration = 60;

// Best-effort in-memory cache (survives while the serverless instance is warm).
// Proper cross-instance caching = Vercel KV, later.
const CACHE = new Map();
function cacheGet(k) { const e = CACHE.get(k); if (e && Date.now() < e.exp) return e.v; CACHE.delete(k); return null; }
function cacheSet(k, v, ttl) { if (CACHE.size > 200) CACHE.clear(); CACHE.set(k, { v, exp: Date.now() + ttl }); }

// Resolve any UK postcode or place name to its official geography
// (district council, county, region) via postcodes.io — free, keyless.
// Fails silently: search still works without it, just less precisely.
async function enrichLocation(loc) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2500);
  try {
    const isPostcode = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(loc);
    const url = isPostcode
      ? `https://api.postcodes.io/postcodes/${encodeURIComponent(loc.replace(/\s+/g, ''))}`
      : `https://api.postcodes.io/places?q=${encodeURIComponent(loc)}&limit=1`;
    const r = await fetch(url, { signal: controller.signal });
    const d = await r.json();
    if (isPostcode && d.result) {
      return {
        district: d.result.admin_district || null,
        county: d.result.admin_county || d.result.region || null,
        region: d.result.region || null,
        lat: d.result.latitude ?? null,
        lon: d.result.longitude ?? null
      };
    }
    if (!isPostcode && Array.isArray(d.result) && d.result[0]) {
      const p = d.result[0];
      return {
        district: p.district_borough || null,
        county: p.county_unitary || p.region || null,
        region: p.region || null,
        lat: p.latitude ?? null,
        lon: p.longitude ?? null
      };
    }
  } catch { /* enrichment is optional */ }
  finally { clearTimeout(t); }
  return null;
}

// Call the Claude API, continuing automatically if a long tool-use turn pauses.
// Accumulates text across ALL turns so nothing gathered is ever lost.
async function callClaude(prompt, tools, withFetchBeta) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  };
  if (withFetchBeta) headers['anthropic-beta'] = 'web-fetch-2025-09-10';

  // cache_control: repeated context on continuation turns is re-read at ~10% price
  let messages = [{ role: 'user', content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] }];
  let collected = '';
  let last = null;
  let cost = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3500, messages, tools })
    });
    last = await r.json();
    if (last.error) return { error: last.error };
    collected += (last.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const u = last.usage || {};
    cost.in += u.input_tokens || 0;
    cost.out += u.output_tokens || 0;
    cost.cacheRead += u.cache_read_input_tokens || 0;
    cost.cacheWrite += u.cache_creation_input_tokens || 0;
    console.log(`claude turn ${i}: stop=${last.stop_reason}, text=${collected.length} chars, in=${u.input_tokens||0}, out=${u.output_tokens||0}, cacheRead=${u.cache_read_input_tokens||0}, cacheWrite=${u.cache_creation_input_tokens||0}`);
    if (last.stop_reason === 'pause_turn') {
      messages = [...messages, { role: 'assistant', content: last.content }];
      continue;
    }
    break;
  }
  // rough cost estimate at Sonnet rates ($3/M in, $15/M out, $0.30/M cache read, $3.75/M cache write)
  const usd = (cost.in * 3 + cost.out * 15 + cost.cacheRead * 0.3 + cost.cacheWrite * 3.75) / 1e6;
  console.log(`search cost ~$${usd.toFixed(3)} (tokens in=${cost.in} out=${cost.out} cached=${cost.cacheRead})`);
  return { text: collected, stop_reason: last ? last.stop_reason : 'unknown' };
}

// Sweep the selected radius for family venues via OpenStreetMap's Overpass API
// (free, keyless, UK-wide). Returns compact candidates for the engine to verify.
const VENUE_TAGS = {
  leisure: 'sports_centre|water_park|swimming_pool|miniature_golf|trampoline_park|ice_rink|bowling_alley|indoor_play|escape_game|amusement_arcade|horse_riding',
  tourism: 'theme_park|zoo|aquarium|attraction|museum',
  sport: 'karting|climbing|laser_tag'
};
const TYPE_LABELS = {
  sports_centre: 'sports/leisure centre', water_park: 'water park', swimming_pool: 'swimming pool',
  miniature_golf: 'mini golf', trampoline_park: 'trampoline park', ice_rink: 'ice rink',
  bowling_alley: 'bowling', indoor_play: 'soft play', escape_game: 'escape room',
  amusement_arcade: 'arcade', horse_riding: 'horse riding', theme_park: 'theme park',
  zoo: 'zoo/animal park', aquarium: 'aquarium', attraction: 'attraction', museum: 'museum',
  karting: 'go-karting', climbing: 'climbing', laser_tag: 'laser tag'
};
function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.8, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
async function sweepVenues(lat, lon, miles) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const m = Math.round(miles * 1609.34);
    const q = `[out:json][timeout:8];(
nwr(around:${m},${lat},${lon})["leisure"~"${VENUE_TAGS.leisure}"]["name"];
nwr(around:${m},${lat},${lon})["tourism"~"${VENUE_TAGS.tourism}"]["name"];
nwr(around:${m},${lat},${lon})["sport"~"${VENUE_TAGS.sport}"]["name"];
);out center tags 120;`;
    // try the main Overpass server, then a mirror if it's busy
    let d = null;
    for (const endpoint of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(q),
          signal: controller.signal
        });
        if (r.ok) { d = await r.json(); break; }
        console.error('overpass non-ok:', endpoint, r.status);
      } catch (e) {
        console.error('overpass failed:', endpoint, e.message);
      }
    }
    if (!d) return [];
    const seen = new Set();
    const out = [];
    for (const el of (d.elements || [])) {
      const tags = el.tags || {};
      const name = tags.name;
      if (!name || seen.has(name.toLowerCase())) continue;
      if ((tags.access || '') === 'private') continue;
      seen.add(name.toLowerCase());
      const typeKey = [tags.leisure, tags.tourism, tags.sport].find(v => v && TYPE_LABELS[v]);
      const vLat = el.lat ?? el.center?.lat, vLon = el.lon ?? el.center?.lon;
      const dist = (vLat != null && vLon != null) ? milesBetween(lat, lon, vLat, vLon) : null;
      out.push({
        name: name.slice(0, 70),
        type: TYPE_LABELS[typeKey] || 'venue',
        miles: dist != null ? Math.round(dist * 10) / 10 : null
      });
    }
    out.sort((a, b) => (a.miles ?? 99) - (b.miles ?? 99));
    return out.slice(0, 40);
  } catch (e) { console.error('sweep error:', e.message); return []; }
  finally { clearTimeout(t); }
}

// Extract the results array from engine output, salvaging complete entries
// from a truncated response rather than failing outright.
function parseItems(raw) {
  const text = (raw || '').replace(/```json|```/gi, '');
  const start = text.indexOf('[');
  if (start === -1) return null;
  const end = text.lastIndexOf(']');
  if (end > start) {
    try { const a = JSON.parse(text.slice(start, end + 1)); if (Array.isArray(a)) return a; } catch {}
  }
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace > start) {
    try { const a = JSON.parse(text.slice(start, lastBrace + 1) + ']'); if (Array.isArray(a)) return a; } catch {}
  }
  return null;
}

// What "special" looks like in each month in the UK — hunted proactively.
const SEASONAL = {
  1: 'winter light trails, last pantomimes, indoor craft workshops, wetland bird-watching events',
  2: 'half-term workshops and trails, snowdrop walks, pancake day events',
  3: 'lambing open days, spring nature trails, Mother\u2019s Day family events, science week activities',
  4: 'Easter egg hunts and trails, bluebell walks, lambing days, spring fairs',
  5: 'May fairs and maypole events, food festivals, half-term trails, open gardens',
  6: 'village fetes, Open Farm Sunday, Father\u2019s Day events, school summer fairs, carnival season starts',
  7: 'school and church summer fairs, town carnivals, open-air theatre and cinema, agricultural shows, beach and pier events, pick-your-own fruit',
  8: 'steam rallies, county and agricultural shows, carnivals and regattas, outdoor cinema, PYO fruit, castle summer events',
  9: 'Heritage Open Days (free entry to normally-closed buildings), harvest festivals, food and cider fairs',
  10: 'pumpkin patches, Halloween trails, apple day events, half-term workshops, conker festivals',
  11: 'bonfire and fireworks displays, Christmas light switch-ons, winter craft fairs',
  12: 'Santa trains and grottos, Christmas light trails, pantomimes, carol events, winter markets'
};

// Venue-category vocabulary — teaches the search engine what "indoor" and
// "outdoor" actually mean for a family, so it runs category-specific searches
// instead of one generic one.
const INDOOR_VOCAB = 'soft play, trampoline park, climbing centre, swimming pool / leisure centre, museum, aquarium, cinema kids\' club, bowling, ice rink, laser tag, pottery painting café, library event, indoor karting, escape room (older kids), theatre matinee';
const OUTDOOR_VOCAB = 'open farm / farm park, splash park / paddling pool, adventure playground, country park, castle or heritage site, woodland trail / Gruffalo trail, beach activity, miniature railway, pick-your-own fruit farm, National Trust / English Heritage site, wildlife reserve, bike pump track, crazy golf, boating lake';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing its API key' });
  }

  const { loc, cost, dist, setting, depth = 0, excluded = [], count = 7, dismissed = null, reported = null, reason = null, day = 'today', mode = null } = req.body || {};
  const safeReason = ['inappropriate', 'dead_link', 'not_on'].includes(reason) ? reason : null;
  const safeDay = day === 'tomorrow' ? 'tomorrow' : 'today';
  const dayWord = safeDay === 'tomorrow' ? 'TOMORROW' : 'TODAY';
  const targetDate = new Date(Date.now() + (safeDay === 'tomorrow' ? 86400000 : 0));

  // --- validate inputs (only accept known values; loc is free text but capped) ---
  const COSTS = { free: 'free things only', paid: 'paid activities are fine', either: 'free or paid' };
  const DISTS = { '5': 'within 5 miles', '10': 'within 10 miles', '25': 'within 25 miles' };
  const SETTINGS = { indoor: 'indoor', outdoor: 'outdoor', either: 'indoor or outdoor' };

  if (typeof loc !== 'string' || !loc.trim() || loc.length > 80) {
    return res.status(400).json({ error: 'Please provide a location' });
  }
  if (!COSTS[cost] || !DISTS[dist] || !SETTINGS[setting]) {
    return res.status(400).json({ error: 'Invalid criteria' });
  }
  const safeExcluded = Array.isArray(excluded)
    ? excluded.slice(0, 30).map(s => String(s).slice(0, 100))
    : [];
  const safeDepth = Math.min(Math.max(parseInt(depth, 10) || 0, 0), 6);
  const safeLoc = loc.trim();
  const n = Math.min(Math.max(parseInt(count, 10) || 7, 1), 7);

  // Feedback loop v1: every dismissal lands in the Vercel function logs.
  // (Project → Logs). Upgrade path: write to Vercel KV / a spreadsheet later.
  if (dismissed && typeof dismissed === 'string') {
    console.log(JSON.stringify({
      event: 'thumbs_down',
      name: dismissed.slice(0, 120),
      loc: safeLoc, cost, dist, setting,
      at: new Date().toISOString()
    }));
  }
  // Data-quality report with reason: inappropriate / dead_link / not_on.
  if (reported && typeof reported === 'string') {
    console.log(JSON.stringify({
      event: 'reported',
      reason: safeReason || 'unspecified',
      name: reported.slice(0, 120),
      loc: safeLoc, cost, dist, setting,
      at: new Date().toISOString()
    }));
  }

  const today = targetDate.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London'
  });

  // QUICK MODE: instant map-sweep venues while the full search runs
  if (mode === 'quick') {
    const qKey = `quick|${safeLoc.toLowerCase()}|${dist}`;
    const cached = cacheGet(qKey);
    if (cached) return res.status(200).json({ venues: cached });
    const qGeo = await enrichLocation(safeLoc);
    const qSwept = (qGeo && qGeo.lat != null)
      ? await sweepVenues(qGeo.lat, qGeo.lon, parseInt(dist, 10))
      : [];
    const venues = qSwept.slice(0, 12);
    cacheSet(qKey, venues, 12 * 3600 * 1000);
    return res.status(200).json({ venues });
  }

  // best-effort full-result cache (first batch only, per location/criteria/day)
  const isCacheable = count === 7 && (!excluded || excluded.length === 0) && !dismissed && !reported;
  const fullKey = `full|${safeLoc.toLowerCase()}|${cost}|${dist}|${setting}|${safeDay}|${targetDate.toDateString()}`;
  if (isCacheable) {
    const hit = cacheGet(fullKey);
    if (hit) return res.status(200).json({ items: hit, cached: true });
  }

  const REASON_LINES = {
    inappropriate: `The user reported "${reported}" as NOT APPROPRIATE for families. Return ONE replacement that is unmistakably family-friendly for ages 3-12 — double-check its nature before including it. Prefer a different type of activity from those already shown.`,
    dead_link: `The user reported the link for "${reported}" as BROKEN. FIRST, search for the correct official page for that same venue or event; if you can verify it is real and available on the target day, return IT with the corrected working URL. Only if you cannot verify it, return ONE different, rigorously verified option.`,
    not_on: `The user reported "${reported}" as NO LONGER ON or no longer existing. Return ONE replacement you have rigorously verified is genuinely happening or open on the target day — open its page and confirm the date. Prefer a different type of activity from those already shown.`
  };
  const gemHunt = n === 1
    ? `${(safeReason && reported && REASON_LINES[safeReason]) || 'The user rejected an option and wants ONE strong replacement. Prefer a different type of activity from those already shown.'} A small local one-off found on a council, parish, village hall or community page is ideal ("gem": true) but a great venue is fine too.`
    : safeDepth === 0
    ? `Run several web searches, not one. Use the vocabulary these events actually use: search "[locality] fete", "fair", "fun day", "open farm", "craft fair", "carnival", "family event" with the target date, plus general venue searches. At least 2 of the 7 results must be hidden gems: a small, one-off, low-publicity local event found on a council, parish, village hall, local newspaper or community page — not a big aggregator. Mark it "gem": true.`
    : `The user has seen the obvious options. Dig DEEPER now. Search local council event calendars, parish and village hall pages, local newspaper what's-on listings, community and church pages, indexed Facebook event pages. Use search terms like fete, gala, fun day, steam rally, agricultural show, open farm, craft fair, carnival, library event + the locality and the target date. Prefer small, one-off, low-publicity events over chains and big venues. At least 4 of the 7 must be hidden gems ("gem": true).`;

  // Setting-specific venue-category searches
  let vocabLine = '';
  if (setting === 'indoor') {
    vocabLine = `For venues, search these INDOOR categories near ${safeLoc}: ${INDOOR_VOCAB}. Cover at least 3 different categories across the results.`;
  } else if (setting === 'outdoor') {
    vocabLine = `For venues, search these OUTDOOR categories near ${safeLoc}: ${OUTDOOR_VOCAB}. Cover at least 3 different categories across the results.`;
  } else {
    vocabLine = `For venues, draw on these categories near ${safeLoc} — indoor: ${INDOOR_VOCAB}; outdoor: ${OUTDOOR_VOCAB}. Mix categories; don't return five of the same type.`;
  }

  // Curated local seeds: venues the app's editors vouch for near this location
  const locLower = safeLoc.toLowerCase();
  const seeds = VENUES.filter(v =>
    Array.isArray(v.areas) && v.areas.some(a => locLower.includes(a) || a.includes(locLower))
  ).slice(0, 8);
  const seedLine = seeds.length
    ? `Editor-curated local venues — verify each is open on the target day and, if so, favour it over generic web finds: ${seeds.map(v => `${v.name} (${v.setting}, ${v.cost}, ${v.url} — ${v.note})`).join(' | ')}.`
    : '';

  // Manually curated source packs are now an optional bonus, not a requirement
  const packUrls = SOURCE_PACKS
    .filter(p => Array.isArray(p.areas) && p.areas.some(a => locLower.includes(a) || a.includes(locLower)))
    .flatMap(p => p.urls)
    .slice(0, 6);
  const packLine = packUrls.length
    ? `Known local listing pages to include in your reading: ${packUrls.join(' , ')} .`
    : '';

  // Automatic geography enrichment — works for any UK postcode or place name
  const geo = await enrichLocation(safeLoc);
  const geoLine = geo && (geo.district || geo.county)
    ? `Official geography: ${safeLoc} falls under ${[geo.district && `${geo.district} council`, geo.county, geo.region].filter(Boolean).join(', ')}. Use these exact names in your discovery searches.`
    : '';

  // Radius sweep: every mapped family venue inside the selected distance
  const radiusMiles = parseInt(dist, 10);
  const swept = (geo && geo.lat != null)
    ? await sweepVenues(geo.lat, geo.lon, radiusMiles)
    : [];
  console.log(`engine v6 | geo: ${geo ? `${geo.district||'?'} ${geo.lat},${geo.lon}` : 'FAILED'} | sweep: ${swept.length} venues within ${radiusMiles}mi of ${safeLoc}`);
  const sweepLine = swept.length
    ? `MAPPED VENUES inside the ${radiusMiles}-mile radius (from the map database — real places, but verify names/opening before recommending): ${swept.map(v => `${v.name} (${v.type}${v.miles != null ? `, ${v.miles}mi` : ''})`).join('; ')}.`
    : '';
  const blendLine = `Aim for a MIX in the final 7: roughly half brilliant VENUES open ${dayWord} (farm parks, water slides, karting, soft play, swimming, trampoline parks — use the mapped venues list plus your searches) and half EVENTS on ${dayWord}. Variety of activity types across the 7 is essential.`;

  // Self-assembling source map: discover, then read, then hunt.
  // This is the UK-wide playbook — the same source TYPES exist everywhere,
  // even though the URLs differ in every town.
  const discoveryLine = `Work in three stages.
STAGE 1 — DISCOVER this area's information map with quick searches (the same source types exist everywhere in the UK): the district/borough council events calendar${geo?.district ? ` (search "${geo.district} events")` : ''}; the town or parish council site; the destination site (search "visit ${safeLoc}" / "${safeLoc} what's on"); the local newspaper's what's-on section (search "${safeLoc} what's on this weekend" — local titles end in Herald, Observer, Argus, Echo, Gazette, Courier, Advertiser, or appear on InYourArea and SussexWorld-style county sites); the library service events page; "things to do with kids ${safeLoc} today" round-up articles.
STAGE 2 — READ: use web_fetch to open the 2-3 most promising listing pages found in stage 1 and extract everything happening ${dayWord} that fits the criteria. This is where hidden gems live — small events appear on these pages and nowhere else.
STAGE 3 — HUNT the gaps with targeted searches using event vocabulary and this month's seasonal specials.`;

  // Seasonal intelligence: what "special" looks like this month
  const month = parseInt(new Intl.DateTimeFormat('en-GB', { month: 'numeric', timeZone: 'Europe/London' }).format(targetDate), 10);
  const seasonLine = `It is ${today.split(' ').slice(-2).join(' ')}. Seasonal specials to actively hunt for this month: ${SEASONAL[month]}.`;

  const excludedLine = safeExcluded.length
    ? `Do NOT include any of these (already shown): ${safeExcluded.join('; ')}.`
    : '';

  const prompt = `You are the results engine for "Why Don't We?", a same-day family day-out finder.
The search is for ${dayWord}, ${today}. Location: ${safeLoc}, UK. Find things a family with kids aged 3 to 12 can actually do on that day.
Criteria: ${COSTS[cost]}; ${DISTS[dist]} of ${safeLoc}; ${SETTINGS[setting]} preferred.
${geoLine}
${sweepLine}
${blendLine}
${discoveryLine}
${packLine}
${seasonLine}
${vocabLine}
${seedLine}
${gemHunt}
${excludedLine}
URL RULE: every "url" must be the specific detail page for that exact item — the page a parent lands on and immediately sees THIS event or venue's details, times and booking. Copy it VERBATIM from your search or fetch results; never construct or guess a URL from memory. NEVER a homepage, never a generic what's-on or events listing page. If you only saw the item on a listing page, run one more search for its dedicated page; only if none exists may you use the most specific page that names it.
HARD RULE: no two options may share the same category — one swimming pool, one bowling alley, one farm park etc. per list, never two.
Respond with ONLY a raw JSON array (no markdown, no commentary) of the ${n === 1 ? 1 : n + 2} best options, ranked best first, each a DIFFERENT category. Each object has exactly these keys:
"name" (string), "category" (2-3 word activity type, e.g. "swimming pool", "bowling", "farm park", "fete", "museum"), "blurb" (string, max 18 words, why it's great today), "cost" ("Free" or short price like "£8 adult"), "setting" ("Indoor"|"Outdoor"|"Both"), "area" (short place name), "url" (see URL RULE above), "time" (short like "10:00–16:00"), "gem" (true if a small one-off low-publicity local find, else false).
Keep it compact. Only include options genuinely available ${dayWord}.`;

  try {
    const searchTool = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: n === 1 ? 3 : 5,
      user_location: { type: 'approximate', country: 'GB', timezone: 'Europe/London' }
    };
    const fetchTool = {
      type: 'web_fetch_20250910',
      name: 'web_fetch',
      max_uses: n === 1 ? 1 : 2,
      max_content_tokens: 6000
    };

    let data = await callClaude(prompt, [searchTool, fetchTool], true);
    if (data.error) {
      // If the fetch tool is ever rejected (beta changes etc.), degrade
      // gracefully to search-only rather than failing the user.
      console.error('claude error (search+fetch):', JSON.stringify(data.error));
      data = await callClaude(prompt, [searchTool], false);
    }
    if (data.error) {
      console.error('claude error (search-only):', JSON.stringify(data.error));
      return res.status(502).json({ error: data.error.message || 'Search service error' });
    }
    if (data.stop_reason === 'max_tokens') {
      console.error('response truncated at max_tokens');
    }

    const text = data.text || '';

    let items = parseItems(text);
    if (!items || items.length === 0) {
      console.error('parse: no usable JSON. stop_reason=', data.stop_reason, '| tail:', text.slice(-300));
      return res.status(502).json({ error: 'No results came back — try again' });
    }

    // enforce one-per-category within the batch (belt to the prompt's braces)
    const seenCat = new Set();
    items = items.filter(it => {
      const c = String(it.category || '').toLowerCase().trim() || String(it.name || '').toLowerCase();
      if (!c || seenCat.has(c)) return false;
      seenCat.add(c);
      return true;
    });

    // sanitise before returning
    const clean = items.slice(0, n).map(it => ({
      name: String(it.name || '').slice(0, 120),
      category: String(it.category || '').slice(0, 40),
      blurb: String(it.blurb || '').slice(0, 200),
      cost: String(it.cost || '').slice(0, 40),
      setting: String(it.setting || '').slice(0, 20),
      area: String(it.area || '').slice(0, 60),
      url: String(it.url || '').slice(0, 500),
      time: String(it.time || '').slice(0, 40),
      gem: Boolean(it.gem)
    }));

    if (isCacheable && clean.length) cacheSet(fullKey, clean, 2 * 3600 * 1000);
    return res.status(200).json({ items: clean });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong — try again' });
  }
}
