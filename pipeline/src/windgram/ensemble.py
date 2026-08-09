"""Shared aggregation authority for ensemble windgram documents.

Builders derive each member as an independent atmospheric profile, then
call this module to rank the published quantities.  Keeping that operation
here gives every ensemble source -- operational feeds and synthetic
scenarios alike -- the same member-counting, direction, and censoring
semantics.
"""

from __future__ import annotations

import math
from collections.abc import Collection, Sequence

PERCENTILE_POINTS = (10, 25, 50, 75, 90)
CEILING_TOLERANCE_M = 0.5
LEVEL_SCALARS = ("heightM", "temperatureC", "dewPointC", "windSpeedMs")
DERIVED_SCALARS = (
    "boundaryLayerTopM",
    "thermalVelocityMs",
    "cloudBaseM",
    "usableLiftTopM",
)
CENSORED_SCALARS = ("boundaryLayerTopM", "usableLiftTopM")


def percentile(sorted_values: Sequence[float], point: float) -> float:
    """Return a linearly interpolated percentile of already-sorted values.

    With 21 members every published point lands on an exact rank:
    p10→2, p25→5, p50→10, p75→15, p90→18.
    """
    if not sorted_values:
        raise ValueError("percentile of no values")
    rank = (len(sorted_values) - 1) * point / 100
    low = math.floor(rank)
    high = math.ceil(rank)
    if low == high:
        return sorted_values[low]
    return sorted_values[low] + (rank - low) * (
        sorted_values[high] - sorted_values[low]
    )


def circular_median(bearings: Sequence[float]) -> float:
    """Return the median after unwrapping bearings around their mean vector.

    This is robust to stray members, respects the 0/360 wrap, and equals the
    ordinary median when the members do not straddle that wrap.
    """
    if not bearings:
        raise ValueError("circular median of no bearings")
    east = sum(math.sin(math.radians(bearing)) for bearing in bearings)
    north = sum(math.cos(math.radians(bearing)) for bearing in bearings)
    anchor = math.degrees(math.atan2(east, north))
    unwrapped = sorted(
        anchor + (bearing - anchor + 180) % 360 - 180 for bearing in bearings
    )
    return percentile(unwrapped, 50) % 360


def percentile_block(values: Sequence[float | None]) -> dict:
    """Build a percentile block over defined members only."""
    present = sorted(value for value in values if value is not None)
    block: dict = {"members": len(present)}
    for point in PERCENTILE_POINTS:
        block[f"p{point}"] = percentile(present, point) if present else None
    return block


def aggregate_pressure_levels(
    member_hours: Sequence[dict], *, level_scalars: Sequence[str]
) -> list[dict]:
    """Aggregate sounding levels by pressure across members that kept them."""
    by_pressure: dict[int, list[dict]] = {}
    for hour in member_hours:
        for level in hour["levels"]:
            by_pressure.setdefault(level["pressureHpa"], []).append(level)

    aggregated = []
    for pressure_hpa, levels in by_pressure.items():
        block: dict = {"pressureHpa": pressure_hpa}
        for key in level_scalars:
            block[key] = percentile_block([level[key] for level in levels])
        block["windDirectionDeg"] = circular_median(
            [level["windDirectionDeg"] for level in levels]
        )
        aggregated.append(block)
    aggregated.sort(key=lambda level: level["heightM"]["p50"])
    return aggregated


def count_ceiled_members(
    member_hours: Sequence[dict],
    key: str,
    *,
    ceiling_tolerance_m: float = CEILING_TOLERANCE_M,
) -> int:
    """Count defined member values censored at their own column ceiling."""
    count = 0
    for hour in member_hours:
        value = hour["derived"][key]
        levels = hour["levels"]
        if value is None or not levels:
            continue
        if value >= levels[-1]["heightM"] - ceiling_tolerance_m:
            count += 1
    return count


def aggregate_derived_height(
    member_hours: Sequence[dict],
    key: str,
    *,
    censored_scalars: Collection[str],
    ceiling_tolerance_m: float = CEILING_TOLERANCE_M,
) -> dict:
    """Aggregate one derived height and annotate column-top censoring."""
    block = percentile_block([hour["derived"][key] for hour in member_hours])
    if key in censored_scalars:
        return {
            "ceiledMembers": count_ceiled_members(
                member_hours, key, ceiling_tolerance_m=ceiling_tolerance_m
            ),
            **block,
        }
    return block


def aggregate_member_profiles(
    member_profiles: Sequence[dict],
    *,
    surface_scalars: Sequence[str],
    level_scalars: Sequence[str] = LEVEL_SCALARS,
    derived_scalars: Sequence[str] = DERIVED_SCALARS,
    censored_scalars: Collection[str] = CENSORED_SCALARS,
    optional_surface_scalars: Collection[str] = (),
    ceiling_tolerance_m: float = CEILING_TOLERANCE_M,
) -> list[dict]:
    """Aggregate independently derived member profiles into ensemble hours.

    Declared surface fields are required unless explicitly listed as
    optional.  Optional absent or null fields do not enter their percentile
    ranking, but their block still reports the number of contributing
    members.
    """
    aggregated_hours = []
    for hour_index in range(len(member_profiles[0]["hours"])):
        member_hours = [profile["hours"][hour_index] for profile in member_profiles]
        surface = {}
        for key in surface_scalars:
            if key == "windDirectionDeg":
                surface[key] = circular_median(
                    [hour["surface"][key] for hour in member_hours]
                )
                continue
            if key in optional_surface_scalars:
                values = [hour["surface"].get(key) for hour in member_hours]
            else:
                values = [hour["surface"][key] for hour in member_hours]
            surface[key] = percentile_block(values)

        aggregated_hours.append(
            {
                "validAt": member_hours[0]["validAt"],
                "surface": surface,
                "levels": aggregate_pressure_levels(
                    member_hours, level_scalars=level_scalars
                ),
                "derived": {
                    key: aggregate_derived_height(
                        member_hours,
                        key,
                        censored_scalars=censored_scalars,
                        ceiling_tolerance_m=ceiling_tolerance_m,
                    )
                    for key in derived_scalars
                },
            }
        )
    return aggregated_hours
