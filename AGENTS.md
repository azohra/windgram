# Working conventions

For anyone — human or agent — working in this repository.

- `site/src/content/research/` holds the research ledger's entries: dated
  stories of work done, carefully authored, published on the site and rendered
  on GitHub. `research/README.md` is the repository-facing index.
  `reference/` holds living documents (the model bestiary) kept current
  against the providers. Never put working notes, roadmaps, speculation, or
  session findings in either. Substantive rewrites of existing prose are
  proposed to the author, not landed unilaterally. No product language, no
  site-name fixation (the catalogue grows), no repeating a fact two places.
  No competitive framing against other projects (canadarasp, soaringmeteo,
  …): credit predecessors gratefully; describe differences in job and
  architecture, never as a scoreboard.
- Work that ships lands with its writing in the same change: update the
  research articles and reference documents the work makes stale, and
  write a new dated entry only when the work genuinely yields an article
  (a new page is a content entry in `site/src/content/research/`; its
  frontmatter is the registration — there is no separate registry). Not
  every change is a story; every change keeps the published prose true.
- Decisions are argued on their own terms — correctness, physics, contract
  honesty, accessibility — never by appeal to any one downstream consumer's
  needs, habits, or users. Anything a consumer could legitimately want
  different (palette, windows, thresholds, sink rates) is a token or
  parameter here, and the choice belongs downstream.
- One authority per published quantity: the pipeline owns stored values that
  need provider inputs or cross-run authority (thermal velocity,
  boundary-layer top, cloud base, and the default usable-lift top); the
  `windgram` package owns pure functions of published documents, the reference
  renderer, and its default tokens. The parameterized `usableLiftTopM` is the
  explicit cross-runtime exception: it projects published inputs for another
  sink rate, while the pipeline's 1.0 m/s value remains authoritative and
  parity-tested. Any other re-expression requires a contract decision.
- Verify before code: provider facts — fields, levels, semantics,
  sentinels, packing, rate limits — are verified against the live feeds
  before any builder consumes them, and recorded with a dated
  `[verified YYYY-MM-DD]` in `reference/`. Community folklore and prior
  notes are hypotheses, not sources.
- Catalogue honesty: a model exists when `data/models.json` declares it —
  capabilities, levels, semantics, and cadence stated exactly as published,
  with absences declared rather than papered over. Capabilities must match
  builder behaviour (tests enforce it); frontends render the declaration,
  not an assumption.
- `notes/` (gitignored) is for working docs: verification spikes, design
  notes, findings, drafts awaiting review — never committed.
- pnpm is pinned via `packageManager` at the workspace root; the root
  lockfile governs `site/` and `packages/*`.
