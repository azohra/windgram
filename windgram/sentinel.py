"""ECCC "not computed" sentinel masking for CAPE and CIN.

ECCC encodes "convection not computed here" inside the data values instead
of the GRIB bitmap, and the encoding differs by family: RDPS and GDPS write
9999 into both CAPE and CIN (a quarter to a third of the grid on a typical
run), the HRDPS family writes -1 into CAPE. Every builder must mask these
before a value reaches a document — an unmasked sentinel reads as a
5-sigma stability signal, and a naive mean over a GDPS field is garbage.

Matching is tolerance-based because GRIB simple packing quantizes values:
a 16-bit-packed field spanning 0..9999 lands within ~0.2 of the sentinel,
while the tolerance stays well below 0.5 so a legitimate CAPE of 0 J/kg is
never confused with the HRDPS family's -1.
"""

from __future__ import annotations

SENTINEL_TOLERANCE = 0.5


def is_sentinel(value: float, sentinel: float) -> bool:
    return abs(value - sentinel) <= SENTINEL_TOLERANCE


def mask_sentinel(value: float, sentinel: float) -> float | None:
    """The value, or None when it is the model's "not computed" marker.

    None means the field is omitted from the published hour (the contract's
    optional-field idiom) — sentinels are masked to absence, not to zero,
    because "not computed" is not a measurement of stability.
    """
    return None if is_sentinel(value, sentinel) else value
