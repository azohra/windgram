# The stability field is background

The stability field is the largest painted surface on a windgram — and it is not the data. It is
the layer everything a pilot actually came to read is drawn on top of: the usable-lift line, cloud
base, the wind barbs, the isotherm labels, the markers. That one fact decides the palette. This
entry records what the shipped eight-class ramp promises, what it deliberately does not, and the
one measured defect in its lineage that a validator caught where every reviewing eye had signed
off.

Every number here is reproducible: colour difference is ΔE, Euclidean distance in the OKLab colour
space scaled by 100, with colour-vision deficiency simulated by the Machado–Oliveira–Fernandes
(2009) matrices at full severity. The shipped palette's figures compute their values at build time
from the package export, so the article cannot drift from what renders.

## What a background field owes its chart

Figure-ground contrast comes first. Every point of saturation a field palette spends on itself is
taken from the legibility of the content above it, so the whole ramp lives in a pale register —
roughly thirty points of lightness, all of it near the paper. Salience still works, because
salience is relative: with the field quiet, the warm unstable classes are the loudest thing on the
chart without spending any ink mass, and the classes that dominate an ordinary summer field —
conditional instability, stable air — recede instead of shouting. A field earns attention for its
exceptions by being quiet about its rule.

The register has a price, and it is paid openly: thirty points of lightness across eight classes
cannot also carry a grayscale-survivable ordering, so none is claimed. Class *identity* rides hue;
class *order* rides the channels the chart already has — the key names every cell in plain words,
the cursor readouts state the class at any point, and the field's own geometry orders it (stable
air sits where stable air sits). The palest cells stand near 2:1 against the surface because
receding into the page is the design, not an accident.

## The lineage, and the pivot that does not transfer

The hues descend from [canadarasp](https://github.com/ajberkley/canadarasp), the project these
windgrams gratefully descend from: warm reds and oranges for instability, pink and lavender for the
conditional middle, a tan pivot, blue for stable, greys for inversion. Two details from its source
are worth keeping on the record. It contours nine lapse-rate boundaries where this project draws
eight classes — but the extra −0.5 °C per 1,000 ft boundary paints the same colour on both sides,
so there were eight visible bands all along, and their boundaries are exactly the classes this
pipeline publishes. And its colormap file states its design's pivot in six words: "matching the
background is stable" — stable air disappears into canadarasp's blue page, and everything painted
is signal. That pivot is brilliant on its own page and does not transfer: these charts sit on
paper, so this palette keeps stable air *pale* rather than invisible, and owes no debt to a
background it does not have.

## Measured, not eyeballed

The ramp's direct ancestor — the palette this project's site first rendered, tuned by eye in
exactly this register — carried a defect nobody saw: its two conditional purples sat at adjacent
ΔE 6.4, and 2.8 under deuteranopia, where roughly 6 is the floor for telling adjacent fills apart
and 2.8 is one colour. The most common form of colour-vision deficiency erased the boundary between
conditional-strong and conditional instability — a boundary the chart exists to draw. The defect
lived below the threshold of design-by-eye and above the threshold of measurement, which is the
process lesson: once a palette is measurable, "looks right" stops being the acceptance test.

The shipped default, [`STABILITY_TOKEN_DEFAULTS`](../packages/windgram/src/svg/index.ts), is that
palette hardened in place — five of eight values unchanged. The failing purples are pulled apart
(ΔE 2.8 to 7.0 under deuteranopia), the grey tail is internally light-ordered from stable through
strong inversion, and every adjacent pair now clears the 6.0 floor on every simulated axis (worst
pair: 7.0 deuteranopic, 6.8 tritanopic). The repairs were found the same way the defect was — a
validator over OKLab with CVD simulation — and are exactly as re-runnable.

## One look

The package ships this palette and no theme catalogue. Anything a consumer legitimately wants
different is a token: the eight `--wg-stab-*` custom properties restyle the field without forking
the renderer, which is precisely how the palette's own ancestor was built and tuned. Defaults are
argued on claims anyone can re-run — figure-ground first, worst-reader floors on the boundaries the
register can honestly hold, and the residue documented rather than pretended away.
