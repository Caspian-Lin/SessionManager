import crypto from 'node:crypto';
import { normalizeText } from './normalize.js';
import type { SessionRole, TurnKind, ViewBlock } from './types.js';

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Extracts and concatenates plain text from blocks for projection and hashing.
 */
export function projectBlocksText(blocks: readonly ViewBlock[], fallbackText?: string | null): string {
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

export const projectItemText = projectBlocksText;

/**
 * Turn/Item Semantic Hash:
 * SHA256(role | kind | primary_tool_name | normalized_text_and_blob_refs)
 */
export function computeTurnSemanticHash(item: {
  role: SessionRole;
  kind: TurnKind;
  text?: string | null;
  blocks: readonly ViewBlock[];
}): string {
  const toolNames = item.blocks
    .map((b) => b.tool_name)
    .filter((n): n is string => Boolean(n))
    .join(',');
  const rawProjected = projectBlocksText(item.blocks, item.text);
  const normText = normalizeText(rawProjected);
  const canonical = `${item.role}\0${item.kind}\0${toolNames}\0${normText}`;
  return sha256Hex(canonical);
}

export const computeItemSemanticHash = computeTurnSemanticHash;
export const computeSemanticItemHash = computeTurnSemanticHash;

/**
 * Computes the head_hash of a session (semantic hash of first non-synthetic user/assistant turn).
 */
export function computeSessionHeadHash(
  items: readonly {
    ordinal: number;
    role: SessionRole;
    kind: TurnKind;
    text?: string | null;
    blocks: readonly ViewBlock[];
    is_synthetic?: boolean;
    is_hidden?: boolean;
    content_hash?: string;
  }[]
): string | null {
  const sorted = [...items].sort((a, b) => a.ordinal - b.ordinal);
  const firstSubstantive =
    sorted.find((it) => !it.is_synthetic && !it.is_hidden && (it.role === 'user' || it.role === 'assistant')) ??
    sorted[0];
  if (!firstSubstantive) return null;
  return firstSubstantive.content_hash ?? computeTurnSemanticHash(firstSubstantive);
}

export const computeConversationHeadHash = computeSessionHeadHash;

/**
 * Session Content Hash (Merkle Root over sorted unique turn semantic hashes).
 */
export function computeSessionMerkleRoot(itemHashes: readonly string[]): string {
  if (itemHashes.length === 0) {
    return sha256Hex('sm:empty-session');
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

export const computeConversationMerkleRoot = computeSessionMerkleRoot;
export const computeConversationMerkleHash = computeSessionMerkleRoot;
