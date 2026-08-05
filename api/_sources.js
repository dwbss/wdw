// api/_sources.js — per-area "source packs": the pages where locals actually
// find out what's on. The engine FETCHES and READS these directly on every
// search for a matching area — it doesn't just hope to find them via search.
//
// This is the highest-leverage file in the codebase for hidden gems.
//
// For each area you care about, collect 5–10 URLs:
//   - Council "events" / "what's on" calendar
//   - The town's destination/tourism site
//   - Local newspaper's what's-on or family section
//   - Library events page
//   - Town/community Facebook page (the public page URL — these are readable)
//   - Village hall / community centre programme pages
//   - Local theatre / museum events pages
//
// areas: lowercase towns this pack applies to (matched against user's location)
// urls:  the pages to read. Keep each under 250 characters.
//
// The examples below are starters — verify each loads, then replace/extend
// with your own researched packs per target town.

export const SOURCE_PACKS = [
  {
    areas: ["worthing", "lancing", "shoreham-by-sea", "goring"],
    urls: [
      "https://www.adur-worthing.gov.uk/events/",
      "https://timeforworthing.uk/whats-on/",
      "https://www.visitsoutheastengland.com/whats-on"
    ]
  },
  {
    areas: ["brighton", "hove"],
    urls: [
      "https://www.visitbrighton.com/whats-on",
      "https://www.brighton-hove.gov.uk/events"
    ]
  }
];
