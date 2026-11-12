import fs from 'node:fs';
import path from 'node:path';
import {
  sha256Hex,
  type OcaBlock,
  type OcaConversationDraft,
  type OcaItemDraft,
  type OcaProviderId,
  type OcaRole,
} from '@sm/oca';
import {
  partitionVendorFields,
  type Adapter,
  type ImportTask,
  type ParseCtx,
  type ProbeResult,
  type SourceRef,
} from '../contract.js';

const KNOWN_CONV_KEYS = ['uuid', 'name', 'created_at', 'updated_at', 'account', 'project', 'chat_messages'] as const;
const KNOWN_MSG_KEYS = [
  'uuid',
  'sender',
  'created_at',
  'updated_at',
  'text',
  'content',
  'attachments',
  'files',
] as const;

export class AnthropicWebAdapter implements Adapter {
  readonly id: OcaProviderId = 'anthropic-web';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const evidence: string[] = [];
    const entries: string[] = [];
    const warnings: string[] = [];
    let confidence = 0;

    if (src.kind === 'file') {
      const base = path.basename(src.path).toLowerCase();
      if (base.endsWith('.zip')) {
        entries.push(src.path);
        evidence.push(`ZIP archive: ${base}`);
        if (base.includes('claude') || base.includes('anthropic')) {
          confidence = Math.max(confidence, 0.7);
        }
      } else if (base.endsWith('.json')) {
        entries.push(src.path);
        try {
          const sample = fs.readFileSync(src.path, { encoding: 'utf8', flag: 'r' }).slice(0, 16384);
          if (sample.includes('"chat_messages"')) {
            confidence = 0.95;
            evidence.push('Discovered chat_messages key');
          }
          if (sample.includes('"sender"') && (sample.includes('"human"') || sample.includes('"assistant"'))) {
            confidence = 0.98;
            evidence.push('Discovered sender: human/assistant signature');
          }
        } catch (err) {
          warnings.push(`File read error: ${(err as Error).message}`);
        }
      }
    } else if (src.kind === 'dir') {
      try {
        const files = fs.readdirSync(src.path);
        const hasConv = files.includes('conversations.json');
        const hasMem = files.includes('memories.json');
        const hasProj = files.includes('projects.json');
        if (hasConv || (hasMem && hasProj)) {
          confidence = 0.98;
          evidence.push(`Anthropic directory markers: ${files.join(', ')}`);
          if (hasConv) entries.push(path.join(src.path, 'conversations.json'));
        }
      } catch (err) {
        warnings.push(`Directory read error: ${(err as Error).message}`);
      }
    }

    if (confidence <= 0) return null;

    return {
      adapterId: this.id,
      version: 'v1',
      confidence,
      evidence,
      entries,
      warnings,
    };
  }

  async *plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask> {
    for (const entry of probe.entries) {
      let size = 0;
      try {
        size = fs.statSync(entry).size;
      } catch {
        // ignore
      }
      yield {
        id: sha256Hex(`${src.path}#${entry}#0`),
        src,
        entry,
        estimatedBytes: size,
      };
    }
  }

  async parse(task: ImportTask, ctx: ParseCtx): Promise<OcaConversationDraft[]> {
    const filePath = task.entry ?? task.src.path;
    ctx.log('info', `AnthropicWebAdapter parsing file: ${filePath}`);

    let rawContent: string;
    try {
      rawContent = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      ctx.log('error', `Failed to read file ${filePath}: ${(err as Error).message}`);
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      ctx.log('error', `JSON parse error in ${filePath}: ${(err as Error).message}`);
      return [];
    }

    const rawList: Record<string, unknown>[] = Array.isArray(parsed)
      ? (parsed as Record<string, unknown>[])
      : typeof parsed === 'object' && parsed !== null
        ? [parsed as Record<string, unknown>]
        : [];

    const drafts: OcaConversationDraft[] = [];

    for (const rawConv of rawList) {
      const draft = this.mapSingleConversation(rawConv, ctx);
      if (draft) {
        drafts.push(draft);
      }
    }

    return drafts;
  }

  private mapSingleConversation(
    rawConv: Record<string, unknown>,
    ctx: ParseCtx
  ): OcaConversationDraft | null {
    const extId = typeof rawConv['uuid'] === 'string' ? rawConv['uuid'] : null;
    const title = typeof rawConv['name'] === 'string' ? rawConv['name'].trim() : null;

    const createdAtStr = typeof rawConv['created_at'] === 'string' ? rawConv['created_at'] : null;
    const updatedAtStr = typeof rawConv['updated_at'] === 'string' ? rawConv['updated_at'] : null;
    const createdAt = createdAtStr ? Date.parse(createdAtStr) : null;
    const updatedAt = updatedAtStr ? Date.parse(updatedAtStr) : null;

    const accountObj = (rawConv['account'] ?? {}) as Record<string, unknown>;
    const accountUuid = typeof accountObj['uuid'] === 'string' ? accountObj['uuid'] : null;
    const projectObj = (rawConv['project'] ?? {}) as Record<string, unknown>;
    const projectUuid = typeof projectObj['uuid'] === 'string' ? projectObj['uuid'] : null;

    const unmappedConv = partitionVendorFields(rawConv, KNOWN_CONV_KEYS, ctx);

    const chatMessages = Array.isArray(rawConv['chat_messages'])
      ? (rawConv['chat_messages'] as Record<string, unknown>[])
      : [];

    const items: OcaItemDraft[] = [];
    let prevItemId: string | null = null;
    let anyContentMismatch = false;

    for (let i = 0; i < chatMessages.length; i++) {
      const rawMsg = chatMessages[i];
      if (!rawMsg || typeof rawMsg !== 'object') continue;

      const msgUuid = typeof rawMsg['uuid'] === 'string' ? rawMsg['uuid'] : `msg-${i}`;
      const sender = typeof rawMsg['sender'] === 'string' ? rawMsg['sender'].toLowerCase() : 'human';
      const role: OcaRole = sender === 'assistant' ? 'assistant' : 'user';

      const msgCreatedAtStr = typeof rawMsg['created_at'] === 'string' ? rawMsg['created_at'] : null;
      const msgCreatedAt = msgCreatedAtStr ? Date.parse(msgCreatedAtStr) : createdAt;

      const fallbackText = typeof rawMsg['text'] === 'string' ? rawMsg['text'] : '';
      const contentList = Array.isArray(rawMsg['content']) ? rawMsg['content'] : [];
      const attachmentsList = Array.isArray(rawMsg['attachments']) ? rawMsg['attachments'] : [];

      const blocks: OcaBlock[] = [];
      let blockIdx = 0;

      for (const c of contentList) {
        if (!c || typeof c !== 'object') continue;
        const cObj = c as Record<string, unknown>;
        const typeStr = typeof cObj['type'] === 'string' ? cObj['type'] : 'text';

        if (typeStr === 'thinking') {
          blocks.push({
            idx: blockIdx++,
            type: 'thinking',
            text: typeof cObj['thinking'] === 'string' ? cObj['thinking'] : '',
          });
        } else if (typeStr === 'tool_use') {
          const toolInput = cObj['input'] ? JSON.stringify(cObj['input']) : null;
          blocks.push({
            idx: blockIdx++,
            type: 'tool_use',
            tool_name: typeof cObj['name'] === 'string' ? cObj['name'] : null,
            tool_call_id: typeof cObj['id'] === 'string' ? cObj['id'] : null,
            tool_input: toolInput,
          });
        } else if (typeStr === 'tool_result') {
          const contentVal = cObj['content'];
          blocks.push({
            idx: blockIdx++,
            type: 'tool_result',
            tool_call_id: typeof cObj['tool_use_id'] === 'string' ? cObj['tool_use_id'] : null,
            text: typeof contentVal === 'string' ? contentVal : JSON.stringify(contentVal ?? ''),
          });
        } else {
          // text or generic
          blocks.push({
            idx: blockIdx++,
            type: 'text',
            text: typeof cObj['text'] === 'string' ? cObj['text'] : '',
          });
        }
      }

      // Attachments with extracted_content
      for (const att of attachmentsList) {
        if (!att || typeof att !== 'object') continue;
        const attObj = att as Record<string, unknown>;
        if (typeof attObj['extracted_content'] === 'string') {
          blocks.push({
            idx: blockIdx++,
            type: 'file',
            text: attObj['extracted_content'],
            availability: 'extracted_only',
            meta: {
              file_name: attObj['file_name'] ?? null,
              file_type: attObj['file_type'] ?? null,
            },
          });
        }
      }

      if (blocks.length === 0 && fallbackText.length > 0) {
        blocks.push({
          idx: blockIdx++,
          type: 'text',
          text: fallbackText,
        });
      }

      const projectedText = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');
      const hasMismatch = fallbackText.length > 0 && fallbackText !== projectedText;
      if (hasMismatch) {
        anyContentMismatch = true;
      }

      const unmappedMsg = partitionVendorFields(rawMsg, KNOWN_MSG_KEYS, ctx);

      items.push({
        external_id: msgUuid,
        parent_external_id: prevItemId,
        ordinal: i,
        role,
        kind: 'message',
        created_at: msgCreatedAt,
        text: projectedText,
        text_len: projectedText.length,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks,
        ext: {
          anthropic: {
            text_content_mismatch: hasMismatch,
          },
          ...(unmappedMsg ? { _unmapped: unmappedMsg } : {}),
        },
      });

      prevItemId = msgUuid;
    }

    return {
      provider: this.id,
      external_id: extId,
      title,
      title_source: title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      items,
      ext: {
        anthropic: {
          account_uuid: accountUuid,
          project_uuid: projectUuid,
          text_content_mismatch: anyContentMismatch,
        },
        ...(unmappedConv ? { _unmapped: unmappedConv } : {}),
      },
    };
  }
}

export const anthropicWebAdapter = new AnthropicWebAdapter();
