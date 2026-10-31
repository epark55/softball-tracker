# Softball Tournament Tracker

A public page with live standings, scores and a bracket for a softball tournament,
built from each team's public GameChanger page plus the Tourney Machine team list.
GitHub updates it automatically every few minutes during game hours, so nobody has
to keep a computer on.

**Public page:** `https://<your-username>.github.io/softball-tracker/`

## Setting up a new tournament each weekend

Edit **`tournament.json`** (open it on GitHub, tap the pencil icon, then *Commit changes*).
The page updates within a few minutes.

| Setting | What it's for |
|---|---|
| `title`, `venue` | Shown at the top of the page |
| `dateStart`, `dateEnd` | Tournament days, as `YYYY-MM-DD`. Scores are only pulled on these days. |
| `bracketStart` | First day of bracket play. Games before it count as pool play. |
| `bracketSize` | `0` for every team, or `4`, `6`, `8` if only the top teams advance |
| `follow` | GameChanger id of the team the page highlights by default (viewers can pick their own) |
| `tmUrls` | Tourney Machine division links. List every division that shares the same pools and bracket. |
| `gcTeams` | Each team's GameChanger id and name. The id is the part after `/teams/` in its GameChanger link. |
| `excludeTeams` | Teams on Tourney Machine's list that aren't actually playing |
| `seedOrder` | Official seeds once the director posts them, 1st seed first. Leave `[]` to seed from pool standings. |

## How it works

- `.github/workflows/update.yml` runs `scripts/update.mjs` every 5 minutes. Outside the
  tournament dates it exits right away; outside game hours it checks once an hour.
- The script saves `docs/data.json` only when something changed, which keeps the history short.
- `docs/index.html` is the page; it reloads `data.json` every minute.
- `docs/logic.js` holds the matching, standings and bracket rules shared by both.

GameChanger's team feed is public but unofficial, so it could change without notice.
If scores stop updating, check the latest run under the **Actions** tab.
