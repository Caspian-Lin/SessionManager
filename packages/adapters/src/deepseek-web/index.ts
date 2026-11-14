import fs from 'node:fs';
import path from 'node:path';
import {
  sha256Hex,
  type IntegrityIssue,
  type ProviderId,
  type SessionRole,
  type ViewBlock,
} from '@sm/shared';
import {
  BaseSessionDocument,
  partitionVendorFields,
  type Adapter,
  type ImportTask,
  type ParseCtx,
  type ProbeResult,
  type RawTurnProjection,
  type SessionDocument,
  type SourceRef,
} from '../contract.js';
import { learnJsonSchemaSummary, type SchemaSummary } from '../schema-learner.js';

export interface DeepSeekNativeConversation {
  id?: string;
  conversation_id?: string;
  chat_id?: string;
  title?: string;
  created_at?: number | string;
  create_time?: number | string;
  updated_at?: number | string;
  update_time?: number | string;
  model?: string;
  messages?: Record<string, unknown>[];
  chat_messages?: Record<string, unknown>[];
  [key: string]: unknown;
}

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
  'chat_messages',
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

function parseFlexTimestamp(val: unknown): number | null {
  if (typeof val === 'number') {
    return val < 10000000000 ? Math.round(val * 1000) : val;
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export class DeepSeekSessionDocument extends BaseSessionDocument<DeepSeekNativeConversation> {
  private readonly schema: SchemaSummary;

  constructor(
    nativeData: DeepSeekNativeConversation,
    schema: SchemaSummary,
    parseIssues: IntegrityIssue[] = []
  ) {
    const extId =
      typeof nativeData.conversation_id === 'string'
        ? nativeData.conversation_id
        : typeof nativeData.chat_id === 'string'
          ? nativeData.chat_id
          : typeof nativeData.id === 'string'
            ? nativeData.id
            : null;

    const title = typeof nativeData.title === 'string' ? nativeData.title.trim() : null;
    const createdAt = parseFlexTimestamp(nativeData.create_time ?? nativeData.created_at);
    const updatedAt = parseFlexTimestamp(nativeData.update_time ?? nativeData.updated_at);
    const defaultModel = typeof nativeData.model === 'string' ? nativeData.model : null;

    super({
      provider: 'deepseek-web',
      rawFormat: 'deepseek-web/inferred_v1',
      nativeData,
      external_id: extId,
      title: title || null,
      title_source: title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      default_model: defaultModel,
      parseIssues,
    });
    this.schema = schema;
  }

  protected projectTurns(): RawTurnProjection[] {
    const messages = Array.isArray(this.nativeData.messages)
      ? this.nativeData.messages
      : Array.isArray(this.nativeData.chat_messages)
        ? this.nativeData.chat_messages
        : [];

    const roleKey = this.schema.candidateRoleKeys[0] ?? 'role';
    const contentKey = this.schema.candidateContentKeys[0] ?? 'content';
    const createdAt = this.init.created_at ?? null;

    const turns: RawTurnProjection[] = [];
    let prevId: string | null = null;

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
      const role: SessionRole =
        rawRole === 'assistant' || rawRole === 'bot' || rawRole === 'model'
          ? 'assistant'
          : rawRole === 'system'
            ? 'system'
            : 'user';

      const blocks: ViewBlock[] = [];
      let blockIdx = 0;

      const reasoningVal = msg['reasoning_content'] ?? msg['thought'];
      if (typeof reasoningVal === 'string' && reasoningVal.trim().length > 0) {
        blocks.push({
          idx: blockIdx++,
          type: 'thinking',
          text: reasoningVal,
        });
      }

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

      turns.push({
        external_id: msgId,
        parent_external_id: prevId,
        ordinal: i,
        role,
        kind: 'message',
        created_at: parseFlexTimestamp(msg['create_time'] ?? msg['created_at']) ?? createdAt,
        text: projectedText,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks,
      });

      prevId = msgId;
    }

    return turns;
  }
}

export class DeepSeekWebAdapter implements Adapter<DeepSeekNativeConversation> {
  readonly id: ProviderId = 'deepseek-web';

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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<DeepSeekNativeConversation>[]> {
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

    const rawList: DeepSeekNativeConversation[] = Array.isArray(parsed)
      ? (parsed as DeepSeekNativeConversation[])
      : typeof parsed === 'object' && parsed !== null
        ? [parsed as DeepSeekNativeConversation]
        : [];

    const schemaSummary = learnJsonSchemaSummary(rawList.slice(0, 50));
    ctx.log(
      'info',
      `Learned schema summary: role keys = ${schemaSummary.candidateRoleKeys.join(',')}, content keys = ${schemaSummary.candidateContentKeys.join(',')}`
    );

    const docs: SessionDocument<DeepSeekNativeConversation>[] = [];
    for (const rawConv of rawList) {
      partitionVendorFields(rawConv, KNOWN_CONV_KEYS, ctx);
      const msgs = rawConv.messages ?? rawConv.chat_messages ?? [];
      for (const m of msgs) {
        if (m && typeof m === 'object') {
          partitionVendorFields(m, KNOWN_MSG_KEYS, ctx);
        }
      }
      docs.push(new DeepSeekSessionDocument(rawConv, schemaSummary));
    }

    return docs;
  }
}

export const deepseekWebAdapter = new DeepSeekWebAdapter();
