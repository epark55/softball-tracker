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

## Where the data comes from

- **GameChanger** (each team's public page): schedules, live scores and finals, usually minutes after a game ends.
- **Tourney Machine** (the division pages in `tmUrls`): the team list and, once the director posts them,
  pools, every game with its number and field, seeds and official finals.
- When both report a game, GameChanger's live score is shown while it's being played, and Tourney Machine's
  posted final is treated as official if the two disagree.
- The bracket is drawn from the bracket games actually on the schedule. Before any are scheduled it shows a
  projection from pool standings.
- Anyone can follow any team in the field from the menu at the top, including after their own team is out.

## How it works

- `.github/workflows/update.yml` runs `scripts/loop.sh`, one long job that runs
  `scripts/update.mjs` every 3 minutes for about 6 hours and then starts its own next run.
  A timed schedule restarts it if that chain ever breaks. Outside game hours `update.mjs`
  checks once an hour; on weekends with no tournament set up it follows our team only.
- The script saves `docs/data.json` only when something changed, which keeps the history short.
- `docs/index.html` is the page; it reloads `data.json` every minute.
- `docs/logic.js` holds the matching, standings and bracket rules shared by both.

GameChanger's team feed is public but unofficial, so it could change without notice.
If scores stop updating, check the latest run under the **Actions** tab.
