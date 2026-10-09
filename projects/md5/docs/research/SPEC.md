# Specification: the three frozen tracks

All tracks use complete MD5 as specified by [RFC 1321](https://www.rfc-editor.org/rfc/rfc1321), including the standard initial state, all rounds, padding, and encoded message length. Reduced rounds, custom initial states, raw compression-function collisions, and intermediate-state matches do not qualify. Render digests as 32 lowercase hexadecimal characters.

For this platform, **1 KiB means exactly 1,024 bytes**. Byte limits count original input bytes, excluding MD5 padding and transport encoding.

### Track 1 Self match

Challenge ID: `md5-mirror-ascii32-v1`.

The candidate `s` must be exactly 32 lowercase ASCII characters from `0123456789abcdef`. This is the allowed alphabet, not a required sequence: characters may appear in any order and repeat. Hash those **32 literal ASCII bytes**, without decoding the candidate as hex. Score the common prefix of `s` and its digest: an integer from 0 through 32, higher is better. Stop at the first mismatch; later matches do not count.

The final goal is `MD5(s.encode("ascii")).hexdigest() == s`.

### Track 2 All zeros

Challenge ID: `md5-zero-bytes1024-v1`.

The input is any byte string of length 0 through 1,024, inclusive. Score consecutive zero hexadecimal characters at the start of its digest, from 0 through 32; higher is better. Stop at the first nonzero character. The final goal is exactly `00000000000000000000000000000000`.

Transport the input in an `input_hex` field using strict lowercase, even-length hexadecimal. Decode once and hash the resulting bytes. For example, `616263` means the three bytes of ASCII `abc`, not six ASCII hex characters. The empty string represents zero bytes. Arbitrary binary data is allowed.

### Track 3 Smallest collision

Challenge ID: `md5-collision-totalbytes1024-v1`.

Inputs `a` and `b` are arbitrary byte strings, each 0 through 1,024 bytes. Unequal lengths and an empty input are allowed, but `a != b` is required. A result qualifies only if **all 128 digest bits match**.

Minimize `len(a) + len(b)` in decoded bytes. Lower is better. Show both lengths and the total. There is no partial-collision score, and hashing an input against itself never counts.

Use `a_hex` and `b_hex` with the same strict transport rules as Track 2. Treat the pair as unordered: swapping its members is a duplicate. Equal totals are tied results; the earliest eligible receipt owns the site record. V1 has no secondary competitive length metric.

### Shared validation

Do not trim whitespace, lowercase uppercase input, accept `0x` prefixes, normalize Unicode, add newlines, or silently repair submissions. Reject malformed, odd-length, oversized, or non-string fields. Decode transport JSON normally, then validate the resulting field values. The server recomputes all digests and scores; client previews are advisory.

Changing a domain, size limit, encoding, digest, or primary scoring rule requires a new challenge ID. Benchmark protocol versions are separately labeled and cannot redefine these tracks.

## Fixtures

Every local scorer should reproduce these before a search starts. All digests were recomputed with two independent implementations.

Required self-match fixtures:

| Literal ASCII candidate | Expected digest | Score |
| --- | --- | ---: |
| `00000000000000000000000000000000` | `cd9e459ea708a948d5c2f5a6ca8838cf` | 0 |
| `0000000000000000000000000000000e` | `0f5ecbfde00848fb349b3ad99d1a302d` | 1 |
| `000000000000000000000000000000e6` | `003d6287c0965a231a872922657ee7dd` | 2 |
| `00000000000000000000000000001efd` | `0005b7062c52fc4ee9762f633adb35fa` | 3 |
| `54db1011d76dc70a0a9df3ff3e0b390f` | `54db1011d76d137956603122ad86d762` | 12 |

Required all-zero-track fixtures:

| Hex transport input | Expected digest | Score |
| --- | --- | ---: |
| Empty string | `d41d8cd98f00b204e9800998ecf8427e` | 0 |
| `616263` | `900150983cd24fb0d6963f7d28e17f72` | 0 |
| `06` | `06eca1b437c7904cc3ce6546c8110110` | 1 |
| `6231303064343734656231303064363064303432653836336331653061646565` | `00000000000008d71ef80eb3849237d2` | 13 |

The last row encodes the 32 ASCII bytes `b100d474eb100d60d042e863c1e0adee`.

Required collision fixture, sourced from Stevens:

```python
A = ("4dc968ff0ee35c209572d4777b721587d"
     "36fa7b21bdc56b74a3dc0783e7b9518a"
     "fbfa200a8284bf36e8e4b55b35f42759"
     "3d849676da0d1555d8360fb5f07fea2")
B = ("4dc968ff0ee35c209572d4777b721587d"
     "36fa7b21bdc56b74a3dc0783e7b9518a"
     "fbfa202a8284bf36e8e4b55b35f42759"
     "3d849676da0d1d55d8360fb5f07fea2")
r = verify_collision(A, B)
assert r["digest"] == "008ee33a9d58b51cfeb425b0959121c9"
assert (r["a_bytes"], r["b_bytes"], r["total_bytes"]) == (64, 64, 128)
assert verify_collision(B, A) == r
```

All listed digest fixtures were recomputed using both Python's OpenSSL-backed `hashlib` and its separate `_md5` implementation. These are validation examples, not platform launch submissions.
