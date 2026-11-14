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

export interface AnthropicNativeMessage {
  uuid?: string;
  sender?: string;
  created_at?: string;
  updated_at?: string;
  text?: string;
  content?: Record<string, unknown>[];
  attachments?: Record<string, unknown>[];
  files?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface AnthropicNativeConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  account?: { uuid?: string; [key: string]: unknown };
  project?: { uuid?: string; [key: string]: unknown };
  chat_messages?: AnthropicNativeMessage[];
  [key: string]: unknown;
}

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

export class AnthropicSessionDocument extends BaseSessionDocument<AnthropicNativeConversation> {
  private mismatchIssues: IntegrityIssue[] = [];
  private attachmentIssues: IntegrityIssue[] = [];

  constructor(nativeData: AnthropicNativeConversation, parseIssues: IntegrityIssue[] = []) {
    const extId = typeof nativeData.uuid === 'string' ? nativeData.uuid : null;
    const title = typeof nativeData.name === 'string' ? nativeData.name.trim() : null;
    const createdAt = typeof nativeData.created_at === 'string' ? Date.parse(nativeData.created_at) : null;
    const updatedAt = typeof nativeData.updated_at === 'string' ? Date.parse(nativeData.updated_at) : null;

    super({
      provider: 'anthropic-web',
      rawFormat: 'anthropic-web/v1',
      nativeData,
      external_id: extId,
      title: title || null,
      title_source: title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      parseIssues,
    });
  }

  protected override validateProviderSpecific(): IntegrityIssue[] {
    return [...this.mismatchIssues, ...this.attachmentIssues];
  }

  protected projectTurns(): RawTurnProjection[] {
    this.mismatchIssues = [];
    this.attachmentIssues = [];

    const chatMessages = Array.isArray(this.nativeData.chat_messages) ? this.nativeData.chat_messages : [];
    const convId = this.init.external_id;
    const createdAt = this.init.created_at ?? null;

    const turns: RawTurnProjection[] = [];
    let prevItemId: string | null = null;

    for (let i = 0; i < chatMessages.length; i++) {
      const rawMsg = chatMessages[i];
      if (!rawMsg || typeof rawMsg !== 'object') continue;

      const msgUuid = typeof rawMsg.uuid === 'string' ? rawMsg.uuid : `msg-${i}`;
      const sender = typeof rawMsg.sender === 'string' ? rawMsg.sender.toLowerCase() : 'human';
      const role: SessionRole = sender === 'assistant' ? 'assistant' : 'user';
      const msgCreatedAt = typeof rawMsg.created_at === 'string' ? Date.parse(rawMsg.created_at) : createdAt;

      const fallbackText = typeof rawMsg.text === 'string' ? rawMsg.text : '';
      const contentList = Array.isArray(rawMsg.content) ? rawMsg.content : [];
      const attachmentsList = Array.isArray(rawMsg.attachments) ? rawMsg.attachments : [];

      const blocks: ViewBlock[] = [];
      let blockIdx = 0;

      for (const c of contentList) {
        if (!c || typeof c !== 'object') continue;
        const typeStr = typeof c['type'] === 'string' ? c['type'] : 'text';

        if (typeStr === 'thinking') {
          blocks.push({
            idx: blockIdx++,
            type: 'thinking',
            text: typeof c['thinking'] === 'string' ? c['thinking'] : '',
          });
        } else if (typeStr === 'tool_use') {
          const toolInput = c['input'] ? JSON.stringify(c['input']) : null;
          blocks.push({
            idx: blockIdx++,
            type: 'tool_use',
            tool_name: typeof c['name'] === 'string' ? c['name'] : null,
            tool_call_id: typeof c['id'] === 'string' ? c['id'] : null,
            tool_input: toolInput,
          });
        } else if (typeStr === 'tool_result') {
          const contentVal = c['content'];
          blocks.push({
            idx: blockIdx++,
            type: 'tool_result',
            tool_call_id: typeof c['tool_use_id'] === 'string' ? c['tool_use_id'] : null,
            text: typeof contentVal === 'string' ? contentVal : JSON.stringify(contentVal ?? ''),
          });
        } else {
          blocks.push({
            idx: blockIdx++,
            type: 'text',
            text: typeof c['text'] === 'string' ? c['text'] : '',
          });
        }
      }

      for (const att of attachmentsList) {
        if (!att || typeof att !== 'object') continue;
        if (typeof att['extracted_content'] === 'string') {
          blocks.push({
            idx: blockIdx++,
            type: 'file',
            text: att['extracted_content'],
            availability: 'extracted_only',
            meta: {
              file_name: att['file_name'] ?? null,
              file_type: att['file_type'] ?? null,
            },
          });
          this.attachmentIssues.push({
            code: 'attachment_extracted_only',
            severity: 'info',
            message: `Attachment "${String(att['file_name'] ?? 'unknown')}" has extracted_content only without binary original`,
            conversation_external_id: convId,
            item_external_id: msgUuid,
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
      if (fallbackText.length > 0 && contentList.length > 0 && fallbackText !== projectedText) {
        this.mismatchIssues.push({
          code: 'text_content_mismatch',
          severity: 'info',
          message: `Anthropic fallback text differs from content[] blocks (using content[])`,
          conversation_external_id: convId,
          item_external_id: msgUuid,
        });
      }

      turns.push({
        external_id: msgUuid,
        parent_external_id: prevItemId,
        ordinal: i,
        role,
        kind: 'message',
        created_at: msgCreatedAt,
        text: projectedText,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks,
      });

      prevItemId = msgUuid;
    }

    return turns;
  }
}

export class AnthropicWebAdapter implements Adapter<AnthropicNativeConversation> {
  readonly id: ProviderId = 'anthropic-web';

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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<AnthropicNativeConversation>[]> {
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

    const rawList: AnthropicNativeConversation[] = Array.isArray(parsed)
      ? (parsed as AnthropicNativeConversation[])
      : typeof parsed === 'object' && parsed !== null
        ? [parsed as AnthropicNativeConversation]
        : [];

    const docs: SessionDocument<AnthropicNativeConversation>[] = [];

    for (const rawConv of rawList) {
      partitionVendorFields(rawConv, KNOWN_CONV_KEYS, ctx);
      if (Array.isArray(rawConv.chat_messages)) {
        for (const msg of rawConv.chat_messages) {
          if (msg && typeof msg === 'object') {
            partitionVendorFields(msg, KNOWN_MSG_KEYS, ctx);
          }
        }
      }
      docs.push(new AnthropicSessionDocument(rawConv));
    }

    return docs;
  }
}

export const anthropicWebAdapter = new AnthropicWebAdapter();
