"""The MD5 Research Challenge reference verifier: the mathematical rules of the three frozen tracks, as specified.

The server verifier (src/lib/challenges.ts) must agree with this on every input; tests/challenge-md5.test.mjs holds them equal.
Run: python3 reference.py <challenge_id> <field> [<field>] prints the result as JSON.
"""
import hashlib
import re

MIRROR = "md5-mirror-ascii32-v1"
ZERO = "md5-zero-bytes1024-v1"
COLLISION = "md5-collision-totalbytes1024-v1"


def md5(data):
    return hashlib.md5(data, usedforsecurity=False).hexdigest()


def prefix(a, b):
    return next((i for i, (x, y) in enumerate(zip(a, b))
                 if x != y), min(len(a), len(b)))


def decode_hex(value):
    if (not isinstance(value, str) or len(value) > 2048
            or re.fullmatch(r"(?:[0-9a-f]{2})*", value) is None):
        raise ValueError("Expected lowercase hex encoding of 0–1024 bytes")
    return bytes.fromhex(value)


def verify_mirror(candidate):
    if (not isinstance(candidate, str)
            or re.fullmatch(r"[0-9a-f]{32}", candidate) is None):
        raise ValueError("Expected exactly 32 lowercase ASCII hex characters")
    digest = md5(candidate.encode("ascii"))
    return dict(challenge_id=MIRROR, candidate=candidate,
                digest=digest, score=prefix(candidate, digest))


def verify_zero(input_hex):
    data = decode_hex(input_hex)
    digest = md5(data)
    return dict(challenge_id=ZERO, input_hex=input_hex,
                byte_length=len(data), digest=digest,
                score=prefix("0" * 32, digest))


def verify_collision(a_hex, b_hex):
    a, b = sorted((decode_hex(a_hex), decode_hex(b_hex)))
    if a == b:
        raise ValueError("Inputs must differ")
    da, db = md5(a), md5(b)
    if da != db:
        raise ValueError("Full MD5 digests must match")
    return dict(challenge_id=COLLISION, a_hex=a.hex(), b_hex=b.hex(),
                a_bytes=len(a), b_bytes=len(b), digest=da,
                total_bytes=len(a) + len(b))


if __name__ == "__main__":
    import json, sys
    cid, *args = sys.argv[1:]
    fn = {MIRROR: verify_mirror, ZERO: verify_zero, COLLISION: verify_collision}[cid]
    try:
        print(json.dumps(fn(*args)))
    except ValueError as e:
        print(json.dumps({"error": str(e)}))
