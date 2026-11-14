import fs from 'node:fs';
import path from 'node:path';
import {
  sha256Hex,
  type IntegrityIssue,
  type ProviderId,
  type SessionRole,
  type ViewBlock,
  type ViewBlockType,
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

export interface OpenAiNativeMessage {
  id?: string;
  author?: { role?: string };
  create_time?: number | null;
  update_time?: number | null;
  content?: {
    content_type?: string;
    parts?: unknown[];
    text?: string;
  };
  status?: string;
  end_turn?: boolean;
  weight?: number;
  metadata?: Record<string, unknown>;
  recipient?: string;
  [key: string]: unknown;
}

export interface OpenAiNativeMappingNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: OpenAiNativeMessage | null;
}

export interface OpenAiNativeConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  current_node?: string;
  default_model_slug?: string;
  gizmo_id?: string;
  is_archived?: boolean;
  is_starred?: boolean;
  is_shared?: boolean;
  mapping?: Record<string, OpenAiNativeMappingNode>;
  [key: string]: unknown;
}

const KNOWN_CONV_KEYS = [
  'id',
  'conversation_id',
  'title',
  'create_time',
  'update_time',
  'mapping',
  'current_node',
  'default_model_slug',
  'gizmo_id',
  'is_archived',
  'is_starred',
  'is_shared',
] as const;

const KNOWN_MSG_KEYS = [
  'id',
  'author',
  'create_time',
  'update_time',
  'content',
  'status',
  'end_turn',
  'weight',
  'metadata',
  'recipient',
] as const;

export class OpenAiSessionDocument extends BaseSessionDocument<OpenAiNativeConversation> {
  constructor(nativeData: OpenAiNativeConversation, parseIssues: IntegrityIssue[] = []) {
    const extId =
      typeof nativeData.conversation_id === 'string'
        ? nativeData.conversation_id
        : typeof nativeData.id === 'string'
          ? nativeData.id
          : null;

    const createdAt = typeof nativeData.create_time === 'number' ? Math.round(nativeData.create_time * 1000) : null;
    const updatedAt = typeof nativeData.update_time === 'number' ? Math.round(nativeData.update_time * 1000) : null;
    const title = typeof nativeData.title === 'string' ? nativeData.title.trim() : null;
    const defaultModel = typeof nativeData.default_model_slug === 'string' ? nativeData.default_model_slug : null;

    super({
      provider: 'openai-web',
      rawFormat: 'openai-web/v2',
      nativeData,
      external_id: extId,
      title: title || null,
      title_source: title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      default_model: defaultModel,
      parseIssues,
    });
  }

  protected override validateProviderSpecific(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    const mapping = this.nativeData.mapping ?? {};
    const currentNode = this.nativeData.current_node;
    const convId = this.init.external_id;

    if (currentNode && !mapping[currentNode]) {
      issues.push({
        code: 'orphan_node',
        severity: 'warn',
        message: `OpenAI current_node "${currentNode}" is missing from mapping graph`,
        conversation_external_id: convId,
        item_external_id: currentNode,
      });
    }
    return issues;
  }

  protected projectTurns(): RawTurnProjection[] {
    const mapping = this.nativeData.mapping ?? {};
    const currentNode = typeof this.nativeData.current_node === 'string' ? this.nativeData.current_node : null;
    const defaultModel = this.init.default_model ?? null;
    const createdAt = this.init.created_at ?? null;

    // Trace active branch from current_node up to root
    const activeBranchNodeIds = new Set<string>();
    const visited = new Set<string>();
    let tracer: string | null = currentNode;
    while (tracer && mapping[tracer] && !visited.has(tracer)) {
      visited.add(tracer);
      activeBranchNodeIds.add(tracer);
      const parent = mapping[tracer]?.parent;
      tracer = typeof parent === 'string' ? parent : null;
    }

    const turns: RawTurnProjection[] = [];
    let ordinal = 0;

    for (const [nodeId, nodeObj] of Object.entries(mapping)) {
      if (!nodeObj || typeof nodeObj !== 'object') continue;
      const msgObj = nodeObj.message;
      if (!msgObj || typeof msgObj !== 'object') {
        continue;
      }

      const parentId = typeof nodeObj.parent === 'string' ? nodeObj.parent : null;
      const rawRole = typeof msgObj.author?.role === 'string' ? msgObj.author.role.toLowerCase() : 'user';

      let role: SessionRole = 'user';
      if (rawRole === 'assistant') role = 'assistant';
      else if (rawRole === 'system') role = 'system';
      else if (rawRole === 'tool') role = 'tool';
      else if (rawRole === 'developer') role = 'developer';
      else if (rawRole === 'critic') role = 'assistant';

      const metadata = (msgObj.metadata ?? {}) as Record<string, unknown>;
      const isHidden = Boolean(metadata['is_visually_hidden_from_conversation']);
      const isSynthetic = Boolean(metadata['is_user_system_message']);
      const model = typeof metadata['model_slug'] === 'string' ? metadata['model_slug'] : defaultModel;
      const msgCreateTime = typeof msgObj.create_time === 'number' ? Math.round(msgObj.create_time * 1000) : createdAt;

      const contentObj = msgObj.content ?? {};
      const contentType = typeof contentObj.content_type === 'string' ? contentObj.content_type : 'text';
      const parts = Array.isArray(contentObj.parts) ? contentObj.parts : [];

      const blocks: ViewBlock[] = [];
      let blockIdx = 0;

      for (const part of parts) {
        if (typeof part === 'string') {
          let blockType: ViewBlockType = 'text';
          if (contentType === 'thoughts' || contentType === 'reasoning_recap') {
            blockType = 'thinking';
          } else if (contentType === 'code') {
            blockType = 'code';
          } else if (contentType === 'execution_output') {
            blockType = 'tool_result';
          } else if (contentType === 'tether_browsing_display' || contentType === 'tether_quote') {
            blockType = 'citation';
          }

          blocks.push({
            idx: blockIdx++,
            type: blockType,
            text: part,
          });
        } else if (part && typeof part === 'object') {
          const partObj = part as Record<string, unknown>;
          if (partObj['content_type'] === 'image_asset_pointer') {
            blocks.push({
              idx: blockIdx++,
              type: 'image',
              text: null,
              meta: { asset_pointer: partObj['asset_pointer'] },
            });
          } else if (typeof partObj['text'] === 'string') {
            blocks.push({
              idx: blockIdx++,
              type: 'text',
              text: partObj['text'],
            });
          }
        }
      }

      if (blocks.length === 0 && typeof contentObj.text === 'string') {
        blocks.push({
          idx: blockIdx++,
          type: 'text',
          text: contentObj.text,
        });
      }

      const isActive = activeBranchNodeIds.size > 0 ? activeBranchNodeIds.has(nodeId) : true;
      const textProjection = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');

      turns.push({
        external_id: nodeId,
        parent_external_id: parentId,
        ordinal: ordinal++,
        role,
        kind: contentType === 'execution_output' ? 'tool_result' : 'message',
        created_at: msgCreateTime,
        model,
        text: textProjection,
        is_active_branch: isActive,
        is_hidden: isHidden,
        is_synthetic: isSynthetic,
        blocks,
      });
    }

    return turns;
  }
}

export class OpenAiWebAdapter implements Adapter<OpenAiNativeConversation> {
  readonly id: ProviderId = 'openai-web';

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
        if (base.includes('chatgpt') || base.includes('openai')) {
          confidence = Math.max(confidence, 0.7);
        }
      } else if (base.endsWith('.json')) {
        entries.push(src.path);
        if (/^conversations(-\d+)?\.json$/.test(base)) {
          confidence = 0.85;
          evidence.push(`Matched OpenAI conversations file signature: ${base}`);
        }
        try {
          const sample = fs.readFileSync(src.path, { encoding: 'utf8', flag: 'r' }).slice(0, 16384);
          if (sample.includes('"mapping"') && sample.includes('"current_node"')) {
            confidence = 0.99;
            evidence.push('Discovered mapping and current_node graph keys');
          }
          if (sample.includes('is_visually_hidden_from_conversation')) {
            evidence.push('Discovered hidden message metadata flag');
          }
        } catch (err) {
          warnings.push(`File read error: ${(err as Error).message}`);
        }
      }
    } else if (src.kind === 'dir') {
      try {
        const files = fs.readdirSync(src.path);
        const convFiles = files.filter((f) => /^conversations(-\d+)?\.json$/i.test(f));
        if (convFiles.length > 0) {
          confidence = 0.95;
          evidence.push(`Directory contains OpenAI export files: ${convFiles.join(', ')}`);
          for (const f of convFiles) {
            entries.push(path.join(src.path, f));
          }
        }
      } catch (err) {
        warnings.push(`Directory read error: ${(err as Error).message}`);
      }
    }

    if (confidence <= 0) return null;

    return {
      adapterId: this.id,
      version: 'v2',
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
        // ignore size probe error
      }
      const taskId = sha256Hex(`${src.path}#${entry}#0`);
      yield {
        id: taskId,
        src,
        entry,
        estimatedBytes: size,
      };
    }
  }

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<OpenAiNativeConversation>[]> {
    const filePath = task.entry ?? task.src.path;
    ctx.log('info', `OpenAiWebAdapter parsing file: ${filePath}`);

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

    const rawList: OpenAiNativeConversation[] = Array.isArray(parsed)
      ? (parsed as OpenAiNativeConversation[])
      : typeof parsed === 'object' && parsed !== null
        ? [parsed as OpenAiNativeConversation]
        : [];

    const docs: SessionDocument<OpenAiNativeConversation>[] = [];

    for (const rawConv of rawList) {
      partitionVendorFields(rawConv, KNOWN_CONV_KEYS, ctx);
      const mapping = rawConv.mapping ?? {};
      for (const node of Object.values(mapping)) {
        if (node?.message && typeof node.message === 'object') {
          partitionVendorFields(node.message, KNOWN_MSG_KEYS, ctx);
        }
      }
      docs.push(new OpenAiSessionDocument(rawConv));
    }

    return docs;
  }
}

export const openaiWebAdapter = new OpenAiWebAdapter();
