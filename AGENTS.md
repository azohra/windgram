# Working conventions

For anyone — human or agent — working in this repository.

One principle carries this file: these are forecasts people act on, so
plausible-but-wrong is the failure mode. Everything below is a mechanism
against it.

- Sell it by showing it: real output, real commands. Name and thank the
  projects this one builds on.
- Provider facts are verified against the live feeds (dated `[verified]`
  stamps in `reference/`); community folklore is hypothesis.
- `data/models.json` declares what each model publishes, absences included;
  tests hold it to builder behaviour.
- Each fact has one home: the pipeline owns stored derivations, the
  `windgram` package owns pure functions of published documents, prose
  states a thing once and links to it.
- Work ships with its writing; substantive rewrites of existing prose are
  proposed to the author.
- Consumer preferences — palette, thresholds, windows, sink rates — are
  parameters, not decisions made here.
- `notes/` (gitignored) holds working docs. pnpm is pinned at the
  workspace root.
