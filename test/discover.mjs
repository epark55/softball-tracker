// TEST ONLY: finds a weekend's tournament field with no hand setup. The live updater doesn't use it.
//   1. Read our team's public GameChanger schedule and find the weekend (game days, opponents).
//   2. Search Tourney Machine for softball events that start or end on those days.
//   3. Open each candidate's divisions and look for our team (and our GC opponents) in the team lists.
//   4. The best match gives the title, dates, venue, division links and the field.
//   5. Match field teams to GameChanger ids we already know (tournament.json + test/team-directory.json).
// Usage:
//   TEAM=9OmIn3ns4vv7 [WEEKEND=2026-10-30] node test/discover.mjs
// Writes test/out/discover-<team>-<date>.json and prints a report.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TL = require("../docs/logic.js");
const ROOT = new URL("..", import.meta.url).pathname;
const GC = "https://api.team-manager.gc.com/public/teams/";
const TMAPI = "https://api.tourneymachine.com/v2/Tournaments/Search";
const TMWEB = "https://tourneymachine.com/Public/Results/";
const UA = "Mozilla/5.0 (compatible; softball-tracker; +https://github.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

async function get(url, kind) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: kind === "json" ? "application/json" : "text/html" },
                                     signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return kind === "json" ? await res.json() : await res.text();
    } catch (e) {
      if (attempt === 3) throw new Error(url + " -> " + e.message);
      await sleep(2000 * attempt);
    }
  }
}
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const tmDate = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return `${m}-${d}-${y}`; };   // TM tags events "11-1-2026"
const dec = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
const parseTMHtml = (await import("../scripts/update.mjs")).parseTMHtml;

/* ---------- 1. our weekend ---------- */
const TEAM = process.env.TEAM || "9OmIn3ns4vv7";
const today = process.env.TODAY || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const team = await get(GC + TEAM, "json");
const games = (await get(GC + TEAM + "/games", "json")).filter((g) => g.start_ts && g.opponent_team && g.opponent_team.name);
const days = [...new Set(games.map((g) => TL.localDate(g.start_ts)))].sort();
const clusters = [];
for (const d of days) { const c = clusters.at(-1); if (c && d <= addDays(c.end, 2)) c.end = d; else clusters.push({ start: d, end: d }); }
const want = process.env.WEEKEND || today;
const wk = clusters.find((c) => c.start <= want && want <= c.end) || clusters.find((c) => c.start >= want);
if (!wk) { log(`No upcoming games on ${team.name}'s GameChanger schedule.`); process.exit(0); }
const wkGames = games.filter((g) => { const d = TL.localDate(g.start_ts); return d >= wk.start && d <= wk.end; });
const opponents = [...new Set(wkGames.map((g) => g.opponent_team.name))];
log(`Team: ${team.name}\nWeekend on GameChanger: ${wk.start} to ${wk.end}, ${wkGames.length} games`);
log(`Opponents listed: ${opponents.join(", ") || "(none yet)"}`);

/* ---------- 2. candidate events ---------- */
const searchDays = [];
for (let d = addDays(wk.start, -1); d <= addDays(wk.end, 1); d = addDays(d, 1)) searchDays.push(d);
const cands = new Map();
for (const d of searchDays) {
  const r = await get(`${TMAPI}?per_page=100&query=${encodeURIComponent("Softball " + tmDate(d))}`, "json");
  for (const x of r.result || []) {
    const id = /IDTournament=([^&]+)/.exec(x.link || "");
    if (!id) continue;
    // the event must actually cover one of our game days (keywords hold its first and last day)
    const ds = [...(x.keywords || "").matchAll(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/g)]
      .map((m) => `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`).sort();
    if (!ds.length || ds.at(-1) < wk.start || ds[0] > wk.end) continue;
    cands.set(id[1], { id: id[1], title: x.title, date: x.date, location: x.location, from: ds[0], to: ds.at(-1) });
  }
  await sleep(400);
}
log(`Tourney Machine softball events overlapping those days: ${cands.size}`);

/* Look nearest-first: events in states where our opponents' names or our past venues suggest we play.
   Simple rule for the test: rank by how many of our game days the event covers, then check up to MAX. */
const MAX = +(process.env.MAX || 60);
const list = [...cands.values()].sort((a, b) => (a.location.length - b.location.length));

/* ---------- 3. open divisions, look for our team ---------- */
const nameHit = (a, b) => TL.similar(a, b);
async function divisions(tid) {
  const h = await get(`${TMWEB}Tournament.aspx?IDTournament=${tid}`, "html");
  const out = [], seen = new Set();
  for (const m of h.matchAll(/href="(Division\.aspx\?IDTournament=[^"&]+&(?:amp;)?IDDivision=([^"&]+))"[^>]*>([\s\S]*?)<\/a>/g)) {
    if (seen.has(m[2])) continue; seen.add(m[2]);
    out.push({ id: m[2], url: TMWEB + dec(m[1]), name: dec(m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")) });
  }
  const venue = /Location[\s\S]{0,300}?<[^>]*>([^<]{3,120})</i.exec(h);
  return { divs: out, venue: venue ? dec(venue[1]) : null };
}
const found = [];
let checked = 0;
for (const c of list) {
  if (checked >= MAX) break;
  checked++;
  try {
    const { divs } = await divisions(c.id);
    c.divisions = [];
    for (const d of divs) {
      const p = parseTMHtml(await get(d.url, "html"));
      const us = p.teams.filter((t) => nameHit(t, team.name));
      const opp = p.teams.filter((t) => opponents.some((o) => nameHit(t, o)));
      c.divisions.push({ ...d, teams: p.teams, status: p.status, games: p.games.length, us, opp });
      await sleep(350);
    }
    c.us = c.divisions.some((d) => d.us.length);
    c.oppHits = new Set(c.divisions.flatMap((d) => d.opp)).size;
    c.score = (c.us ? 100 : 0) + c.oppHits;
    if (c.score) { found.push(c); log(`  match: ${c.title} (${c.location}) us=${c.us} opponents=${c.oppHits}`); }
  } catch (e) { log(`  skipped ${c.title}: ${e.message}`); }
  await sleep(400);
}
log(`Checked ${checked} events.`);
found.sort((a, b) => b.score - a.score);
const best = found[0];

/* ---------- 4/5. field + GameChanger ids ---------- */
const dir = {};
const addDir = (id, name) => { if (id && name) dir[id] = name; };
try { for (const t of JSON.parse(readFileSync(ROOT + "tournament.json", "utf8")).gcTeams || []) addDir(t.id, t.name); } catch {}
try { for (const [id, name] of Object.entries(JSON.parse(readFileSync(ROOT + "test/team-directory.json", "utf8")))) addDir(id, name); } catch {}
addDir(TEAM, team.name);

let result = { team: { id: TEAM, name: team.name }, weekend: wk, opponents, checked, candidates: cands.size };
if (!best) {
  log("\nNo Tourney Machine event lists this team or its opponents. The page would follow our team's GameChanger games only.");
} else {
  // keep divisions that hold us or any opponent (that's how 13U and 14U got combined at Ghostbuster)
  const keep = best.divisions.filter((d) => d.us.length || d.opp.length);
  const field = [...new Set(keep.flatMap((d) => d.teams))];
  const gcTeams = [], noGc = [];
  for (const t of field) {
    const hit = Object.entries(dir).find(([, n]) => nameHit(n, t));
    if (hit) gcTeams.push({ id: hit[0], name: hit[1], tm: t }); else noGc.push(t);
  }
  const proposed = {
    title: best.title, venue: best.location, dateStart: best.from, dateEnd: best.to,
    follow: TEAM, tmUrls: keep.map((d) => d.url), gcTeams: gcTeams.map(({ id, name }) => ({ id, name })),
  };
  result = { ...result, best: { title: best.title, location: best.location, date: best.date, divisions: best.divisions.map((d) =>
    ({ name: d.name, url: d.url, status: d.status, games: d.games, teams: d.teams.length, us: d.us, opponents: d.opp })) },
    others: found.slice(1).map((c) => ({ title: c.title, score: c.score })), field, gcMatched: gcTeams, noGc, proposed };
  log(`\nBest match: ${best.title}\n  ${best.date} · ${best.location}`);
  for (const d of best.divisions) log(`  division ${d.name || d.id}: ${d.teams.length} teams, schedule ${d.status}${d.us.length ? " · has us (" + d.us.join(", ") + ")" : ""}${d.opp.length ? " · opponents: " + d.opp.join(", ") : ""}${keep.includes(d) ? "  [kept]" : ""}`);
  log(`Field (${field.length}): ${field.join(" | ")}`);
  log(`GameChanger ids known for ${gcTeams.length}: ${gcTeams.map((g) => g.name).join(", ")}`);
  log(`No GameChanger id yet for ${noGc.length}: ${noGc.join(", ")}`);
}
mkdirSync(ROOT + "test/out", { recursive: true });
const outFile = `${ROOT}test/out/discover-${TEAM}-${wk.start}.json`;
writeFileSync(outFile, JSON.stringify(result, null, 2));
log(`\nSaved ${outFile}`);
