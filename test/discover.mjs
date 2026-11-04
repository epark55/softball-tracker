// TEST ONLY: finds our next tournament and its field with no hand setup. The live updater doesn't use it.
// Two ways to find it, earliest wins:
//   A. GameChanger: our team's public schedule gives the weekend (and opponents once they're named).
//      Search Tourney Machine for softball events on those days; the one listing us (or our opponents) wins.
//   B. Look-ahead: for each weekend between now and then (up to LOOKAHEAD days), search Tourney Machine
//      for nearby softball events and check their team lists for our name. This catches events we're
//      committed to before the coach adds the games to GameChanger.
// Field = teams in the divisions that hold us or our opponents (that's how 13U and 14U combined at Ghostbuster).
// GameChanger ids come from teams we already know (tournament.json + test/state/team-directory.json).
//
// CLI:  TEAM=9OmIn3ns4vv7 [WEEKEND=2026-10-30] [TODAY=2026-11-04] node test/discover.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const TL = require("../docs/logic.js");
const ROOT = new URL("..", import.meta.url).pathname;
const GC = "https://api.team-manager.gc.com/public/teams/";
const TMAPI = "https://api.tourneymachine.com/v2/Tournaments/Search";
const TMWEB = "https://tourneymachine.com/Public/Results/";
const UA = "Mozilla/5.0 (compatible; softball-tracker; +https://github.com)";
const REGION = (process.env.REGION || "PA,WV,OH,MD,NY,NJ,VA,DE").split(",");
const LOOKAHEAD = +(process.env.LOOKAHEAD || 70);   // days
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
export const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (ymd) => new Date(ymd + "T12:00:00Z").getUTCDay();
const tmDate = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return `${m}-${d}-${y}`; };   // TM tags events "11-1-2026"
const dec = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
const inRegion = (loc) => REGION.some((st) => new RegExp(",\\s*" + st + "\\b").test(loc || ""));
let parseTMHtml;

/* Is this Tourney Machine name our team? Stricter than the page's matcher, since we're searching
   every event, not one known field: every distinctive word of the shorter name must be in the longer one
   and the shorter one needs at least two ("Team PA 2032" isn't "Team PA 2030 Kammerdeiner", but
   "Unity 14U Rodgers" is "Unity 14u Rodgers - PA"); a different grad year or age group rules it out. */
const GENERIC = new Set(["team", "the", "softball", "fastpitch", "fp", "club", "travel"]);
const toks = (s) => (s || "").toLowerCase().replace(/&/g, " and ").replace(/(\d+)\s*u\b/g, "$1u").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const years = (s) => toks(s).filter((t) => /^(19|20)\d\d$/.test(t));
const ages = (s) => toks(s).filter((t) => /^\d+u$/.test(t));
const words = (s) => toks(s).filter((t) => !GENERIC.has(t) && !/^\d+u$/.test(t) && !/^(19|20)\d\d$/.test(t));
const clash = (a, b) => a.length && b.length && !a.some((x) => b.includes(x));
export function isTeam(theirs, ours) { return isOpp(theirs, ours); }
function isOpp(a, b) {
  if (clash(years(a), years(b)) || clash(ages(a), ages(b))) return false;
  const [s, l] = words(a).length <= words(b).length ? [words(a), new Set(words(b))] : [words(b), new Set(words(a))];
  return s.length >= 2 && s.every((x) => l.has(x)) || (s.length === 1 && l.size === 1 && l.has(s[0]));
}

/* Tourney Machine search: softball events whose first or last day is `ymd` */
async function searchDay(ymd, cands) {
  const r = await get(`${TMAPI}?per_page=100&query=${encodeURIComponent("Softball " + tmDate(ymd))}`, "json");
  for (const x of r.result || []) {
    const id = /IDTournament=([^&]+)/.exec(x.link || "");
    if (!id || cands.has(id[1])) continue;
    const ds = [...(x.keywords || "").matchAll(/\b(\d{1,2})-(\d{1,2})-(\d{4})\b/g)]
      .map((m) => `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`).sort();
    if (!ds.length) continue;
    cands.set(id[1], { id: id[1], title: x.title, date: x.date, location: x.location || "", from: ds[0], to: ds.at(-1) });
  }
  await sleep(350);
}

/* an event's divisions and their team lists (cached for the run) */
const divCache = new Map();
async function loadDivisions(c) {
  if (divCache.has(c.id)) return divCache.get(c.id);
  const h = await get(`${TMWEB}Tournament.aspx?IDTournament=${c.id}`, "html");
  const out = [], seen = new Set();
  for (const m of h.matchAll(/href="(Division\.aspx\?IDTournament=[^"&]+&(?:amp;)?IDDivision=([^"&]+))"[^>]*>([\s\S]*?)<\/a>/g)) {
    if (seen.has(m[2])) continue; seen.add(m[2]);
    const url = TMWEB + dec(m[1]);
    const p = parseTMHtml(await get(url, "html"));
    out.push({ id: m[2], url, name: dec(m[3].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")), teams: p.teams, status: p.status, games: p.games.length });
    await sleep(300);
  }
  divCache.set(c.id, out);
  await sleep(300);
  return out;
}
async function check(c, ourName, opponents) {
  const divs = await loadDivisions(c);
  c.divisions = divs.map((d) => ({ ...d,
    us: d.teams.filter((t) => isTeam(t, ourName)),
    opp: d.teams.filter((t) => opponents.some((o) => isOpp(t, o))) }));
  c.us = c.divisions.some((d) => d.us.length);
  c.oppHits = new Set(c.divisions.flatMap((d) => d.opp)).size;
  c.score = (c.us ? 100 : 0) + c.oppHits;
  return c;
}

export async function discover({ team: TEAM, weekend, today, quiet }) {
  parseTMHtml = parseTMHtml || (await import("../scripts/update.mjs")).parseTMHtml;
  const say = quiet ? () => {} : log;
  const team = await get(GC + TEAM, "json");
  // game days count even before opponents are named (early schedules often say TBD)
  const games = (await get(GC + TEAM + "/games", "json")).filter((g) => g.start_ts);
  const days = [...new Set(games.map((g) => TL.localDate(g.start_ts)))].sort();
  const clusters = [];
  for (const d of days) { const c = clusters.at(-1); if (c && d <= addDays(c.end, 2)) c.end = d; else clusters.push({ start: d, end: d }); }
  const want = weekend || today;
  // the weekend under way, or the next one (a weekend that ended yesterday still counts as "this one")
  const wk = clusters.find((c) => c.start <= want && addDays(c.end, weekend ? 0 : 1) >= want) || clusters.find((c) => c.start >= want) || null;
  say(`Team: ${team.name}`);
  say(wk ? `GameChanger: next games ${wk.start} to ${wk.end}` : "GameChanger: no upcoming games");

  /* A. the GameChanger weekend */
  let fromGC = null;
  if (wk) {
    const wkGames = games.filter((g) => { const d = TL.localDate(g.start_ts); return d >= wk.start && d <= wk.end; });
    const opponents = [...new Set(wkGames.map((g) => g.opponent_team && g.opponent_team.name).filter((n) => n && !/^(tbd|tba)\b/i.test(n)))];
    say(`  opponents listed: ${opponents.join(", ") || "(none yet)"}`);
    const cands = new Map();
    for (let d = addDays(wk.start, -1); d <= addDays(wk.end, 1); d = addDays(d, 1)) await searchDay(d, cands);
    const list = [...cands.values()].filter((c) => c.to >= wk.start && c.from <= wk.end)
      .sort((a, b) => inRegion(b.location) - inRegion(a.location));          // nearby first
    say(`  Tourney Machine softball events on those days: ${list.length}`);
    const hits = [];
    for (const c of list.slice(0, 60)) {
      try { if ((await check(c, team.name, opponents)).score) hits.push(c); } catch (e) { say(`  skipped ${c.title}: ${e.message}`); }
      if (hits.some((h) => h.us)) break;                                     // found us; good enough
    }
    hits.sort((a, b) => b.score - a.score);
    if (hits[0]) { fromGC = { ...hits[0], how: "gamechanger", opponents }; say(`  match: ${fromGC.title}`); }
    else say("  no Tourney Machine event lists us or our opponents");
  }

  /* B. look ahead for events that list us before GameChanger has the games */
  let ahead = null;
  const stop = wk && wk.start > today ? wk.start : addDays(today, LOOKAHEAD);
  const limit = addDays(today, LOOKAHEAD);
  const end = stop < limit ? stop : limit;
  if (!weekend) {
    const cands = new Map();
    // every Friday, Saturday and Sunday from today until then (TM tags each event with its first and last day)
    for (let d = today; d < end; d = addDays(d, 1)) if ([0, 5, 6].includes(dow(d))) await searchDay(d, cands);
    const list = [...cands.values()].filter((c) => inRegion(c.location) && c.to >= today && c.from < end)
      .sort((a, b) => a.from.localeCompare(b.from));
    say(`Look-ahead to ${end}: ${list.length} nearby softball events`);
    for (const c of list) {
      try { if ((await check(c, team.name, [])).us) { ahead = { ...c, how: "lookahead", opponents: [] }; break; } }
      catch (e) { say(`  skipped ${c.title}: ${e.message}`); }
    }
    say(ahead ? `  we're listed on: ${ahead.title} (${ahead.from})` : "  not listed on any of them");
  }

  const best = [fromGC, ahead].filter(Boolean).sort((a, b) => a.from.localeCompare(b.from))[0] || null;
  const result = { checkedAt: new Date().toISOString(), team: { id: TEAM, name: team.name },
                   gcWeekend: wk, found: !!best };
  if (!best) { say("Result: nothing on Tourney Machine; the page follows our GameChanger games only."); return result; }

  const dir = {};
  const addDir = (id, name) => { if (id && name) dir[id] = name; };
  try { for (const t of JSON.parse(readFileSync(ROOT + "tournament.json", "utf8")).gcTeams || []) addDir(t.id, t.name); } catch {}
  try { for (const [id, name] of Object.entries(JSON.parse(readFileSync(ROOT + "test/state/team-directory.json", "utf8")))) addDir(id, name); } catch {}
  addDir(TEAM, team.name);

  const keep = best.divisions.filter((d) => d.us.length || d.opp.length);
  const field = [...new Set(keep.flatMap((d) => d.teams))];
  const gcTeams = [{ id: TEAM, name: team.name }], noGc = [];
  for (const t of field) {
    if (keep.some((d) => d.us.includes(t))) continue;                         // that's us
    const hit = Object.entries(dir).find(([id, n]) => id !== TEAM && TL.similar(n, t) >= 1 && isOpp(n, t));
    if (hit && !gcTeams.some((g) => g.id === hit[0])) gcTeams.push({ id: hit[0], name: hit[1] }); else if (!hit) noGc.push(t);
  }
  Object.assign(result, {
    how: best.how, title: best.title, location: best.location, date: best.date, dateStart: best.from, dateEnd: best.to,
    tournamentUrl: `${TMWEB}Tournament.aspx?IDTournament=${best.id}`,
    divisions: best.divisions.map((d) => ({ name: d.name, url: d.url, status: d.status, games: d.games, teams: d.teams.length,
                                            us: d.us, opponents: d.opp, kept: keep.includes(d) })),
    field, noGc,
    settings: { title: best.title, venue: best.location, dateStart: best.from, dateEnd: best.to, bracketStart: best.to,
                bracketSize: 0, follow: TEAM, tmUrls: keep.map((d) => d.url), gcTeams,
                excludeTeams: [], ignoreReports: [], seedOrder: [], discovered: true },
  });
  say(`Result: ${best.title} · ${best.date} · ${best.location} (found via ${best.how === "lookahead" ? "Tourney Machine team list" : "GameChanger schedule"})`);
  for (const d of result.divisions) say(`  ${d.kept ? "kept   " : "skipped"} ${d.name}: ${d.teams} teams, schedule ${d.status}${d.us.length ? " · has us" : ""}${d.opponents.length ? " · opponents: " + d.opponents.join(", ") : ""}`);
  say(`  field ${field.length}; GameChanger links for ${gcTeams.length}; none yet for: ${noGc.join(", ") || "-"}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const today = process.env.TODAY || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const r = await discover({ team: process.env.TEAM || "9OmIn3ns4vv7", weekend: process.env.WEEKEND || "", today });
  mkdirSync(ROOT + "test/out", { recursive: true });
  const f = `${ROOT}test/out/discover-${r.team.id}-${r.dateStart || "none"}.json`;
  writeFileSync(f, JSON.stringify(r, null, 2));
  log(`Saved ${f}`);
}
