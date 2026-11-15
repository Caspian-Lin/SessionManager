import { DatabaseSync } from 'node:sqlite';
import {
  SPILL_THRESHOLD_BYTES,
  type BlobAsset,
  type IntegrityIssue,
  type ItemStatus,
  type ProviderId,
  type SessionRole,
  type TitleSource,
  type ViewBlock,
} from '@sm/shared';
import {
  BaseSessionDocument,
  partitionVendorFields,
  type ImportTask,
  type ParseCtx,
  type RawTurnProjection,
  type SessionDocument,
  type SourceRef,
} from '../contract.js';

export interface OpenCodeV1MessagePayload {
  id: string;
  time_created: number | null;
  time_updated: number | null;
  sequence?: number | null;
  data: Record<string, unknown>;
  parts: Array<{
    id: string;
    time_created: number | null;
    sequence?: number | null;
    data: Record<string, unknown>;
  }>;
}

export interface OpenCodeV2MessagePayload {
  id: string;
  type: string;
  seq: number;
  time_created: number | null;
  time_updated: number | null;
  data: Record<string, unknown>;
}

export interface OpenCodeFamilyNativeSession {
  schema_variant: 'v1' | 'v2';
  session_id: string;
  source_file: string;
  title?: string | null;
  title_source?: string | null;
  cwd?: string | null;
  project_id?: string | null;
  parent_session_id?: string | null;
  task_type?: string | null;
  version?: string | null;
  default_model?: string | null;
  v1_messages?: OpenCodeV1MessagePayload[];
  v2_messages?: OpenCodeV2MessagePayload[];
  spills?: Record<string, { sha256: string; bytes: number; preview: string }>;
}

const KNOWN_PART_KEYS = [
  'type',
  'text',
  'callID',
  'id',
  'tool',
  'name',
  'state',
  'mime',
  'filename',
  'url',
  'source',
  'time',
  'summary',
  'files',
  'hash',
  'timelineType',
  'display',
  'status',
  'toModel',
  'toModelSelection',
  'auto',
  'trigger',
  'phase',
  'compactReason',
  'operationId',
  'timelineStatus',
  'timelineDisplay',
  'replace',
  'boundaryId',
  'summaryMessageId',
] as const;

export function safeJsonObj(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { raw_text: raw };
    } catch {
      return { raw_text: raw };
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function normalizeTs(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val < 10_000_000_000 ? Math.round(val * 1000) : Math.round(val);
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function mapToolStatus(status: unknown): ItemStatus | null {
  if (typeof status !== 'string') return null;
  const s = status.toLowerCase();
  if (s === 'completed' || s === 'ok' || s === 'success') return 'ok';
  if (s === 'error' || s === 'failed') return 'error';
  if (s === 'pending' || s === 'running' || s === 'in_progress') return 'pending';
  if (s === 'interrupted' || s === 'cancelled' || s === 'canceled') return 'interrupted';
  return null;
}

function mapTitleSource(raw: unknown): TitleSource | null {
  if (raw === 'provider' || raw === 'generated' || raw === 'first_user' || raw === 'filename') {
    return raw;
  }
  if (typeof raw === 'string' && raw.length > 0) return 'provider';
  return null;
}

function extractModelId(data: Record<string, unknown>): string | null {
  if (typeof data['modelID'] === 'string' && data['modelID'].length > 0) {
    return data['modelID'];
  }
  const modelObj = data['model'];
  if (typeof modelObj === 'string' && modelObj.length > 0) return modelObj;
  if (modelObj && typeof modelObj === 'object') {
    const m = modelObj as Record<string, unknown>;
    if (typeof m['modelID'] === 'string' && m['modelID'].length > 0) return m['modelID'];
    if (typeof m['id'] === 'string' && m['id'].length > 0) return m['id'];
  }
  return null;
}

function serializeCompact(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val === undefined || val === null) return '';
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

async function maybeSpillOutput(
  key: string,
  val: unknown,
  spills: Record<string, { sha256: string; bytes: number; preview: string }>,
  ctx: ParseCtx
): Promise<void> {
  if (val === undefined || val === null) return;
  const str = typeof val === 'string' ? val : JSON.stringify(val);
  const bytes = Buffer.byteLength(str, 'utf8');
  if (bytes > SPILL_THRESHOLD_BYTES) {
    const sha256 = await ctx.spill(val);
    const preview = `${str.slice(0, 2048)}\n... [spilled ${bytes} bytes -> blob:${sha256}]`;
    spills[key] = { sha256, bytes, preview };
  }
}

export class OpenCodeFamilySessionDocument extends BaseSessionDocument<OpenCodeFamilyNativeSession> {
  constructor(
    provider: ProviderId,
    rawFormat: string,
    nativeData: OpenCodeFamilyNativeSession,
    createdAt: number | null,
    updatedAt: number | null,
    parseIssues: IntegrityIssue[] = [],
    blobs: BlobAsset[] = []
  ) {
    const subagentMatch = nativeData.title
      ? /\(@([^\s)]+)\s+subagent\)/i.exec(nativeData.title)
      : null;
    const isSubagent = Boolean(
      nativeData.parent_session_id ||
        nativeData.task_type === 'subagent' ||
        subagentMatch
    );
    super({
      provider,
      rawFormat,
      nativeData,
      external_id: nativeData.session_id,
      parent_external_id: nativeData.parent_session_id ?? null,
      is_subagent: isSubagent,
      subagent_name:
        subagentMatch?.[1] ?? (nativeData.task_type === 'subagent' ? 'subagent' : null),
      title: nativeData.title ?? null,
      title_source: nativeData.title ? mapTitleSource(nativeData.title_source) ?? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      default_model: nativeData.default_model ?? null,
      cwd: nativeData.cwd ?? null,
      blobs,
      parseIssues,
    });
  }

  protected projectTurns(): RawTurnProjection[] {
    if (this.nativeData.schema_variant === 'v2') {
      return this.projectV2Turns();
    }
    return this.projectV1Turns();
  }

  private projectV1Turns(): RawTurnProjection[] {
    const turns: RawTurnProjection[] = [];
    const spills = this.nativeData.spills ?? {};
    let ordinal = 0;
    let prevId: string | null = null;
    const messageFirstNodeId = new Map<string, string>();

    for (const msg of this.nativeData.v1_messages ?? []) {
      const mData = msg.data ?? {};
      const rawRole = typeof mData['role'] === 'string' ? mData['role'] : 'user';
      const role: SessionRole =
        rawRole === 'assistant' ? 'assistant' : rawRole === 'system' ? 'system' : 'user';
      const model = extractModelId(mData);
      const msgTs = normalizeTs(
        (mData['time'] as Record<string, unknown> | undefined)?.['created'] ?? msg.time_created
      );
      const parentMsgId =
        typeof mData['parentID'] === 'string' ? mData['parentID'] : null;
      const anchorParentId =
        (parentMsgId ? messageFirstNodeId.get(parentMsgId) : null) ?? prevId;

      const textParts: string[] = [];
      const attachmentBlocks: ViewBlock[] = [];
      let emittedMainMessage = false;

      const emitMainIfBuffered = () => {
        if (textParts.length === 0 && attachmentBlocks.length === 0) return;
        const text = textParts.join('\n').trim();
        const nodeId = msg.id;
        const blocks: ViewBlock[] = [];
        if (text.length > 0) {
          blocks.push({ idx: 0, type: 'text', text });
        }
        for (const att of attachmentBlocks) {
          blocks.push({ ...att, idx: blocks.length });
        }
        turns.push({
          external_id: nodeId,
          parent_external_id: anchorParentId,
          ordinal: ordinal++,
          role,
          kind: 'message',
          created_at: msgTs,
          model,
          text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks,
        });
        if (!messageFirstNodeId.has(msg.id)) messageFirstNodeId.set(msg.id, nodeId);
        prevId = nodeId;
        textParts.length = 0;
        attachmentBlocks.length = 0;
        emittedMainMessage = true;
      };

      for (let pIdx = 0; pIdx < msg.parts.length; pIdx++) {
        const part = msg.parts[pIdx]!;
        const pData = part.data ?? {};
        const pType = typeof pData['type'] === 'string' ? pData['type'] : '';
        const partTs = normalizeTs(
          (pData['time'] as Record<string, unknown> | undefined)?.['start'] ??
            part.time_created ??
            msgTs
        );

        if (pType === 'step-start' || pType === 'step-finish') {
          continue;
        }

        if (pType === 'text') {
          const t = typeof pData['text'] === 'string' ? pData['text'] : '';
          if (t.length > 0) textParts.push(t);
        } else if (pType === 'file') {
          const fname =
            typeof pData['filename'] === 'string'
              ? pData['filename']
              : typeof pData['url'] === 'string'
                ? pData['url']
                : 'attachment';
          const mime = typeof pData['mime'] === 'string' ? pData['mime'] : 'application/octet-stream';
          attachmentBlocks.push({
            idx: attachmentBlocks.length,
            type: mime.startsWith('image/') ? 'image' : 'file',
            text: fname,
            availability: 'extracted_only',
            meta: { file_name: fname, mime, path: pData['url'] ?? fname },
          });
        } else if (pType === 'reasoning') {
          emitMainIfBuffered();
          const rText = typeof pData['text'] === 'string' ? pData['text'] : '';
          if (rText.trim().length > 0) {
            const rId = part.id || `${msg.id}:reason:${pIdx}`;
            turns.push({
              external_id: rId,
              parent_external_id: emittedMainMessage ? prevId : anchorParentId,
              ordinal: ordinal++,
              role: 'assistant',
              kind: 'reasoning',
              created_at: partTs,
              model,
              text: rText,
              is_active_branch: true,
              is_hidden: false,
              is_synthetic: false,
              blocks: [{ idx: 0, type: 'thinking', text: rText }],
            });
            if (!messageFirstNodeId.has(msg.id)) messageFirstNodeId.set(msg.id, rId);
            prevId = rId;
          }
        } else if (pType === 'tool') {
          emitMainIfBuffered();
          const toolName =
            typeof pData['tool'] === 'string'
              ? pData['tool']
              : typeof pData['name'] === 'string'
                ? pData['name']
                : 'tool';
          const state = safeJsonObj(pData['state']);
          const status = mapToolStatus(state['status']);
          const inputText = serializeCompact(state['input'] ?? {});
          const callId =
            (typeof pData['callID'] === 'string' && pData['callID']) ||
            part.id ||
            `${msg.id}:tool:${pIdx}`;
          const nodeKey = part.id || `${msg.id}:tool:${pIdx}`;
          const inSpill = spills[`${msg.id}:${part.id}:in`];
          const renderedInput = inSpill ? inSpill.preview : inputText;

          turns.push({
            external_id: `${nodeKey}:call`,
            parent_external_id: emittedMainMessage ? prevId : anchorParentId,
            ordinal: ordinal++,
            role: 'assistant',
            kind: 'tool_call',
            created_at: partTs,
            model,
            text: `${toolName}: ${renderedInput.slice(0, 1200)}`,
            is_active_branch: true,
            is_hidden: false,
            is_synthetic: false,
            status,
            payload_ref: inSpill?.sha256 ?? null,
            blocks: [
              {
                idx: 0,
                type: 'tool_use',
                tool_name: toolName,
                tool_call_id: callId,
                tool_input: renderedInput,
                ...(inSpill ? { blob_sha256: inSpill.sha256 } : {}),
              },
            ],
          });
          if (!messageFirstNodeId.has(msg.id)) messageFirstNodeId.set(msg.id, `${nodeKey}:call`);
          prevId = `${nodeKey}:call`;

          const rawOutput = state['error'] ?? state['output'];
          if (rawOutput !== undefined && rawOutput !== null) {
            const spillKey = `${msg.id}:${part.id}`;
            const spill = spills[spillKey];
            const outText = spill ? spill.preview : serializeCompact(rawOutput);
            const isError = status === 'error' || state['error'] !== undefined;
            const resId = `${nodeKey}:res`;
            turns.push({
              external_id: resId,
              parent_external_id: prevId,
              ordinal: ordinal++,
              role: 'tool',
              kind: 'tool_result',
              created_at: normalizeTs(state['time'] && typeof state['time'] === 'object' ? (state['time'] as Record<string, unknown>)['end'] : null) ?? partTs,
              model,
              text: outText,
              is_active_branch: true,
              is_hidden: false,
              is_synthetic: false,
              status,
              payload_ref: spill?.sha256 ?? null,
              blocks: [
                {
                  idx: 0,
                  type: 'tool_result',
                  tool_name: toolName,
                  tool_call_id: callId,
                  text: outText,
                  status,
                  blob_sha256: spill?.sha256 ?? null,
                },
              ],
            });
            prevId = resId;
          }
        } else if (pType === 'compaction') {
          emitMainIfBuffered();
          const cText =
            typeof pData['text'] === 'string'
              ? pData['text']
              : `Compaction (${String(pData['compactReason'] ?? pData['trigger'] ?? 'auto')})`;
          const cId = part.id || `${msg.id}:cmp:${pIdx}`;
          turns.push({
            external_id: cId,
            parent_external_id: prevId,
            ordinal: ordinal++,
            role: 'system',
            kind: 'compaction',
            created_at: partTs,
            text: cText,
            is_active_branch: true,
            is_hidden: false,
            is_synthetic: true,
            blocks: [{ idx: 0, type: 'text', text: cText }],
          });
          prevId = cId;
        } else if (pType === 'patch') {
          emitMainIfBuffered();
          const files = Array.isArray(pData['files']) ? pData['files'].join(', ') : serializeCompact(pData);
          const patchId = part.id || `${msg.id}:patch:${pIdx}`;
          turns.push({
            external_id: patchId,
            parent_external_id: prevId,
            ordinal: ordinal++,
            role: 'assistant',
            kind: 'file_change',
            created_at: partTs,
            model,
            text: files,
            is_active_branch: true,
            is_hidden: false,
            is_synthetic: true,
            blocks: [{ idx: 0, type: 'text', text: files }],
          });
          prevId = patchId;
        } else if (pType === 'timeline') {
          emitMainIfBuffered();
          const tlType = String(pData['timelineType'] ?? 'timeline');
          const toModel = (pData['toModel'] as Record<string, unknown> | undefined)?.['label'];
          const tlText = toModel ? `${tlType}: ${String(toModel)}` : serializeCompact(pData);
          const tlId = part.id || `${msg.id}:tl:${pIdx}`;
          turns.push({
            external_id: tlId,
            parent_external_id: prevId,
            ordinal: ordinal++,
            role: 'system',
            kind: 'notice',
            created_at: partTs,
            text: tlText,
            is_active_branch: true,
            is_hidden: false,
            is_synthetic: true,
            blocks: [{ idx: 0, type: 'text', text: tlText }],
          });
          prevId = tlId;
        }
      }

      emitMainIfBuffered();
    }

    return turns;
  }

  private projectV2Turns(): RawTurnProjection[] {
    const turns: RawTurnProjection[] = [];
    const spills = this.nativeData.spills ?? {};
    let ordinal = 0;
    let prevId: string | null = null;

    for (const msg of this.nativeData.v2_messages ?? []) {
      const mData = msg.data ?? {};
      const mType = msg.type;
      const msgTs = normalizeTs(msg.time_created);
      const model = extractModelId(mData);

      if (mType === 'user') {
        const text = typeof mData['text'] === 'string' ? mData['text'] : serializeCompact(mData);
        turns.push({
          external_id: msg.id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'user',
          kind: 'message',
          created_at: msgTs,
          text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks: [{ idx: 0, type: 'text', text }],
        });
        prevId = msg.id;
      } else if (mType === 'assistant') {
        const content = Array.isArray(mData['content']) ? mData['content'] : [];
        if (content.length === 0 && typeof mData['text'] === 'string') {
          turns.push({
            external_id: msg.id,
            parent_external_id: prevId,
            ordinal: ordinal++,
            role: 'assistant',
            kind: 'message',
            created_at: msgTs,
            model,
            text: mData['text'],
            is_active_branch: true,
            is_hidden: false,
            is_synthetic: false,
            blocks: [{ idx: 0, type: 'text', text: mData['text'] }],
          });
          prevId = msg.id;
          continue;
        }

        const bufferedText: string[] = [];
        const flushText = (suffix: string) => {
          if (bufferedText.length === 0) return;
          const t = bufferedText.join('\n').trim();
          bufferedText.length = 0;
          if (!t) return;
          const nodeId = suffix === '' ? msg.id : `${msg.id}:${suffix}`;
          turns.push({
            external_id: nodeId,
            parent_external_id: prevId,
            ordinal: ordinal++,
            role: 'assistant',
            kind: 'message',
            created_at: msgTs,
            model,
            text: t,
            is_active_branch: true,
            is_hidden: false,
            is_synthetic: false,
            blocks: [{ idx: 0, type: 'text', text: t }],
          });
          prevId = nodeId;
        };

        for (let idx = 0; idx < content.length; idx++) {
          const item = safeJsonObj(content[idx]);
          const iType = typeof item['type'] === 'string' ? item['type'] : '';
          if (iType === 'text') {
            if (typeof item['text'] === 'string') bufferedText.push(item['text']);
          } else if (iType === 'reasoning') {
            flushText(`pre-${idx}`);
            const rText = typeof item['text'] === 'string' ? item['text'] : '';
            if (rText.trim().length > 0) {
              const rId = `${msg.id}:reason:${idx}`;
              turns.push({
                external_id: rId,
                parent_external_id: prevId,
                ordinal: ordinal++,
                role: 'assistant',
                kind: 'reasoning',
                created_at: msgTs,
                model,
                text: rText,
                is_active_branch: true,
                is_hidden: false,
                is_synthetic: false,
                blocks: [{ idx: 0, type: 'thinking', text: rText }],
              });
              prevId = rId;
            }
          } else if (iType === 'tool') {
            flushText(`pre-${idx}`);
            const toolName =
              typeof item['name'] === 'string'
                ? item['name']
                : typeof item['tool'] === 'string'
                  ? item['tool']
                  : 'tool';
            const state = safeJsonObj(item['state']);
            const inputVal = item['input'] ?? state['input'] ?? {};
            const inputStr = serializeCompact(inputVal);
            const status = mapToolStatus(item['status'] ?? state['status']);
            const callId = (typeof item['id'] === 'string' && item['id']) || `${msg.id}:tool:${idx}`;
            const nodeKey = `${msg.id}:c${idx}`;
            const inSpill = spills[`${msg.id}:c${idx}:in`];
            const renderedInput = inSpill ? inSpill.preview : inputStr;

            turns.push({
              external_id: `${nodeKey}:call`,
              parent_external_id: prevId,
              ordinal: ordinal++,
              role: 'assistant',
              kind: 'tool_call',
              created_at: msgTs,
              model,
              text: `${toolName}: ${renderedInput.slice(0, 1200)}`,
              is_active_branch: true,
              is_hidden: false,
              is_synthetic: false,
              status,
              payload_ref: inSpill?.sha256 ?? null,
              blocks: [
                {
                  idx: 0,
                  type: 'tool_use',
                  tool_name: toolName,
                  tool_call_id: callId,
                  tool_input: renderedInput,
                  ...(inSpill ? { blob_sha256: inSpill.sha256 } : {}),
                },
              ],
            });
            prevId = `${nodeKey}:call`;

            const outVal = item['error'] ?? item['output'] ?? state['error'] ?? state['output'];
            if (outVal !== undefined && outVal !== null) {
              const spill = spills[`${msg.id}:c${idx}`];
              const outStr = spill ? spill.preview : serializeCompact(outVal);
              const isErr =
                status === 'error' ||
                item['error'] !== undefined ||
                state['error'] !== undefined;
              const resId = `${nodeKey}:res`;
              turns.push({
                external_id: resId,
                parent_external_id: prevId,
                ordinal: ordinal++,
                role: 'tool',
                kind: 'tool_result',
                created_at: msgTs,
                model,
                text: outStr,
                is_active_branch: true,
                is_hidden: false,
                is_synthetic: false,
                status,
                payload_ref: spill?.sha256 ?? null,
                blocks: [
                  {
                    idx: 0,
                    type: 'tool_result',
                    tool_name: toolName,
                    tool_call_id: callId,
                    text: outStr,
                    status,
                    blob_sha256: spill?.sha256 ?? null,
                  },
                ],
              });
              prevId = resId;
            }
          }
        }

        flushText('');
      } else if (mType === 'compaction') {
        const text =
          typeof mData['summary'] === 'string'
            ? mData['summary']
            : typeof mData['text'] === 'string'
              ? mData['text']
              : serializeCompact(mData);
        turns.push({
          external_id: msg.id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'compaction',
          created_at: msgTs,
          text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          blocks: [{ idx: 0, type: 'text', text }],
        });
        prevId = msg.id;
      } else {
        const text = typeof mData['text'] === 'string' ? mData['text'] : `${mType}: ${serializeCompact(mData)}`;
        turns.push({
          external_id: msg.id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'system',
          kind: mType === 'system' ? 'system_note' : 'notice',
          created_at: msgTs,
          text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          blocks: [{ idx: 0, type: 'text', text }],
        });
        prevId = msg.id;
      }
    }

    return turns;
  }
}

export interface SqliteDbInspection {
  tables: Set<string>;
  sessionCols: Set<string>;
  hasV1: boolean;
  hasV2: boolean;
  hasZcodeSignals: boolean;
}

export function inspectOpenCodeSqliteDb(dbPath: string): SqliteDbInspection | null {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tableRows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
        .all() as { name: string }[];
      const tables = new Set(tableRows.map((r) => r.name));
      const sessionCols = new Set<string>();
      if (tables.has('session')) {
        const colRows = db.prepare(`PRAGMA table_info("session")`).all() as { name: string }[];
        for (const c of colRows) sessionCols.add(c.name);
      }
      const hasV1 = tables.has('session') && tables.has('message') && tables.has('part');
      const hasV2 = tables.has('session_v2') && tables.has('session_message');
      const hasZcodeSignals =
        tables.has('session_task_link') ||
        sessionCols.has('task_type') ||
        sessionCols.has('title_source');
      return { tables, sessionCols, hasV1, hasV2, hasZcodeSignals };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

interface RawSessionRow {
  id: string;
  project_id?: string | null;
  parent_id?: string | null;
  directory?: string | null;
  path?: string | null;
  title?: string | null;
  title_source?: string | null;
  version?: string | null;
  task_type?: string | null;
  model?: string | null;
  time_created?: number | null;
  time_updated?: number | null;
  time_deleted?: number | null;
}

export interface PlannedOpenCodeTaskPayload {
  schemaVariant: 'v1' | 'v2';
  session: RawSessionRow;
  messagesV1?: OpenCodeV1MessagePayload[];
  messagesV2?: OpenCodeV2MessagePayload[];
}

export function loadOpenCodeFamilyTasks(
  src: SourceRef,
  dbPath: string,
  options?: { extraTitles?: Map<string, string> }
): ImportTask[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tableRows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as { name: string }[];
    const tables = new Set(tableRows.map((r) => r.name));

    const tasks: ImportTask[] = [];
    const seenSessionIds = new Set<string>();

    // Prefer v2 rows first when present (OpenCode v2 supersedes overlapping v1 ids)
    if (tables.has('session_v2') && tables.has('session_message')) {
      const v2SCols = new Set(
        (db.prepare(`PRAGMA table_info("session_v2")`).all() as { name: string }[]).map((c) => c.name)
      );
      const v2MCols = new Set(
        (db.prepare(`PRAGMA table_info("session_message")`).all() as { name: string }[]).map((c) => c.name)
      );

      const v2CreatedCol = v2SCols.has('time_created')
        ? 'time_created'
        : v2SCols.has('created_at')
          ? 'created_at'
          : 'NULL';
      const v2UpdatedCol = v2SCols.has('time_updated')
        ? 'time_updated'
        : v2SCols.has('updated_at')
          ? 'updated_at'
          : v2CreatedCol;
      const v2WhereDeleted = v2SCols.has('time_deleted') ? 'WHERE time_deleted IS NULL' : '';

      const v2SelectCols = [
        'id',
        v2SCols.has('project_id') ? 'project_id' : 'NULL AS project_id',
        v2SCols.has('parent_id') ? 'parent_id' : 'NULL AS parent_id',
        v2SCols.has('directory') ? 'directory' : 'NULL AS directory',
        v2SCols.has('path') ? 'path' : 'NULL AS path',
        v2SCols.has('title') ? 'title' : 'NULL AS title',
        v2SCols.has('title_source') ? 'title_source' : 'NULL AS title_source',
        v2SCols.has('version') ? 'version' : 'NULL AS version',
        v2SCols.has('model') ? 'model' : 'NULL AS model',
        `${v2CreatedCol} AS time_created`,
        `${v2UpdatedCol} AS time_updated`,
      ];

      const v2Sessions = db
        .prepare(
          `SELECT ${v2SelectCols.join(', ')} FROM session_v2 ${v2WhereDeleted} ORDER BY time_updated DESC, time_created DESC`
        )
        .all() as unknown as RawSessionRow[];

      const v2MsgSeqCol = v2MCols.has('seq')
        ? 'seq'
        : v2MCols.has('position')
          ? 'position'
          : 'rowid';
      const v2MsgCreatedCol = v2MCols.has('time_created')
        ? 'time_created'
        : v2MCols.has('created_at')
          ? 'created_at'
          : 'NULL';
      const v2MsgUpdatedCol = v2MCols.has('time_updated')
        ? 'time_updated'
        : v2MCols.has('updated_at')
          ? 'updated_at'
          : v2MsgCreatedCol;

      const v2MsgsAll = db
        .prepare(
          `SELECT id, session_id, type, ${v2MsgSeqCol} AS seq, ${v2MsgCreatedCol} AS time_created, ${v2MsgUpdatedCol} AS time_updated, data FROM session_message ORDER BY session_id ASC, seq ASC, time_created ASC`
        )
        .all() as unknown as Array<{
          id: string;
          session_id: string;
          type: string;
          seq: number;
          time_created: number | null;
          time_updated: number | null;
          data: string;
        }>;

      const msgsBySess = new Map<string, OpenCodeV2MessagePayload[]>();
      const bytesBySess = new Map<string, number>();
      for (const m of v2MsgsAll) {
        let list = msgsBySess.get(m.session_id);
        if (!list) {
          list = [];
          msgsBySess.set(m.session_id, list);
        }
        const rawLen = typeof m.data === 'string' ? m.data.length : 128;
        bytesBySess.set(m.session_id, (bytesBySess.get(m.session_id) ?? 0) + rawLen);
        list.push({
          id: m.id,
          type: m.type,
          seq: m.seq,
          time_created: m.time_created,
          time_updated: m.time_updated,
          data: safeJsonObj(m.data),
        });
      }

      for (const s of v2Sessions) {
        seenSessionIds.add(s.id);
        const msgs = msgsBySess.get(s.id) ?? [];
        const payload: PlannedOpenCodeTaskPayload = {
          schemaVariant: 'v2',
          session: s,
          messagesV2: msgs,
        };
        tasks.push({
          id: `v2:${s.id}`,
          src,
          entry: `${dbPath}#${s.id}`,
          estimatedBytes: Math.max(512, bytesBySess.get(s.id) ?? 512),
          payload,
        });
      }
    }

    if (tables.has('session') && tables.has('message') && tables.has('part')) {
      const sCols = new Set(
        (db.prepare(`PRAGMA table_info("session")`).all() as { name: string }[]).map((c) => c.name)
      );
      const mCols = new Set(
        (db.prepare(`PRAGMA table_info("message")`).all() as { name: string }[]).map((c) => c.name)
      );
      const pCols = new Set(
        (db.prepare(`PRAGMA table_info("part")`).all() as { name: string }[]).map((c) => c.name)
      );

      const whereDeleted = sCols.has('time_deleted') ? `WHERE time_deleted IS NULL` : '';
      const selectSessCols = [
        'id',
        'project_id',
        'parent_id',
        'directory',
        sCols.has('path') ? 'path' : 'NULL AS path',
        'title',
        sCols.has('title_source') ? 'title_source' : 'NULL AS title_source',
        'version',
        sCols.has('task_type') ? 'task_type' : 'NULL AS task_type',
        'time_created',
        'time_updated',
      ].join(', ');

      const v1Sessions = db
        .prepare(`SELECT ${selectSessCols} FROM session ${whereDeleted} ORDER BY time_updated DESC, time_created DESC`)
        .all() as unknown as RawSessionRow[];

      const activeSessSet = new Set<string>();
      for (const s of v1Sessions) {
        if (!seenSessionIds.has(s.id)) {
          activeSessSet.add(s.id);
        }
      }

      if (activeSessSet.size > 0) {
        // Single linear pass over `part` and `message` (avoids O(N_sessions * N_parts) repeated table scans!)
        const pOrder = pCols.has('sequence')
          ? 'COALESCE(sequence, time_created) ASC, time_created ASC, id ASC'
          : 'time_created ASC, id ASC';
        const partsByMsg = new Map<string, OpenCodeV1MessagePayload['parts']>();
        const bytesBySess = new Map<string, number>();

        const pSql = `SELECT id, message_id, session_id, time_created${pCols.has('sequence') ? ', sequence' : ''}, data FROM part ORDER BY ${pOrder}`;
        for (const pRow of db.prepare(pSql).iterate() as IterableIterator<{
          id: string;
          message_id: string;
          session_id: string;
          time_created: number | null;
          sequence?: number | null;
          data: string;
        }>) {
          if (!activeSessSet.has(pRow.session_id)) continue;
          let plist = partsByMsg.get(pRow.message_id);
          if (!plist) {
            plist = [];
            partsByMsg.set(pRow.message_id, plist);
          }
          const rawLen = typeof pRow.data === 'string' ? pRow.data.length : 64;
          bytesBySess.set(pRow.session_id, (bytesBySess.get(pRow.session_id) ?? 0) + rawLen);
          plist.push({
            id: pRow.id,
            time_created: pRow.time_created,
            sequence: pRow.sequence ?? null,
            data: safeJsonObj(pRow.data),
          });
        }

        const mOrder = mCols.has('sequence')
          ? 'COALESCE(sequence, time_created) ASC, time_created ASC, id ASC'
          : 'time_created ASC, id ASC';
        const msgsBySess = new Map<string, OpenCodeV1MessagePayload[]>();
        const mSql = `SELECT id, session_id, time_created, time_updated${mCols.has('sequence') ? ', sequence' : ''}, data FROM message ORDER BY ${mOrder}`;
        for (const mRow of db.prepare(mSql).iterate() as IterableIterator<{
          id: string;
          session_id: string;
          time_created: number | null;
          time_updated: number | null;
          sequence?: number | null;
          data: string;
        }>) {
          if (!activeSessSet.has(mRow.session_id)) continue;
          let mlist = msgsBySess.get(mRow.session_id);
          if (!mlist) {
            mlist = [];
            msgsBySess.set(mRow.session_id, mlist);
          }
          mlist.push({
            id: mRow.id,
            time_created: mRow.time_created,
            time_updated: mRow.time_updated,
            sequence: mRow.sequence ?? null,
            data: safeJsonObj(mRow.data),
            parts: partsByMsg.get(mRow.id) ?? [],
          });
        }

        for (const s of v1Sessions) {
          if (!activeSessSet.has(s.id)) continue;
          seenSessionIds.add(s.id);
          const extraTitle = options?.extraTitles?.get(s.id);
          const sessionCopy: RawSessionRow =
            extraTitle && (!s.title || s.title.trim().length === 0)
              ? { ...s, title: extraTitle }
              : s;
          const payload: PlannedOpenCodeTaskPayload = {
            schemaVariant: 'v1',
            session: sessionCopy,
            messagesV1: msgsBySess.get(s.id) ?? [],
          };
          tasks.push({
            id: `v1:${s.id}`,
            src,
            entry: `${dbPath}#${s.id}`,
            estimatedBytes: Math.max(512, bytesBySess.get(s.id) ?? 512),
            payload,
          });
        }
      }
    }

    return tasks;
  } finally {
    db.close();
  }
}

export async function parseOpenCodeFamilyTask(
  provider: ProviderId,
  rawFormat: string,
  task: ImportTask,
  ctx: ParseCtx
): Promise<SessionDocument<OpenCodeFamilyNativeSession>[]> {
  const payload = task.payload as PlannedOpenCodeTaskPayload | undefined;
  if (!payload) return [];

  const s = payload.session;
  const issues: IntegrityIssue[] = [];
  const spills: Record<string, { sha256: string; bytes: number; preview: string }> = {};
  const sourceFile = task.entry?.split('#')[0] ?? task.src.path;

  let defaultModel = s.model ?? null;
  if (payload.schemaVariant === 'v1') {
    for (const msg of payload.messagesV1 ?? []) {
      const m = extractModelId(msg.data);
      if (!defaultModel && m) defaultModel = m;
      for (const part of msg.parts) {
        if (ctx.recordUnrecognizedField) {
          partitionVendorFields(part.data, KNOWN_PART_KEYS, ctx);
        }
        if (part.data['type'] === 'tool') {
          const state = safeJsonObj(part.data['state']);
          await maybeSpillOutput(`${msg.id}:${part.id}:in`, state['input'], spills, ctx);
          const outVal = state['error'] ?? state['output'];
          await maybeSpillOutput(`${msg.id}:${part.id}`, outVal, spills, ctx);
        }
      }
    }
  } else {
    for (const msg of payload.messagesV2 ?? []) {
      const m = extractModelId(msg.data);
      if (!defaultModel && m) defaultModel = m;
      if (msg.type === 'assistant' && Array.isArray(msg.data['content'])) {
        const content = msg.data['content'] as unknown[];
        for (let idx = 0; idx < content.length; idx++) {
          const item = safeJsonObj(content[idx]);
          if (item['type'] === 'tool') {
            const state = safeJsonObj(item['state']);
            await maybeSpillOutput(`${msg.id}:c${idx}:in`, item['input'] ?? state['input'], spills, ctx);
            const outVal = item['error'] ?? item['output'] ?? state['error'] ?? state['output'];
            await maybeSpillOutput(`${msg.id}:c${idx}`, outVal, spills, ctx);
          }
        }
      }
    }
  }

  const nativeData: OpenCodeFamilyNativeSession = {
    schema_variant: payload.schemaVariant,
    session_id: s.id,
    source_file: sourceFile,
    title: s.title ?? null,
    title_source: s.title_source ?? null,
    cwd: s.path && s.path.trim().length > 0 ? s.path : s.directory ?? null,
    project_id: s.project_id ?? null,
    parent_session_id: s.parent_id ?? null,
    task_type: s.task_type ?? null,
    version: s.version ?? null,
    default_model: defaultModel,
    ...(payload.messagesV1 ? { v1_messages: payload.messagesV1 } : {}),
    ...(payload.messagesV2 ? { v2_messages: payload.messagesV2 } : {}),
    ...(Object.keys(spills).length > 0 ? { spills } : {}),
  };

  return [
    new OpenCodeFamilySessionDocument(
      provider,
      rawFormat,
      nativeData,
      normalizeTs(s.time_created),
      normalizeTs(s.time_updated),
      issues
    ),
  ];
}
