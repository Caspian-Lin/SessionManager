import type { OcaArchiveManifest, OcaBlob, OcaConversation } from '@sm/oca';

export interface ExportManifestOptions {
  generator?: string;
  exportedAt?: number;
  conversationsFile?: string;
  blobsDir?: string;
}

/**
 * Builds an OCA v1 archive manifest adhering to the Open Conversation Archive specification.
 */
export function exportToOcaManifest(
  convs: readonly OcaConversation[],
  blobs?: readonly OcaBlob[],
  options?: ExportManifestOptions
): OcaArchiveManifest {
  const convCount = convs.length;
  let itemCount = 0;
  let embeddedBlobCount = 0;

  for (const c of convs) {
    itemCount += c.items.length;
    if (c.blobs) {
      embeddedBlobCount += c.blobs.length;
    }
  }

  const blobCount = blobs !== undefined ? blobs.length : embeddedBlobCount;

  return {
    oca_version: '1.0.0',
    exported_at: options?.exportedAt ?? Date.now(),
    generator: options?.generator ?? 'sm-core/0.1.0',
    conversation_count: convCount,
    item_count: itemCount,
    blob_count: blobCount,
    conversations_file: options?.conversationsFile ?? 'conversations.jsonl',
    blobs_dir: options?.blobsDir ?? 'blobs',
  };
}

/**
 * Formats an OcaConversation into a human-readable Markdown vault document
 * with complete YAML frontmatter and structured blocks (thinking, code, tool calls).
 */
export function formatConversationMarkdown(conv: OcaConversation): string {
  const frontmatterLines = [
    '---',
    `title: ${JSON.stringify(conv.title ?? 'Untitled Conversation')}`,
    `provider: ${conv.provider}`,
    `external_id: ${JSON.stringify(conv.external_id ?? '')}`,
    `created_at: ${conv.created_at ? new Date(conv.created_at).toISOString() : ''}`,
    `updated_at: ${conv.updated_at ? new Date(conv.updated_at).toISOString() : ''}`,
    `default_model: ${JSON.stringify(conv.default_model ?? '')}`,
    `cwd: ${JSON.stringify(conv.cwd ?? '')}`,
    `content_hash: ${conv.content_hash}`,
    `item_count: ${conv.items.length}`,
    '---',
    '',
  ];

  const contentLines: string[] = [];
  contentLines.push(`# ${conv.title ?? 'Untitled Conversation'}`);
  contentLines.push('');

  const sortedItems = [...conv.items].sort((a, b) => a.ordinal - b.ordinal);

  for (const item of sortedItems) {
    const roleCapitalized = item.role.charAt(0).toUpperCase() + item.role.slice(1);
    const modelBadge = item.model ? ` (${item.model})` : '';
    const kindBadge = item.kind !== 'message' ? ` [${item.kind}]` : '';

    contentLines.push(`### ${roleCapitalized}${modelBadge}${kindBadge}`);
    contentLines.push('');

    for (const block of item.blocks) {
      if (block.type === 'thinking') {
        contentLines.push('> [!NOTE] Thinking');
        const lines = (block.text ?? '').split('\n');
        for (const line of lines) {
          contentLines.push(`> ${line}`);
        }
        contentLines.push('');
      } else if (block.type === 'code') {
        const lang = block.lang ?? '';
        contentLines.push(`\`\`\`${lang}`);
        contentLines.push(block.text ?? '');
        contentLines.push('```');
        contentLines.push('');
      } else if (block.type === 'tool_use') {
        contentLines.push(`> [!TIP] Tool Call: \`${block.tool_name ?? 'tool'}\``);
        if (block.tool_input) {
          contentLines.push('> ```json');
          for (const l of block.tool_input.split('\n')) {
            contentLines.push(`> ${l}`);
          }
          contentLines.push('> ```');
        }
        contentLines.push('');
      } else if (block.type === 'tool_result') {
        contentLines.push('> [!NOTE] Tool Result');
        if (block.text) {
          contentLines.push('> ```');
          for (const l of block.text.split('\n')) {
            contentLines.push(`> ${l}`);
          }
          contentLines.push('> ```');
        }
        contentLines.push('');
      } else if (block.type === 'image') {
        const ref = block.blob_sha256 ? `blob:${block.blob_sha256}` : (block.meta?.['asset_pointer'] as string) ?? '';
        contentLines.push(`![Image](${ref})`);
        contentLines.push('');
      } else {
        // Text or file
        if (block.text) {
          contentLines.push(block.text);
          contentLines.push('');
        }
      }
    }

    contentLines.push('---');
    contentLines.push('');
  }

  return frontmatterLines.join('\n') + contentLines.join('\n');
}
