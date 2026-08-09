from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples" / "club-project"
PACKAGE = ROOT / "packages" / "windgram"


def run(*arguments: str | Path, cwd: Path) -> subprocess.CompletedProcess[str]:
    environment = {**os.environ, "CI": "1", "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0"}
    return subprocess.run(
        [str(argument) for argument in arguments],
        cwd=cwd,
        env=environment,
        check=True,
        capture_output=True,
        text=True,
    )


def files_beneath(root: Path) -> set[str]:
    return {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file()
    }


def test_complete_club_publisher_journey_is_static_offline_and_cwd_independent(
    tmp_path: Path,
) -> None:
    runner = tmp_path / "unrelated-cwd"
    runner.mkdir()
    club_project = tmp_path / "club-project"

    # This is the same clean-example copy documented for a source checkout.
    run("cp", "-R", EXAMPLE, club_project, cwd=runner)

    example_text = "\n".join(
        path.read_text()
        for path in club_project.rglob("*")
        if path.is_file() and path.suffix in {".json", ".md", ".mjs", ".py"}
    )
    assert "acrophobia.ca" not in example_text
    assert "/Users/" not in example_text

    public = club_project / "public"
    data = public / "data"
    sites = club_project / "club-sites.json"
    profile = data / "synthetic-club-demo" / "sites" / "example-ridge.json"
    manifest = data / "synthetic-club-demo" / "manifest.json"

    # Preflight the real registered builder with external paths and a cap.
    # --dry-run is the deliberate no-provider boundary and must write nothing.
    preflight = run(
        "uv",
        "run",
        "--offline",
        "--project",
        ROOT,
        "windgram",
        "build",
        "--model",
        "hrrr-conus",
        "--sites",
        sites,
        "--output",
        data,
        "--max-steps",
        "2",
        "--dry-run",
        cwd=runner,
    )
    assert "hrrr-conus" in preflight.stdout
    assert str(sites) in preflight.stdout
    assert str(data) in preflight.stdout
    assert not data.exists()

    # Generate from the checked-in synthetic source through the Python
    # derivation and publisher serializer, still from the unrelated cwd.
    run(
        "uv",
        "run",
        "--offline",
        "--project",
        ROOT,
        "python",
        club_project / "generate_profile.py",
        "--sites",
        sites,
        "--source",
        club_project / "fixtures" / "synthetic-source.json",
        "--output",
        data,
        cwd=runner,
    )

    profile_document = json.loads(profile.read_text())
    manifest_document = json.loads(manifest.read_text())
    assert profile_document["model"] == "synthetic-club-demo"
    assert profile_document["site"] == {
        "id": "example-ridge",
        "name": "Example Ridge",
        "latitude": 49,
        "longitude": -123,
        "altitudeM": 1050,
        "modelElevationM": 900,
        "timeZone": "Etc/UTC",
    }
    assert profile_document["run"]["referenceTime"] == manifest_document["referenceTime"]
    assert manifest_document["sites"] == [
        {"name": "Example Ridge", "slug": "example-ridge"}
    ]
    assert manifest_document["stats"] == {
        "downloads": 0,
        "downloadBytes": 0,
        "retries": 0,
        "durationMs": 0,
    }
    generated_bytes = {profile: profile.read_bytes(), manifest: manifest.read_bytes()}
    run(
        "uv",
        "run",
        "--offline",
        "--project",
        ROOT,
        "python",
        club_project / "generate_profile.py",
        "--sites",
        sites,
        "--source",
        club_project / "fixtures" / "synthetic-source.json",
        "--output",
        data,
        cwd=runner,
    )
    assert {path: path.read_bytes() for path in generated_bytes} == generated_bytes

    # Build and pack the actual package at its manifest-declared version, then
    # install it from the local tarball with registry access forbidden. This
    # exercises shipped exports, not TypeScript source imports or a workspace
    # symlink.
    run("pnpm", "--dir", PACKAGE, "build", cwd=runner)
    run(
        "pnpm",
        "--dir",
        PACKAGE,
        "pack",
        "--pack-destination",
        club_project,
        cwd=runner,
    )
    package_manifest = json.loads((PACKAGE / "package.json").read_text())
    package_tarball = (
        club_project / f"{package_manifest['name']}-{package_manifest['version']}.tgz"
    )
    assert package_tarball.is_file()
    run(
        "pnpm",
        "--dir",
        club_project,
        "add",
        "--offline",
        "--save-exact",
        package_tarball,
        cwd=runner,
    )

    # The renderer validates all three contracts, verifies publication
    # identity and timezone propagation, and writes only static assets.
    run(
        "pnpm",
        "--dir",
        club_project,
        "run",
        "render",
        "--",
        "--sites",
        sites,
        "--profile",
        profile,
        "--manifest",
        manifest,
        "--output",
        public,
        cwd=runner,
    )

    expected_files = {
        "assets/example-ridge-key.svg",
        "assets/example-ridge.svg",
        "data/synthetic-club-demo/manifest.json",
        "data/synthetic-club-demo/sites/example-ridge.json",
        "index.html",
    }
    assert files_beneath(public) == expected_files
    assert not (data / "models.json").exists()
    assert not (data / "runs.json").exists()

    html = (public / "index.html").read_text()
    svg = (public / "assets" / "example-ridge.svg").read_text()
    key_svg = (public / "assets" / "example-ridge-key.svg").read_text()
    assert "Etc/UTC" in html
    assert "<script" not in html
    assert "http://" not in html and "https://" not in html
    assert svg.startswith("<svg")
    assert 'aria-label="' in svg
    assert 'viewBox="0 0 1080 ' in svg
    assert 'class="wg-surface-temp wg-mono"' in svg
    assert '>LIFT<' in svg
    assert key_svg.startswith("<svg")
    assert 'aria-label="Windgram key:' in key_svg
    assert "LAPSE RATE" in key_svg
    all_ids = re.findall(r'\bid="([^"]+)"', svg + key_svg)
    assert len(all_ids) == len(set(all_ids))

    rendered_bytes = {
        public / "index.html": (public / "index.html").read_bytes(),
        public / "assets" / "example-ridge.svg": (
            public / "assets" / "example-ridge.svg"
        ).read_bytes(),
        public / "assets" / "example-ridge-key.svg": (
            public / "assets" / "example-ridge-key.svg"
        ).read_bytes(),
    }
    run(
        "pnpm",
        "--dir",
        club_project,
        "run",
        "render",
        "--",
        "--sites",
        sites,
        "--profile",
        profile,
        "--manifest",
        manifest,
        "--output",
        public,
        cwd=runner,
    )
    assert {path: path.read_bytes() for path in rendered_bytes} == rendered_bytes

    # Publishing is a byte-for-byte directory handoff; no Windgram process
    # remains after this copy and no server is started by the journey.
    deploy = club_project / "deploy"
    run("mkdir", deploy, cwd=runner)
    run("cp", "-R", f"{public}/.", f"{deploy}/", cwd=runner)
    assert files_beneath(deploy) == expected_files
    for name in expected_files:
        assert (deploy / name).read_bytes() == (public / name).read_bytes()
