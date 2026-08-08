# Why the stability ramp trades contrast for order

The stability field is the largest painted surface on a windgram, and its eight-class palette is
load-bearing in a way no line colour is: adjacent fills are the encoding. This entry records how the
default ramp was derived — a defect that was measurable but never visible, two legitimate palette
philosophies, and an optimizer that ran into the boundary between them. Past that boundary a palette
can maximize adjacent contrast or preserve its ordering, but not both. The default chooses order.

Every number below is reproducible: colour difference is ΔE, Euclidean distance in the OKLab colour
space scaled by 100, and colour-vision deficiency is simulated with the Machado–Oliveira–Fernandes
(2009) matrices at full severity — the thresholds quoted are calibrated to that simulation. The
figures compute their values at build time from the palettes the package actually exports, so the
article cannot drift from what renders.

## A defect measured before it was seen

The ramp this project's site first rendered is recorded here because this entry is now its only
record: `#d95f52 #d98243 #c48abd #aaa0cf #d7b29b #768bb9 #b3b9b6 #858d89`, most unstable first. It
had been looked at plenty and read well at a glance — warm unstable end, cool stable end. A palette
validator found what no reviewing eye had: the two purples, `#c48abd` and `#aaa0cf`, sat at adjacent
ΔE 6.4 — and 2.8 under deuteranopia, where roughly 6 is the floor for telling adjacent fills apart
and 2.8 is one colour. Those two purples are the fills for conditional-strong and conditional
instability (the classes are defined in [Reading a windgram](reading-a-windgram.md)), so the palette
was quietly erasing a boundary the chart exists to draw. The validator also found the warm arm's
lightness non-monotonic — the ramp brightened toward near-neutral before darkening again — so a
grayscale print scrambled the class order outright.

The point is not that the palette was carelessly made. It was made the way most chart palettes are
made, by eye, and the eye signed off. The defect lived below the threshold of design-by-eye and
above the threshold of measurement, which is an argument about process, not talent: once a palette
is measurable, "looks right" stops being the acceptance test.

## The categorical answer canadarasp gives

The windgrams this project descends from are [canadarasp](https://github.com/ajberkley/canadarasp)'s,
and its stability palette answers the colour question with a different, entirely coherent
philosophy. Its band colours are categorical: chosen for maximal pairwise pop — its adjacent pairs
measure ΔE 11 to 30, the strongest of them almost three times this project's ramp — with the class
*ordering* carried by the legend and by many seasons of pilot memory rather than by the colours
themselves. Under grayscale or simulated colour-vision deficiency the sequence scrambles, which is
not a flaw in the design but its declared cost profile: a categorical palette answers "which class
is this?" and delegates "which direction is more unstable?" to the legend. (The old ramp's failing
pair is an echo of this ancestry: pale pink beside pale lavender, the same two classes, softened
until the pair collapsed.)

The archaeology of that palette turned out to be worth the dig, and two details belong here. First,
an apparent mismatch dissolved in canadarasp's own source: it contours nine lapse-rate boundaries
where this project draws eight classes, but the extra −0.5 °C per 1,000 ft boundary paints the same
colour on both sides — eight visible bands after all, and their boundaries are exactly the classes
this pipeline publishes. Second, the colormap file's own comment records the design's pivot in six
words: "matching the background is stable". The chart background *is* the stable colour, stable air
disappears into the page, and everything painted is signal. That is a deliberate, opinionated design
move, and it is why the preset below carries canadarasp's background alongside its ramp. The full
extraction — every hue cited to its line in canadarasp's source, verified 2026-08-08 — lives in
[`CANADARASP_PRESET`](../packages/windgram/src/presets/index.ts).

## Making the order the encoding

The other philosophy makes the order itself the encoding. If lightness falls strictly monotonically
from most unstable to most stable, the ramp's *sequence* survives every channel that destroys hue:
grayscale printing, protanopia and deuteranopia, a photocopied flight-planning sheet. No legend is
required to answer the directional question, because darker simply is more stable. The first
validator-derived ramp did exactly that — strictly monotone OKLCH lightness, the warm arm carrying
the unstable half, a neutral pivot at near-neutral, a cool arm for the stable half — and lifted the
worst adjacent pair from the old ramp's 6.4 to ΔE 8.1.

## Annealing toward the boundary

8.1 left room, and the polish was a constrained simulated annealer over OKLCH. The hard constraints
encode the ordinal philosophy: strictly monotone lightness with bounded steps, the warm-to-cool
reading direction held by per-class hue bands, muted field chroma, floors on the colour-vision ΔE,
and the light end held at 2:1 contrast against the chart surface. The objective is simply to
maximize the minimum adjacent ΔE under normal vision. The result is the shipped default,
[`STABILITY_TOKEN_DEFAULTS`](../packages/windgram/src/svg/index.ts): minimum adjacent ΔE 11.0 under
normal vision, 7.7 under protanopia, 8.9 under deuteranopia, with lightness falling monotonically
from 0.787 to 0.334 and no adjacent grayscale step smaller than 0.05.

## Contrast without order

The most instructive run is the one that was allowed to fail. Released from the ordering
constraints — no monotone lightness, no hue arms, only the colour-vision floors still standing —
the annealer reached a minimum adjacent ΔE of 16. Every solution in that regime is a
categorical zigzag: hue alternating band by band, the single warm-to-cool sweep gone, the ordinal
read destroyed. Told only to maximize adjacent difference, the optimizer rediscovers the categorical
philosophy from scratch — which is the measured boundary this entry is really about. Between ΔE 11
and ΔE 16 for this field, contrast is bought by spending order. The two philosophies are not a right
one and a wrong one; they are two points on a frontier, and a default has to stand somewhere on it.

## Defaults are argued; familiarity is a preset

Where it stands is a governance question, and the rule this project uses is: defaults are argued on
accessibility and correctness — claims anyone can re-run — and familiarity ships as a verified
option. A pilot with years of canadarasp's colours in their head loses real reading speed on an
unfamiliar ramp, and that cost is legitimate. So the package carries canadarasp's actual palette,
cited hue by hue to its source, as a preset a consumer applies in one move; the
[package README](../packages/windgram/README.md) documents how. Neither palette wins. One answers
"which class is this?" at maximum volume and hands the ordering to a legend; the other makes the
ordering unlosable and accepts a quieter chart. The default takes the second answer because it is
the one that still works on the worst display, in the worst light, for the most eyes — and because
it was derived by a procedure that can be argued with, which is the property this project cares
about most.
