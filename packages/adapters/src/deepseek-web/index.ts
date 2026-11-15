import fs from 'node:fs';
import path from 'node:path';
import {
  SPILL_THRESHOLD_BYTES,
  ZipArchive,
  sha256Hex,
  type BlobAsset,
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

export interface DeepSeekFragment {
  id?: number | string;
  type?: string;
  content?: string;
  results?: unknown[];
  [key: string]: unknown;
}

export interface DeepSeekMappingMessage {
  id?: string;
  message_id?: string;
  model?: string;
  role?: string;
  sender?: string;
  inserted_at?: string | number;
  create_time?: string | number;
  created_at?: string | number;
  content?: string | unknown[];
  text?: string;
  reasoning_content?: string;
  thinking_content?: string;
  thought?: string;
  fragments?: DeepSeekFragment[];
  files?: unknown[];
  [key: string]: unknown;
}

export interface DeepSeekMappingNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: DeepSeekMappingMessage | null;
  [key: string]: unknown;
}

export interface DeepSeekNativeConversation {
  id?: string;
  conversation_id?: string;
  chat_id?: string;
  title?: string;
  created_at?: number | string;
  create_time?: number | string;
  inserted_at?: number | string;
  updated_at?: number | string;
  update_time?: number | string;
  model?: string;
  current_node?: string | null;
  current_message_id?: string | number | null;
  mapping?: Record<string, DeepSeekMappingNode>;
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
  'inserted_at',
  'updated_at',
  'update_time',
  'messages',
  'chat_messages',
  'mapping',
  'current_node',
  'current_message_id',
  'model',
] as const;

const KNOWN_MSG_KEYS = [
  'id',
  'message_id',
  'parent_id',
  'parent_message_id',
  'role',
  'sender',
  'content',
  'text',
  'reasoning_content',
  'thinking_content',
  'thought',
  'fragments',
  'files',
  'created_at',
  'create_time',
  'inserted_at',
  'model',
  'is_active_branch',
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

function hasDeepSeekMarkersText(sample: string): { matched: boolean; confidence: number; reason: string[] } {
  const lower = sample.toLowerCase();
  const reason: string[] = [];
  let confidence = 0;

  if (lower.includes('deepseek')) {
    confidence = Math.max(confidence, 0.85);
    reason.push('Discovered deepseek token in JSON sample');
  }
  if (sample.includes('"reasoning_content"') || sample.includes('"thinking_content"')) {
    confidence = Math.max(confidence, 0.95);
    reason.push('Discovered DeepSeek signature field: reasoning_content');
  }
  if (
    sample.includes('"fragments"') &&
    (sample.includes('"THINK"') || sample.includes('"RESPONSE"') || sample.includes('"REQUEST"'))
  ) {
    confidence = Math.max(confidence, 0.96);
    reason.push('Discovered DeepSeek official export fragments (THINK/RESPONSE/REQUEST)');
  }
  if (sample.includes('"inserted_at"') && sample.includes('"mapping"')) {
    confidence = Math.max(confidence, 0.92);
    reason.push('Discovered DeepSeek official mapping + inserted_at export markers');
  }

  return { matched: confidence > 0, confidence, reason };
}

function hasConversationContent(obj: Record<string, unknown>): boolean {
  return (
    Array.isArray(obj['messages']) ||
    Array.isArray(obj['chat_messages']) ||
    Array.isArray(obj['fragments']) ||
    (Boolean(obj['mapping']) && typeof obj['mapping'] === 'object')
  );
}

function extractConversationsList(parsed: unknown): DeepSeekNativeConversation[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(
      (x): x is DeepSeekNativeConversation =>
        Boolean(x && typeof x === 'object' && hasConversationContent(x as Record<string, unknown>))
    );
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['conversations', 'chat_sessions', 'sessions', 'data']) {
      const candidate = obj[key];
      if (Array.isArray(candidate)) {
        return candidate.filter(
          (x): x is DeepSeekNativeConversation =>
            Boolean(x && typeof x === 'object' && hasConversationContent(x as Record<string, unknown>))
        );
      }
      if (candidate && typeof candidate === 'object' && key === 'data') {
        const nested = extractConversationsList(candidate);
        if (nested.length > 0) return nested;
      }
    }
    return hasConversationContent(obj) ? [obj as DeepSeekNativeConversation] : [];
  }
  return [];
}

function extractMessageBlocks(
  msg: Record<string, unknown>,
  contentKey: string
): { blocks: ViewBlock[]; inferredRole?: SessionRole; inferredModel: string | null } {
  const blocks: ViewBlock[] = [];
  let blockIdx = 0;
  let inferredRole: SessionRole | undefined;
  const inferredModel = typeof msg['model'] === 'string' ? msg['model'] : null;

  const reasoningVal = msg['reasoning_content'] ?? msg['thinking_content'] ?? msg['thought'];
  if (typeof reasoningVal === 'string' && reasoningVal.trim().length > 0) {
    blocks.push({
      idx: blockIdx++,
      type: 'thinking',
      text: reasoningVal,
    });
  }

  if (Array.isArray(msg['fragments'])) {
    for (const frag of msg['fragments']) {
      if (!frag || typeof frag !== 'object') continue;
      const fObj = frag as Record<string, unknown>;
      const fType = typeof fObj['type'] === 'string' ? fObj['type'].toUpperCase() : 'TEXT';
      const fContent =
        typeof fObj['content'] === 'string'
          ? fObj['content']
          : typeof fObj['text'] === 'string'
            ? fObj['text']
            : '';

      if (fType === 'REQUEST') {
        inferredRole = inferredRole ?? 'user';
        if (fContent) blocks.push({ idx: blockIdx++, type: 'text', text: fContent });
      } else if (fType === 'THINK') {
        inferredRole = inferredRole ?? 'assistant';
        if (fContent) blocks.push({ idx: blockIdx++, type: 'thinking', text: fContent });
      } else if (fType === 'RESPONSE') {
        inferredRole = inferredRole ?? 'assistant';
        if (fContent) blocks.push({ idx: blockIdx++, type: 'text', text: fContent });
      } else if (fType === 'SEARCH') {
        inferredRole = inferredRole ?? 'assistant';
        const resultsText = Array.isArray(fObj['results']) ? JSON.stringify(fObj['results']) : fContent;
        if (resultsText) blocks.push({ idx: blockIdx++, type: 'text', text: resultsText });
      } else if (fContent) {
        blocks.push({ idx: blockIdx++, type: 'text', text: fContent });
      }
    }
  }

  const contentVal = msg[contentKey] ?? msg['content'] ?? msg['text'];
  if (typeof contentVal === 'string' && contentVal.length > 0 && blocks.every((b) => b.text !== contentVal)) {
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

  return { blocks, inferredRole, inferredModel };
}

export class DeepSeekSessionDocument extends BaseSessionDocument<DeepSeekNativeConversation> {
  private readonly schema: SchemaSummary;

  constructor(
    nativeData: DeepSeekNativeConversation,
    schema: SchemaSummary,
    parseIssues: IntegrityIssue[] = [],
    blobs: BlobAsset[] = []
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
    const createdAt = parseFlexTimestamp(
      nativeData.create_time ?? nativeData.created_at ?? nativeData.inserted_at
    );
    const updatedAt = parseFlexTimestamp(
      nativeData.update_time ?? nativeData.updated_at ?? nativeData.inserted_at
    );
    const defaultModel = typeof nativeData.model === 'string' ? nativeData.model : null;

    super({
      provider: 'deepseek-web',
      rawFormat: nativeData.mapping ? 'deepseek-web/mapping_v1' : 'deepseek-web/inferred_v1',
      nativeData,
      external_id: extId,
      title: title || null,
      title_source: title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      default_model: defaultModel,
      blobs,
      parseIssues,
    });
    this.schema = schema;
  }

  protected projectTurns(): RawTurnProjection[] {
    const roleKey = this.schema.candidateRoleKeys[0] ?? 'role';
    const contentKey = this.schema.candidateContentKeys[0] ?? 'content';
    const createdAt = this.init.created_at ?? null;

    if (this.nativeData.mapping && typeof this.nativeData.mapping === 'object') {
      return this.projectMappingTurns(this.nativeData.mapping, roleKey, contentKey, createdAt);
    }

    const messages = Array.isArray(this.nativeData.messages)
      ? this.nativeData.messages
      : Array.isArray(this.nativeData.chat_messages)
        ? this.nativeData.chat_messages
        : [];

    const activeIds = new Set<string>();
    const rawTip = this.nativeData.current_message_id ?? this.nativeData.current_node;
    if (typeof rawTip === 'string' || typeof rawTip === 'number') {
      const parentById = new Map<string, string | null>();
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== 'object') continue;
        const rawId = msg['id'] ?? msg['message_id'];
        const msgId =
          typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : `dsk-msg-${i}`;
        const rawParent = msg['parent_id'] ?? msg['parent_message_id'];
        const parentId =
          typeof rawParent === 'string' || typeof rawParent === 'number' ? String(rawParent) : null;
        parentById.set(msgId, parentId);
      }
      let cursor: string | null = String(rawTip);
      while (cursor && parentById.has(cursor) && !activeIds.has(cursor)) {
        activeIds.add(cursor);
        cursor = parentById.get(cursor) ?? null;
      }
    }

    const turns: RawTurnProjection[] = [];
    let prevId: string | null = null;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;

      const rawId = msg['id'] ?? msg['message_id'];
      const msgId =
        typeof rawId === 'string' || typeof rawId === 'number'
          ? String(rawId)
          : `dsk-msg-${i}`;

      const { blocks, inferredRole, inferredModel } = extractMessageBlocks(msg, contentKey);
      const rawRoleVal = msg[roleKey] ?? msg['role'] ?? msg['sender'];
      const rawRole = typeof rawRoleVal === 'string' ? rawRoleVal.toLowerCase() : undefined;
      const role: SessionRole =
        rawRole === 'assistant' || rawRole === 'bot' || rawRole === 'model'
          ? 'assistant'
          : rawRole === 'system'
            ? 'system'
            : rawRole === 'user' || rawRole === 'human'
              ? 'user'
              : inferredRole ?? 'user';

      const rawParent = msg['parent_id'] ?? msg['parent_message_id'];
      const explicitParent =
        typeof rawParent === 'string' || typeof rawParent === 'number'
          ? String(rawParent)
          : prevId;

      const projectedText = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');

      turns.push({
        external_id: msgId,
        parent_external_id: explicitParent,
        ordinal: i,
        role,
        kind: 'message',
        created_at:
          parseFlexTimestamp(msg['create_time'] ?? msg['created_at'] ?? msg['inserted_at']) ?? createdAt,
        model: inferredModel,
        text: projectedText,
        is_active_branch:
          typeof msg['is_active_branch'] === 'boolean'
            ? msg['is_active_branch']
            : activeIds.size > 0
              ? activeIds.has(msgId)
              : true,
        is_hidden: false,
        is_synthetic: false,
        blocks,
      });

      prevId = msgId;
    }

    return turns;
  }

  private projectMappingTurns(
    mapping: Record<string, DeepSeekMappingNode>,
    roleKey: string,
    contentKey: string,
    fallbackCreatedAt: number | null
  ): RawTurnProjection[] {
    const activeIds = new Set<string>();
    let tipId: string | null =
      typeof this.nativeData.current_node === 'string' && mapping[this.nativeData.current_node]
        ? this.nativeData.current_node
        : null;

    if (!tipId) {
      // Follow latest-child spine from root if current_node is absent
      const roots = Object.entries(mapping)
        .filter(([, node]) => !node?.parent || !mapping[node.parent])
        .map(([id]) => id);
      let cursor = roots[0] ?? null;
      const seen = new Set<string>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        const node = mapping[cursor];
        const children = Array.isArray(node?.children) ? node.children : [];
        if (children.length === 0) {
          tipId = cursor;
          break;
        }
        cursor = children[children.length - 1] ?? null;
      }
    }

    let walk: string | null = tipId;
    while (walk && !activeIds.has(walk)) {
      activeIds.add(walk);
      const p = mapping[walk]?.parent;
      walk = typeof p === 'string' && mapping[p] ? p : null;
    }

    // Traverse DFS from roots to preserve parent ordering deterministically
    const orderedNodeIds: string[] = [];
    const visited = new Set<string>();
    const visit = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      orderedNodeIds.push(nodeId);
      const children = Array.isArray(mapping[nodeId]?.children) ? mapping[nodeId]!.children! : [];
      for (const childId of children) {
        if (mapping[childId]) visit(childId);
      }
    };

    const roots = Object.keys(mapping).filter((id) => {
      const p = mapping[id]?.parent;
      return !p || !mapping[p];
    });
    for (const r of roots) visit(r);
    for (const id of Object.keys(mapping)) visit(id);

    const turns: RawTurnProjection[] = [];
    let ordinal = 0;

    for (const nodeId of orderedNodeIds) {
      const node = mapping[nodeId];
      const msg = node?.message;
      if (!msg || typeof msg !== 'object') continue;

      const msgRecord = msg as Record<string, unknown>;
      const { blocks, inferredRole, inferredModel } = extractMessageBlocks(msgRecord, contentKey);
      const rawRoleVal = msgRecord[roleKey] ?? msgRecord['role'] ?? msgRecord['sender'];
      const rawRole = typeof rawRoleVal === 'string' ? rawRoleVal.toLowerCase() : undefined;
      const role: SessionRole =
        rawRole === 'assistant' || rawRole === 'bot' || rawRole === 'model'
          ? 'assistant'
          : rawRole === 'system'
            ? 'system'
            : rawRole === 'user' || rawRole === 'human'
              ? 'user'
              : inferredRole ?? 'user';

      const projectedText = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');
      let parentId: string | null = node.parent ?? null;
      while (parentId && (!mapping[parentId] || !mapping[parentId]?.message)) {
        parentId = mapping[parentId]?.parent ?? null;
      }

      turns.push({
        external_id: nodeId,
        parent_external_id: parentId,
        ordinal: ordinal++,
        role,
        kind: 'message',
        created_at:
          parseFlexTimestamp(msgRecord['inserted_at'] ?? msgRecord['create_time'] ?? msgRecord['created_at']) ??
          fallbackCreatedAt,
        model: inferredModel,
        text: projectedText,
        is_active_branch: activeIds.size > 0 ? activeIds.has(nodeId) : true,
        is_hidden: false,
        is_synthetic: false,
        blocks,
      });
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
          const raw = fs.readFileSync(src.path, { encoding: 'utf8', flag: 'r' }).slice(0, 32768);
          const check = hasDeepSeekMarkersText(raw);
          if (check.matched) {
            confidence = Math.max(confidence, check.confidence);
            evidence.push(...check.reason);
          }
        } catch (err) {
          warnings.push(`File read error: ${(err as Error).message}`);
        }
      } else if (base.endsWith('.zip')) {
        let archive: ZipArchive | null = null;
        try {
          archive = ZipArchive.open(src.path);
          const ignoredNames = new Set(['manifest.json', 'user.json', 'chat_session_index.json']);
          const jsonEntries = archive
            .listEntries()
            .filter((e) => {
              if (e.isDirectory || !e.name.toLowerCase().endsWith('.json')) return false;
              const entryBase = path.basename(e.name).toLowerCase();
              return !ignoredNames.has(entryBase);
            });
          for (const entryInfo of jsonEntries) {
            const sample = archive.readEntryText(entryInfo.name).slice(0, 32768);
            const check = hasDeepSeekMarkersText(sample);
            if (check.matched || base.includes('deepseek')) {
              confidence = Math.max(confidence, Math.max(check.confidence, 0.9));
              evidence.push(`DeepSeek JSON inside ZIP (${entryInfo.name}): ${check.reason.join('; ')}`);
              entries.push(`${src.path}::zip::${entryInfo.name}`);
            }
          }
        } catch (err) {
          warnings.push(`ZIP inspect error: ${(err as Error).message}`);
        } finally {
          archive?.close();
        }
      }
    } else if (src.kind === 'dir') {
      try {
        const files = fs.readdirSync(src.path);
        for (const file of files) {
          const lower = file.toLowerCase();
          if (lower.endsWith('.json')) {
            const full = path.join(src.path, file);
            if (lower.includes('deepseek')) {
              confidence = Math.max(confidence, 0.85);
              evidence.push(`Found DeepSeek named file: ${file}`);
              entries.push(full);
            } else {
              try {
                const sample = fs.readFileSync(full, 'utf8').slice(0, 16384);
                const check = hasDeepSeekMarkersText(sample);
                if (check.matched && check.confidence >= 0.9) {
                  confidence = Math.max(confidence, check.confidence);
                  evidence.push(`${file}: ${check.reason.join(', ')}`);
                  entries.push(full);
                }
              } catch {
                // ignore
              }
            }
          }
        }
      } catch (err) {
        warnings.push(`Dir read error: ${(err as Error).message}`);
      }
    }

    if (confidence <= 0 || entries.length === 0) return null;

    return {
      adapterId: this.id,
      version: 'inferred_v2',
      confidence,
      evidence,
      entries,
      warnings,
    };
  }

  async *plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask> {
    for (const entry of probe.entries) {
      let size = 0;
      const diskPath = entry.includes('::zip::') ? entry.split('::zip::')[0]! : entry;
      try {
        size = fs.statSync(diskPath).size;
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
    const entry = task.entry ?? task.src.path;
    let rawContent: string;

    try {
      if (entry.includes('::zip::')) {
        const [zipPath, innerEntry] = entry.split('::zip::') as [string, string];
        ctx.log('info', `DeepSeekWebAdapter parsing ZIP entry: ${innerEntry}`);
        const archive = ZipArchive.open(zipPath);
        try {
          rawContent = archive.readEntryText(innerEntry);
        } finally {
          archive.close();
        }
      } else {
        ctx.log('info', `DeepSeekWebAdapter parsing file: ${entry}`);
        rawContent = fs.readFileSync(entry, 'utf8');
      }
    } catch (err) {
      ctx.log('error', `Failed to read DeepSeek source ${entry}: ${(err as Error).message}`);
      return [];
    }

    let parsed: unknown;
    try {
      const cleanRaw = rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;
      parsed = JSON.parse(cleanRaw);
    } catch (err) {
      ctx.log('error', `JSON parse error in ${entry}: ${(err as Error).message}`);
      return [];
    }

    const rawList = extractConversationsList(parsed);
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
      const blobs: BlobAsset[] = [];
      const rawJsonBytes = Buffer.byteLength(JSON.stringify(rawConv), 'utf8');
      if (rawJsonBytes > SPILL_THRESHOLD_BYTES * 8) {
        const spilledSha = await ctx.spill(rawConv);
        blobs.push({
          sha256: spilledSha,
          mime: 'application/json',
          bytes: rawJsonBytes,
          ext: '.json',
          rel_path: `blobs/${spilledSha.slice(0, 2)}/${spilledSha}.json`,
          origin_kind: 'oversized_payload',
          created_at: Date.now(),
        });
      }
      docs.push(new DeepSeekSessionDocument(rawConv, schemaSummary, [], blobs));
    }

    return docs;
  }
}

export const deepseekWebAdapter = new DeepSeekWebAdapter();
