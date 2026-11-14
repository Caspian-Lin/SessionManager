import type { SessionDocument } from '@sm/adapters';
import {
  estimateMinHashSimilarity,
  type ConversationViewModel,
} from '@sm/shared';

export type DedupeDecision =
  | 'identical'
  | 'superset_append'
  | 'branch_revision'
  | 'auto_merge_fingerprint'
  | 'candidate_review'
  | 'new';

export type DedupeComparable = SessionDocument | ConversationViewModel;

function toViewModel(input: DedupeComparable): ConversationViewModel {
  return 'toViewModel' in input ? input.toViewModel() : input;
}

/**
 * Checks whether sequence `sub` appears in `full` in the same relative order.
 */
export function isSubsequence(sub: readonly string[], full: readonly string[]): boolean {
  if (sub.length === 0) return true;
  if (sub.length > full.length) return false;

  let subIdx = 0;
  for (let i = 0; i < full.length; i++) {
    if (full[i] === sub[subIdx]) {
      subIdx++;
      if (subIdx === sub.length) return true;
    }
  }
  return false;
}

/**
 * Estimates Jaccard similarity between two same-provider sessions using their MinHash fingerprints.
 */
export function estimateConversationSimilarity(a: DedupeComparable, b: DedupeComparable): number {
  const metaA = toViewModel(a).meta;
  const metaB = toViewModel(b).meta;
  if (metaA.fingerprint === metaB.fingerprint) return 1.0;
  if (!metaA.fingerprint || !metaB.fingerprint) return 0.0;
  try {
    return estimateMinHashSimilarity(metaA.fingerprint, metaB.fingerprint);
  } catch {
    return 0.0;
  }
}

/**
 * Same-provider L0–L4 deduplication decision engine.
 * Cross-provider pairs are treated as distinct ('new') unless explicitly reconciled.
 */
export function decideConversationMerge(
  incomingInput: DedupeComparable,
  existingInput: DedupeComparable | null
): DedupeDecision {
  if (!existingInput) {
    return 'new';
  }

  const incoming = toViewModel(incomingInput);
  const existing = toViewModel(existingInput);

  // Deduplication only runs within the same provider type
  if (incoming.meta.provider !== existing.meta.provider) {
    return 'new';
  }

  // If both are SessionDocument instances of the same provider, leverage polymorphic diffWith()
  if ('diffWith' in incomingInput && 'diffWith' in existingInput) {
    const diff = incomingInput.diffWith(existingInput);
    if (diff.status === 'identical') return 'identical';
    if (diff.status === 'superset_append') return 'superset_append';
    if (
      incoming.meta.external_id &&
      existing.meta.external_id &&
      incoming.meta.external_id === existing.meta.external_id
    ) {
      return 'branch_revision';
    }
    if (diff.similarity >= 0.9) return 'auto_merge_fingerprint';
    if (diff.similarity >= 0.75) return 'candidate_review';
    return 'new';
  }

  // L0: Exact content hash match
  if (incoming.meta.content_hash === existing.meta.content_hash) {
    return 'identical';
  }

  // L1: Superset append check
  const existingHashes = existing.nodes.map((it) => it.content_hash);
  const incomingHashes = incoming.nodes.map((it) => it.content_hash);

  if (
    existingHashes.length > 0 &&
    incomingHashes.length > existingHashes.length &&
    isSubsequence(existingHashes, incomingHashes)
  ) {
    return 'superset_append';
  }

  // L2: Same provider external ID with divergence
  if (
    incoming.meta.external_id &&
    existing.meta.external_id &&
    incoming.meta.external_id === existing.meta.external_id
  ) {
    return 'branch_revision';
  }

  // L3 & L4: MinHash Fingerprint similarity
  const sim = estimateConversationSimilarity(incoming, existing);
  if (sim >= 0.9) {
    return 'auto_merge_fingerprint';
  }
  if (sim >= 0.75) {
    return 'candidate_review';
  }

  return 'new';
}
