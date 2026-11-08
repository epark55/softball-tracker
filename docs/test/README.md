# Test copy

A duplicate of the public page for trying changes. Editing these files never changes the live page
at softball.edparkermedia.com (this copy is at `/test/`).

It also tests the hands-off weekly setup. The test page has its own tournament, found with no
Thursday task:

- `test/discover.mjs` finds our next tournament on Tourney Machine, from our GameChanger schedule
  or by spotting our team's name on upcoming nearby events.
- `test/pipeline.mjs` (every 6 hours) saves what it found to `next.json` and, the week of the
  tournament, makes it this page's tournament (`test/state/tournament.json`).
- `.github/workflows/test-updater.yml` (every 30 minutes) runs a private copy of the score updater on
  that file and saves `data.json` here. Live files are only read, never written.
