// Minimal unkeyed BLAKE2b (RFC 7693) used for CIP-14 asset fingerprints.
// BigInt arithmetic keeps the implementation small and auditable; input sizes
// here are tiny (policy id + asset name ≤ 60 bytes), so throughput is irrelevant.

const MASK = 0xffff_ffff_ffff_ffffn;
const FINAL_FLAG = 0xffff_ffff_ffff_ffffn;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
] as const;

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
] as const;

const rot = (value: bigint, bits: number) => ((value >> BigInt(bits)) | (value << BigInt(64 - bits))) & MASK;

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean) {
  const m = Array.from({ length: 16 }, (_, index) => {
    let value = 0n;
    for (let byte = 7; byte >= 0; byte--) value = (value << 8n) | BigInt(block[index * 8 + byte]);
    return value;
  });
  const v = [...h, IV[0], IV[1], IV[2], IV[3], IV[4], IV[5], IV[6], IV[7]];
  v[12] ^= t & MASK;
  v[13] ^= t >> 64n;
  if (last) v[14] ^= FINAL_FLAG;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a] + v[b] + x) & MASK;
    v[d] = rot(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rot(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + y) & MASK;
    v[d] = rot(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d]) & MASK;
    v[b] = rot(v[b] ^ v[c], 63);
  };
  for (let round = 0; round < 12; round++) {
    const s = SIGMA[round];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let index = 0; index < 8; index++) h[index] ^= v[index] ^ v[index + 8];
}

export function blake2b(input: Uint8Array, digestBytes = 64): Uint8Array {
  if (!Number.isInteger(digestBytes) || digestBytes < 1 || digestBytes > 64) throw new Error("BLAKE2b 摘要长度必须在 1–64 字节之间");
  const h = [...IV];
  h[0] ^= 0x0101_0000n ^ BigInt(digestBytes);
  const fullBlocks = Math.floor(input.length / 128);
  let t = 0n;
  for (let block = 0; block < fullBlocks; block++) {
    t += 128n;
    compress(h, input.subarray(block * 128, block * 128 + 128), t, false);
  }
  const remainder = input.length - fullBlocks * 128;
  const lastBlock = new Uint8Array(128);
  lastBlock.set(input.subarray(fullBlocks * 128));
  t += BigInt(remainder);
  compress(h, lastBlock, t, true);
  const digest = new Uint8Array(digestBytes);
  for (let index = 0; index < digestBytes; index++) digest[index] = Number((h[index >> 3] >> BigInt(8 * (index % 8))) & 0xffn);
  return digest;
}
