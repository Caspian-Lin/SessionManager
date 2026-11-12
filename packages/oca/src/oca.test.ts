import { describe, expect, it } from 'vitest';
import {
  computeConversationMerkleRoot,
  computeItemSemanticHash,
  computeMinHash128,
  estimateMinHashSimilarity,
  normalizeText,
  validateAndNormalizeDraft,
} from './index.js';

describe('@sm/oca core specification', () => {
  it('normalizes text deterministically without semantic loss', () => {
    const raw =
      '[2026-11-13 02:00:00] \x1b[32mHello\x1b[0m\u3000World!   \r\n\r\n\r\n\r\nSecond paragraph.\r\n';
    expect(normalizeText(raw)).toBe('Hello World!\n\nSecond paragraph.');
  });

  it('computes identical semantic hashes across CRLF and ANSI variations', () => {
    const h1 = computeItemSemanticHash({
      role: 'user',
      kind: 'message',
      blocks: [{ idx: 0, type: 'text', text: 'Fix bug\r\n\r\n\r\nin main.ts  ' }],
    });
    const h2 = computeItemSemanticHash({
      role: 'user',
      kind: 'message',
      blocks: [{ idx: 0, type: 'text', text: '\x1b[31mFix bug\x1b[0m\n\nin main.ts' }],
    });
    expect(h1).toBe(h2);
  });

  it('estimates MinHash128 Jaccard similarity accurately', () => {
    const base = Array.from({ length: 20 }, (_, i) => `item-hash-${i}`);
    const subset = base.slice(0, 18); // 90% overlap
    const fpA = computeMinHash128(base);
    const fpB = computeMinHash128(subset);
    const sim = estimateMinHashSimilarity(fpA, fpB);
    expect(sim).toBeGreaterThan(0.75);
  });

  it('repairs orphan nodes and cycles during draft validation', () => {
    const { conversation, issues } = validateAndNormalizeDraft({
      provider: 'openai-web',
      external_id: 'conv-1',
      items: [
        {
          external_id: 'item-1',
          parent_external_id: 'non-existent-root',
          ordinal: 0,
          role: 'user',
          kind: 'message',
          blocks: [{ idx: 0, type: 'text', text: 'First prompt for title' }],
        },
        {
          external_id: 'item-a',
          parent_external_id: 'item-b',
          ordinal: 1,
          role: 'assistant',
          kind: 'message',
          blocks: [{ idx: 0, type: 'text', text: 'Cycle A' }],
        },
        {
          external_id: 'item-b',
          parent_external_id: 'item-a',
          ordinal: 2,
          role: 'user',
          kind: 'message',
          blocks: [{ idx: 0, type: 'text', text: 'Cycle B' }],
        },
      ],
    });

    expect(conversation.title).toBe('First prompt for title');
    expect(conversation.title_source).toBe('first_user');
    expect(issues.some((i) => i.code === 'orphan_node')).toBe(true);
    expect(issues.some((i) => i.code === 'cycle_detected')).toBe(true);
    expect(conversation.content_hash).toBe(
      computeConversationMerkleRoot(conversation.items.map((i) => i.content_hash))
    );
  });
});
