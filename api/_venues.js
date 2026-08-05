// api/_venues.js — YOUR curated venue list. This is the file to edit!
//
// Any venue here whose "areas" list matches the user's searched location gets
// handed to the search engine as a trusted lead: it will verify it's open today
// and can rank it above generic web finds.
//
// How to add one:
//   name    — venue name as it appears online
//   areas   — towns/localities it should show up for (lowercase). Be generous:
//             a farm near Worthing might list ["worthing","lancing","shoreham"]
//   setting — "Indoor", "Outdoor", or "Both"
//   cost    — "Free" or a short price hint like "£7 child"
//   url     — the venue's own site (not an aggregator)
//   note    — one line on why it's actually good (this shapes the blurb)
//
// A couple of examples to replace with your own:

export const VENUES = [
  {
    name: "Example Farm Park",
    areas: ["worthing", "lancing", "shoreham-by-sea"],
    setting: "Outdoor",
    cost: "£9 child",
    url: "https://example.com",
    note: "Tractor rides and lamb feeding in spring; café does decent coffee"
  },
  {
    name: "Example Soft Play Centre",
    areas: ["worthing"],
    setting: "Indoor",
    cost: "£6 child",
    url: "https://example.com",
    note: "Big separate toddler zone, quiet before 10am"
  }
];
