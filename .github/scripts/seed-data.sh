#!/bin/sh
# One-time bucket fill: uploads the checkout's entire data/ tree plus the
# root catalogues to the public R2 bucket with the same Cache-Control
# policy the scheduled uploads apply (.github/scripts/upload-data.sh).
# Deleted, together with data/, once the dataset is served from R2.
set -eu

bucket="s3://meteo-data"
short="public, max-age=300"
closed="public, max-age=31536000, immutable"

s3() {
  aws s3 "$@" --endpoint-url "$R2_ENDPOINT"
}

# Current and previous months can still receive appends (a run started
# just before a month boundary lands after it); anything older is closed.
open_months=$(python3 -c "
from datetime import date, timedelta
first = date.today().replace(day=1)
print(first.strftime('%Y-%m'), (first - timedelta(days=1)).strftime('%Y-%m'))
")
current_month=${open_months% *}
previous_month=${open_months#* }

s3 cp models.json "$bucket/models.json" \
  --cache-control "$short" --content-type application/json
s3 cp sites.json "$bucket/sites.json" \
  --cache-control "$short" --content-type application/json

# Closed month archives first, then the still-open months.
s3 sync data/ "$bucket/" \
  --exclude "*" --include "*/history/*" \
  --exclude "*/history/*/${current_month}.jsonl.gz" \
  --exclude "*/history/*/${previous_month}.jsonl.gz" \
  --cache-control "$closed" --content-type application/gzip
s3 sync data/ "$bucket/" \
  --exclude "*" \
  --include "*/history/*/${current_month}.jsonl.gz" \
  --include "*/history/*/${previous_month}.jsonl.gz" \
  --cache-control "$short" --content-type application/gzip

# Everything else — manifests, current profiles, runs.json — changes with
# the next run: short TTL.
s3 sync data/ "$bucket/" \
  --exclude "*/history/*" \
  --cache-control "$short" --content-type application/json
