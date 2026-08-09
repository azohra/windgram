# Retiring 121 metres per degree

Cloud base was the last published quantity still computed by a rule of thumb: 121 m of climb for
every degree of surface dew-point depression. This entry records the pipeline's first science change
since the derivations became their own baseline — an exact lifted condensation level, a floor drawn
from the model's own moisture column, and one measured consequence that justified the whole
exercise: afternoon hours that looked cloud-capped actually hit the sink crossing hundreds of metres
lower.

## An estimate with a lineage

The constant is old and honourable. Approximating condensation height as a fixed climb per degree of
temperature–dew-point spread goes back to James Espy's nineteenth-century cloud observations, and
121 m/°C is the value canadarasp's windgram scripts used. This pipeline inherited it the way it
inherited the strongest-core updraft profile and the 1 m/s sink threshold: ported
constant-for-constant, because during the schema migration the derivations were the verification
oracle — the one thing deliberately held fixed while everything around them moved. That debt is
recorded with gratitude in [How a windgram is computed](windgram-derivations.md); the estimate
served canadarasp's pilots for years and served this project as its proof of equivalence.

An oracle's virtue is constancy, not precision. Once the migration closed, the linear estimate
stopped being an asset and became an approximation of a quantity the pipeline could compute exactly
— from numbers it was already publishing.

## The exact answer costs nothing the documents don't already carry

The parcel LCL needs exactly two inputs: surface temperature and surface dew point. Every builder
publishes both — the ECCC deterministic family, the NOAA family including the newly adopted NAM
pair, and both ensembles, whose members each carry their own surface fields, so the change flows
through REPS and GEPS percentiles with no per-model work at all. The derivation stays one shared
function of the source column; no builder was touched.

Between the exact formulas, pragmatics decided. Romps (2017) gives the closed-form LCL, but it needs
the Lambert W function — a dependency, in a pipeline that is deliberately standard-library-only.
Bolton (1980, eq. 15) gives the LCL temperature explicitly from temperature and dew point, accurate
to 0.1 K, and agrees with Romps to about 1% in height across the meteorological range. The code
cites both and uses Bolton; the equation and its constants now live in the
[derivations article](windgram-derivations.md) and in `windgram/windgram.py`.

## Believe the column when it shows cloud below the parcel

A parcel LCL answers one question: where would air lifted from the model surface condense. The model
column answers another: where has the model already put cloud. When a published level saturates
below the parcel LCL — dew-point depression down at the same 0.5 °C the renderer hatches as dense
cloud, with the crossing interpolated between samples — a climb meets cloud there, whatever the
surface parcel says. So the published `cloudBaseM` is now the lower of the two answers, clamped to
model terrain.

The threshold is deliberately the hatch threshold. Before this change 0.5 °C was a display choice;
now it is load-bearing: the cloud-base line can never sit above a layer the chart cross-hatches as
saturated, so the two moisture signals can no longer contradict each other on height.

## What changed, measured

Both committed real columns were re-derived old-versus-new: the 15-hour HRDPS column behind the
package's pipeline-parity fixture and the 10-hour HRRR column behind the site's fixed forecast
example. Both are dry columns — no hour triggers the saturated-layer floor, which is exercised by
synthetic tests instead — so the measured shift is pure Bolton-versus-121:

| Column | Hours | Cloud-base shift, new − old (min / median / max) |
| --- | --- | --- |
| HRDPS 2.5 km, Dundee | 15 | +34.9 / +42.1 / +58.2 m |
| HRRR CONUS, Red Mtn | 10 | +36.3 / +45.2 / +51.1 m |

The direction is uniform: at these warm surface temperatures the true condensation slope runs
nearer 124 m/°C, so the inherited 121 sat 35–58 m low. A modest, honest correction — and not the
interesting one.

The interesting one is what the low cloud base had been hiding. The usable-lift derivation walks the
retained levels and, on reaching one above cloud base, publishes the cap — trusting lift to persist
that far. Four hours across the two columns changed:

| Hour (UTC) | Column | Old `usableLiftTopM` | New `usableLiftTopM` | Change |
| --- | --- | --- | --- | --- |
| 08-08 19:00 | HRDPS | 3,733.8 m (cloud-capped) | 3,254.3 m (sink crossing) | **−479.5 m** |
| 08-08 20:00 | HRDPS | 3,759.0 m (cloud-capped) | 3,659.9 m (sink crossing) | **−99.1 m** |
| 08-08 21:00 | HRDPS | 4,118.2 m (cloud-capped) | 4,173.5 m (cloud-capped) | +55.3 m |
| 08-08 22:00 | HRRR | 3,037.1 m (cloud-capped) | 3,086.5 m (cloud-capped) | +49.4 m |

In the two de-capped hours, the old cloud base sat just below the 650 hPa level, so the scan stopped
and published the cap without ever evaluating the core there. Raising cloud base ~56 m let the scan
reach that level, find the strongest core already dead, and interpolate the real sink crossing —
480 m below what the chart had been advertising at 19:00. The old answer was not 56 m optimistic; it
was hiding a crossing half a kilometre down. That is the de-capping finding, and it is the reason an
exact cloud base matters beyond tidiness: the cap is only as honest as the base that draws it.

The usable-lift derivation itself is untouched — same profile, same constants, as
[Why usable lift can sit above the boundary layer](usable-lift-and-boundary-layer.md) describes.
Every shift above enters through its cloud-base input alone. Boundary-layer top and thermal velocity
are moisture-free and did not move.

## What stays fixed

Published history is append-only: documents already in the archive keep the values they were built
with, and the renderer keeps drawing committed documents byte-for-byte — the reference goldens did
not change. The parity fixture, whose contract is "current pipeline output, unrounded", was
regenerated, and the package's parameterized `usableLiftTopM` still reproduces the pipeline's
published value float-exactly at the default sink rate. From the next run onward, every model —
deterministic and ensemble alike — publishes the exact base.
