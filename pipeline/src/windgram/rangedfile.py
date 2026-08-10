"""A read-only, seekable file over HTTP Range requests.

Built for pulling a handful of HDF5 chunks out of a multi-megabyte GOES
granule (h5py accepts any file-like object) without downloading the file
whole: fixed-size blocks are fetched on demand — a miss fetches the
whole missing run plus READ_AHEAD_BLOCKS in one request — and cached for
the file's lifetime, so the metadata walk and the chunk reads cost a few
hundred kilobytes instead of tens of megabytes. Every request and every
response byte is counted through the caller's DownloadStats, so manifest
telemetry stays honest about what a build really moved.

Failure manners: 429s, 5xx, and transport errors retry three times with
backoff, mirroring the builders' fetch manners; anything else — including
a 200 from a server ignoring Range, which would make "ranged" a silent
whole-file download — fails the read. But the failure NEVER raises out
of read/seek: h5py drives this object from C callbacks, and an exception
raised inside one leaves a pending interpreter exception while HDF5
keeps calling the next callback (observed as a deadlock, 2026-08-10).
Instead the reader poisons itself — `error` holds the failure, every
subsequent read serves nothing — and the owner re-raises `error` after
each h5py operation. The caller's whole-file fallback is the safety
net, not this module.
"""

from __future__ import annotations

import io
import re
import threading
import time

import requests

REQUEST_TIMEOUT_S = 120
BLOCK_SIZE = 64 * 1024
READ_AHEAD_BLOCKS = 1

_CONTENT_RANGE = re.compile(r"bytes (\d+)-(\d+)/(\d+)")

_session_local = threading.local()


def _session() -> requests.Session:
    session = getattr(_session_local, "session", None)
    if session is None:
        session = requests.Session()
        _session_local.session = session
    return session


class RangedHTTPFile(io.RawIOBase):
    """Seek/read over one URL via HTTP Range, with a block cache."""

    def __init__(
        self,
        url: str,
        stats,
        *,
        session=None,
        block_size: int = BLOCK_SIZE,
        timeout: float = REQUEST_TIMEOUT_S,
    ) -> None:
        super().__init__()
        self._url = url
        self._stats = stats
        self._explicit_session = session
        self._block_size = block_size
        self._timeout = timeout
        self._blocks: dict[int, bytes] = {}
        self._size: int | None = None
        self._pos = 0
        #: The first fetch failure, kept instead of raised (see module
        #: docstring); a poisoned reader answers every read with b"".
        self.error: Exception | None = None

    # ------------------------------------------------------ io protocol

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        if whence == io.SEEK_SET:
            position = offset
        elif whence == io.SEEK_CUR:
            position = self._pos + offset
        elif whence == io.SEEK_END:
            if self._safe_file_size() is None:
                return self._pos  # poisoned: hold position, owner re-raises
            position = self._size + offset
        else:
            raise ValueError(f"unsupported whence {whence}")
        if position < 0:
            raise ValueError("negative seek position")
        self._pos = position
        return position

    def read(self, size: int = -1) -> bytes:
        file_size = self._safe_file_size()
        if file_size is None:
            return b""
        if self._pos >= file_size:
            return b""
        if size is None or size < 0:
            size = file_size - self._pos
        end = min(self._pos + size, file_size)
        if end <= self._pos:
            return b""
        first = self._pos // self._block_size
        last = (end - 1) // self._block_size
        try:
            self._ensure_blocks(first, last)
        except Exception as error:  # noqa: BLE001 — poison, never raise (module docstring)
            self.error = self.error or error
            return b""
        parts = []
        for index in range(first, last + 1):
            block = self._blocks[index]
            start_within = self._pos - index * self._block_size if index == first else 0
            end_within = end - index * self._block_size if index == last else len(block)
            parts.append(block[start_within:end_within])
        data = b"".join(parts)
        self._pos = end
        return data

    def readinto(self, buffer) -> int:
        data = self.read(len(buffer))
        buffer[: len(data)] = data
        return len(data)

    # ---------------------------------------------------- block fetching

    def _safe_file_size(self) -> int | None:
        """The file size, or None once the reader is poisoned."""
        if self.error is not None:
            return None
        if self._size is None:
            try:
                # The first block carries the HDF5 superblock anyway; its
                # Content-Range total tells us the file size for free.
                self._fetch_blocks(0, 0)
            except Exception as error:  # noqa: BLE001 — poison, never raise
                self.error = error
                return None
        return self._size

    def _last_block(self) -> int | None:
        if self._size is None:
            return None
        return max((self._size - 1) // self._block_size, 0)

    def _ensure_blocks(self, first: int, last: int) -> None:
        index = first
        while index <= last:
            if index in self._blocks:
                index += 1
                continue
            run_end = index
            while run_end < last and (run_end + 1) not in self._blocks:
                run_end += 1
            self._fetch_blocks(index, run_end)
            index = run_end + 1

    def _fetch_blocks(self, first: int, last: int) -> None:
        last += READ_AHEAD_BLOCKS
        last_block = self._last_block()
        if last_block is not None:
            last = min(last, last_block)
        start = first * self._block_size
        end = (last + 1) * self._block_size - 1  # inclusive; servers clamp at EOF
        content = self._fetch_range(start, end)
        for offset in range(0, len(content), self._block_size):
            index = first + offset // self._block_size
            self._blocks[index] = content[offset : offset + self._block_size]

    def _fetch_range(self, start: int, end: int) -> bytes:
        session = self._explicit_session or _session()
        headers = {"Range": f"bytes={start}-{end}"}
        last_error: Exception | None = None
        for attempt in range(3):
            self._stats.record_request(retry=attempt > 0)
            try:
                response = session.get(self._url, headers=headers, timeout=self._timeout)
                if response.status_code == 206:
                    self._stats.record_bytes(len(response.content))
                    matched = _CONTENT_RANGE.match(response.headers.get("Content-Range", ""))
                    if not matched:
                        raise RuntimeError(f"{self._url} sent 206 without a Content-Range")
                    self._size = int(matched.group(3))
                    return response.content
                if response.status_code != 429 and response.status_code < 500:
                    # Includes a 200: a server ignoring Range would make
                    # "ranged" a silent whole-file download — fail instead.
                    raise RuntimeError(
                        f"{self._url} answered {response.status_code} to a Range request"
                    )
                last_error = RuntimeError(
                    f"{self._url} answered {response.status_code} to a Range request"
                )
            except requests.RequestException as error:
                last_error = error
            if attempt < 2:
                time.sleep(2**attempt)
        assert last_error is not None
        raise last_error
