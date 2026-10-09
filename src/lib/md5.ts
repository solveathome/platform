/**
 * MD5 written out from RFC 1321, independent of OpenSSL. Challenge verification recomputes every digest with Node's
 * OpenSSL-backed `crypto` and with this, and refuses to record a result the two disagree on: an exceptional claim (a fixed point,
 * an all-zero digest, a collision shorter than the published one) must hold under two genuinely separate implementations, and
 * two wrappers around one library would not be (the MD5 challenge proposal, acceptance test 6).
 */
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
// T[i] = floor(2^32 * |sin(i + 1)|), the table of RFC 1321 section 3.4, computed rather than copied.
const T = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export const RFC1321_IMPLEMENTATION = "rfc1321-ts-1";

export function md5Rfc1321(data: Uint8Array): string {
  // Padding: a 1 bit, zeros to 56 mod 64 bytes, then the bit length as a 64-bit little-endian integer.
  const n = data.length, padded = new Uint8Array(((n + 8) >> 6) + 1 << 6);
  padded.set(data); padded[n] = 0x80;
  const bits = n * 8, view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32) >>> 0, true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const sum = (A + F + T[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((w, i) => out.setUint32(i * 4, w, true));
  return Array.from(new Uint8Array(out.buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}
