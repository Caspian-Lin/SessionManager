import type { SessionDocument } from '@sm/adapters';
import type { BatchDiffStats, ConversationViewModel } from '@sm/shared';
import { estimateConversationSimilarity } from './deduper.js';

export type DiffableSession = SessionDocument | ConversationViewModel;

function asView(input: DiffableSession): ConversationViewModel {
  return 'toViewModel' in input ? input.toViewModel() : input;
}

/**
 * Computes delta metrics between an earlier same-provider snapshot (`prevSessions`)
 * and a newly ingested snapshot (`nextSessions`). Flags shrunk sessions (messages deleted upstream),
 * additions, disappearances, and ambiguous candidates.
 */
export function buildBatchDiffStats(
  prevSessions: readonly DiffableSession[],
  nextSessions: readonly DiffableSession[],
  previousBatchId?: number | null
): BatchDiffStats {
  let added = 0;
  let grown = 0;
  let shrunk = 0;
  const shrunkIds: string[] = [];
  let disappeared = 0;
  let identical = 0;
  let ambiguous = 0;

  const prevViews = prevSessions.map(asView);
  const nextViews = nextSessions.map(asView);

  const prevByExtId = new Map<string, ConversationViewModel>();
  const prevByContentHash = new Map<string, ConversationViewModel>();
  const prevByHeadHash = new Map<string, ConversationViewModel[]>();

  for (const prev of prevViews) {
    if (prev.meta.external_id) {
      prevByExtId.set(`${prev.meta.provider}:${prev.meta.external_id}`, prev);
    }
    prevByContentHash.set(`${prev.meta.provider}:${prev.meta.content_hash}`, prev);
    if (prev.meta.head_hash) {
      const key = `${prev.meta.provider}:${prev.meta.head_hash}`;
      const list = prevByHeadHash.get(key) ?? [];
      list.push(prev);
      prevByHeadHash.set(key, list);
    }
  }

  const matchedPrevKeys = new Set<string>();

  for (const next of nextViews) {
    let matchedPrev: ConversationViewModel | null = null;
    let matchKey: string | null = null;

    if (next.meta.external_id) {
      const key = `${next.meta.provider}:${next.meta.external_id}`;
      const found = prevByExtId.get(key);
      if (found) {
        matchedPrev = found;
        matchKey = key;
      }
    }

    if (!matchedPrev) {
      const found = prevByContentHash.get(`${next.meta.provider}:${next.meta.content_hash}`);
      if (found) {
        matchedPrev = found;
        matchKey = found.meta.external_id
          ? `${found.meta.provider}:${found.meta.external_id}`
          : `${found.meta.provider}:${found.meta.content_hash}`;
      }
    }

    if (!matchedPrev && next.meta.head_hash) {
      const candidates = prevByHeadHash.get(`${next.meta.provider}:${next.meta.head_hash}`);
      if (candidates && candidates.length > 0) {
        for (const cand of candidates) {
          const sim = estimateConversationSimilarity(next, cand);
          if (sim >= 0.75) {
            matchedPrev = cand;
            matchKey = cand.meta.external_id
              ? `${cand.meta.provider}:${cand.meta.external_id}`
              : `${cand.meta.provider}:${cand.meta.content_hash}`;
            break;
          }
        }
      }
    }

    if (!matchedPrev) {
      added++;
    } else {
      if (matchKey) matchedPrevKeys.add(matchKey);

      if (next.meta.content_hash === matchedPrev.meta.content_hash) {
        identical++;
      } else if (next.nodes.length > matchedPrev.nodes.length) {
        grown++;
      } else if (next.nodes.length < matchedPrev.nodes.length) {
        shrunk++;
        const reportedId = matchedPrev.meta.external_id ?? matchedPrev.meta.content_hash;
        shrunkIds.push(reportedId);
      } else {
        ambiguous++;
      }
    }
  }

  for (const prev of prevViews) {
    const key = prev.meta.external_id
      ? `${prev.meta.provider}:${prev.meta.external_id}`
      : `${prev.meta.provider}:${prev.meta.content_hash}`;
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
