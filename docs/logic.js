/* Shared tournament logic: used by the public page and by scripts/update.mjs */
/* ---------- pure logic (no DOM) ---------- */
var TL = (function(){
  var TZ = "America/New_York";
  function extractBody(t){
    if (typeof t !== "string") return "";
    var i = t.indexOf("\n---\n"); var s = i >= 0 ? t.slice(i+5) : t;
    var j = s.lastIndexOf("\n\nTab Context:"); if (j >= 0) s = s.slice(0,j);
    return s.replace(/\n\n\[truncated[^\]]*\]\s*$/,"").trim();
  }
  function parseTabId(t){ var m = /tabId ([^)\s]+)\)/.exec(t||""); return m ? m[1] : null; }
  function gcIdFromLink(s){
    s = (s||"").trim(); if (!s) return null;
    var m = /teams\/([A-Za-z0-9]{8,20})/.exec(s); if (m) return m[1];
    return /^[A-Za-z0-9]{8,20}$/.test(s) ? s : null;
  }
  function norm(s){
    return (s||"").toLowerCase().replace(/&/g," and ").replace(/(\d+)\s*u\b/g,"$1u").replace(/[^a-z0-9]+/g," ").trim();
  }
  function tokens(s){ return norm(s).split(" ").filter(Boolean); }
  /* words that every team name shares; they can't tell two teams apart */
  var GENERIC = {team:1, the:1, softball:1, fastpitch:1, fp:1, club:1, travel:1};
  function key(s){
    var all = tokens(s);
    var d = all.filter(function(t){ return !GENERIC[t] && !/^\d+u$/.test(t) && !/^(19|20)\d\d$/.test(t) && !/^\d+s$/.test(t); });
    return d.length ? d : all;
  }
  function similar(a,b){
    if (!tokens(a).length || !tokens(b).length) return 0;
    if (norm(a) === norm(b)) return 1;
    var A = new Set(key(a)), B = new Set(key(b)), shared = 0;
    A.forEach(function(x){ if (B.has(x)) shared++; });
    var small = Math.min(A.size, B.size);
    if (shared < Math.min(2, small)) return 0;
    return shared / small;
  }
  var MATCH = 1; /* every distinctive word of the shorter name must appear in the longer one */
  function localDate(ts){ return new Intl.DateTimeFormat("en-CA",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts)); }
  function inWindow(ts, cfg){ var d = localDate(ts); return d >= cfg.dateStart && d <= cfg.dateEnd; }
  /* roster: tournament teams from GameChanger links and Tourney Machine */
  function buildRoster(cfg, snap){
    var roster = [];
    function add(name, extra){
      if (!name) return;
      for (var i=0;i<roster.length;i++){ if (similar(roster[i].name,name) >= MATCH){ Object.assign(roster[i], extra||{}); return; } }
      roster.push(Object.assign({key:"t"+roster.length, name:name}, extra||{}));
    }
    (cfg.gcTeams||[]).forEach(function(t){ add(t.name, {gcId:t.id}); });
    var out = (cfg.excludeTeams || []).filter(Boolean);
    function excluded(n){ return out.some(function(x){ return similar(x, n) >= MATCH; }); }
    ((snap && snap.tm && snap.tm.teams) || []).forEach(function(n){ if (!excluded(n)) add(n, {tm:true}); });
    return roster;
  }
  function canon(name, roster){
    var best=null, bs=0;
    roster.forEach(function(r){ var s = similar(r.name,name); if (s>bs){bs=s;best=r;} });
    if (best && bs >= MATCH) return {key:best.key, name:best.name, inField:true};
    return {key:"x:"+norm(name), name:name, inField:false};
  }
  /* one list of tournament games from every team feed, duplicates merged */
  function mergeGames(cfg, snap, roster){
    var map = {};
    var feeds = (snap && snap.feeds) || {};
    Object.keys(feeds).forEach(function(id){
      var f = feeds[id]; if (!f || !f.games) return;
      var me = canon(f.name, roster);
      f.games.forEach(function(g){
        var opp = g.opponent_team && g.opponent_team.name; if (!opp || !g.start_ts || !inWindow(g.start_ts,cfg)) return;
        var o = canon(opp, roster);
        var hasScore = !!(g.score && typeof g.score.team === "number" && typeof g.score.opponent_team === "number");
        var done = g.game_status === "completed" && hasScore;
        /* a score on a game that isn't completed yet is a live, in-progress score */
        /* GameChanger lists 0-0 on games that haven't started ("new"), so that alone isn't live */
        var st = g.game_status || "";
        var notStarted = st === "new" || st === "scheduled" || st === "canceled" || st === "cancelled" || st === "postponed";
        var live = !done && hasScore && !notStarted && (st === "in_progress" || st === "live" || (g.score.team + g.score.opponent_team) > 0);
        var showScore = done || live;
        var mine = {k:me.key, n:me.name, inField:true, s: showScore ? g.score.team : null};
        var theirs = {k:o.key, n:o.name, inField:o.inField, s: showScore ? g.score.opponent_team : null};
        var pair = [mine,theirs].sort(function(a,b){ return a.k < b.k ? -1 : 1; });
        var key = g.start_ts.slice(0,16) + "|" + pair[0].k + "|" + pair[1].k;
        var rec = {key:key, start:g.start_ts, end:g.end_ts||null, a:pair[0], b:pair[1], final:!!done, live:live, status:g.game_status||null, sources:[id], conflict:false};
        var ex = map[key];
        if (!ex){ map[key] = rec; return; }
        if (ex.sources.indexOf(id) < 0) ex.sources.push(id);
        if (!ex.end && rec.end) ex.end = rec.end;
        if (rec.final && !ex.final){ rec.sources = ex.sources; rec.end = rec.end || ex.end; map[key] = rec; }
        else if (rec.final && ex.final && (rec.a.s !== ex.a.s || rec.b.s !== ex.b.s)) ex.conflict = true;
        else if (!ex.final && rec.live && (!ex.live || (rec.a.s + rec.b.s) > (ex.a.s + ex.b.s))){ rec.sources = ex.sources; rec.end = rec.end || ex.end; map[key] = rec; }
      });
    });
    return Object.keys(map).map(function(k){ return map[k]; }).sort(function(x,y){ return x.start < y.start ? -1 : x.start > y.start ? 1 : 0; });
  }
  function standings(games){
    var t = {};
    function row(side){ return t[side.k] || (t[side.k] = {key:side.k, name:side.n, inField:side.inField, w:0,l:0,tie:0,rs:0,ra:0,gp:0}); }
    games.forEach(function(g){
      row(g.a); row(g.b);
      if (!g.final || g.conflict) return;
      [[g.a,g.b],[g.b,g.a]].forEach(function(p){
        var r = row(p[0]); r.gp++; r.rs += p[0].s; r.ra += p[1].s;
        if (p[0].s > p[1].s) r.w++; else if (p[0].s < p[1].s) r.l++; else r.tie++;
      });
    });
    return Object.keys(t).map(function(k){ var r=t[k]; r.rd = r.rs - r.ra; r.pct = r.gp ? (r.w + r.tie/2)/r.gp : 0; return r; })
      .sort(function(x,y){ return (y.inField-x.inField) || (y.pct-x.pct) || (y.rd-x.rd) || (x.ra-y.ra) || x.name.localeCompare(y.name); });
  }
  /* Tourney Machine division page text */
  function parseTM(text){
    var out = {status:"none", teams:[], lastUpdated:null};
    if (!text) return out;
    var lu = /Last Updated\s*\n?\s*([^\n]+)/.exec(text); if (lu) out.lastUpdated = lu[1].trim();
    var ti = text.indexOf("\nTeams\n"), si = text.indexOf("\nSchedule\n");
    if (ti >= 0){
      var block = text.slice(ti+7, si > ti ? si : undefined);
      out.teams = block.split("\n").map(function(l){ return l.replace(/\s*\([^)]*\)\s*$/,"").trim(); }).filter(function(l){ return l && l.length < 80; });
    }
    if (/has not released the schedule/i.test(text)) out.status = "not_released";
    else if (si >= 0) out.status = "posted";
    return out;
  }
  /* a game is on the field now: GameChanger shows a live score, or the clock is between its start and end */
  function inProgress(g, now){
    if (g.final) return false;
    if (g.live) return true;
    var s = Date.parse(g.start), e = g.end ? Date.parse(g.end) : s + 2*3600000;
    return now >= s && now <= e + 30*60000;
  }
  /* GameChanger team ids whose games are on the field now */
  function liveTeamIds(games, roster, now){
    var ids = {};
    games.forEach(function(g){ if (!inProgress(g, now)) return;
      [g.a, g.b].forEach(function(sd){ var r = roster.find(function(x){ return x.key===sd.k; }); if (r && r.gcId) ids[r.gcId] = 1; }); });
    return Object.keys(ids);
  }
  /* ---------- deciding what to read, so the page makes as few reads as it can ---------- */
  function gcIdOf(side, roster){ var r = roster.find(function(x){ return x.key===side.k; }); return r && r.gcId ? r.gcId : null; }
  function todays(games, now){ var d = localDate(new Date(now).toISOString()); return games.filter(function(g){ return localDate(g.start) === d; }); }
  /* true from 30 minutes before today's first game until an hour after the last one ends */
  function inGameHours(games, now){
    var t = todays(games, now); if (!t.length) return false;
    var first = Math.min.apply(null, t.map(function(g){ return Date.parse(g.start); }));
    var last = Math.max.apply(null, t.map(function(g){ return g.end ? Date.parse(g.end) : Date.parse(g.start) + 2*3600000; }));
    return now >= first - 30*60000 && now <= last + 60*60000;
  }
  /* full refresh: teams with a game today that isn't final yet, plus any team never read */
  function teamsForFull(games, roster, now, feeds, allIds){
    var ids = {};
    allIds.forEach(function(id){ if (!feeds || !feeds[id]) ids[id] = 1; });
    todays(games, now).forEach(function(g){ if (g.final) return;
      [g.a, g.b].forEach(function(sd){ var id = gcIdOf(sd, roster); if (id) ids[id] = 1; }); });
    return Object.keys(ids);
  }
  /* live refresh: one tracked team per game on the field */
  function teamsForLive(games, roster, now){
    var ids = {};
    games.forEach(function(g){ if (!inProgress(g, now)) return;
      var a = gcIdOf(g.a, roster), b = gcIdOf(g.b, roster);
      if (a && ids[a]) return; if (b && ids[b]) return;
      var pick = a || b; if (pick) ids[pick] = 1; });
    return Object.keys(ids);
  }
  /* several Tourney Machine divisions playing as one field */
  function combineTM(parts, prev){
    var teams = [], st = parts.map(function(p){ return p.status; });
    parts.forEach(function(p){ (p.teams||[]).forEach(function(t){ if (teams.indexOf(t) < 0) teams.push(t); }); });
    if (st.every(function(s){ return s==="error"; })) return Object.assign({}, prev || {teams:[]}, {status:"error"});
    if (!teams.length && prev && prev.teams) teams = prev.teams;
    var status = st.indexOf("posted") >= 0 ? "posted" : st.indexOf("not_released") >= 0 ? "not_released" : st.indexOf("error") >= 0 ? "error" : "none";
    var lu = parts.map(function(p){ return p.lastUpdated; }).filter(Boolean);
    return {status:status, teams:teams, lastUpdated: lu.length ? lu[lu.length-1] : null, divisions: parts.length};
  }
  function trimGames(arr, cfg){
    return (Array.isArray(arr)?arr:[]).filter(function(g){ return g && g.start_ts && inWindow(g.start_ts,cfg); })
      .map(function(g){ return {id:g.id, start_ts:g.start_ts, end_ts:g.end_ts||null, home_away:g.home_away||null, opponent_team:{name:(g.opponent_team&&g.opponent_team.name)||""}, score:g.score||null, game_status:g.game_status||null}; });
  }
  /* ---------- pool play vs bracket ---------- */
  function bracketDay(cfg){ return cfg.bracketStart || cfg.dateEnd; }
  function poolGames(games, cfg){ var d = bracketDay(cfg); return games.filter(function(g){ return localDate(g.start) < d; }); }
  function elimGames(games, cfg){ var d = bracketDay(cfg); return games.filter(function(g){ return localDate(g.start) >= d; }); }
  /* standings with every tournament team listed, even before they play */
  function table(games, roster){
    var t = standings(games);
    roster.forEach(function(r){ if (!t.some(function(x){ return x.key===r.key; })) t.push({key:r.key, name:r.name, inField:true, w:0,l:0,tie:0,rs:0,ra:0,rd:0,gp:0,pct:0}); });
    return t.sort(function(x,y){ return (y.inField-x.inField) || (y.pct-x.pct) || (y.rd-x.rd) || (x.ra-y.ra) || x.name.localeCompare(y.name); });
  }
  function seedList(tbl, cfg, roster){
    var field = tbl.filter(function(r){ return r.inField; });
    if (cfg.seedOrder && cfg.seedOrder.length){
      var out = [];
      cfg.seedOrder.forEach(function(n){ var c = canon(n, roster); var r = field.find(function(x){ return x.key===c.key; }); if (r && out.indexOf(r) < 0) out.push(r); });
      field.forEach(function(r){ if (out.indexOf(r) < 0) out.push(r); });
      return {list:out, official:true};
    }
    return {list:field, official:false};
  }
  function slotOrder(P){ var o=[1]; while (o.length < P){ var n=o.length*2, nx=[]; o.forEach(function(s){ nx.push(s); nx.push(n+1-s); }); o=nx; } return o; }
  function findGame(games, a, b){
    var c = games.filter(function(g){ return (g.a.k===a.key && g.b.k===b.key) || (g.a.k===b.key && g.b.k===a.key); });
    var fin = c.filter(function(g){ return g.final; }); if (fin.length) return fin[fin.length-1];
    return c[0] || null;
  }
  function playMatch(m, games){
    if (!m.a || !m.b || m.a.tbd || m.b.tbd) return m;
    var g = findGame(games, m.a, m.b); m.game = g;
    if (g && g.final && !g.conflict){
      m.sa = g.a.k===m.a.key ? g.a.s : g.b.s; m.sb = g.a.k===m.a.key ? g.b.s : g.a.s;
      if (m.sa !== m.sb){ m.winner = m.sa > m.sb ? m.a : m.b; m.loser = m.winner===m.a ? m.b : m.a; }
    }
    return m;
  }
  function roundName(teamsLeft){ return teamsLeft===2 ? "Final" : teamsLeft===4 ? "Semifinals" : teamsLeft===8 ? "Quarterfinals" : "Round of " + teamsLeft; }
  function buildBracket(seeds, games, size){
    var n = Math.min(size || seeds.length, seeds.length); if (n < 2) return null;
    var P = 1; while (P < n) P *= 2;
    var cur = slotOrder(P).map(function(s){ return s <= n ? {seed:s, key:seeds[s-1].key, name:seeds[s-1].name} : null; });
    var rounds = [], first = true;
    while (cur.length > 1){
      var ms = [], nx = [];
      for (var i=0;i<cur.length;i+=2){
        var m = {a:cur[i], b:cur[i+1], winner:null, loser:null, game:null, bye:false};
        if (first && (!m.a || !m.b)){ m.bye = true; m.winner = m.a || m.b; }
        else playMatch(m, games);
        ms.push(m);
        nx.push(m.winner || {tbd:true, label: m.a && m.b && !m.a.tbd && !m.b.tbd ? (m.a.name + " / " + m.b.name) : "TBD"});
      }
      rounds.push({name: roundName(cur.length), matches: ms}); cur = nx; first = false;
    }
    var third = null;
    if (rounds.length >= 2){
      var semis = rounds[rounds.length-2].matches.filter(function(m){ return !m.bye; });
      if (semis.length === 2){
        var lo = semis.map(function(m){ return m.loser || {tbd:true, label:"Semifinal loser"}; });
        third = playMatch({a:lo[0], b:lo[1], winner:null, loser:null, game:null}, games);
      }
    }
    var fin = rounds[rounds.length-1].matches[0];
    return {rounds:rounds, third:third, champion: fin.winner || null, size:n};
  }

  return {extractBody:extractBody, parseTabId:parseTabId, gcIdFromLink:gcIdFromLink, norm:norm, similar:similar, inWindow:inWindow, localDate:localDate,
          buildRoster:buildRoster, canon:canon, mergeGames:mergeGames, standings:standings, parseTM:parseTM, combineTM:combineTM, trimGames:trimGames, TZ:TZ,
          inProgress:inProgress, liveTeamIds:liveTeamIds, inGameHours:inGameHours, teamsForFull:teamsForFull, teamsForLive:teamsForLive,
          poolGames:poolGames, elimGames:elimGames, table:table, seedList:seedList, slotOrder:slotOrder, buildBracket:buildBracket, bracketDay:bracketDay};
})();
if (typeof module !== "undefined" && module.exports) module.exports = TL;
