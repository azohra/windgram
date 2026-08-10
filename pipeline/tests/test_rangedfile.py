import re

from windgram.noaa import DownloadStats
from windgram.rangedfile import RangedHTTPFile


class _FakeResponse:
    def __init__(self, status_code, content=b"", headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}


class _FakeRangeSession:
    """Serves one payload with honest 206 semantics; can also play the
    server that ignores Range headers and answers 200 whole."""

    def __init__(self, payload: bytes, honors_range: bool = True):
        self.payload = payload
        self.honors_range = honors_range
        self.ranges: list[str] = []
        self.served_bytes = 0

    def get(self, url, headers=None, timeout=None):
        self.ranges.append(headers["Range"])
        if not self.honors_range:
            self.served_bytes += len(self.payload)
            return _FakeResponse(200, self.payload)
        matched = re.fullmatch(r"bytes=(\d+)-(\d+)", headers["Range"])
        start = int(matched.group(1))
        end = min(int(matched.group(2)), len(self.payload) - 1)
        body = self.payload[start : end + 1]
        self.served_bytes += len(body)
        return _FakeResponse(
            206, body, {"Content-Range": f"bytes {start}-{end}/{len(self.payload)}"}
        )


PAYLOAD = bytes(range(256)) * 8  # 2048 B of position-identifiable bytes


def _reader(session, block_size=256):
    return RangedHTTPFile(
        "https://bucket.example/granule.nc",
        DownloadStats(),
        session=session,
        block_size=block_size,
    )


def test_reads_and_seeks_return_the_exact_bytes():
    reader = _reader(_FakeRangeSession(PAYLOAD))

    assert reader.read(4) == PAYLOAD[:4]
    reader.seek(1000)
    assert reader.read(300) == PAYLOAD[1000:1300]  # crosses block boundaries
    reader.seek(-8, 2)
    assert reader.read() == PAYLOAD[-8:]
    assert reader.read(10) == b""  # past EOF
    reader.seek(2040)
    assert reader.read(100) == PAYLOAD[2040:]  # clamped at EOF


def test_blocks_are_cached_and_read_ahead_by_one_block():
    session = _FakeRangeSession(PAYLOAD)
    reader = _reader(session, block_size=256)

    reader.read(4)
    # One request for block 0 plus one block of read-ahead.
    assert session.ranges == ["bytes=0-511"]
    reader.seek(0)
    reader.read(512)  # both blocks already cached: no new request
    assert len(session.ranges) == 1
    reader.read(1)  # block 2 misses; read-ahead pulls block 3 too
    assert session.ranges[-1] == "bytes=512-1023"


def test_download_stats_count_exactly_the_ranged_bytes():
    session = _FakeRangeSession(PAYLOAD)
    stats = DownloadStats()
    reader = RangedHTTPFile(
        "https://bucket.example/granule.nc", stats, session=session, block_size=256
    )

    reader.seek(1024)
    reader.read(10)

    assert stats.requests == len(session.ranges)
    assert stats.response_bytes == session.served_bytes
    # Sensitivity: a partial read really moved fewer bytes than the file.
    assert 0 < stats.response_bytes < len(PAYLOAD)


def test_a_server_that_ignores_range_poisons_the_reader_without_raising():
    # A 200 would silently make "ranged" a whole-file download. But the
    # failure must not RAISE here: h5py drives this object from C
    # callbacks, and an exception inside one deadlocks the interpreter
    # (observed 2026-08-10). The reader records the error and goes dark;
    # its owner re-raises after every h5py operation.
    session = _FakeRangeSession(PAYLOAD, honors_range=False)
    reader = _reader(session)

    assert reader.read(4) == b""
    assert isinstance(reader.error, RuntimeError)
    assert "answered 200" in str(reader.error)
    # Poisoned means dark: no further requests, no phantom bytes.
    requests_so_far = len(session.ranges)
    assert reader.read(4) == b""
    assert reader.seek(0, 2) == 0  # SEEK_END cannot know the size either
    assert len(session.ranges) == requests_so_far
