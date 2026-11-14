import { describe, expect, it } from 'vitest';
import {
  computeMinHash128,
  computeSessionMerkleRoot,
  computeTurnSemanticHash,
  estimateMinHashSimilarity,
  normalizeText,
} from './index.js';

describe('@sm/shared hashing & normalization', () => {
  it('normalizes text deterministically without semantic loss', () => {
    const raw =
      '[2026-11-13 02:00:00] \x1b[32mHello\x1b[0m\u3000World!   \r\n\r\n\r\n\r\nSecond paragraph.\r\n';
    expect(normalizeText(raw)).toBe('Hello World!\n\nSecond paragraph.');
  });

  it('computes identical semantic hashes across CRLF and ANSI variations', () => {
    const h1 = computeTurnSemanticHash({
      role: 'user',
      kind: 'message',
      blocks: [{ idx: 0, type: 'text', text: 'Fix bug\r\n\r\n\r\nin main.ts  ' }],
    });
    const h2 = computeTurnSemanticHash({
      role: 'user',
      kind: 'message',
      blocks: [{ idx: 0, type: 'text', text: '\x1b[31mFix bug\x1b[0m\n\nin main.ts' }],
    });
    expect(h1).toBe(h2);
  });

  it('estimates MinHash128 Jaccard similarity accurately', () => {
    const base = Array.from({ length: 20 }, (_, i) => `item-hash-${i}`);
    const subset = base.slice(0, 18);
    const fpA = computeMinHash128(base);
    const fpB = computeMinHash128(subset);
    const sim = estimateMinHashSimilarity(fpA, fpB);
    expect(sim).toBeGreaterThan(0.75);
  });

  it('computes stable Merkle roots over turn hashes', () => {
    const r1 = computeSessionMerkleRoot(['a', 'b', 'c']);
    const r2 = computeSessionMerkleRoot(['c', 'a', 'b', 'b']);
    expect(r1).toBe(r2);
  });
});
