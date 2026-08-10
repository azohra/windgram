# windgram.azohra.com

Astro renders the research articles in `src/content/research/`, and the learning, model,
publishing, and reference guides — including the living forecast model feed reference — in
`src/content/docs/`.
Teaching figures use deterministic synthetic profiles bundled at build time. Normal site routes do
not fetch the launch catalogue, current manifests, or current profiles in the browser.

## Developing

```sh
pnpm install
pnpm dev      # http://localhost:4321
pnpm check    # typecheck
pnpm build    # -> dist/
```

## Source map

- `src/lib/catalogue.ts` — parses the repo's `models.json` through the
  package contract at build time, so catalogue drift fails the build
  before capability and horizon figures are generated.
- `src/lib/scenarios.ts` — eagerly validates generated teaching profiles and
  exposes them to the site as immutable build inputs.
- `src/components/labs/` — interactive teaching figures driven by those
  synthetic profiles and the `windgram` package's derivation and rendering
  authorities.
- `src/components/docs/`, `research/`, `about/`, `home/` — figure and page
  compositions, housed by the page family that consumes them; the shared
  figure frame lives in `src/components/figure/`.
- `src/content/docs/docs/` — the Starlight documentation portal, including learning, model,
  publishing, and reference routes (the living forecast model feed reference is
  `reference/forecast-model-feeds.mdx` in that collection).
- `src/content/research/*.mdx` — the canonical research entries, with validated metadata and
  explicit figure placement. `src/lib/research.ts` derives archive, navigation, and related-entry
  metadata from the content collection.

## Deploying

Hosted on Cloudflare's unified Workers Builds, connected directly to this
repo, deployed as a Worker serving static assets (`wrangler.jsonc`'s `assets`
block) rather than a classic Pages project:

- Root directory: `site`
- Build command: `pnpm build`
- Deploy command: `pnpm dlx wrangler deploy`
- Build watch paths: `site/**` and `scenarios/**`; every article and reference page lives
  under `site/src/content/` and rebuilds through `site/**`, while generated teaching
  scenarios rebuild through their own path.
