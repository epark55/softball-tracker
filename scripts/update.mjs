// Pulls scores from each team's public GameChanger feed and the Tourney Machine
// division pages, then writes docs/data.json for the public page.
// Run by .github/workflows/update.yml every few minutes. Run locally with:
//   node scripts/update.mjs          (respects game hours)
//   FORCE=1 node scripts/update.mjs  (always pulls)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const TL = require("../docs/logic.js");

const ROOT = new URL("..", import.meta.url).pathname;
const CFG_PATH = ROOT + "tournament.json";
const OUT_PATH = ROOT + "docs/data.json";
const LIVE_PATH = process.env.LIVE_PATH || ROOT + ".live.json";
const GC = "https://api.team-manager.gc.com/public/teams/";
const UA = "Mozilla/5.0 (compatible; softball-tracker; +https://github.com)";
const FORCE = process.env.FORCE === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function get(url, kind) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: kind === "json" ? "application/json" : "text/html" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return kind === "json" ? await res.json() : await res.text();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1500);
    }
  }
}

/* Tourney Machine division page (raw HTML) -> {status, teams, pools, games, lastUpdated}.
   Once the director posts, the page has pool tables and one schedule row per game:
   game number (P1.. pool, B1.. bracket), date, time, field, both teams (seeds as "[2] Name"), scores. */
const clean = (s) => s.replace(/<br\s*\/?>[\s\S]*$/i, "").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
function etOffsetHours(y, m, d) {
  const s = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" });
  const mm = /GMT([+-]\d+)/.exec(s); return mm ? +mm[1] : -5;
}
export function parseTMHtml(html) {
  const out = { status: "none", teams: [], pools: [], games: [], lastUpdated: null };
  const addTeam = (n) => { n = n.replace(/&amp;/g, "&").replace(/\s*\([^)]*\)\s*$/, "").trim(); if (n && !out.teams.includes(n)) out.teams.push(n); };
  let m;
  const re = /hlkTeamResults"[^>]*>([^<]+)</g;
  while ((m = re.exec(html))) addTeam(m[1]);
  const pr = /pool-name">[\s\S]*?tournamentResultsTitle">\s*([^<]+?)\s*<\/th>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/g;
  while ((m = pr.exec(html))) {
    const teams = [...m[2].matchAll(/IDTeam=[^"]+">([^<]+)<\/a>/g)].map((x) => x[1].replace(/&amp;/g, "&").trim());
    teams.forEach(addTeam);
    out.pools.push({ name: m[1].trim(), teams });
  }
  const gr = /<tr class="schedule_row date_(\d{8})[^"]*"[^>]*data-gameid="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g;
  while ((m = gr.exec(html))) {
    const c = [...m[3].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    if (c.length < 7) continue;
    const y = +m[1].slice(0, 4), mo = +m[1].slice(4, 6), d = +m[1].slice(6, 8);
    const t = /(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(clean(c[1].replace(/<div[^>]*schedule_row_date[^>]*>[\s\S]*?<\/div>/, "")));
    const start_ts = t ? new Date(Date.UTC(y, mo - 1, d, (+t[1] % 12) + (/p/i.test(t[3]) ? 12 : 0) - etOffsetHours(y, mo, d), +t[2])).toISOString() : null;
    const side = (cell) => { const n = clean(cell); const sd = /^\[(\d+)\]\s*/.exec(n); return { name: n.replace(/^\[\d+\]\s*/, ""), seed: sd ? +sd[1] : null }; };
    const num = (cell) => { const v = clean(cell); return /^\d+$/.test(v) ? +v : null; };
    out.games.push({ id: m[2], no: clean(c[0]), start_ts, loc: clean(c[2]), t1: side(c[3]), t2: side(c[6]), s1: num(c[4]), s2: num(c[5]) });
  }
  const lu = /Last Updated[\s\S]{0,200}?(\w{3} \d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M)/.exec(html);
  if (lu) out.lastUpdated = lu[1];
  if (/has not released the schedule/i.test(html) && !out.games.length) out.status = "not_released";
  else if (out.games.length || /<span>Schedule<\/span>/.test(html)) out.status = "posted";
  return out;
}

function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
const slim = (g) => ({ id: g.id, start_ts: g.start_ts, end_ts: g.end_ts || null, opponent_team: { name: (g.opponent_team && g.opponent_team.name) || "" },
                       score: g.score || null, game_status: g.game_status || null });

/* Group our team's games into weekends (game days at most a day apart) and pick the one to show:
   the weekend under way, else the next one within 6 days, else the one that just ended (through
   Tuesday), else the next one on the calendar. */
function weekendOf(games, today) {
  const days = [...new Set((games || []).filter((g) => g.start_ts && g.opponent_team && g.opponent_team.name)
    .map((g) => TL.localDate(g.start_ts)))].sort();
  const clusters = [];
  for (const d of days) {
    const c = clusters[clusters.length - 1];
    if (c && d <= addDays(c.dateEnd, 2)) c.dateEnd = d; else clusters.push({ dateStart: d, dateEnd: d });
  }
  return clusters.find((c) => c.dateStart <= today && today <= c.dateEnd)
      || clusters.find((c) => c.dateStart > today && c.dateStart <= addDays(today, 6))
      || [...clusters].reverse().find((c) => c.dateEnd < today && today <= addDays(c.dateEnd, 2))
      || clusters.find((c) => c.dateStart > today)
      || null;
}
function autoGameHours(cfg, snap, now) {
  if (!cfg || !cfg.auto) return false;
  try { return TL.inGameHours(TL.mergeGames(cfg, snap, TL.buildRoster(cfg, snap)), now); } catch { return false; }
}

function sameScores(a, b) {
  const strip = (s) => JSON.stringify(s, (k, v) => (/^(fetchedAt|checkedAt|fullAt|tmAt|allAt)$/.test(k) ? undefined : v));
  return strip(a) === strip(b);
}

async function main() {
  const base = JSON.parse(readFileSync(CFG_PATH, "utf8"));
  const prev = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, "utf8")) : {};
  let prevSnap = prev.snap || {};
  const now = Date.now();
  const today = TL.localDate(new Date(now).toISOString());
  const baseChanged = JSON.stringify(prev.base || null) !== JSON.stringify(base);

  // Which tournament to show: the one in tournament.json from the week before it until the
  // day after it ends; otherwise "our team only" for whatever weekend the team plays next.
  let cfg = base;
  const configured = base.dateStart && base.dateEnd && today >= addDays(base.dateStart, -6) && today <= addDays(base.dateEnd, 1);
  if (!configured) {
    const ourId = base.follow;
    let ourGames = (prevSnap.feeds && prevSnap.feeds[ourId] && prevSnap.feeds[ourId].all) || null;
    const lastAll = prevSnap.allAt || 0;
    if (!ourGames || now - lastAll > 55 * 60000 || FORCE || baseChanged || autoGameHours(prev.cfg, prevSnap, now)) {
      try { ourGames = (await get(GC + ourId + "/games", "json")).map(slim); prevSnap = { ...prevSnap, allAt: now }; }
      catch (e) { log("Couldn't read our team's schedule:", e.message || e); if (!ourGames) { process.exitCode = 1; return; } }
    }
    const wk = weekendOf(ourGames, today);
    const name = (base.gcTeams || []).find((t) => t.id === ourId)?.name || prev.cfg?.gcTeams?.[0]?.name || "Our team";
    const when = !wk ? "Schedule" : wk.dateEnd < today ? "Last weekend" : wk.dateStart > addDays(today, 6) ? "Next games" : "This weekend";
    cfg = { auto: true, title: name + " · " + when,
            venue: "", dateStart: wk ? wk.dateStart : today, dateEnd: wk ? wk.dateEnd : today,
            bracketStart: wk ? wk.dateEnd : today, bracketSize: 0, follow: ourId, tmUrls: [],
            gcTeams: [{ id: ourId, name }], excludeTeams: [], seedOrder: [] };
    prevSnap = { ...prevSnap, ourAll: ourGames };
    log("No tournament set up for this week; following", name, wk ? wk.dateStart + ".." + wk.dateEnd : "(no upcoming games)");
  }
  const cfgChanged = baseChanged || JSON.stringify(prev.cfg || null) !== JSON.stringify(cfg);

  // Only pull during the tournament: every run during game hours, hourly otherwise.
  if (!FORCE && !cfgChanged) {
    if (!cfg.auto && (today < cfg.dateStart || today > cfg.dateEnd)) { log("Outside tournament dates; nothing to do."); return; }
    const games = TL.mergeGames(cfg, prevSnap, TL.buildRoster(cfg, prevSnap));
    const lastFull = prevSnap.fullAt || prevSnap.fetchedAt || 0;
    if (!TL.inGameHours(games, now) && now - lastFull < 55 * 60000) { log("Outside game hours; checked recently."); return; }
  }

  const snap = { fetchedAt: now, checkedAt: now, fullAt: now, tmAt: prevSnap.tmAt || 0, allAt: prevSnap.allAt || 0,
                 feeds: { ...(prevSnap.feeds || {}) }, tm: prevSnap.tm || { status: "none", teams: [] } };
  const teams = cfg.gcTeams || [];
  let ok = 0;

  for (const t of teams) {
    try {
      if (!t.name || /^Team [A-Za-z0-9]+$/.test(t.name)) {
        const info = await get(GC + t.id, "json");
        if (info && info.name) t.name = info.name;
      }
      const arr = await get(GC + t.id + "/games", "json");
      snap.feeds[t.id] = { name: t.name, games: TL.trimGames(arr, cfg), fetchedAt: Date.now() };
      ok++;
      log("GameChanger", t.name, "->", snap.feeds[t.id].games.length, "games");
    } catch (e) {
      const p = snap.feeds[t.id];
      snap.feeds[t.id] = p ? { ...p, error: String(e.message || e) } : { name: t.name, games: [], error: String(e.message || e) };
      log("GameChanger FAILED", t.name, e.message || e);
    }
    await sleep(400);
  }
  // Drop feeds for teams no longer in the settings file.
  for (const id of Object.keys(snap.feeds)) if (!teams.some((t) => t.id === id)) delete snap.feeds[id];

  const tmUrls = (cfg.tmUrls || (cfg.tmUrl ? [cfg.tmUrl] : [])).filter(Boolean);
  if (tmUrls.length && (FORCE || cfgChanged || now - snap.tmAt > 14 * 60000)) {
    const parts = [];
    for (const u of tmUrls) {
      try { parts.push(parseTMHtml(await get(u, "html"))); log("Tourney Machine ok", u.slice(-12)); }
      catch (e) { parts.push({ status: "error", teams: [], lastUpdated: null }); log("Tourney Machine FAILED", e.message || e); }
      await sleep(400);
    }
    snap.tm = TL.combineTM(parts, prevSnap.tm || null);
    snap.tmAt = now;
  }

  if (!ok && teams.length) {
    console.error("Could not read any GameChanger team feed. Keeping the previous data.");
    process.exitCode = 1;
  }

  // Only write (and so commit) when something people would see has changed,
  // or once an hour so the page shows it is still being checked.
  const changed = cfgChanged || !sameScores(prevSnap, snap);
  const stale = now - (prevSnap.fetchedAt || 0) > 60 * 60000;
  // Every check also writes a "live" copy with the check time. scripts/loop.sh publishes it on a
  // side branch (no site rebuild), so the page can say "checked 2 min ago" even when no score moved.
  const liveSnap = changed || stale ? snap : { ...prevSnap, checkedAt: now };
  if (cfg.auto && prevSnap.ourAll) liveSnap.feeds = { ...liveSnap.feeds, [cfg.follow]: { ...(liveSnap.feeds[cfg.follow] || {}), all: prevSnap.ourAll } };
  writeFileSync(LIVE_PATH, JSON.stringify({ base, cfg, snap: liveSnap }) + "\n");
  if (!changed && !stale) { log("No score changes."); return; }
  if (cfg.auto && prevSnap.ourAll) { snap.feeds[cfg.follow] = { ...(snap.feeds[cfg.follow] || {}), all: prevSnap.ourAll }; snap.allAt = prevSnap.allAt || now; }
  writeFileSync(OUT_PATH, JSON.stringify({ base, cfg, snap }, null, 1) + "\n");
  log(changed ? "Scores changed; wrote docs/data.json" : "Hourly refresh; wrote docs/data.json");
}

// Run only when started directly (tests import parseTMHtml without running a pull).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
