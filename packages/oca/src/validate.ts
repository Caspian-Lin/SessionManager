import {
  computeConversationHeadHash,
  computeConversationMerkleRoot,
  computeItemSemanticHash,
  projectItemText,
} from './hash.js';
import { computeMinHash128 } from './minhash.js';
import {
  OCA_SPILL_THRESHOLD_BYTES,
  OCA_TEXT_PREVIEW_MAX_CHARS,
  type OcaConversation,
  type OcaConversationDraft,
  type OcaIntegrityIssue,
  type OcaItem,
} from './types.js';

export interface ValidateAndNormalizeResult {
  conversation: OcaConversation;
  issues: OcaIntegrityIssue[];
}

/**
 * Validates an OcaConversationDraft from any Adapter, repairs tree anomalies
 * (orphan parent_external_id, cycles, duplicate external_ids), computes all 5 hash levels,
 * and returns a normalized OcaConversation ready for deduplication & storage.
 */
export function validateAndNormalizeDraft(draft: OcaConversationDraft): ValidateAndNormalizeResult {
  const issues: OcaIntegrityIssue[] = [];
  const convExtId = draft.external_id ?? null;

  // 1. Deduplicate items with identical external_id within the same draft
  const byId = new Map<string, OcaItem>();
  for (const rawItem of draft.items) {
    const projected = projectItemText(rawItem.blocks, rawItem.text);
    const truncatedText =
      projected.length > OCA_TEXT_PREVIEW_MAX_CHARS
        ? projected.slice(0, OCA_TEXT_PREVIEW_MAX_CHARS)
        : projected;

    // Check 32KB inline spill compliance on blocks
    for (const block of rawItem.blocks) {
      if (block.tool_input && Buffer.byteLength(block.tool_input, 'utf8') > OCA_SPILL_THRESHOLD_BYTES && !block.blob_sha256) {
        issues.push({
          code: 'oversized_inline_payload',
          severity: 'warn',
          message: `Block idx=${block.idx} has tool_input > 32KB without blob_sha256 spill`,
          conversation_external_id: convExtId,
          item_external_id: rawItem.external_id,
        });
      }
    }

    const contentHash = rawItem.content_hash ?? computeItemSemanticHash(rawItem);

    const normalizedItem: OcaItem = {
      ...rawItem,
      parent_external_id: rawItem.parent_external_id ?? null,
      depth: rawItem.depth ?? 0,
      text: truncatedText,
      text_len: projected.length,
      content_hash: contentHash,
      is_active_branch: rawItem.is_active_branch ?? true,
      is_hidden: rawItem.is_hidden ?? false,
      is_synthetic: rawItem.is_synthetic ?? false,
    };

    if (byId.has(rawItem.external_id)) {
      issues.push({
        code: 'duplicate_external_id',
        severity: 'warn',
        message: `Duplicate item external_id "${rawItem.external_id}" merged`,
        conversation_external_id: convExtId,
        item_external_id: rawItem.external_id,
      });
    }
    byId.set(rawItem.external_id, normalizedItem);
  }

  // 2. Repair orphan parent pointers and detect cycles
  for (const item of byId.values()) {
    if (item.parent_external_id && !byId.has(item.parent_external_id)) {
      issues.push({
        code: 'orphan_node',
        severity: 'warn',
        message: `Item "${item.external_id}" references missing parent "${item.parent_external_id}"; re-attached to root`,
        conversation_external_id: convExtId,
        item_external_id: item.external_id,
      });
      item.parent_external_id = null;
    }
  }

  // Detect cycles & compute depth
  const visitState = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done
  const computeDepth = (id: string): number => {
    const state = visitState.get(id) ?? 0;
    const item = byId.get(id)!;
    if (state === 1) {
      // Cycle detected! Break edge
      issues.push({
        code: 'cycle_detected',
        severity: 'error',
        message: `Cycle detected at item "${id}"; parent edge broken`,
        conversation_external_id: convExtId,
        item_external_id: id,
      });
      item.parent_external_id = null;
      visitState.set(id, 2);
      item.depth = 0;
      return 0;
    }
    if (state === 2) {
      return item.depth;
    }
    visitState.set(id, 1);
    const d = item.parent_external_id ? computeDepth(item.parent_external_id) + 1 : 0;
    item.depth = d;
    visitState.set(id, 2);
    return d;
  };

  for (const id of byId.keys()) {
    computeDepth(id);
  }

  // 3. Time anomaly check
  if (
    draft.created_at != null &&
    draft.updated_at != null &&
    draft.updated_at < draft.created_at
  ) {
    issues.push({
      code: 'time_anomaly',
      severity: 'warn',
      message: `Conversation updated_at (${draft.updated_at}) < created_at (${draft.created_at})`,
      conversation_external_id: convExtId,
    });
  }

  const items = [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
  const substantiveHashes = items
    .filter((i) => !i.is_synthetic && !i.is_hidden)
    .map((i) => i.content_hash);
  const allHashes = items.map((i) => i.content_hash);

  const headHash = computeConversationHeadHash(items);
  const contentHash = computeConversationMerkleRoot(allHashes);
  const fingerprint = computeMinHash128(substantiveHashes.length > 0 ? substantiveHashes : allHashes);

  // Derive fallback title from first user message if missing
  let title = draft.title ?? null;
  let titleSource = draft.title_source ?? (title ? 'provider' : null);
  if (!title) {
    const firstUser = items.find((i) => i.role === 'user' && !i.is_synthetic && i.text.trim().length > 0);
    if (firstUser) {
      title = firstUser.text.trim().replace(/\s+/g, ' ').slice(0, 40);
      titleSource = 'first_user';
    }
  }

  return {
    conversation: {
      ...draft,
      title,
      title_source: titleSource,
      head_hash: headHash,
      content_hash: contentHash,
      fingerprint,
      items,
    },
    issues,
  };
}
