# Adopting a model two months before its retirement

Four candidate models went through feed verification in one sitting — NOAA's NAM, both its 12 km
parent and its 3 km CONUS nest, NOAA's RAP, and DWD's global ICON. Partway through, a service
change notice reframed the whole exercise: NAM is terminated on 2026-10-06, the day its successor
becomes operational. The obvious verdict is to skip a model with two months to live. This entry
records why the catalogue adopted it anyway, the schema machinery that adoption forced into
existence, and a debt the evaluation exposed in two models already being served.

## The notice that reframed the evaluation

The NAM feeds themselves verified cleanly — the
[feed reference](../reference/forecast-model-feeds.md) records the inventories, the product split,
and the decode-level semantics, as it does for every supported model. What changed the question was
NCEP's SCN 26-48: the Rapid Refresh Forecast System and its ensemble replace NAM, HREF, SREF, and
all HiresW domains but Guam, with implementation and retirement on the same day. There is no overlap era to enjoy.
A builder written for NAM starts its life with a death date.

Skipping it would have been defensible. Builders are real work, and code written for a feed that
stops answering is the least dignified kind of dead code. The reason to build anyway came from
verifying the successor first.

## The successor was verified before the predecessor was adopted

RRFS's prototype output checked out against the same contract the catalogue holds every model to,
and one fact carried the decision: its CONUS cutout is exactly the grid the NAM nest already runs
on — which is itself exactly HRRR's grid. The builder the NAM nest needs is, to a first
approximation, the builder RRFS will need, minus a filename scheme and one field-semantics
difference. Adopting NAM now is not two months of throwaway work; it is the RRFS port started
early, with two months of production shakedown against a live feed and two months of NAM columns
accumulating in the forecast history before the switch.

The succession is also a simplification. Today NAM must be two catalogue entries, because the
parent and the nest are separately integrated models with different grids, horizons, and cadences.
On cutover day both entries end and a single `rrfs` entry replaces them, carrying the nest's
3 km resolution and the parent's 84-hour horizon in one model. Two entries collapse into one
better one — a rare direction for a catalogue to move.

## Sunset is data, not prose

A retirement date that lives only in reference prose is a fact consumers cannot act on. So the
catalogue schema gained a `sunset` field: a date and a successor slug, declared on both NAM
entries from the day they were published (see [`data/models.json`](../data/models.json)). A
frontend can say "this model retires on this date, and this one replaces it" without parsing any
prose; `successor: null` remains available for a true end-of-life with no replacement.

The field was designed for more than this episode. RAP's lifetime is bounded by RRFS's second
version, and eventually HRRR's is too — when those dates firm up, they become `sunset`
declarations, not surprises.

## The evaluation exposed a debt in models already served

Inventorying vertical velocity across the candidates meant inventorying it across the incumbents,
and the result was uncomfortable: HRRR and GFS have always published omega at every curated
pressure level, through their full horizons. The catalogue declared `verticalVelocity: false` for
both — not because the feeds lacked the field, but because the builders never fetched it. A
declaration that is supposed to mean "the model does not publish this" was quietly meaning "we
never asked". That is exactly the kind of dishonesty the capability system exists to prevent, so
the debt was paid in the same change: both builders now fetch and publish omega, and the
[feed reference](../reference/forecast-model-feeds.md) records the verification.

The fix also changed the declaration's type. RRFS does not publish omega at all — its vertical
velocity is geometric w in m/s — so the port will convert at build time (ω ≈ −ρgw, with density
from the level temperature and moisture) rather than leave the capability false. That conversion
is representation normalization, the same family as dew point from relative humidity or
grid-relative wind rotation, so it belongs in the pipeline — `derive` stays a set of pure
functions of published state. But a converted quantity should not masquerade as a native one:
`verticalVelocity` is now a provenance token — `"omega"`, `"fromGeometricW"`, or `false` — in the
same spirit as the gust declaration, which already distinguishes an hour-maximum from an
instantaneous sample instead of claiming mere presence.

## Two candidates declined, on the record

RAP was not adopted. It survives the October retirements and cycles hourly, but everything it
publishes for this product HRRR already publishes at finer resolution from the same buckets, and
its own successor is scheduled. The [feed reference](../reference/forecast-model-feeds.md) records
the verified details, so the omission reads as a decision rather than a blind spot.

ICON global was not adopted for now — the harder call of the two. It is the only candidate that
would add a physics and data-assimilation lineage from outside North America, which is genuine
disagreement signal no NOAA or ECCC sibling can supply. The cost is not the physics but a new
transport, and several contract fields it cannot fill; the feed reference records both sides.
The catalogue can revisit it, and the entry it would occupy is a judgment call deferred, not a
door closed.

## Slugs name legs, not descriptions

Adding models forced the catalogue to answer what a slug is before minting more of them. The
tempting answer embeds description — a slug like `gdps-15km` reads naturally right up until the
provider upgrades the grid, and then the name either lies or forces the rename-on-continuity that
identity exists to prevent. GDPS has already changed resolution once in its lifetime; GFS twice;
RRFS will change engines without changing its name. So the rule: a slug names a feed leg and
survives everything the provider presents as continuity — resolution, grid, even model engine.
Display strings compose resolution from the catalogue's `gridKm`; successors get new slugs plus
`sunset`, never renames.

The discipline has one subtle clause, and it was a reviewer's catch. Qualifiers belong only to
siblings that are separately integrated or separately cycled: the NAM nest earns
`nam-conus-nest` — NCEP's own token — because it is a distinct integration nested in the parent.
RRFS's `conus`, `ak`, `hi`, and `pr` files look superficially similar but are distribution
cutouts of one 3 km North-America integration, so the future slug is `rrfs`, not `rrfs-conus`:
which cutout a builder fetches is transport detail, and naming it would mint two "models" out of
one the day a site crosses a cutout boundary. Cutouts share a slug; legs get their own.
