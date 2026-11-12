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
import { learnJsonSchemaSummary } from '../schema-learner.js';

const KNOWN_CONV_KEYS = [
  'id',
  'conversation_id',
  'chat_id',
  'title',
  'created_at',
  'create_time',
  'updated_at',
  'update_time',
  'messages',
  'model',
] as const;

const KNOWN_MSG_KEYS = [
  'id',
  'message_id',
  'role',
  'sender',
  'content',
  'text',
  'reasoning_content',
  'thought',
  'created_at',
  'create_time',
  'model',
] as const;

export class DeepSeekWebAdapter implements Adapter {
  readonly id: OcaProviderId = 'deepseek-web';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const evidence: string[] = [];
    const entries: string[] = [];
    const warnings: string[] = [];
    let confidence = 0;

    if (src.kind === 'file') {
      const base = path.basename(src.path).toLowerCase();
      if (base.includes('deepseek')) {
        confidence = Math.max(confidence, 0.6);
        evidence.push(`File name hints DeepSeek origin: ${base}`);
      }

      if (base.endsWith('.json')) {
        entries.push(src.path);
        try {
          const raw = fs.readFileSync(src.path, { encoding: 'utf8', flag: 'r' }).slice(0, 16384);
          if (raw.toLowerCase().includes('deepseek')) {
            confidence = Math.max(confidence, 0.85);
            evidence.push('Discovered deepseek token in JSON sample');
          }
          if (raw.includes('"reasoning_content"')) {
            confidence = 0.95;
            evidence.push('Discovered DeepSeek signature field: reasoning_content');
          }
        } catch (err) {
          warnings.push(`File read error: ${(err as Error).message}`);
        }
      }
    } else if (src.kind === 'dir') {
      try {
        const files = fs.readdirSync(src.path);
        for (const file of files) {
          if (file.toLowerCase().includes('deepseek') && file.endsWith('.json')) {
            confidence = Math.max(confidence, 0.8);
            evidence.push(`Found DeepSeek named file: ${file}`);
            entries.push(path.join(src.path, file));
          }
        }
      } catch (err) {
        warnings.push(`Dir read error: ${(err as Error).message}`);
      }
    }

    if (confidence <= 0) return null;

    return {
      adapterId: this.id,
      version: 'inferred_v1',
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
    ctx.log('info', `DeepSeekWebAdapter parsing file: ${filePath}`);

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

    // Run schema learning over the sample items to infer field shapes
    const schemaSummary = learnJsonSchemaSummary(rawList.slice(0, 50));
    ctx.log('info', `Learned schema summary: role keys = ${schemaSummary.candidateRoleKeys.join(',')}, content keys = ${schemaSummary.candidateContentKeys.join(',')}`);

    const drafts: OcaConversationDraft[] = [];

    for (const rawConv of rawList) {
      const draft = this.mapSingleConversation(rawConv, schemaSummary, ctx);
      if (draft) {
        drafts.push(draft);
      }
    }

    return drafts;
  }

  private mapSingleConversation(
    rawConv: Record<string, unknown>,
    schema: ReturnType<typeof learnJsonSchemaSummary>,
    ctx: ParseCtx
  ): OcaConversationDraft | null {
    const extId =
      typeof rawConv['conversation_id'] === 'string'
        ? rawConv['conversation_id']
        : typeof rawConv['chat_id'] === 'string'
          ? rawConv['chat_id']
          : typeof rawConv['id'] === 'string'
            ? rawConv['id']
            : null;

    const title = typeof rawConv['title'] === 'string' ? rawConv['title'].trim() : null;

    const createTimeVal = rawConv['create_time'] ?? rawConv['created_at'];
    let createdAt: number | null = null;
    if (typeof createTimeVal === 'number') {
      createdAt = createTimeVal < 10000000000 ? Math.round(createTimeVal * 1000) : createTimeVal;
    } else if (typeof createTimeVal === 'string') {
      createdAt = Date.parse(createTimeVal) || null;
    }

    const updateTimeVal = rawConv['update_time'] ?? rawConv['updated_at'];
    let updatedAt: number | null = null;
    if (typeof updateTimeVal === 'number') {
      updatedAt = updateTimeVal < 10000000000 ? Math.round(updateTimeVal * 1000) : updateTimeVal;
    } else if (typeof updateTimeVal === 'string') {
      updatedAt = Date.parse(updateTimeVal) || null;
    }

    const defaultModel = typeof rawConv['model'] === 'string' ? rawConv['model'] : null;

    const unmappedConv = partitionVendorFields(rawConv, KNOWN_CONV_KEYS, ctx);

    const messages = Array.isArray(rawConv['messages'])
      ? (rawConv['messages'] as Record<string, unknown>[])
      : Array.isArray(rawConv['chat_messages'])
        ? (rawConv['chat_messages'] as Record<string, unknown>[])
        : [];

    const items: OcaItemDraft[] = [];
    let prevId: string | null = null;
    let reasoningPresent = false;

    // Pick most likely role key and content key
    const roleKey = schema.candidateRoleKeys[0] ?? 'role';
    const contentKey = schema.candidateContentKeys[0] ?? 'content';

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;

      const msgId =
        typeof msg['id'] === 'string'
          ? msg['id']
          : typeof msg['message_id'] === 'string'
            ? msg['message_id']
            : `dsk-msg-${i}`;

      const rawRole = typeof msg[roleKey] === 'string' ? (msg[roleKey] as string).toLowerCase() : 'user';
      const role: OcaRole =
        rawRole === 'assistant' || rawRole === 'bot' || rawRole === 'model'
          ? 'assistant'
          : rawRole === 'system'
            ? 'system'
            : 'user';

      const blocks: OcaBlock[] = [];
      let blockIdx = 0;

      // Check reasoning content
      const reasoningVal = msg['reasoning_content'] ?? msg['thought'];
      if (typeof reasoningVal === 'string' && reasoningVal.trim().length > 0) {
        reasoningPresent = true;
        blocks.push({
          idx: blockIdx++,
          type: 'thinking',
          text: reasoningVal,
        });
      }

      // Check main content
      const contentVal = msg[contentKey] ?? msg['text'];
      if (typeof contentVal === 'string') {
        blocks.push({
          idx: blockIdx++,
          type: 'text',
          text: contentVal,
        });
      } else if (Array.isArray(contentVal)) {
        for (const part of contentVal) {
          if (typeof part === 'string') {
            blocks.push({ idx: blockIdx++, type: 'text', text: part });
          } else if (part && typeof part === 'object') {
            const pObj = part as Record<string, unknown>;
            blocks.push({
              idx: blockIdx++,
              type: pObj['type'] === 'thinking' ? 'thinking' : 'text',
              text: typeof pObj['text'] === 'string' ? pObj['text'] : JSON.stringify(part),
            });
          }
        }
      }

      const projectedText = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');
      const unmappedMsg = partitionVendorFields(msg, KNOWN_MSG_KEYS, ctx);

      items.push({
        external_id: msgId,
        parent_external_id: prevId,
        ordinal: i,
        role,
        kind: 'message',
        created_at: createdAt,
        text: projectedText,
        text_len: projectedText.length,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks,
        ext: {
          deepseek: {
            reasoning_content_present: typeof reasoningVal === 'string' && reasoningVal.length > 0,
          },
          ...(unmappedMsg ? { _unmapped: unmappedMsg } : {}),
        },
      });

      prevId = msgId;
    }

    return {
      provider: this.id,
      external_id: extId,
      title,
      title_source: title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      default_model: defaultModel,
      items,
      ext: {
        deepseek: {
          inferred_schema_version: 'v1',
          reasoning_content_present: reasoningPresent,
        },
        ...(unmappedConv ? { _unmapped: unmappedConv } : {}),
      },
    };
  }
}

export const deepseekWebAdapter = new DeepSeekWebAdapter();
