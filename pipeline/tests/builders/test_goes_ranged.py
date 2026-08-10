"""The ranged granule path against the whole-file path and netCDF4 truth.

A synthetic chunked+zlib NetCDF granule — written by netCDF4 itself in a
SUBPROCESS, so the HDF5 layout is the real thing — is served by a local
HTTP server that honors Range requests. The ranged h5py extraction must
be bit-identical to the whole-file h5py extraction AND to netCDF4's own
mask-and-scale reading of the same pixels; any ranged-path failure must
fall back to the whole-file download rather than fail the build.

netCDF4 never loads in this process: the h5py and netCDF4 wheels each
bundle a libhdf5, and both in one interpreter segfault it at shutdown
(exit 139 — every Linux CI run of the first 0.6.0 push, after all tests
had passed). The reference implementation runs in its own interpreter
(netcdf4_reference.py) and reports over JSON; a guard test below pins
the one-HDF5-stack-per-process invariant.
"""

import http.server
import json
import re
import struct
import subprocess
import sys
import threading
from pathlib import Path

import numpy
import pytest

from windgram.builders import goes
from windgram.noaa import DownloadStats

REFERENCE_SCRIPT = Path(__file__).with_name("netcdf4_reference.py")

# Mirrors netcdf4_reference.PIXELS — asserted equal via the reference's
# per-pixel DQF report, so the two tables cannot drift apart silently.
PIXELS = {
    "good": (2, 2),  # valid retrieval, DQF 0
    "medium": (3, 3),  # valid retrieval, DQF 1
    "low": (4, 4),  # valid retrieval, DQF 2 — AOD rejects
    "worst": (5, 5),  # valid retrieval, DQF 3 — AOD rejects
    "night": (0, 0),  # _FillValue with DQF 0 — the DSR trap
    "invalid": (0, 1),  # outside valid_range but not fill
}
SITES = [{"slug": slug} for slug in PIXELS]


class _GranuleHandler(http.server.BaseHTTPRequestHandler):
    payload = b""
    mode = "range"  # "range" | "ignore" | "corrupt"
    ranged_bytes_served = 0

    def do_GET(self):
        cls = type(self)
        header = self.headers.get("Range")
        if header is None or cls.mode == "ignore":
            self._send(200, cls.payload)
            return
        matched = re.fullmatch(r"bytes=(\d+)-(\d+)", header)
        start = int(matched.group(1))
        end = min(int(matched.group(2)), len(cls.payload) - 1)
        body = cls.payload[start : end + 1]
        if cls.mode == "corrupt":
            body = bytes(len(body))
        cls.ranged_bytes_served += len(body)
        self._send(206, body, content_range=f"bytes {start}-{end}/{len(cls.payload)}")

    def _send(self, status, body, content_range=None):
        self.send_response(status)
        if content_range:
            self.send_header("Content-Range", content_range)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # keep pytest output readable
        pass


@pytest.fixture(scope="module")
def granule(tmp_path_factory):
    """The granule bytes, the serving URL, and netCDF4's truth — the
    write and the reference read both happen in the subprocess."""
    path = tmp_path_factory.mktemp("granule") / "synthetic.nc"
    completed = subprocess.run(
        [sys.executable, str(REFERENCE_SCRIPT), str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    reference = json.loads(completed.stdout)
    payload = path.read_bytes()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _GranuleHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_address[1]}/synthetic.nc"
    yield url, payload, reference
    server.shutdown()
    thread.join()


@pytest.fixture(autouse=True)
def _fresh_handler(granule):
    _GranuleHandler.payload = granule[1]
    _GranuleHandler.mode = "range"
    _GranuleHandler.ranged_bytes_served = 0


def _whole_file_samples(payload, product):
    with goes._granule(payload) as dataset:
        _, samples = goes._sample_sites(dataset, product, SITES, dict(PIXELS))
        x_values = dataset["x"][:]
    return samples, x_values


def _expected_samples(reference, max_quality):
    """The gate applied to netCDF4's own per-pixel reading — the
    independently derived answer both h5py paths must reproduce."""
    return {
        slug: pixel["value"]
        for slug, pixel in reference["pixels"].items()
        if not pixel["masked"] and not pixel["dqfMasked"] and pixel["dqf"] <= max_quality
    }


def test_netcdf4_never_loads_in_the_builder_process():
    """One HDF5 stack per process: importing the builder must not pull
    in netCDF4 (whose bundled libhdf5 beside h5py's segfaults the
    interpreter at shutdown). Checked in a clean interpreter so this
    test cannot be fooled by import order elsewhere in the suite."""
    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import windgram.builders.goes; "
            "sys.exit(1 if 'netCDF4' in sys.modules else 0)",
        ],
        capture_output=True,
    )
    assert completed.returncode == 0, completed.stderr.decode()


def test_ranged_extraction_is_bit_identical_to_netcdf4(granule):
    url, payload, reference = granule
    product = goes.PRODUCTS["goes18-aod"]
    expected = _expected_samples(reference, product.max_quality)
    whole, whole_x = _whole_file_samples(payload, product)

    stats = DownloadStats()
    with goes._ranged_granule(url, stats) as ranged_granule:
        _, ranged = goes._sample_sites(ranged_granule, product, SITES, dict(PIXELS))
        ranged_x = ranged_granule["x"][:]

    # Sensitivity first: the gate really gated — retrievals at DQF 0 and 1
    # pass, DQF 2-3 and both masked pixels are absences.
    assert set(expected) == {"good", "medium"}
    assert set(whole) == set(expected)
    assert set(ranged) == set(expected)
    for slug, value in expected.items():
        # Bit-identical to netCDF4's mask-and-scale on BOTH h5py paths.
        assert struct.pack("<d", whole[slug]) == struct.pack("<d", value)
        assert struct.pack("<d", ranged[slug]) == struct.pack("<d", value)
    # The scaled coordinate axis matches netCDF4's to the dtype and bit.
    assert str(numpy.asarray(whole_x).dtype) == reference["xDtype"]
    assert [float(v) for v in numpy.asarray(whole_x)] == reference["x"]
    assert numpy.array_equal(numpy.asarray(whole_x), numpy.asarray(ranged_x))


def test_the_dsr_quality_gate_stays_exact_zero_on_both_paths(granule):
    url, payload, reference = granule
    # The DSR product's gate (unmasked AND DQF == 0) over the same granule
    # variable: only the DQF-0 pixel passes, and the fill-with-DQF-0
    # night pixel stays an absence — on both paths.
    import dataclasses

    product = dataclasses.replace(
        goes.PRODUCTS["goes18-dsr"], variable="AOD", value_key="downwardShortwaveWm2"
    )
    expected = _expected_samples(reference, product.max_quality)
    whole, _ = _whole_file_samples(payload, product)
    with goes._ranged_granule(url, DownloadStats()) as ranged_granule:
        _, ranged = goes._sample_sites(ranged_granule, product, SITES, dict(PIXELS))

    assert set(expected) == {"good"}
    assert whole == expected
    assert ranged == whole


def test_ranged_stats_count_a_fraction_of_the_file(granule):
    url, payload, _ = granule
    stats = DownloadStats()
    with goes._ranged_granule(url, stats) as ranged_granule:
        goes._sample_sites(ranged_granule, goes.PRODUCTS["goes18-aod"], SITES, dict(PIXELS))

    assert stats.response_bytes == _GranuleHandler.ranged_bytes_served
    # The point of the exercise: a handful of chunks, not the granule.
    assert 0 < stats.response_bytes < len(payload)


@pytest.mark.parametrize("mode", ["ignore", "corrupt"])
def test_fallback_serves_the_granule_when_the_ranged_path_fails(granule, capsys, mode):
    url, payload, _ = granule
    _GranuleHandler.mode = mode
    product = goes.PRODUCTS["goes18-aod"]
    whole, _ = _whole_file_samples(payload, product)

    stats = DownloadStats()
    _, samples, path_used = goes._granule_samples(url, product, SITES, dict(PIXELS), stats)

    assert path_used == "whole-file"
    assert samples == whole  # the fallback is a full answer, not a stub
    assert "downloading whole" in capsys.readouterr().out
    assert stats.response_bytes >= len(payload)  # the whole file moved


def test_the_ranged_path_serves_the_granule_when_ranges_work(granule):
    url, payload, _ = granule
    product = goes.PRODUCTS["goes18-aod"]
    whole, _ = _whole_file_samples(payload, product)

    _, samples, path_used = goes._granule_samples(
        url, product, SITES, dict(PIXELS), DownloadStats()
    )

    assert path_used == "ranged"
    assert samples == whole
