import fs from 'node:fs';
import path from 'node:path';
import {
  sha256Hex,
  type OcaBlock,
  type OcaBlockType,
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

export class OpenAiWebAdapter implements Adapter {
  readonly id: OcaProviderId = 'openai-web';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const evidence: string[] = [];
    const entries: string[] = [];
    const warnings: string[] = [];
    let confidence = 0;

    if (src.kind === 'file') {
      const base = path.basename(src.path).toLowerCase();
      if (base.endsWith('.zip')) {
        // Zip archive probe
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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<OcaConversationDraft[]> {
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
    const extId =
      typeof rawConv['conversation_id'] === 'string'
        ? rawConv['conversation_id']
        : typeof rawConv['id'] === 'string'
          ? rawConv['id']
          : null;

    const createTimeSec = typeof rawConv['create_time'] === 'number' ? rawConv['create_time'] : null;
    const updateTimeSec = typeof rawConv['update_time'] === 'number' ? rawConv['update_time'] : null;
    const createdAt = createTimeSec !== null ? Math.round(createTimeSec * 1000) : null;
    const updatedAt = updateTimeSec !== null ? Math.round(updateTimeSec * 1000) : null;

    let title = typeof rawConv['title'] === 'string' ? rawConv['title'].trim() : null;
    let titleSource: 'provider' | 'first_user' = 'provider';

    const defaultModel =
      typeof rawConv['default_model_slug'] === 'string' ? rawConv['default_model_slug'] : null;

    const unmappedConv = partitionVendorFields(rawConv, KNOWN_CONV_KEYS, ctx);

    const mapping = (rawConv['mapping'] ?? {}) as Record<string, Record<string, unknown>>;
    const currentNode = typeof rawConv['current_node'] === 'string' ? rawConv['current_node'] : null;

    // Trace active branch from current_node up to root
    const activeBranchNodeIds = new Set<string>();
    let tracer = currentNode;
    while (tracer && mapping[tracer]) {
      activeBranchNodeIds.add(tracer);
      const parent = mapping[tracer]?.['parent'];
      tracer = typeof parent === 'string' ? parent : null;
    }

    const items: OcaItemDraft[] = [];
    let ordinal = 0;
    let firstUserText: string | null = null;

    // Process nodes in mapping
    for (const [nodeId, nodeObj] of Object.entries(mapping)) {
      if (!nodeObj || typeof nodeObj !== 'object') continue;
      const msgObj = nodeObj['message'] as Record<string, unknown> | null | undefined;
      if (!msgObj || typeof msgObj !== 'object') {
        // Root or container anchor node without message payload
        continue;
      }

      const parentId = typeof nodeObj['parent'] === 'string' ? nodeObj['parent'] : null;
      const author = (msgObj['author'] ?? {}) as Record<string, unknown>;
      const rawRole = typeof author['role'] === 'string' ? author['role'].toLowerCase() : 'user';

      let role: OcaRole = 'user';
      if (rawRole === 'assistant') role = 'assistant';
      else if (rawRole === 'system') role = 'system';
      else if (rawRole === 'tool') role = 'tool';
      else if (rawRole === 'developer') role = 'developer';
      else if (rawRole === 'critic') role = 'assistant';

      const metadata = (msgObj['metadata'] ?? {}) as Record<string, unknown>;
      const isHidden = Boolean(metadata['is_visually_hidden_from_conversation']);
      const isSynthetic = Boolean(metadata['is_user_system_message']);
      const model = typeof metadata['model_slug'] === 'string' ? metadata['model_slug'] : defaultModel;

      const msgCreateTime = typeof msgObj['create_time'] === 'number' ? Math.round(msgObj['create_time'] * 1000) : createdAt;

      const contentObj = (msgObj['content'] ?? {}) as Record<string, unknown>;
      const contentType = typeof contentObj['content_type'] === 'string' ? contentObj['content_type'] : 'text';
      const parts = Array.isArray(contentObj['parts']) ? contentObj['parts'] : [];

      const blocks: OcaBlock[] = [];
      let blockIdx = 0;

      for (const part of parts) {
        if (typeof part === 'string') {
          let blockType: OcaBlockType = 'text';
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

      if (blocks.length === 0 && typeof contentObj['text'] === 'string') {
        blocks.push({
          idx: blockIdx++,
          type: 'text',
          text: contentObj['text'],
        });
      }

      const unmappedMsg = partitionVendorFields(msgObj, KNOWN_MSG_KEYS, ctx);

      const isActive = activeBranchNodeIds.has(nodeId);
      const textProjection = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');

      if (role === 'user' && !firstUserText && textProjection.length > 0) {
        firstUserText = textProjection.slice(0, 40).replace(/\s+/g, ' ');
      }

      items.push({
        external_id: nodeId,
        parent_external_id: parentId,
        ordinal: ordinal++,
        role,
        kind: contentType === 'execution_output' ? 'tool_result' : 'message',
        created_at: msgCreateTime,
        model,
        text: textProjection,
        text_len: textProjection.length,
        is_active_branch: isActive,
        is_hidden: isHidden,
        is_synthetic: isSynthetic,
        blocks,
        ext: {
          openai: {
            default_model_slug: model,
            feedback: typeof metadata['feedback'] === 'string' ? metadata['feedback'] : null,
            recipient: typeof msgObj['recipient'] === 'string' ? msgObj['recipient'] : null,
            content_type: contentType,
            about_user_message:
              typeof (metadata['user_context_message_data'] as Record<string, unknown> | undefined)?.[
                'about_user_message'
              ] === 'string'
                ? ((metadata['user_context_message_data'] as Record<string, unknown>)['about_user_message'] as string)
                : null,
            about_model_message:
              typeof (metadata['user_context_message_data'] as Record<string, unknown> | undefined)?.[
                'about_model_message'
              ] === 'string'
                ? ((metadata['user_context_message_data'] as Record<string, unknown>)['about_model_message'] as string)
                : null,
          },
          ...(unmappedMsg ? { _unmapped: unmappedMsg } : {}),
        },
      });
    }

    if ((!title || title.length === 0) && firstUserText) {
      title = firstUserText;
      titleSource = 'first_user';
    }

    return {
      provider: this.id,
      external_id: extId,
      title,
      title_source: titleSource,
      created_at: createdAt,
      updated_at: updatedAt,
      default_model: defaultModel,
      items,
      ext: {
        openai: {
          gizmo_id: typeof rawConv['gizmo_id'] === 'string' ? rawConv['gizmo_id'] : null,
          default_model_slug: defaultModel,
          shared: Boolean(rawConv['is_shared']),
        },
        ...(unmappedConv ? { _unmapped: unmappedConv } : {}),
      },
    };
  }
}

export const openaiWebAdapter = new OpenAiWebAdapter();
