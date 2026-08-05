# Why Don't We? — Deployment Guide

Spin the wheels, find brilliant things to do with the kids today — near you, right now.

## What's in this folder

- `index.html` — the entire front end (responsive: phones and desktop)
- `api/find.js` — the search engine: AI web search + page reading, map-database venue sweep, geography lookup, caching, feedback logging
- `api/_venues.js` — optional: your hand-picked venue boosts (works fine empty)
- `api/_sources.js` — optional: known local what's-on pages (works fine empty)
- `package.json` — tells Vercel the code uses modern JavaScript

## Deploy in 5 steps (~40 minutes, browser only, no command line)

### 1. Anthropic API key (~10 min)
- Sign up at https://console.anthropic.com and add ~£5 of credit
- Create a key under **API Keys** and copy it somewhere safe
- Set a monthly spend cap under **Settings → Limits** (£20 is sensible while testing)

### 2. GitHub (~10 min)
- Create a free account at https://github.com → **New repository** → name it `why-dont-we` → Create
- Click **"uploading an existing file"** and drag in the UNZIPPED contents of this folder
- IMPORTANT: keep the folder structure — the three `.js` files must sit inside a folder called `api`
  (dragging the whole `api` folder in preserves this)
- Click **Commit changes**

### 3. Vercel (~10 min)
- Sign up at https://vercel.com **using your GitHub account**
- **Add New → Project** → Import your `why-dont-we` repo → leave all settings on defaults
- BEFORE clicking Deploy: expand **Environment Variables** and add
  - Name: `ANTHROPIC_API_KEY`
  - Value: (paste your key)
- Click **Deploy**. ~30 seconds later you get a live URL like `why-dont-we.vercel.app`
- (Forgot the key? Add it under Project → Settings → Environment Variables, then Deployments → ⋯ → Redeploy)

### 4. Test (~5 min)
- Open the vercel.app URL on your phone: run a search, thumbs-down something,
  report something with the ⊘ button, favourite something, refresh — the favourite should survive
- Check the engine: **Vercel → your project → Logs**, run a search, look for a line like
  `engine v6 | geo: Adur 50.83,-0.37 | sweep: 34 venues within 10mi of WORTHING`
  - `sweep: 20+` = the map layer is working
  - `sweep: 0` or `geo: FAILED` = paste the line into the chat with Claude

### 5. Your domain (123 Reg) (~15 min + propagation)
- Vercel → Project → **Settings → Domains** → add your domain
  (choose the bare domain as primary; let Vercel redirect www)
- Vercel shows you the DNS records. In 123 Reg: **Control Panel → your domain → Manage DNS**
  - EDIT the existing A record on `@` to Vercel's IP (don't add a duplicate)
  - Add/edit the CNAME on `www` → `cname.vercel-dns.com`
  - Ignore all 123 Reg upsell boxes; leave TTL at default
- Back in Vercel, wait for green ticks (15 min – 1 hour). HTTPS is automatic.

## Costs & guardrails
- A typical deep search costs roughly 15–30p (web search + page reading + tokens);
  repeat searches for the same town/day are cached and much cheaper
- Keep the Anthropic spend cap on until you add rate limiting (recommended before sharing publicly)

## Updating the app
Edit a file on github.com (pencil icon → paste → Commit) and Vercel redeploys automatically in ~30 seconds. Usually only `index.html` and `api/find.js` change.

## Feedback data
Vercel → Logs collects every thumbs-down (`thumbs_down`) and every report
(`reported` with reason: `inappropriate` / `dead_link` / `not_on`) — your free QA stream.
