/**
 * MinHash(128) Fingerprint & LSH Banding for Approximate Same-Provider Deduplication.
 *
 * Computes a 128-permutation MinHash signature over the set of turn semantic hashes
 * and encodes it as base64.
 */

const NUM_HASHES = 128;
const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

function fnv1a32(str: string, seed: number): number {
  let h = (FNV_OFFSET ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const SEEDS: readonly number[] = Array.from({ length: NUM_HASHES }, (_, i) =>
  Math.imul(i + 1, 0x9e3779b9) >>> 0
);

/**
 * Computes a 128-dimensional 32-bit MinHash signature encoded as base64 (512 bytes -> 684 chars base64).
 */
export function computeMinHash128(tokens: readonly string[]): string {
  const sig = new Uint32Array(NUM_HASHES);
  sig.fill(0xffffffff);

  if (tokens.length === 0) {
    return Buffer.from(sig.buffer, sig.byteOffset, sig.byteLength).toString('base64');
  }

  for (const token of tokens) {
    if (!token) continue;
    for (let i = 0; i < NUM_HASHES; i++) {
      const h = fnv1a32(token, SEEDS[i]!);
      if (h < sig[i]!) {
        sig[i] = h;
      }
    }
  }

  return Buffer.from(sig.buffer, sig.byteOffset, sig.byteLength).toString('base64');
}

export const computeMinHashFingerprint = computeMinHash128;

/**
 * Decodes a base64 MinHash128 fingerprint back to Uint32Array.
 */
export function decodeMinHash128(base64Fingerprint: string): Uint32Array {
  const buf = Buffer.from(base64Fingerprint, 'base64');
  if (buf.byteLength !== NUM_HASHES * 4) {
    throw new Error(`Invalid MinHash128 byte length: expected ${NUM_HASHES * 4}, got ${buf.byteLength}`);
  }
  return new Uint32Array(buf.buffer, buf.byteOffset, NUM_HASHES);
}

/**
 * Estimates Jaccard similarity (0..1) between two base64-encoded MinHash128 fingerprints.
 */
export function estimateMinHashSimilarity(fpA: string, fpB: string): number {
  if (fpA === fpB) return 1.0;
  const sigA = decodeMinHash128(fpA);
  const sigB = decodeMinHash128(fpB);
  let matches = 0;
  for (let i = 0; i < NUM_HASHES; i++) {
    if (sigA[i] === sigB[i]) matches++;
  }
  return matches / NUM_HASHES;
}

export const estimateJaccardSimilarity = estimateMinHashSimilarity;

/**
 * Splits a MinHash128 fingerprint into `bands` LSH bucket keys (default: 16 bands x 8 rows)
 * for sub-linear candidate generation.
 */
export function computeLshBands(base64Fingerprint: string, bands = 16): string[] {
  const sig = decodeMinHash128(base64Fingerprint);
  const rowsPerBand = Math.floor(NUM_HASHES / bands);
  const keys: string[] = [];
  for (let b = 0; b < bands; b++) {
    const slice = sig.subarray(b * rowsPerBand, (b + 1) * rowsPerBand);
    keys.push(`b${b}:${Array.from(slice, (v) => v.toString(16).padStart(8, '0')).join('')}`);
  }
  return keys;
}
