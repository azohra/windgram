# How a windgram is computed

Each weather model publishes atmospheric fields; one shared derivation turns an hourly vertical
column into stability, cloud base, thermal velocity,
boundary-layer top, and usable lift. Its constants and fallback rules define the product.

## Required surface and pressure-level fields

Every deterministic builder must supply the same source shape for each site and forecast hour:

| Part of the column | Fields |
| --- | --- |
| Surface | temperature, 10 m wind, cloud cover, dew point depression, sensible and latent heat flux, sea-level pressure, precipitation |
| Pressure levels | geopotential height, temperature, dew point depression, wind speed and direction |
| Terrain | model elevation at the launch grid cell |

The pressure levels are curated per model and declared in the model catalogue (`data/models.json`) —
the ECCC feeds publish a 14-level 1015–600 hPa band, the NOAA feeds the eight or nine levels their
files carry. The derivation is transport-independent and tolerates an absent level.

## 1. Discard levels below model terrain

Pressure levels are sorted by height and discarded unless they are finite and at least 20 m above
model terrain. In mountains, 925 hPa—and sometimes higher levels—can be underground. Plotting them
would invent an atmosphere beneath model terrain and corrupt every interpolation above it.

This filter makes model terrain data, not metadata. Change its elevation and boundary-layer depth,
surface parcel temperature, cloud-base elevation, and the set of valid pressure levels all change.

## 2. Build the stability and cloud fields

Between adjacent retained levels, local lapse rate is:

```
lapse = (T_next − T) / (z_next − z) × 304.8    # °C per 1000 ft
```

Negative means temperature decreases with height. The renderer classifies the result into eight fixed
stability bands. The renderer hatches a level as model cloud when its dew point depression — derived
from the published dew point — falls below 0.5 °C; the pipeline publishes the moisture, not the flag.

## 3. Estimate cloud base

The surface lifted condensation level uses the classic approximation of 121 m of climb per degree of
dew point depression:

```
cloudBaseM = modelElevationM + max(0, dewPointDepressionC) × 121
```

The result estimates a surface parcel; it does not forecast cloud by itself. Existing saturated layers come from
the pressure-level moisture field and are shown separately as hatching.

## 4. Lift the surface parcel

The surface parcel cools at 0.0098 °C/m as it rises dry adiabatically. The code walks upward until the
parcel is no longer warmer than the model environment, then intersects the parcel and environmental
temperature lines inside that layer. The crossing is `boundaryLayerTopM`.

If the parcel stays warmer than the entire available sounding, the top level is returned. That value is
a **column ceiling**, not evidence that mixing stops there; the ensemble work records this
kind of censoring explicitly.

## 5. Turn surface heating into w\*

Deardorff’s thermal velocity scale combines virtual heat flux and boundary-layer depth:

```
Q_v = SHTFL + 0.000245268 × T_K × LHTFL
θ   = T_K × (1015 / p_first)^0.28482
w*  = ((0.0075516 / θ) × Q_v × D)⅓
```

`D` is boundary-layer depth in metres. The latent term accounts for moist air’s buoyancy contribution;
the 0.0075516 factor folds gravity, air density, and heat capacity into compatible units. If virtual
heat flux or depth is non-positive, `w*` is zero. Night, rain, and heavily suppressed heating therefore
produce no thermal forecast by construction.

## 6. Find usable lift

canadarasp’s Hcrit logic evaluates the strongest-core profile described in
[Why usable lift can sit above the boundary layer](usable-lift-and-boundary-layer.md):

1. If `2.02 × w* < 1 m/s`, even the profile maximum cannot beat the sink threshold; publish null.
2. Start at 0.25 of the boundary-layer depth and evaluate
   `w* × 4 × (z/D)⅓ × (1 − 0.8z/D)` at each retained level.
3. Interpolate the first height where the core falls to 1 m/s.
4. Stop at cloud base if it comes first.
5. If the sounding ends before a crossing, fall back to boundary-layer top, still capped at cloud base.

The code publishes the result as `usableLiftTopM`; achieved altitude also depends on the air and pilot.
The windgram package exposes the same derivation with the sink rate as a parameter (`usableLiftTopM`
in `windgram/derive`, a pure function of the published document); the pipeline's published value is
the 1 m/s case, and a package test asserts the two agree exactly on a real profile.

## 7. Publish unsmoothed; smooth in the renderer

The pipeline publishes derived series exactly as computed. The renderer may apply a 1–2–1 temporal
kernel to cloud base and usable-lift top (`smooth121` in the windgram package, on by default to match
the historical look), and only across values exactly one hour apart — three-hourly models, missing
hours, boundary-layer top, and `w*` are never smoothed. Consumers who want the model's values read the
JSON; the smoothing is undoable because it no longer happens upstream.

## 8. Publish every hour; window in the renderer

Profiles carry every forecast hour, chronological. Day windowing (07:00–21:00 local, discard days with
fewer than five samples, fall back to all hours when none qualifies) moved to the windgram package with
the timezone and day bounds as parameters, so no consumer's clock is baked into the open dataset. The
published coordinates let a renderer derive local time for any site.

## Five constants define cloud base, lift, and hatching

| Constant | Meaning | Status |
| --- | --- | --- |
| 121 m/°C | surface LCL approximation | inherited |
| 0.0098 °C/m | dry adiabatic lapse | physical approximation |
| 4.0 | strongest-core profile coefficient | canadarasp choice |
| 1 m/s | glider sink threshold | canadarasp choice |
| 0.5 °C | saturated-level hatching threshold (renderer) | display choice |

Changing a constant creates a different metric. Name it separately and test it against the archive.

Executable authority: [`windgram/windgram.py`](../windgram/windgram.py), with exact assertions in
[`tests/`](../tests).
