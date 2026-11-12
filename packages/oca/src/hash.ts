import crypto from 'node:crypto';
import { normalizeText } from './normalize.js';
import type { OcaBlock, OcaItemDraft, OcaItemKind, OcaRole } from './types.js';

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Extracts and concatenates plain text from an item's blocks for projection and hashing.
 */
export function projectItemText(blocks: readonly OcaBlock[], fallbackText?: string | null): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.text && b.text.trim().length > 0) {
      parts.push(b.text);
    } else if (b.tool_input && b.tool_input.trim().length > 0) {
      parts.push(b.tool_input);
    } else if (b.blob_sha256) {
      parts.push(`[blob:${b.blob_sha256}]`);
    }
  }
  if (parts.length > 0) {
    return parts.join('\n');
  }
  return fallbackText ?? '';
}

/**
 * Level-3 Item Semantic Hash:
 * SHA256(role | kind | primary_tool_name | normalized_text_and_blob_refs)
 */
export function computeItemSemanticHash(item: {
  role: OcaRole;
  kind: OcaItemKind;
  text?: string | null;
  blocks: readonly OcaBlock[];
}): string {
  const toolNames = item.blocks
    .map((b) => b.tool_name)
    .filter((n): n is string => Boolean(n))
    .join(',');
  const rawProjected = projectItemText(item.blocks, item.text);
  const normText = normalizeText(rawProjected);
  const canonical = `${item.role}\0${item.kind}\0${toolNames}\0${normText}`;
  return sha256Hex(canonical);
}

/**
 * Computes the head_hash of a conversation (the semantic hash of the first non-synthetic user/assistant item).
 */
export function computeConversationHeadHash(items: readonly OcaItemDraft[]): string | null {
  const sorted = [...items].sort((a, b) => a.ordinal - b.ordinal);
  const firstSubstantive =
    sorted.find((it) => !it.is_synthetic && !it.is_hidden && (it.role === 'user' || it.role === 'assistant')) ??
    sorted[0];
  if (!firstSubstantive) return null;
  return firstSubstantive.content_hash ?? computeItemSemanticHash(firstSubstantive);
}

/**
 * Level-4 Conversation Content Hash (Merkle Root over sorted unique item semantic hashes).
 */
export function computeConversationMerkleRoot(itemHashes: readonly string[]): string {
  if (itemHashes.length === 0) {
    return sha256Hex('oca:empty-conversation');
  }
  let layer = [...new Set(itemHashes)].sort();
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = layer[i + 1] ?? left;
      next.push(sha256Hex(`${left}:${right}`));
    }
    layer = next;
  }
  return layer[0]!;
}
