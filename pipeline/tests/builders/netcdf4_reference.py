"""Subprocess-only netCDF4 reference for the ranged-granule tests.

Writes the synthetic ABI-shaped granule and reports netCDF4's own
mask-and-scale reading of every probe pixel as JSON on stdout. It runs
in its OWN interpreter because the h5py and netCDF4 wheels each bundle
a libhdf5, and loading both into one process segfaults the interpreter
at shutdown (exit 139, every Linux CI run of the first 0.6.0 push) —
one HDF5 stack per process, so the reference must never import goes.py
or h5py, and the test process must never import netCDF4.

Usage: python netcdf4_reference.py <granule-path>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import netCDF4
import numpy

SIZE = 512

# Pixels chosen to exercise every branch of the validity gate; the test
# module mirrors this table (asserted equal through the JSON).
PIXELS = {
    "good": (2, 2),  # valid retrieval, DQF 0
    "medium": (3, 3),  # valid retrieval, DQF 1
    "low": (4, 4),  # valid retrieval, DQF 2 — AOD rejects
    "worst": (5, 5),  # valid retrieval, DQF 3 — AOD rejects
    "night": (0, 0),  # _FillValue with DQF 0 — the DSR trap
    "invalid": (0, 1),  # outside valid_range but not fill
}


def write_granule(path: Path) -> None:
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


def reference(path: Path) -> dict:
    """netCDF4's auto mask-and-scale truth: per probe pixel, whether the
    value is masked, the scaled value, and the DQF — the independent
    reading the h5py paths must match bit for bit."""
    dataset = netCDF4.Dataset(path, "r")
    aod = dataset["AOD"]
    dqf = dataset["DQF"]
    pixels = {}
    for slug, (row, column) in PIXELS.items():
        value = aod[row, column]
        masked = bool(getattr(value, "mask", False))
        quality = dqf[row, column]
        pixels[slug] = {
            "masked": masked,
            "value": None if masked else float(value),
            "dqfMasked": bool(getattr(quality, "mask", False)),
            "dqf": int(quality),
        }
    x_values = dataset["x"][:]
    result = {
        "pixels": pixels,
        "x": [float(value) for value in numpy.asarray(x_values)],
        "xDtype": str(numpy.asarray(x_values).dtype),
    }
    dataset.close()
    return result


if __name__ == "__main__":
    granule_path = Path(sys.argv[1])
    write_granule(granule_path)
    json.dump(reference(granule_path), sys.stdout)
