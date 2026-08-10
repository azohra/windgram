#!/bin/sh
# Uploads one model's freshly built outputs from the scratch data/ tree to
# the public R2 bucket behind https://data.meteo.azohra.com. Called after
# every model build so a completed model is published even if a later
# builder or the job's timeout kills the run.
#
# Requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / R2_ENDPOINT in the
# environment (the workflow maps them from repo secrets).
set -eu

model="$1"
bucket="s3://meteo-data"
# Everything that changes with the next run rides a short TTL; only month
# archives that can no longer receive an append are immutable.
short="public, max-age=300"
closed="public, max-age=31536000, immutable"

s3() {
  aws s3 "$@" --endpoint-url "$R2_ENDPOINT"
}

# The builder writes nothing when the published run is current, so an
# absent manifest means there is nothing new to upload for this model.
if [ ! -f "data/$model/manifest.json" ]; then
  echo "No new $model output to upload."
  exit 0
fi

# Never publish backwards: a scratch tree older than the published dataset
# (a stale checkout, a replayed job) must not overwrite newer objects.
freshness=$(uv run --no-dev --project pipeline python -c "
import json, sys
from windgram import dataset
local = json.load(open('data/$model/manifest.json'))
published = dataset.published_manifest('$model')
fresh = published is None or published['generatedAt'] < local['generatedAt']
print('fresh' if fresh else 'stale')
")
if [ "$freshness" != "fresh" ]; then
  echo "Published $model manifest is not older than the local one; skipping upload."
  exit 0
fi

# Month archives close when no run with a referenceTime in that month can
# still arrive. A run started just before a month boundary appends to the
# previous month after it, so the previous month stays on the short TTL
# too; anything older is genuinely closed.
open_months=$(python3 -c "
from datetime import date, timedelta
first = date.today().replace(day=1)
print(first.strftime('%Y-%m'), (first - timedelta(days=1)).strftime('%Y-%m'))
")
current_month=${open_months% *}
previous_month=${open_months#* }

# History before profiles before the manifest: the manifest is the
# publication's commit point, so nothing it references appears after it.
if [ -d "data/$model/history" ]; then
  s3 sync "data/$model/history" "$bucket/$model/history" \
    --exclude "*" \
    --include "*/${current_month}.jsonl.gz" --include "*/${previous_month}.jsonl.gz" \
    --cache-control "$short" --content-type application/gzip
  s3 sync "data/$model/history" "$bucket/$model/history" \
    --exclude "*/${current_month}.jsonl.gz" --exclude "*/${previous_month}.jsonl.gz" \
    --cache-control "$closed" --content-type application/gzip
fi
s3 sync "data/$model/sites" "$bucket/$model/sites" \
  --cache-control "$short" --content-type application/json
s3 cp "data/$model/manifest.json" "$bucket/$model/manifest.json" \
  --cache-control "$short" --content-type application/json

# The authored catalogues publish at the bucket root; re-uploading them
# with every model keeps the bucket following the source checkout.
#
# Never publish backwards here either: a build runs up to an hour, so a
# job checked out before a merge can upload after a job checked out after
# it and stomp the catalogues back to the old version (measured
# 2026-08-10: post-merge upload 21:20:33Z, pre-merge re-stomp 21:21:15Z).
# The checkout's HEAD commit epoch orders checkouts — every job checks
# out main's tip, and the epoch survives the workflow's default
# fetch-depth-1 clone, where per-file commit times do not exist. The
# epoch rides as object metadata on each catalogue; absent metadata
# (objects published before this guard) reads as 0, and an equal epoch
# re-uploads, so the same checkout can republish itself. A head-then-put
# race remains — R2 offers no compare-and-swap — but the guard shrinks
# the window from the length of a build run to milliseconds.
catalogue_epoch=$(git log -1 --format=%ct)
published_epoch=$(aws s3api head-object \
  --bucket "${bucket#s3://}" --key models.json \
  --endpoint-url "$R2_ENDPOINT" \
  --query 'Metadata."catalogue-commit-epoch"' --output text \
  2>/dev/null || true)
case $published_epoch in
  '' | *[!0-9]*) published_epoch=0 ;;
esac
if [ "$published_epoch" -gt "$catalogue_epoch" ]; then
  # The three catalogues skip as a set: they were committed together and
  # must stay coherent with each other on the bucket.
  echo "Published catalogues come from a newer checkout; skipping catalogue upload."
else
  s3 cp models.json "$bucket/models.json" \
    --metadata "catalogue-commit-epoch=$catalogue_epoch" \
    --cache-control "$short" --content-type application/json
  s3 cp sites.json "$bucket/sites.json" \
    --metadata "catalogue-commit-epoch=$catalogue_epoch" \
    --cache-control "$short" --content-type application/json
  # site-context.json is machine-generated but committed like a catalogue
  # (regenerated only when the site catalogue changes), so it publishes the
  # same way. Tolerate absence: checkouts predating the terrain wave.
  if [ -f site-context.json ]; then
    s3 cp site-context.json "$bucket/site-context.json" \
      --metadata "catalogue-commit-epoch=$catalogue_epoch" \
      --cache-control "$short" --content-type application/json
  fi
fi

# runs.json is regenerated from every model's *published* manifest (model
# list from models.json, never-published models tolerated), so the index
# is a pure function of the dataset and concurrent lanes converge on
# whoever uploads last. It stays outside the catalogue guard for the same
# reason: a stale write self-heals on the next model upload.
uv run --no-dev --project pipeline python -c \
  "from windgram.publish import write_runs_index; write_runs_index()"
s3 cp data/runs.json "$bucket/runs.json" \
  --cache-control "$short" --content-type application/json
