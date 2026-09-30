"""The little of PNG this package reads and writes.

The elevation tiles arrive as PNGs, which ``terrain`` decodes with a reader
of its own, and the link previews are written as PNGs by ``previews``. Both
only need the signature and the chunk layout: a length, a type, the data and
a CRC over the type and the data.
"""

import struct
import zlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

__all__ = [
    "PNG_SIGNATURE",
    "PngError",
    "chunk",
    "chunks",
]

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class PngError(ValueError):
    """A PNG this package cannot or will not read."""


def chunks(data: bytes) -> Iterable[tuple[bytes, bytes]]:
    """The chunks of a PNG after its signature, each checked against its CRC.

    Raises ``PngError`` for a corrupt chunk, and once the data runs out
    before an IEND chunk: a reader stops at IEND itself.
    """
    pos = len(PNG_SIGNATURE)
    while pos + 12 <= len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if len(body) != length or pos + 12 + length > len(data):
            break
        (crc,) = struct.unpack_from(">I", data, pos + 8 + length)
        if zlib.crc32(kind + body) != crc:
            raise PngError(f"PNG chunk {kind!r} is corrupt")
        yield kind, body
        pos += 12 + length
    raise PngError("PNG ends before its IEND chunk")


def chunk(kind: bytes, data: bytes) -> bytes:
    """One chunk of a PNG: its length, type, data and CRC."""
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data))
    )
