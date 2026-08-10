"""The ranged granule path against the whole-file netCDF4 truth.

A synthetic chunked+zlib NetCDF granule (written by netCDF4 itself, so
the HDF5 layout is the real thing) is served by a local HTTP server that
honors Range requests. The ranged h5py extraction must be bit-identical
to the whole-file netCDF4 extraction — masks, DQF gating, and scaled
values alike — and any ranged-path failure must fall back to the
whole-file download rather than fail the build.
"""

import http.server
import re
import struct
import threading

import netCDF4
import numpy
import pytest

from windgram.builders import goes
from windgram.noaa import DownloadStats

SIZE = 512

# Pixels chosen to exercise every branch of the validity gate.
PIXELS = {
    "good": (2, 2),  # valid retrieval, DQF 0
    "medium": (3, 3),  # valid retrieval, DQF 1
    "low": (4, 4),  # valid retrieval, DQF 2 — AOD rejects
    "worst": (5, 5),  # valid retrieval, DQF 3 — AOD rejects
    "night": (0, 0),  # _FillValue with DQF 0 — the DSR trap
    "invalid": (0, 1),  # outside valid_range but not fill
}
SITES = [{"slug": slug} for slug in PIXELS]


def _write_granule(path) -> bytes:
    """An ABI-shaped granule: uint16 value variable and uint8 DQF, both
    chunked and zlib-compressed exactly like the live full-disk files
    (row-band chunks), int16 scaled x/y, float32 packing attributes."""
    generator = numpy.random.RandomState(7)
    dataset = netCDF4.Dataset(path, "w", format="NETCDF4")
    dataset.createDimension("y", SIZE)
    dataset.createDimension("x", SIZE)

    aod = dataset.createVariable(
        "AOD",
        "u2",
        ("y", "x"),
        zlib=True,
        complevel=5,
        shuffle=True,
        chunksizes=(32, SIZE),
        fill_value=numpy.uint16(65535),
    )
    aod.set_auto_maskandscale(False)
    aod.scale_factor = numpy.float32(7.706e-05)
    aod.add_offset = numpy.float32(-0.05)
    aod.valid_range = numpy.array([0, 65530], dtype="u2")
    raw = generator.randint(0, 60000, (SIZE, SIZE)).astype("u2")
    raw[PIXELS["night"]] = 65535  # fill
    raw[PIXELS["invalid"]] = 65533  # inside uint16, outside valid_range
    aod[:] = raw

    dqf = dataset.createVariable(
        "DQF",
        "u1",
        ("y", "x"),
        zlib=True,
        complevel=5,
        shuffle=True,
        chunksizes=(64, SIZE),
        fill_value=numpy.uint8(255),
    )
    dqf.set_auto_maskandscale(False)
    dqf.valid_range = numpy.array([0, 3], dtype="u1")
    quality = generator.randint(0, 4, (SIZE, SIZE)).astype("u1")
    quality[PIXELS["good"]] = 0
    quality[PIXELS["medium"]] = 1
    quality[PIXELS["low"]] = 2
    quality[PIXELS["worst"]] = 3
    quality[PIXELS["night"]] = 0  # the live DSR trap: fill value, DQF 0
    quality[PIXELS["invalid"]] = 0
    dqf[:] = quality

    x = dataset.createVariable("x", "i2", ("x",))
    x.set_auto_maskandscale(False)
    x.scale_factor = numpy.float32(5.6e-05)
    x.add_offset = numpy.float32(-0.151844)
    x[:] = numpy.arange(SIZE, dtype="i2")
    y = dataset.createVariable("y", "i2", ("y",))
    y.set_auto_maskandscale(False)
    y.scale_factor = numpy.float32(-5.6e-05)
    y.add_offset = numpy.float32(0.151844)
    y[:] = numpy.arange(SIZE, dtype="i2")

    dataset.close()
    return path.read_bytes()


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
    payload = _write_granule(tmp_path_factory.mktemp("granule") / "synthetic.nc")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _GranuleHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_address[1]}/synthetic.nc"
    yield url, payload
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


def test_ranged_extraction_is_bit_identical_to_whole_file(granule):
    url, payload = granule
    product = goes.PRODUCTS["goes18-aod"]
    whole, whole_x = _whole_file_samples(payload, product)

    stats = DownloadStats()
    with goes._RangedGranule(url, stats) as ranged_granule:
        _, ranged = goes._sample_sites(ranged_granule, product, SITES, dict(PIXELS))
        ranged_x = ranged_granule["x"][:]

    # Sensitivity first: the gate really gated — retrievals at DQF 0 and 1
    # pass, DQF 2-3 and both masked pixels are absences.
    assert set(whole) == {"good", "medium"}
    assert set(ranged) == set(whole)
    for slug in whole:
        assert struct.pack("<d", ranged[slug]) == struct.pack("<d", whole[slug])
    # The scaled coordinate axes match to the dtype and the bit.
    assert whole_x.dtype == ranged_x.dtype
    assert numpy.array_equal(numpy.asarray(whole_x), numpy.asarray(ranged_x))


def test_the_dsr_quality_gate_stays_exact_zero_on_both_paths(granule):
    url, payload = granule
    # The DSR product's gate (unmasked AND DQF == 0) over the same granule
    # variable: only the DQF-0 pixel passes, and the fill-with-DQF-0
    # night pixel stays an absence — on both paths.
    import dataclasses

    product = dataclasses.replace(
        goes.PRODUCTS["goes18-dsr"], variable="AOD", value_key="downwardShortwaveWm2"
    )
    whole, _ = _whole_file_samples(payload, product)
    with goes._RangedGranule(url, DownloadStats()) as ranged_granule:
        _, ranged = goes._sample_sites(ranged_granule, product, SITES, dict(PIXELS))

    assert set(whole) == {"good"}
    assert ranged == whole


def test_ranged_stats_count_a_fraction_of_the_file(granule):
    url, payload = granule
    stats = DownloadStats()
    with goes._RangedGranule(url, stats) as ranged_granule:
        goes._sample_sites(ranged_granule, goes.PRODUCTS["goes18-aod"], SITES, dict(PIXELS))

    assert stats.response_bytes == _GranuleHandler.ranged_bytes_served
    # The point of the exercise: a handful of chunks, not the granule.
    assert 0 < stats.response_bytes < len(payload)


@pytest.mark.parametrize("mode", ["ignore", "corrupt"])
def test_fallback_serves_the_granule_when_the_ranged_path_fails(granule, capsys, mode):
    url, payload = granule
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
    url, payload = granule
    product = goes.PRODUCTS["goes18-aod"]
    whole, _ = _whole_file_samples(payload, product)

    _, samples, path_used = goes._granule_samples(
        url, product, SITES, dict(PIXELS), DownloadStats()
    )

    assert path_used == "ranged"
    assert samples == whole
