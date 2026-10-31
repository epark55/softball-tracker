#!/usr/bin/env bash
# Keeps scores updated without relying on GitHub's timed schedule, which can start late or skip.
# Runs update.mjs every 3 minutes for just under 6 hours (GitHub's job limit), saving changes,
# then starts its own next run. update.mjs itself decides whether there's anything to read
# (game hours, tournament dates), so idle loops cost nothing but a few seconds.
set -u
REPO="${GITHUB_REPOSITORY}"
ME="${GITHUB_RUN_ID}"

# Only one copy should run. Wait for a run that's handing off to finish, then
# leave if an older copy is still going.
sleep 90
older=$(gh run list -R "$REPO" --workflow update.yml --status in_progress --json databaseId \
          --jq "[.[].databaseId | select(. < $ME)] | length" 2>/dev/null || echo 0)
if [ "${older:-0}" -gt 0 ]; then
  echo "Another update run is already keeping scores fresh; exiting."
  exit 0
fi

git config user.name "score-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

end=$((SECONDS + 5*3600 + 40*60))
while [ $SECONDS -lt $end ]; do
  git pull -q --rebase origin main || git rebase --abort || true
  rm -f .live.json
  node scripts/update.mjs || echo "update.mjs failed this time; trying again next loop"
  # Publish the latest check (with its time) to the "live" branch as a single commit that replaces
  # the last one. The page reads it straight from there, so "checked 2 min ago" stays true without
  # rebuilding the site every 3 minutes.
  if [ -s .live.json ]; then
    blob=$(git hash-object -w .live.json)
    tree=$(printf '100644 blob %s\tdata.json\n' "$blob" | git mktree)
    commit=$(git commit-tree "$tree" -m "Latest check")
    git push -q -f origin "$commit:refs/heads/live" || echo "couldn't publish the latest check"
  fi
  if ! git diff --quiet -- docs/data.json; then
    git add docs/data.json
    git commit -q -m "Update scores"
    for attempt in 1 2 3; do
      git pull -q --rebase origin main && git push -q origin HEAD:main && break
      sleep 5
    done
  fi
  sleep 180
done

echo "Handing off to the next run."
gh workflow run update.yml -R "$REPO" --ref main
