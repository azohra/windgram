/* Parameterized usable-lift top — the pipeline's hcrit derivation with the
   pilot's sink rate exposed as a parameter.

   The pipeline publishes usableLiftTopM computed at a fixed 1.0 m/s sink
   rate (windgram/windgram.py, the one-home rule's authority). Every input
   that derivation needs is itself published — model elevation, the
   boundary-layer top, thermal velocity W* (already derived from the fluxes
   upstream), cloud base, and the level heights — so re-running it with a
   different sink rate is a pure function of the profile document. At the
   default 1.0 m/s this function reproduces the pipeline's published value
   exactly; tests assert that parity against a real pipeline-derived
   fixture.

   The physics is canadarasp's hcrit, ported constant-for-constant from the
   pipeline: the height where the STRONGEST core still out-climbs the sink
   rate. The updraft profile is W* × 4 × z^(1/3) × (1 − 0.8 z) with
   z = height / BL depth; the 4 is Lenschow & Stephens' average-updraft
   coefficient (1.34) times ~3 for the core, which is why the line can sit
   above the boundary layer — cores overshoot the mixed-layer top before
   they die. Cloud base caps the answer everywhere. */

export interface UsableLiftInputs {
  /** site.modelElevationM from the profile document. */
  modelElevationM: number;
  /** derived.boundaryLayerTopM (MSL); null when the hour has no boundary layer. */
  boundaryLayerTopM: number | null;
  /** derived.thermalVelocityMs (W*). */
  thermalVelocityMs: number;
  /** derived.cloudBaseM (MSL). */
  cloudBaseM: number;
  /** hours[].levels — only heightM is read; must be ascending like the document. */
  levels: ReadonlyArray<{ heightM: number }>;
}

/**
 * Height (MSL, metres) to which a pilot sinking at `sinkRateMs` can still
 * climb, or null when the strongest core never beats the sink rate. The
 * default 1.0 m/s reproduces the pipeline's published usableLiftTopM; other
 * sink rates answer "what about my glider?" without republishing anything.
 */
export function usableLiftTopM(inputs: UsableLiftInputs, sinkRateMs = 1.0): number | null {
  const { modelElevationM, boundaryLayerTopM, thermalVelocityMs, cloudBaseM, levels } = inputs;
  if (boundaryLayerTopM === null) return null;
  const boundaryLayerDepthM = boundaryLayerTopM - modelElevationM;
  if (boundaryLayerDepthM <= 0 || thermalVelocityMs * 2.02 < sinkRateMs) return null;

  let previousAltitudeAglM = boundaryLayerDepthM * 0.2;
  let previousUpdraftMs = thermalVelocityMs * 1.97;

  for (const level of levels) {
    const altitudeAglM = level.heightM - modelElevationM;
    if (altitudeAglM < boundaryLayerDepthM * 0.25) continue;
    if (level.heightM >= cloudBaseM) return cloudBaseM;

    const normalizedHeight = altitudeAglM / boundaryLayerDepthM;
    const updraftMs =
      thermalVelocityMs * 4 * Math.cbrt(Math.max(0, normalizedHeight)) * (1 - 0.8 * normalizedHeight);
    if (updraftMs <= sinkRateMs) {
      const fraction = clamp(
        (sinkRateMs - previousUpdraftMs) / (updraftMs - previousUpdraftMs),
        0,
        1,
      );
      return Math.min(
        cloudBaseM,
        modelElevationM + previousAltitudeAglM + fraction * (altitudeAglM - previousAltitudeAglM),
      );
    }
    previousAltitudeAglM = altitudeAglM;
    previousUpdraftMs = updraftMs;
  }

  return Math.min(cloudBaseM, modelElevationM + boundaryLayerDepthM);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
