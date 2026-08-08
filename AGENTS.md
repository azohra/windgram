# Working conventions

For anyone — human or agent — working in this repository.

- `research/` holds the research ledger's entries: dated stories of work
  done, carefully authored, published on the site and rendered on GitHub.
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
  (register new pages in `site/src/lib/research.ts`). Not every change is
  a story; every change keeps the published prose true.
- Decisions are argued on their own terms — correctness, physics, contract
  honesty, accessibility — never by appeal to any one downstream consumer's
  needs, habits, or users. Anything a consumer could legitimately want
  different (palette, windows, thresholds, sink rates) is a token or
  parameter here, and the choice belongs downstream.
- One home per quantity: the pipeline owns derived values needing inputs
  beyond the published JSON (thermal velocity, boundary-layer top, cloud
  base, usable-lift top); the `windgram` package owns everything that is a
  pure function of published documents, plus the reference renderer and its
  default tokens. Neither restates the other's facts, formulas, or values —
  consumers inherit package exports or override them, never copy them.
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
