import type { SessionDocument } from '@sm/adapters';
import type { BlobAsset, ConversationViewModel, NativeArchiveManifest } from '@sm/shared';

export interface ExportManifestOptions {
  generator?: string;
  exportedAt?: number;
  conversationsFile?: string;
  blobsDir?: string;
}

export type ExportableSession = SessionDocument | ConversationViewModel;

function asView(input: ExportableSession): ConversationViewModel {
  return 'toViewModel' in input ? input.toViewModel() : input;
}

/**
 * Builds a native-slice archive manifest describing exported per-session slices and blobs.
 */
export function exportNativeManifest(
  sessions: readonly ExportableSession[],
  blobs?: readonly BlobAsset[],
  options?: ExportManifestOptions
): NativeArchiveManifest {
  const convCount = sessions.length;
  let itemCount = 0;
  let embeddedBlobCount = 0;

  for (const s of sessions) {
    const view = asView(s);
    itemCount += view.nodes.length;
    embeddedBlobCount += view.blobs.length;
  }

  const blobCount = blobs !== undefined ? blobs.length : embeddedBlobCount;

  return {
    archive_version: '1.0.0',
    format: 'native-slice',
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
 * Formats a SessionDocument or ConversationViewModel into a human-readable Markdown document.
 */
export function formatConversationMarkdown(input: ExportableSession): string {
  const view = asView(input);
  const { meta, nodes } = view;

  const frontmatterLines = [
    '---',
    `title: ${JSON.stringify(meta.title ?? 'Untitled Conversation')}`,
    `provider: ${meta.provider}`,
    `raw_format: ${meta.raw_format}`,
    `external_id: ${JSON.stringify(meta.external_id ?? '')}`,
    `created_at: ${meta.created_at ? new Date(meta.created_at).toISOString() : ''}`,
    `updated_at: ${meta.updated_at ? new Date(meta.updated_at).toISOString() : ''}`,
    `default_model: ${JSON.stringify(meta.default_model ?? '')}`,
    `cwd: ${JSON.stringify(meta.cwd ?? '')}`,
    `content_hash: ${meta.content_hash}`,
    `item_count: ${nodes.length}`,
    '---',
    '',
  ];

  const contentLines: string[] = [];
  contentLines.push(`# ${meta.title ?? 'Untitled Conversation'}`);
  contentLines.push('');

  const sortedNodes = [...nodes].sort((a, b) => a.ordinal - b.ordinal);

  for (const node of sortedNodes) {
    const roleCapitalized = node.role.charAt(0).toUpperCase() + node.role.slice(1);
    const modelBadge = node.model ? ` (${node.model})` : '';
    const kindBadge = node.kind !== 'message' ? ` [${node.kind}]` : '';

    contentLines.push(`### ${roleCapitalized}${modelBadge}${kindBadge}`);
    contentLines.push('');

    for (const block of node.blocks) {
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
