#!/bin/sh
# Commits and pushes whatever data/ changes exist right now. Called after
# every model build so a completed model persists even if a later builder
# or the job's timeout kills the run — a cold start (all models stale) can
# otherwise exceed the ceiling and loop forever without publishing.
set -eu

git add data/
if git diff --cached --quiet; then
  echo "No new run to commit."
  exit 0
fi

message=""
for manifest in data/*/manifest.json; do
  if git diff --cached --name-only | grep -qx "$manifest"; then
    part=$(python3 -c "import json; m=json.load(open('$manifest')); print(f\"{m['model']} run {m['referenceTime']}\")")
    message="${message:+$message; }$part"
  fi
done

git config user.name "windgram-bot"
git config user.email "actions@github.com"
git commit -m "${message:-Data update}"
# A code push can land while a build runs, and the three provider jobs
# race each other's data commits; both rebase over cleanly, so retry
# instead of stranding the run on the runner.
for attempt in 1 2 3 4 5; do
  git push && exit 0
  git pull --rebase
done
git push
