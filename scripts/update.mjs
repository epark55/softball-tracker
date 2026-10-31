// Pulls scores from each team's public GameChanger feed and the Tourney Machine
// division pages, then writes docs/data.json for the public page.
// Run by .github/workflows/update.yml every few minutes. Run locally with:
//   node scripts/update.mjs          (respects game hours)
//   FORCE=1 node scripts/update.mjs  (always pulls)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TL = require("../docs/logic.js");

const ROOT = new URL("..", import.meta.url).pathname;
const CFG_PATH = ROOT + "tournament.json";
const OUT_PATH = ROOT + "docs/data.json";
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

/* Tourney Machine division page (raw HTML) -> {status, teams, lastUpdated} */
function parseTMHtml(html) {
  const out = { status: "none", teams: [], lastUpdated: null };
  const re = /hlkTeamResults"[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(html))) {
    const name = m[1].replace(/&amp;/g, "&").replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (name && !out.teams.includes(name)) out.teams.push(name);
  }
  const lu = /Last Updated[\s\S]{0,200}?(\w{3} \d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2} [AP]M)/.exec(html);
  if (lu) out.lastUpdated = lu[1];
  if (/has not released the schedule/i.test(html)) out.status = "not_released";
  else if (/<span>Schedule<\/span>/.test(html)) out.status = "posted";
  return out;
}

function sameScores(a, b) {
  const strip = (s) => JSON.stringify(s, (k, v) => (/^(fetchedAt|checkedAt|fullAt|tmAt)$/.test(k) ? undefined : v));
  return strip(a) === strip(b);
}

async function main() {
  const cfg = JSON.parse(readFileSync(CFG_PATH, "utf8"));
  const prev = existsSync(OUT_PATH) ? JSON.parse(readFileSync(OUT_PATH, "utf8")) : {};
  const prevSnap = prev.snap || {};
  const now = Date.now();
  const today = TL.localDate(new Date(now).toISOString());
  const cfgChanged = JSON.stringify(prev.cfg || null) !== JSON.stringify(cfg);

  // Only pull during the tournament: every run during game hours, hourly otherwise.
  if (!FORCE && !cfgChanged) {
    if (today < cfg.dateStart || today > cfg.dateEnd) { log("Outside tournament dates; nothing to do."); return; }
    const games = TL.mergeGames(cfg, prevSnap, TL.buildRoster(cfg, prevSnap));
    const lastFull = prevSnap.fullAt || prevSnap.fetchedAt || 0;
    if (!TL.inGameHours(games, now) && now - lastFull < 55 * 60000) { log("Outside game hours; checked recently."); return; }
  }

  const snap = { fetchedAt: now, checkedAt: now, fullAt: now, tmAt: prevSnap.tmAt || 0,
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
  if (!changed && !stale) { log("No score changes."); return; }
  writeFileSync(OUT_PATH, JSON.stringify({ cfg, snap }, null, 1) + "\n");
  log(changed ? "Scores changed; wrote docs/data.json" : "Hourly refresh; wrote docs/data.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
