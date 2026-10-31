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
    var map = {}, nowMs = Date.now();
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
        /* a report someone has flagged as wrong in tournament.json ("ignoreReports"): skip it while it still says that */
        if ((cfg.ignoreReports || []).some(function(x){
              return similar(x.team, f.name) >= 1 && similar(x.opponent, opp) >= 1 && (!x.start || Math.abs(Date.parse(x.start) - Date.parse(g.start_ts)) < 60000) &&
                     (!x.score || (hasScore && x.score === g.score.team + "-" + g.score.opponent_team)); })) return;
        /* no real game is final within 45 minutes of its start: that's a scoring mistake, so show it as not started */
        if (rec.final && nowMs < Date.parse(g.start_ts) + 45*60000){ rec.final = false; rec.a.s = rec.b.s = null; rec.early = true; }
        (map[key] = map[key] || []).push(rec);
      });
    });
    /* each team's page reports the game separately; decide what to show when they differ */
    var list = Object.keys(map).map(function(k){
      var reps = map[k], srcs = [];
      reps.forEach(function(r){ r.sources.forEach(function(s){ if (srcs.indexOf(s) < 0) srcs.push(s); }); });
      var end = (reps.find(function(r){ return r.end; }) || {}).end || null;
      var finals = reps.filter(function(r){ return r.final; }), lives = reps.filter(function(r){ return r.live; });
      var pick;
      if (lives.length && finals.length && lives.some(function(l){ return finals.every(function(f){ return f.sources[0] !== l.sources[0]; }); })){
        /* one team still scoring it live while the other already says final: trust the live game */
        pick = lives.sort(function(x,y){ return (y.a.s + y.b.s) - (x.a.s + x.b.s); })[0];
      } else if (finals.length){
        pick = finals[0];
        if (finals.some(function(f){ return f.a.s !== pick.a.s || f.b.s !== pick.b.s; })) pick.conflict = true;
      } else if (lives.length){
        pick = lives.sort(function(x,y){ return (y.a.s + y.b.s) - (x.a.s + x.b.s); })[0];
      } else pick = reps[0];
      pick.sources = srcs; pick.end = pick.end || end;
      return pick;
    });
    /* Tourney Machine: the official schedule. Its game matches a GameChanger game when the same two
       teams meet the same day within 2 hours. GameChanger stays the source for live scores (it's faster);
       Tourney Machine's final is official, so it settles disagreements and fills in games GameChanger lacks. */
    var tmg = (snap && snap.tm && snap.tm.games) || [];
    tmg.forEach(function(t){
      if (!t.start_ts || !inWindow(t.start_ts, cfg)) return;
      var A = canon(t.t1.name, roster), B = canon(t.t2.name, roster);
      if (!A.inField || !B.inField || A.key === B.key) return;   /* "Winner of B2", "1st Pool A" and the like */
      var fin = t.s1 != null && t.s2 != null;
      var sa = {k:A.key, n:A.name, inField:true, s: fin ? t.s1 : null}, sb = {k:B.key, n:B.name, inField:true, s: fin ? t.s2 : null};
      var seeds = {}; if (t.t1.seed) seeds[A.key] = t.t1.seed; if (t.t2.seed) seeds[B.key] = t.t2.seed;
      var day = localDate(t.start_ts), at = Date.parse(t.start_ts), best = null, bestGap = 2*3600000 + 1;
      list.forEach(function(g){
        var same = (g.a.k===A.key && g.b.k===B.key) || (g.a.k===B.key && g.b.k===A.key);
        if (!same || localDate(g.start) !== day) return;
        var gap = Math.abs(Date.parse(g.start) - at); if (gap < bestGap){ best = g; bestGap = gap; }
      });
      var info = {no:t.no, loc:t.loc, seeds:seeds};
      if (best){
        best.tm = info; if (best.sources.indexOf("tm") < 0) best.sources.push("tm");
        if (fin){
          var aIsA = best.a.k === A.key;
          var ta = aIsA ? t.s1 : t.s2, tb = aIsA ? t.s2 : t.s1;
          if (!best.final || best.conflict || best.a.s !== ta || best.b.s !== tb){ best.overruled = best.final && !best.conflict && (best.a.s !== ta || best.b.s !== tb); }
          best.a.s = ta; best.b.s = tb; best.final = true; best.live = false; best.conflict = false; best.official = true;
        }
      } else {
        var pair = [sa, sb].sort(function(x,y){ return x.k < y.k ? -1 : 1; });
        list.push({key:"tm|"+(t.id||t.no), start:t.start_ts, end:null, a:pair[0], b:pair[1], final:fin, live:false, official:fin,
                   status:null, sources:["tm"], conflict:false, tm:info});
      }
    });
    /* A scorekeeper sometimes scores a game as a new entry and leaves the original listing behind.
       Drop a never-started game when the same two teams already have a final the same day
       and its start time is more than 3 hours past. */
    var now = Date.now();
    list = list.filter(function(g){
      if (g.final || g.live || now - Date.parse(g.start) < 3*3600000) return true;
      var d = localDate(g.start);
      return !list.some(function(o){ return o !== g && o.final && localDate(o.start) === d &&
        ((o.a.k===g.a.k && o.b.k===g.b.k) || (o.a.k===g.b.k && o.b.k===g.a.k)); });
    });
    return list.sort(function(x,y){ return x.start < y.start ? -1 : x.start > y.start ? 1 : 0; });
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
    return now >= s && now <= e;
  }
  /* the scheduled end has passed and no one has reported a score */
  function unreported(g, now){
    if (g.final || g.live) return false;
    var s = Date.parse(g.start), e = g.end ? Date.parse(g.end) : s + 2*3600000;
    return now > e;
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
    var games = [], pools = [], seen = {};
    parts.forEach(function(p){ (p.games||[]).forEach(function(g){ if (!seen[g.id]){ seen[g.id] = 1; games.push(g); } }); (p.pools||[]).forEach(function(x){ pools.push(x); }); });
    if (!games.length && prev && prev.games && st.indexOf("error") >= 0) games = prev.games;
    return {status:status, teams:teams, pools:pools, games:games, lastUpdated: lu.length ? lu[lu.length-1] : null, divisions: parts.length};
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
      var byes = ms.filter(function(m){ return m.bye; }).length;
      rounds.push({name: first && byes ? "Opening round" : roundName(cur.length), matches: ms}); cur = nx; first = false;
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

  /* The bracket as actually scheduled: bracket-day games between tournament teams, from GameChanger
     and Tourney Machine. Single elimination: a team's next game is one round later than its last.
     Teams that enter in round 1 are the ones whose first game comes before every bye team plays;
     with N teams in a bracket sized P (next power of 2), that's N - P/2 opening games. */
  function actualBracket(elim, field, cfg){
    var games = elim.filter(function(g){ return g.a.inField && g.b.inField; })
                    .sort(function(x,y){ return x.start < y.start ? -1 : x.start > y.start ? 1 : 0; });
    if (!games.length) return null;
    var N = cfg.bracketSize || field.length; if (N < 2) N = 2;
    var P = 1; while (P < N) P *= 2;
    var R = Math.round(Math.log(P)/Math.log(2));
    var opening = N === P ? P/2 : N - P/2;
    var st = {}, rounds = [], third = null, used1 = 0, champion = null;
    function ent(k){ return st[k] || (st[k] = {next:null, out:false, outRound:null, played:0}); }
    games.forEach(function(g){
      var A = ent(g.a.k), B = ent(g.b.k), round;
      if (A.out && B.out){ third = g; g.consolation = true; return; }
      if (A.next == null && B.next == null){ round = used1 < opening ? (used1++, 1) : 2; if (opening === P/2) round = 1; }
      else round = Math.max(A.next || 0, B.next || 0);
      round = Math.min(Math.max(round, 1), R);
      g.round = round; (rounds[round-1] = rounds[round-1] || []).push(g);
      A.next = B.next = round + 1; A.played++; B.played++;
      if (g.final && !g.conflict && g.a.s !== g.b.s){
        var w = g.a.s > g.b.s ? g.a : g.b, l = w === g.a ? g.b : g.a;
        g.winner = w.k; st[l.k].out = true; st[l.k].outRound = round;
        if (round === R) champion = w;
      }
    });
    var out = [];
    for (var r = 1; r <= R; r++){
      var gs = rounds[r-1] || [];
      var expected = r === 1 ? opening : P / Math.pow(2, r);
      /* teams that have won through to this round but aren't on the schedule yet */
      var waiting = [];
      (rounds[r-2] || []).forEach(function(g){ if (g.winner && !gs.some(function(x){ return x.a.k===g.winner || x.b.k===g.winner; })) waiting.push(g.a.k===g.winner ? g.a : g.b); });
      var placeholders = [];
      for (var i = gs.length; i < expected; i++) placeholders.push(waiting.length ? waiting.shift() : null);
      var slots = P / Math.pow(2, r-1);
      out.push({name: r === 1 && opening < P/2 ? "Opening round" : roundName(slots), games: gs, placeholders: placeholders});
    }
    if (out.length > 1 && !out[0].games.length && !out[0].placeholders.length) out.shift();
    return {rounds: out, third: third, champion: champion, status: st, size: N, finalRound: R};
  }

  return {actualBracket:actualBracket, extractBody:extractBody, parseTabId:parseTabId, gcIdFromLink:gcIdFromLink, norm:norm, similar:similar, inWindow:inWindow, localDate:localDate,
          buildRoster:buildRoster, canon:canon, mergeGames:mergeGames, standings:standings, parseTM:parseTM, combineTM:combineTM, trimGames:trimGames, TZ:TZ,
          inProgress:inProgress, unreported:unreported, liveTeamIds:liveTeamIds, inGameHours:inGameHours, teamsForFull:teamsForFull, teamsForLive:teamsForLive,
          poolGames:poolGames, elimGames:elimGames, table:table, seedList:seedList, slotOrder:slotOrder, buildBracket:buildBracket, bracketDay:bracketDay};
})();
if (typeof module !== "undefined" && module.exports) module.exports = TL;
