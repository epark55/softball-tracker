// TEST ONLY: the hands-off weekly setup, without the Thursday task.
// Runs discovery (at most every 6 hours), saves what it found to docs/test/next.json for the test page,
// and when the found tournament is within 6 days, makes it the test page's tournament
// (test/state/tournament.json). The workflow then runs a private copy of the score updater on that file.
// Live files (tournament.json, docs/data.json, scripts/) are only read, never written.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { discover, addDays } from "./discover.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const STATE = ROOT + "test/state/tournament.json";
const DIR = ROOT + "test/state/team-directory.json";
const NEXT = ROOT + "docs/test/next.json";
const read = (p, d) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return d; } };
const write = (p, o) => writeFileSync(p, JSON.stringify(o, null, 1) + "\n");
const now = Date.now();
const today = process.env.TODAY || new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

// 1. grow the team directory from every team we've linked by hand or seen in a feed
const dir = read(DIR, {});
const before = JSON.stringify(dir);
for (const t of read(ROOT + "tournament.json", {}).gcTeams || []) if (t.id && t.name) dir[t.id] = t.name;
for (const [id, f] of Object.entries((read(ROOT + "docs/data.json", {}).snap || {}).feeds || {})) if (f && f.name) dir[id] = f.name;
if (JSON.stringify(dir) !== before) write(DIR, dir);

// 2. discovery, at most every 6 hours (FORCE=1 to run now)
const base = read(STATE, null);
if (!base) { console.error("test/state/tournament.json missing"); process.exit(1); }
const prev = read(NEXT, {});
if (process.env.FORCE !== "1" && prev.checkedAt && now - Date.parse(prev.checkedAt) < 6 * 3600000) {
  console.log("Discovery ran", Math.round((now - Date.parse(prev.checkedAt)) / 60000), "min ago; skipping.");
  process.exit(0);
}
const r = await discover({ team: base.follow, today });
const summary = { checkedAt: r.checkedAt, found: r.found, how: r.how || null, team: r.team.name,
  title: r.title || null, location: r.location || null, dateStart: r.dateStart || null, dateEnd: r.dateEnd || null,
  tournamentUrl: r.tournamentUrl || null, field: r.field || [], noGc: r.noGc || [],
  gcWeekend: r.gcWeekend, settings: r.settings || null };
write(NEXT, summary);

// 3. take it over as the test page's tournament once it's within 6 days (the live page does the same from
//    the Thursday task). A field that changes during the week (teams added or dropped) is refreshed too.
if (r.found && r.dateStart <= addDays(today, 6) && r.dateEnd >= addDays(today, -1)) {
  const same = base.title === r.settings.title && base.dateStart === r.settings.dateStart;
  const next = same ? { ...base, tmUrls: r.settings.tmUrls, gcTeams: r.settings.gcTeams, venue: base.venue || r.settings.venue }
                    : r.settings;
  if (JSON.stringify(next) !== JSON.stringify(base)) {
    write(STATE, next);
    console.log(same ? "Refreshed the field for " + next.title : "Test page now set up for " + next.title);
  } else console.log("Test page already set up for " + base.title);
} else console.log("Keeping the test page on " + base.title + (r.found ? "; next one starts " + r.dateStart : ""));
