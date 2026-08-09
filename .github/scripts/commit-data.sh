#!/bin/sh
# Commits and pushes whatever data/ changes exist right now. Called after
# every model build so a completed model persists even if a later builder
# or the job's timeout kills the run — a cold start (all models stale) can
# otherwise exceed the ceiling and loop forever without publishing.
set -eu

# data/runs.json is the cross-model run index: per published model, the
# manifest's (referenceTime, generatedAt) pair. It is regenerated wholesale
# from every on-disk manifest and staged into the same commit as the data
# it indexes, so the index is always a pure function of the tree it lands
# with. Concurrent provider lanes converge through the rebase-retry below:
# after every rebase the index is regenerated from the merged manifests —
# whether the rebase conflicted on runs.json (the only file two lanes both
# write) or applied cleanly over another lane's newer runs — so the last
# lane to push publishes an index covering every lane's runs.
regenerate_runs_index() {
  python3 -c "from windgram.publish import write_runs_index; write_runs_index()"
  git add data/runs.json
}

git add data/
if git diff --cached --quiet; then
  echo "No new run to commit."
  exit 0
fi
regenerate_runs_index

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
# race each other's data commits; retry instead of stranding the run on
# the runner. Manifests never conflict (one model per lane), so the only
# possible rebase conflict is runs.json — resolved by regenerating it from
# the merged on-disk manifests.
for attempt in 1 2 3 4 5; do
  git push && exit 0
  if git pull --rebase; then
    # Clean rebase: fold a freshly regenerated index into our commit in
    # case upstream brought newer manifests our committed index predates.
    regenerate_runs_index
    git diff --cached --quiet || git commit --amend --no-edit
  else
    regenerate_runs_index
    GIT_EDITOR=true git rebase --continue
  fi
done
git push
