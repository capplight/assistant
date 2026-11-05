"""UUIDv7 for `public_id` columns (time-ordered, safe to expose and to create offline).

Python 3.13 has no uuid.uuid7() and Postgres 17 has no uuidv7(), so ids are made here.
Rows that existed before a table got `public_id` were backfilled with gen_random_uuid() (v4);
clients must treat public ids as opaque UUIDs and never parse the version.
"""

import os
import time
import uuid


def uuid7() -> uuid.UUID:
    """RFC 9562 UUIDv7: 48-bit unix ms timestamp, version 7, 74 random bits."""
    ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    value = (ms & 0xFFFF_FFFF_FFFF) << 80
    value |= 0x7 << 76  # version
    value |= ((rand >> 62) & 0xFFF) << 64  # rand_a, 12 bits
    value |= 0b10 << 62  # variant
    value |= rand & ((1 << 62) - 1)  # rand_b, 62 bits
    return uuid.UUID(int=value)
