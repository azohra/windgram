# windgram.azohra.com

Astro renders the [research articles](../research/README.md) and
[forecast model feed reference](../reference/forecast-model-feeds.md). The reading
guide uses a fixed archived forecast; the model-selection entry fetches the
latest published JSON from `raw.githubusercontent.com` in the browser.

## Developing

```sh
pnpm install
pnpm dev      # http://localhost:4321
pnpm check    # typecheck
pnpm build    # -> dist/
```

## Source map

- `src/lib/api.ts` — fetches manifests and site profiles, validates them
  against `windgram/contract`, and enforces the reference-time skew guard
  the pipeline's docs specify (a manifest and a site file can briefly
  disagree about which run is current while GitHub's CDN converges).
- `src/lib/catalogue.ts` — parses the repo's `data/models.json` through the
  package contract at build time, so catalogue drift fails the build
  instead of shipping a picker that lies.
- `src/lib/app.ts` — the chart page: windgrams are rendered through the
  `windgram` workspace package (`scene` + `svg`); the app supplies day
  windowing, overlay toggles, tooltips, and storage around it.
- `src/lib/overlay.ts` — the multi-model comparison overlay, hand-built
  SVG over many profiles at once (a site feature, not part of the
  package).
- `src/lib/research.ts` — renders `../research/*.md` directly at build time. The articles
  stay single-sourced in the root `research/` folder; this only rewrites the
  relative links (`forecast-model-feeds.md`, `../windgram/windgram.py`, …) into
  site routes and GitHub links respectively, since those resolve differently
  on GitHub than on this site.

## Deploying

Hosted on Cloudflare's unified Workers Builds, connected directly to this
repo, deployed as a Worker serving static assets (`wrangler.jsonc`'s `assets`
block) rather than a classic Pages project:

- Root directory: `site`
- Build command: `pnpm build`
- Deploy command: `pnpm dlx wrangler deploy`
- Build watch paths: `site/**`, `research/**`, `reference/**`. Data commits remain
  excluded: live instruments fetch profiles at runtime, while article examples use
  an explicit fixture under `site/src/components/research/`.

## A known gap

`src/lib/time.ts` hardcodes `America/Vancouver` for all day-grouping and
hour labels, matching the founding catalogue. A site in another timezone
added to `sites.json` would need that threaded through per-site rather than
assumed — flagged there, not silently wrong.
