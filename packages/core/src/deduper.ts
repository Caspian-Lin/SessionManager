import { estimateMinHashSimilarity, type OcaConversation } from '@sm/oca';

export type DedupeDecision =
  | 'identical'
  | 'superset_append'
  | 'branch_revision'
  | 'auto_merge_fingerprint'
  | 'candidate_review'
  | 'new';

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
 * Estimates Jaccard similarity between two conversations using their MinHash fingerprints.
 */
export function estimateConversationSimilarity(a: OcaConversation, b: OcaConversation): number {
  if (a.fingerprint === b.fingerprint) return 1.0;
  if (!a.fingerprint || !b.fingerprint) return 0.0;
  try {
    return estimateMinHashSimilarity(a.fingerprint, b.fingerprint);
  } catch {
    return 0.0;
  }
}

/**
 * Multi-tier L0–L4 deduplication decision engine:
 * - L0: Identical content hash (exact duplicate) -> 'identical'
 * - L1: Superset append (incoming is pure forward extension of existing) -> 'superset_append'
 * - L2: External ID match with divergent content -> 'branch_revision'
 * - L3: MinHash similarity >= 0.90 -> 'auto_merge_fingerprint'
 * - L4: MinHash similarity >= 0.75 -> 'candidate_review'
 * - Default -> 'new'
 */
export function decideConversationMerge(
  incoming: OcaConversation,
  existing: OcaConversation | null
): DedupeDecision {
  if (!existing) {
    return 'new';
  }

  // L0: Exact content hash match
  if (incoming.content_hash === existing.content_hash) {
    return 'identical';
  }

  // L1: Superset append check
  const existingHashes = existing.items.map((it) => it.content_hash);
  const incomingHashes = incoming.items.map((it) => it.content_hash);

  if (
    existingHashes.length > 0 &&
    incomingHashes.length > existingHashes.length &&
    isSubsequence(existingHashes, incomingHashes)
  ) {
    return 'superset_append';
  }

  // L2: Same provider external ID with divergence
  if (
    incoming.external_id &&
    existing.external_id &&
    incoming.external_id === existing.external_id &&
    incoming.provider === existing.provider
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
