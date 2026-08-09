# Club publisher example

This example publishes one configured launch from a fixed synthetic,
model-shaped source. The Python pipeline derives the profile. The `windgram`
npm package validates the site catalogue, profile, and manifest, builds the
scene in the launch's declared timezone, and writes a self-contained SVG, its
scene-derived key, and an HTML page.

The [Run one model guide](../../site/src/content/docs/docs/publish/run-one-model.mdx#run-the-provider-free-example)
documents the source-checkout commands.

The command writes:

```text
public/
  index.html
  assets/example-ridge-key.svg
  assets/example-ridge.svg
  data/synthetic-club-demo/manifest.json
  data/synthetic-club-demo/sites/example-ridge.json
```

The page selects one synthetic profile directly. Its manifest/profile pair
supplies publication identity. Add the model catalogue and cross-model run
index when the consuming surface supports discovery or aggregate freshness.

[`render.mjs`](render.mjs) owns this reader's presentation choices. The
[scene guide](../../site/src/content/docs/docs/typescript/scene.mdx) defines the
options; the [SVG guide](../../site/src/content/docs/docs/typescript/svg.mdx)
defines scene-derived key semantics.

`public/` is a complete static tree. Copy it to static hosting or a downstream
build; the publisher supplies its access, presentation, and retention policy.
