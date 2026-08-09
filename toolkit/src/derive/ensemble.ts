import { isEnsembleValue, type Scalar } from "../contract/index.js";

/**
 * Selects the median from a Scalar: plain numbers pass through, ensemble
 * values yield their p50. Deterministic derivations (lapse, TI, shear, ...)
 * take plain numbers; run them against an ensemble profile by mapping its
 * Scalars through p50 first. Null and undefined pass through as null so
 * nullable positions (boundaryLayerTopM, usableLiftTopM) and optional ones
 * (capeJkg, windGustMs) can be selected without ceremony — and since 0.7.0
 * the return is honestly nullable for ANY Scalar input: a full-dropout
 * ensemble position ({ members: 0 }, every percentile null) has no median,
 * so its p50 is null too.
 */
export function p50(value: Scalar | null | undefined): number | null {
  if (value == null) return null;
  return isEnsembleValue(value) ? value.p50 : value;
}
