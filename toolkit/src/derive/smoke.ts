/* Smoke-adjusted thermal derivations — pure functions of published
   documents: a wind profile plus a smoke source (the profile's own smoke
   block, or a smoke document from an air-quality model joined by validAt).

   The physics chain is deliberately one step: aerosol optical thickness
   attenuates surface global irradiance by a factor f, the virtual heat
   flux scales with the irradiance, and Deardorff's w* is the cube root of
   that flux — so the adjusted w* is simply w* × ∛f, computed from the
   PUBLISHED thermalVelocityMs. Nothing here re-derives boundary-layer
   depth or cloud base: in heavy smoke the real boundary layer also
   shallows, so the adjustment is a partial correction and still optimistic.
   The stored document never changes; this is a labeled alternate view.

   Never apply this to a model whose fluxes already feel its smoke
   (semantics.smoke === "radiativelyCoupled" — HRRR): its published w* is
   already smoke-aware, and derating it again double-counts. Use
   isSmokeAwareProfile as the guard.

   Constants are versioned physics claims with citations, not consumer
   preferences. Cube-root damping keeps the output robust to their
   uncertainty: a 30 % error in f moves w* by ~10 %. */

import type {
  SmokeDocument,
  SmokeDocumentHour,
  WindgramProfile,
} from "../contract/index.js";

/**
 * Mass extinction efficiency of aged wildfire smoke at mid-visible
 * wavelength, m²/g — converts a PM2.5 smoke column (mg/m²) into aerosol
 * optical thickness. Reid et al. 2005 (Atmos. Chem. Phys. 5, 827–849,
 * doi:10.5194/acp-5-827-2005), Table 5, temperate/boreal aged smoke:
 * scattering 4.3 ± 0.4 + absorption 0.4 ± 0.3 m²/g. Fresh plumes run
 * ~3.5–4; multi-day aged smoke higher (Saide et al. 2022,
 * doi:10.1029/2022GL099175) — treat derived AOT as ±30–50 %.
 */
export const SMOKE_MASS_EXTINCTION_M2_PER_G = 4.7;

/**
 * Effective broadband extinction coefficient for surface global horizontal
 * irradiance under smoke at midday sun: f = exp(−k·τ). Three independent
 * datasets converge on k ≈ 0.14–0.22 — Donaldson et al. 2021
 * (doi:10.1109/ACCESS.2021.3084528, California 2020 PV vs GOES AOD),
 * Chubarova et al. 2012 (doi:10.5194/amt-5-557-2012, pyranometers under
 * extreme Russian smoke), McKendry et al. 2019 (doi:10.5194/acp-19-835-2019,
 * BC July 2015). Far below exp(−τ) because smoke's single-scattering albedo
 * (~0.95) turns most extinction into diffuse light that still arrives.
 */
export const SMOKE_TRANSMITTANCE_K_MIDDAY = 0.16;

/**
 * The zenith-aware companion of SMOKE_TRANSMITTANCE_K_MIDDAY:
 * f = exp(−k·τ / cosθz) with k normalized to a vertical path, so morning
 * and evening hours — exactly where a fixed midday constant under-derates —
 * see the longer slant path through the plume.
 */
export const SMOKE_TRANSMITTANCE_K_VERTICAL = 0.13;

/* Slant paths longer than ~1/0.15 air masses (sun below ~8.6°) leave the
   parameterization's validity; irradiance is marginal there anyway. */
const MIN_COS_ZENITH = 0.15;

/**
 * Aerosol optical thickness (dimensionless, mid-visible) from a wildfire
 * PM2.5 column, mg/m² — the smoke document's smokePlumeColumnMgm2. For
 * profiles with their own smoke block prefer the published `aot` directly.
 */
export function smokeAotFromColumn(columnMgm2: number): number {
  if (!(columnMgm2 > 0)) return 0;
  return (columnMgm2 / 1000) * SMOKE_MASS_EXTINCTION_M2_PER_G;
}

/**
 * The factor f ∈ (0, 1] by which smoke of optical thickness `aot` reduces
 * surface global irradiance — and, to first order, the virtual heat flux
 * driving thermals. With `cosSolarZenith` supplied the slant path is
 * respected (use cosSolarZenith() below); without it the midday effective
 * constant applies. A non-positive cosine (sun down) returns 1: there is
 * no irradiance to attenuate, and w* is already zero at night.
 */
export function smokeTransmittance(aot: number, cosZenith?: number): number {
  if (!(aot > 0)) return 1;
  if (cosZenith === undefined) return Math.exp(-SMOKE_TRANSMITTANCE_K_MIDDAY * aot);
  if (cosZenith <= 0) return 1;
  const path = Math.max(cosZenith, MIN_COS_ZENITH);
  return Math.exp((-SMOKE_TRANSMITTANCE_K_VERTICAL * aot) / path);
}

/**
 * The smoke-adjusted convective velocity scale: w* × ∛f. Follows from the
 * published w* alone because Deardorff's w* is the cube root of the
 * virtual heat flux (× depth, held fixed here) — no flux re-derivation.
 * NEVER apply to a smoke-aware profile (isSmokeAwareProfile): its
 * published w* already includes the model's own smoke attenuation.
 */
export function smokeAdjustedThermalVelocityMs(
  thermalVelocityMs: number,
  transmittance: number,
): number {
  if (!(thermalVelocityMs > 0)) return 0;
  const f = Math.min(Math.max(transmittance, 0), 1);
  return thermalVelocityMs * Math.cbrt(f);
}

/**
 * True when the profile model's own radiation already feels its smoke
 * (semantics.smoke === "radiativelyCoupled" — HRRR), so its fluxes,
 * published w*, and everything derived from them are ALREADY smoke-aware
 * and smokeAdjustedThermalVelocityMs must not be applied on top. Absence
 * of the tag means the document predates it or carries no smoke — treat
 * the profile as smoke-blind.
 */
export function isSmokeAwareProfile(profile: WindgramProfile): boolean {
  return profile.semantics?.smoke === "radiativelyCoupled";
}

/**
 * A smoke document's hours keyed by validAt, for joining against
 * `profile.hours` — the two models run on different schedules (RAQDPS 00Z
 * and 12Z only), so consumers should surface the smoke run's
 * referenceTime beside any adjusted view rather than implying same-run
 * provenance. Hours the smoke document does not cover are simply absent.
 */
export function smokeHoursByValidAt(smoke: SmokeDocument): Map<string, SmokeDocumentHour> {
  return new Map(smoke.hours.map((hour) => [hour.validAt, hour]));
}

/**
 * Cosine of the solar zenith angle at a UTC instant and location — the
 * slant-path input for smokeTransmittance. Declination and the equation
 * of time from Spencer's Fourier series (1971, Search 2:172), accurate to
 * a few tenths of a degree: ample for an attenuation whose w* effect is
 * cube-root damped. Negative means the sun is below the horizon.
 */
export function cosSolarZenith(
  validAt: string,
  latitudeDeg: number,
  longitudeDeg: number,
): number {
  const date = new Date(validAt);
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = (date.getTime() - startOfYear) / 86_400_000; // fractional
  const gamma = (2 * Math.PI * dayOfYear) / 365;

  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const equationOfTimeMinutes =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solarHours = utcHours + longitudeDeg / 15 + equationOfTimeMinutes / 60;
  const hourAngle = ((solarHours - 12) * 15 * Math.PI) / 180;

  const latitude = (latitudeDeg * Math.PI) / 180;
  return (
    Math.sin(latitude) * Math.sin(declination) +
    Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle)
  );
}
