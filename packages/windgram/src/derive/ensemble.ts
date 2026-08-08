import { isEnsembleValue, type Scalar } from "../contract/index.js";

/**
 * Selects the median from a Scalar: plain numbers pass through, ensemble
 * values yield their p50. Deterministic derivations (lapse, TI, shear, ...)
 * take plain numbers; run them against an ensemble profile by mapping its
 * Scalars through p50 first. Null passes through so nullable positions
 * (boundaryLayerTopM, usableLiftTopM) can be selected without ceremony.
 */
export function p50(value: Scalar): number;
export function p50(value: Scalar | null): number | null;
export function p50(value: Scalar | null): number | null {
  if (value === null) return null;
  return isEnsembleValue(value) ? value.p50 : value;
}
