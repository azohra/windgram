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
# whether the rebase conflicted or applied cleanly over another lane's
# newer runs — so the last lane to push publishes an index covering every
# lane's runs.
regenerate_runs_index() {
  python3 -c "from windgram.publish import write_runs_index; write_runs_index()"
  git add data/runs.json
}

# Same-model rebase conflicts are settled by the manifests' referenceTime.
# Lanes own disjoint models, but a scheduled job checks out the commit its
# run was pinned to at creation, so after a concurrency-queue wait its tree
# can predate the previous job's pushes and it rebuilds a run that is
# already on main — the rebase then conflicts across that model's whole
# data/<model>/ tree, not just runs.json. The newer publication wins
# wholesale; a duplicate of an already-published run is dropped. During a
# rebase --ours is the upstream tip (HEAD) and --theirs is our replayed
# publication (REBASE_HEAD).
resolve_model_conflicts() {
  for model in $(git diff --name-only --diff-filter=U | grep '^data/[^/]*/' | cut -d/ -f2 | sort -u); do
    side=$(python3 - "$model" <<'PY'
import json, subprocess, sys

model = sys.argv[1]

def reference_time(rev):
    show = subprocess.run(
        ["git", "show", f"{rev}:data/{model}/manifest.json"],
        check=True, capture_output=True, text=True,
    )
    return json.loads(show.stdout)["referenceTime"]

print("theirs" if reference_time("REBASE_HEAD") > reference_time("HEAD") else "ours")
PY
    )
    git diff --name-only --diff-filter=U | grep "^data/$model/" | while IFS= read -r path; do
      git checkout "--$side" -- "$path"
      git add "$path"
    done
  done
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
# A code push can land while a build runs, and the provider jobs race
# each other's data commits; retry instead of stranding the run on the
# runner. Conflicts under data/<model>/ resolve by referenceTime
# (resolve_model_conflicts above); a conflict on runs.json alone resolves
# by regeneration from the merged manifests.
for attempt in 1 2 3 4 5; do
  git push && exit 0
  if git pull --rebase; then
    # Clean rebase: fold a freshly regenerated index into our commit in
    # case upstream brought newer manifests our committed index predates.
    regenerate_runs_index
    git diff --cached --quiet || git commit --amend --no-edit
    continue
  fi
  if git diff --name-only --diff-filter=U | grep -qv '^data/'; then
    echo "Rebase conflict outside data/ is not ours to resolve; aborting." >&2
    git rebase --abort
    exit 1
  fi
  resolve_model_conflicts
  regenerate_runs_index
  # A dropped duplicate publication leaves nothing on top of upstream;
  # --continue would balk at the empty commit, so skip it instead.
  if git diff --cached --quiet HEAD; then
    git rebase --skip
  else
    GIT_EDITOR=true git rebase --continue
  fi
done
git push
