"""Regenerates toolkit/test/pipeline-parity.json — the fixture behind the
toolkit's float-exact cross-language parity tests — by the fixture's own
documented procedure: invert the published profile back to source form and
run it through the current pipeline derivation, unrounded.

Run after a deliberate derivation change, from the repo root:

    uv run --project pipeline python scripts/regen-pipeline-parity.py

The script reports every derived value the regeneration changed. An empty
report means the derivations are byte-stable; a non-empty report is the
evidence to carry into the change's review, alongside the toolkit test run
(pnpm --dir toolkit test) that must be updated to match.
"""

from __future__ import annotations

import json
from pathlib import Path

from windgram.derive import derive_windgram_profile

ROOT = Path(__file__).resolve().parents[1]
PARITY = ROOT / "toolkit/test/pipeline-parity.json"


def semantics_for(slug: str) -> dict[str, str]:
    """The transport-semantics declaration for a deterministic model,
    borrowed from the builder that owns it."""
    from windgram.builders import eccc, gfs, hrdps_west, hrrr, nam

    datamart = {"hrdps-continental": eccc.HRDPS, "rdps": eccc.RDPS, "gdps": eccc.GDPS}
    if slug in datamart:
        return eccc.model_semantics(datamart[slug])
    modules = {"hrrr-conus": hrrr, "gfs": gfs, "hrdps-west": hrdps_west,
               "nam": nam, "nam-conus-nest": nam}
    if slug in modules:
        return modules[slug].SEMANTICS
    raise ValueError(f"no deterministic builder owns semantics for {slug!r}")


def to_source(profile: dict) -> dict:
    """Invert a published profile document back to derive_windgram_profile's
    source form. Every needed input is itself published."""
    site = profile["site"]
    hours = []
    for hour in profile["hours"]:
        surface = hour["surface"]
        source_hour = {
            "validAt": hour["validAt"],
            "pressurePa": surface["pressurePa"],
            "temperatureC": surface["temperatureC"],
            "dewPointDepressionC": surface["temperatureC"] - surface["dewPointC"],
            "windSpeedMs": surface["windSpeedMs"],
            "windDirectionDeg": surface["windDirectionDeg"],
            "cloudCoverPercent": surface["cloudCoverPercent"],
            "precipitationMm": surface["precipitationMmHr"],
            "sensibleHeatFluxWm2": surface["sensibleHeatFluxWm2"],
            "latentHeatFluxWm2": surface["latentHeatFluxWm2"],
            "levels": [
                {
                    "pressureHpa": level["pressureHpa"],
                    "heightM": level["heightM"],
                    "temperatureC": level["temperatureC"],
                    "dewPointDepressionC": level["temperatureC"] - level["dewPointC"],
                    "windSpeedMs": level["windSpeedMs"],
                    "windDirectionDeg": level["windDirectionDeg"],
                    **(
                        {"verticalVelocityPaS": level["verticalVelocityPaS"]}
                        if "verticalVelocityPaS" in level
                        else {}
                    ),
                    **(
                        {"cloudFractionPercent": level["cloudFractionPercent"]}
                        if "cloudFractionPercent" in level
                        else {}
                    ),
                }
                for level in hour["levels"]
            ],
        }
        for optional in (
            "windGustMs",
            "capeJkg",
            "cinJkg",
            "pblHeightM",
            "lowCloudPercent",
            "midCloudPercent",
            "highCloudPercent",
        ):
            if optional in surface:
                source_hour[optional] = surface[optional]
        hours.append(source_hour)
    return {
        "generatedAt": profile["run"]["generatedAt"],
        "referenceTime": profile["run"]["referenceTime"],
        "latitude": site["latitude"],
        "longitude": site["longitude"],
        "modelElevationM": site["modelElevationM"],
        "siteAltitudeM": site["altitudeM"],
        "siteId": site["id"],
        "siteName": site["name"],
        "hours": hours,
    }


def main() -> None:
    before = json.loads(PARITY.read_text())
    regenerated = derive_windgram_profile(
        to_source(before), model=before["model"], semantics=semantics_for(before["model"])
    )
    PARITY.write_text(json.dumps(regenerated, indent=1) + "\n")
    print(f"wrote {PARITY.relative_to(ROOT)}")

    changes = 0
    for old_hour, new_hour in zip(before["hours"], regenerated["hours"]):
        for field in sorted(set(old_hour["derived"]) | set(new_hour["derived"])):
            old_value = old_hour["derived"].get(field)
            new_value = new_hour["derived"].get(field)
            if old_value != new_value:
                changes += 1
                print(f"{new_hour['validAt']}  {field}: {old_value} -> {new_value}")
    if changes:
        print(f"{changes} derived value(s) changed — update the toolkit parity tests to match.")
    else:
        print("derivations byte-stable: regeneration changed nothing.")


if __name__ == "__main__":
    main()
