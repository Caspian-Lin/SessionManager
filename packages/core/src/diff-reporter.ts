import type { OcaBatchDiffStats, OcaConversation } from '@sm/oca';
import { estimateConversationSimilarity } from './deduper.js';

/**
 * Computes delta metrics between an earlier conversation snapshot (`prevConvs`)
 * and a newly ingested snapshot (`nextConvs`). Accurately flags shrunk conversations
 * (messages deleted upstream), additions, disappearances, and ambiguous candidates.
 */
export function buildBatchDiffStats(
  prevConvs: readonly OcaConversation[],
  nextConvs: readonly OcaConversation[],
  previousBatchId?: number | null
): OcaBatchDiffStats {
  let added = 0;
  let grown = 0;
  let shrunk = 0;
  const shrunkIds: string[] = [];
  let disappeared = 0;
  let identical = 0;
  let ambiguous = 0;

  // Build indexes for fast alignment
  const prevByExtId = new Map<string, OcaConversation>();
  const prevByContentHash = new Map<string, OcaConversation>();
  const prevByHeadHash = new Map<string, OcaConversation[]>();

  for (const prev of prevConvs) {
    if (prev.external_id) {
      prevByExtId.set(`${prev.provider}:${prev.external_id}`, prev);
    }
    prevByContentHash.set(prev.content_hash, prev);
    if (prev.head_hash) {
      const list = prevByHeadHash.get(prev.head_hash) ?? [];
      list.push(prev);
      prevByHeadHash.set(prev.head_hash, list);
    }
  }

  const matchedPrevKeys = new Set<string>();

  for (const next of nextConvs) {
    let matchedPrev: OcaConversation | null = null;
    let matchKey: string | null = null;

    // 1. Try external_id alignment
    if (next.external_id) {
      const key = `${next.provider}:${next.external_id}`;
      const found = prevByExtId.get(key);
      if (found) {
        matchedPrev = found;
        matchKey = key;
      }
    }

    // 2. Try exact content_hash alignment
    if (!matchedPrev) {
      const found = prevByContentHash.get(next.content_hash);
      if (found) {
        matchedPrev = found;
        matchKey = found.external_id
          ? `${found.provider}:${found.external_id}`
          : found.content_hash;
      }
    }

    // 3. Try head_hash match + MinHash similarity
    if (!matchedPrev && next.head_hash) {
      const candidates = prevByHeadHash.get(next.head_hash);
      if (candidates && candidates.length > 0) {
        for (const cand of candidates) {
          const sim = estimateConversationSimilarity(next, cand);
          if (sim >= 0.75) {
            matchedPrev = cand;
            matchKey = cand.external_id
              ? `${cand.provider}:${cand.external_id}`
              : cand.content_hash;
            break;
          }
        }
      }
    }

    if (!matchedPrev) {
      added++;
    } else {
      if (matchKey) matchedPrevKeys.add(matchKey);

      if (next.content_hash === matchedPrev.content_hash) {
        identical++;
      } else if (next.items.length > matchedPrev.items.length) {
        grown++;
      } else if (next.items.length < matchedPrev.items.length) {
        shrunk++;
        const reportedId = matchedPrev.external_id ?? matchedPrev.content_hash;
        shrunkIds.push(reportedId);
      } else {
        // Equal item count but differing content hash
        ambiguous++;
      }
    }
  }

  // Count disappeared conversations
  for (const prev of prevConvs) {
    const key = prev.external_id ? `${prev.provider}:${prev.external_id}` : prev.content_hash;
    if (!matchedPrevKeys.has(key)) {
      disappeared++;
    }
  }

  return {
    previous_batch_id: previousBatchId ?? null,
    added_conversations: added,
    grown_conversations: grown,
    shrunk_conversations: shrunk,
    shrunk_conversation_ids: shrunkIds,
    disappeared_conversations: disappeared,
    identical_conversations: identical,
    ambiguous_candidates: ambiguous,
  };
}
