// api/_areas.js — areas pre-warmed automatically so the default search
// (10 miles / Either / Either) is INSTANT for anyone there all day.
//
// Add a line per tester town. Cost per area: roughly 2 deep searches a day
// (one for today, one for tomorrow) ≈ 40–60p/day per area — so keep this
// list to places where testers actually live. Max 6 are warmed per run.

export const WARM_AREAS = [
  { loc: 'Tunbridge Wells' },
  { loc: 'Uckfield' }
];
