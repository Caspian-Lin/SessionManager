import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SPILL_THRESHOLD_BYTES,
  decompressZstd,
  isZstdBuffer,
  iterJsonLines,
  parseBase64DataUri,
  sha256Hex,
  type BlobAsset,
  type IntegrityIssue,
  type ItemStatus,
  type ProviderId,
  type SessionRole,
  type TurnKind,
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

export interface CodexRolloutRecord {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface CodexSqliteTurn {
  thread_id: string;
  turn_id: string;
  status?: string | null;
  started_at?: number | null;
  completed_at?: number | null;
  duration_ms?: number | null;
  first_user_item_id?: string | null;
  final_agent_item_id?: string | null;
  root_turn_id?: string | null;
}

export interface CodexSqliteItem {
  thread_id: string;
  turn_id?: string | null;
  item_id: string;
  rollout_ordinal?: number | null;
  created_at_ms?: number | null;
  item_json?: string | null;
  item_type?: string | null;
  updated_at_ordinal?: number | null;
  started_at_ms?: number | null;
  completed_at_ms?: number | null;
}

export interface CodexNativeSession {
  session_id: string;
  source_file: string;
  title?: string | null;
  cwd?: string | null;
  parent_session_id?: string | null;
  is_subagent?: boolean;
  subagent_name?: string | null;
  originator?: string | null;
  cli_version?: string | null;
  model_provider?: string | null;
  base_instructions_sha256?: string | null;
  records: CodexRolloutRecord[];
  sqlite_turns?: CodexSqliteTurn[];
  sqlite_items?: CodexSqliteItem[];
}

export interface SpillRefInfo {
  sha256: string;
  bytes: number;
  mime: string;
  preview: string;
}

function readBufferMaybeZstd(filePath: string): Buffer {
  const buf = fs.readFileSync(filePath);
  if (isZstdBuffer(buf)) {
    return decompressZstd(buf);
  }
  return buf;
}

function parseTimestampMs(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return val < 10_000_000_000 ? Math.round(val * 1000) : Math.round(val);
  }
  if (typeof val === 'string') {
    const parsed = Date.parse(val);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function mapCodexStatus(rawStatus: unknown): ItemStatus | null {
  if (typeof rawStatus !== 'string') return null;
  const s = rawStatus.toLowerCase();
  if (s === 'completed' || s === 'ok' || s === 'success') return 'ok';
  if (s === 'failed' || s === 'error') return 'error';
  if (s === 'interrupted' || s === 'declined' || s === 'cancelled' || s === 'canceled') return 'interrupted';
  if (s === 'inprogress' || s === 'in_progress' || s === 'pending' || s === 'running') return 'pending';
  return null;
}

function safeJsonParse(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw_text: raw };
  }
}

function makePreview(text: string, sha256: string, bytes: number, maxChars = 2048): string {
  const head = text.slice(0, maxChars);
  return `${head}\n... [spilled ${bytes} bytes -> blob:${sha256}]`;
}

function extractTextFromParts(val: unknown): string[] {
  if (typeof val === 'string') return val.length > 0 ? [val] : [];
  if (!Array.isArray(val)) return [];
  const out: string[] = [];
  for (const part of val) {
    if (typeof part === 'string') {
      if (part.length > 0) out.push(part);
    } else if (part && typeof part === 'object') {
      const pObj = part as Record<string, unknown>;
      if (typeof pObj['text'] === 'string' && pObj['text'].length > 0) {
        out.push(pObj['text']);
      } else if (typeof pObj['summary'] === 'string' && pObj['summary'].length > 0) {
        out.push(pObj['summary']);
      }
    }
  }
  return out;
}

function findDataUrisInValue(val: unknown, out: string[] = []): string[] {
  if (typeof val === 'string') {
    if (val.trimStart().startsWith('data:image/') && val.includes(';base64,')) {
      out.push(val.trim());
    }
    return out;
  }
  if (Array.isArray(val)) {
    for (const item of val) findDataUrisInValue(item, out);
    return out;
  }
  if (val && typeof val === 'object') {
    for (const v of Object.values(val as Record<string, unknown>)) {
      findDataUrisInValue(v, out);
    }
  }
  return out;
}

const KNOWN_META_KEYS = [
  'session_id',
  'id',
  'cwd',
  'parent_thread_id',
  'parent_session_id',
  'source',
  'agent_role',
  'agent_nickname',
  'originator',
  'cli_version',
  'model_provider',
  'base_instructions',
  'history_mode',
  'timestamp',
] as const;

function inferCodexSqliteCwd(items: readonly CodexSqliteItem[] | undefined): string | null {
  if (!items || items.length === 0) return null;
  for (const item of items) {
    if (!item.item_json) continue;
    const data = safeJsonParse(item.item_json);
    if (typeof data['cwd'] === 'string' && data['cwd'].trim().length > 0) {
      return data['cwd'].trim();
    }
  }
  return null;
}

export class CodexSessionDocument extends BaseSessionDocument<CodexNativeSession> {
  private readonly spillByContentHash: ReadonlyMap<string, SpillRefInfo>;

  constructor(
    nativeData: CodexNativeSession,
    createdAt: number | null,
    updatedAt: number | null,
    parseIssues: IntegrityIssue[] = [],
    blobs: BlobAsset[] = [],
    spillByContentHash: ReadonlyMap<string, SpillRefInfo> = new Map()
  ) {
    const title = typeof nativeData.title === 'string' && nativeData.title.trim().length > 0
      ? nativeData.title.trim()
      : null;
    const effectiveCwd = nativeData.cwd ?? inferCodexSqliteCwd(nativeData.sqlite_items);

    super({
      provider: 'codex-local',
      rawFormat: 'codex-rollout/v1',
      nativeData,
      external_id: nativeData.session_id,
      parent_external_id: nativeData.parent_session_id ?? null,
      is_subagent: Boolean(nativeData.is_subagent || nativeData.parent_session_id),
      subagent_name: nativeData.subagent_name ?? null,
      title,
      title_source: title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      default_model: nativeData.model_provider ?? null,
      cwd: effectiveCwd,
      blobs,
      parseIssues,
    });
    this.spillByContentHash = spillByContentHash;
  }

  private lookupSpill(rawText: string): SpillRefInfo | undefined {
    if (!rawText) return undefined;
    return this.spillByContentHash.get(sha256Hex(rawText));
  }

  private buildTextOrSpill(
    rawText: string
  ): { text: string; blob_sha256: string | null; payload_ref: string | null } {
    const spilled = this.lookupSpill(rawText);
    if (spilled) {
      return {
        text: spilled.preview,
        blob_sha256: spilled.sha256,
        payload_ref: spilled.sha256,
      };
    }
    return { text: rawText, blob_sha256: null, payload_ref: null };
  }

  private buildToolInputOrSpill(
    rawJson: string
  ): { tool_input: string | null; blob_sha256: string | null; payload_ref: string | null; spilledBytes?: number } {
    const spilled = this.lookupSpill(rawJson);
    if (spilled) {
      return {
        tool_input: null,
        blob_sha256: spilled.sha256,
        payload_ref: spilled.sha256,
        spilledBytes: spilled.bytes,
      };
    }
    return { tool_input: rawJson, blob_sha256: null, payload_ref: null };
  }

  protected projectTurns(): RawTurnProjection[] {
    const sqliteItems = this.nativeData.sqlite_items ?? [];
    const sqliteTurns = this.nativeData.sqlite_turns ?? [];
    const records = this.nativeData.records ?? [];

    if (sqliteItems.length > 0) {
      return this.projectAlignedSqliteAndRollout(sqliteTurns, sqliteItems, records);
    }

    return this.projectRolloutOnly(records);
  }

  private projectAlignedSqliteAndRollout(
    sqliteTurns: CodexSqliteTurn[],
    sqliteItems: CodexSqliteItem[],
    records: CodexRolloutRecord[]
  ): RawTurnProjection[] {
    const turnById = new Map<string, CodexSqliteTurn>();
    for (const t of sqliteTurns) {
      turnById.set(t.turn_id, t);
    }

    const sortedItems = [...sqliteItems].sort((a, b) => {
      const oa = a.rollout_ordinal ?? Number.MAX_SAFE_INTEGER;
      const ob = b.rollout_ordinal ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      const ca = a.created_at_ms ?? a.started_at_ms ?? 0;
      const cb = b.created_at_ms ?? b.started_at_ms ?? 0;
      return ca - cb;
    });

    const turns: RawTurnProjection[] = [];
    let ordinal = 0;
    let prevItemId: string | null = null;
    let lastTurnId: string | null = null;
    let maxCoveredRolloutOrdinal = -1;
    const createdAt = this.init.created_at ?? null;

    for (const item of sortedItems) {
      if (typeof item.rollout_ordinal === 'number' && item.rollout_ordinal > maxCoveredRolloutOrdinal) {
        maxCoveredRolloutOrdinal = item.rollout_ordinal;
      }

      // Emit synthetic turn_context boundary when entering a new SQLite turn
      if (item.turn_id && item.turn_id !== lastTurnId) {
        lastTurnId = item.turn_id;
        const turnMeta = turnById.get(item.turn_id);
        const tcId = `tc-${item.turn_id}`;
        const tcTs = turnMeta?.started_at ?? item.created_at_ms ?? createdAt;
        turns.push({
          external_id: tcId,
          parent_external_id: prevItemId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'turn_context',
          created_at: tcTs,
          text: `Turn context: ${item.turn_id}`,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          status: mapCodexStatus(turnMeta?.status),
          blocks: [
            {
              idx: 0,
              type: 'text',
              text: `turn_id=${item.turn_id}${turnMeta?.status ? ` status=${turnMeta.status}` : ''}`,
              meta: turnMeta ? { ...turnMeta } : { turn_id: item.turn_id },
            },
          ],
        });
        prevItemId = tcId;
      }

      const turnMeta = item.turn_id ? turnById.get(item.turn_id) : undefined;
      const projected = this.projectSqliteItem(item, turnMeta, ordinal, prevItemId);
      ordinal++;
      prevItemId = projected.external_id;
      turns.push(projected);
    }

    // Append any trailing rollout records beyond maxCoveredRolloutOrdinal (e.g. unprojected tail)
    const trailingRecords = records.filter(
      (r) => r.type === 'response_item' && typeof r.ordinal === 'number' && r.ordinal > maxCoveredRolloutOrdinal
    );
    for (const rec of trailingRecords) {
      const projected = this.projectRolloutRecord(rec, ordinal, prevItemId);
      if (projected) {
        ordinal++;
        prevItemId = projected.external_id;
        turns.push(projected);
      }
    }

    return turns;
  }

  private projectSqliteItem(
    item: CodexSqliteItem,
    turnMeta: CodexSqliteTurn | undefined,
    ordinal: number,
    parentExternalId: string | null
  ): RawTurnProjection {
    const itemType = item.item_type ?? 'agentMessage';
    const data = safeJsonParse(item.item_json);
    const ts = item.created_at_ms ?? item.started_at_ms ?? this.init.created_at ?? null;
    const itemStatus = mapCodexStatus(data['status'] ?? turnMeta?.status);
    const blocks: ViewBlock[] = [];
    let bIdx = 0;
    let role: SessionRole = 'assistant';
    let kind: TurnKind = 'message';
    let isSynthetic = false;
    let payloadRef: string | null = null;

    if (itemType === 'userMessage') {
      role = 'user';
      kind = 'message';
      const texts = [
        ...extractTextFromParts(data['content']),
        ...(typeof data['text'] === 'string' ? [data['text']] : []),
        ...(typeof data['message'] === 'string' ? [data['message']] : []),
      ];
      const combined = texts.join('\n');
      if (combined.length > 0) {
        const res = this.buildTextOrSpill(combined);
        if (res.payload_ref) payloadRef = res.payload_ref;
        blocks.push({
          idx: bIdx++,
          type: 'text',
          text: res.text,
          blob_sha256: res.blob_sha256,
        });
      }
      for (const uri of findDataUrisInValue(data)) {
        const imgSpill = this.lookupSpill(uri);
        if (imgSpill) {
          payloadRef = payloadRef ?? imgSpill.sha256;
          blocks.push({
            idx: bIdx++,
            type: 'image',
            text: null,
            blob_sha256: imgSpill.sha256,
            availability: 'full',
            meta: { mime: imgSpill.mime, bytes: imgSpill.bytes },
          });
        }
      }
    } else if (itemType === 'agentMessage') {
      role = 'assistant';
      kind = 'message';
      const texts = [
        ...extractTextFromParts(data['content']),
        ...(typeof data['text'] === 'string' ? [data['text']] : []),
        ...(typeof data['message'] === 'string' ? [data['message']] : []),
      ];
      const combined = texts.join('\n');
      const res = this.buildTextOrSpill(combined);
      if (res.payload_ref) payloadRef = res.payload_ref;
      blocks.push({
        idx: bIdx++,
        type: 'text',
        text: res.text,
        blob_sha256: res.blob_sha256,
      });
    } else if (itemType === 'reasoning') {
      role = 'assistant';
      kind = 'reasoning';
      const parts = [
        ...extractTextFromParts(data['summary']),
        ...extractTextFromParts(data['content']),
        ...(typeof data['text'] === 'string' ? [data['text']] : []),
      ];
      const combined = parts.join('\n');
      const res = this.buildTextOrSpill(combined);
      if (res.payload_ref) payloadRef = res.payload_ref;
      blocks.push({
        idx: bIdx++,
        type: 'thinking',
        text: res.text,
        blob_sha256: res.blob_sha256,
      });
    } else if (itemType === 'commandExecution') {
      role = 'assistant';
      kind = 'tool_call';
      const inputObj: Record<string, unknown> = {
        command: data['command'] ?? data['cmd'] ?? null,
        cwd: data['cwd'] ?? null,
      };
      if (data['commandActions'] !== undefined) inputObj['commandActions'] = data['commandActions'];
      const inputJson = JSON.stringify(inputObj);
      const inputRes = this.buildToolInputOrSpill(inputJson);
      if (inputRes.payload_ref) payloadRef = inputRes.payload_ref;

      blocks.push({
        idx: bIdx++,
        type: 'tool_use',
        tool_name: 'commandExecution',
        tool_call_id: item.item_id,
        tool_input: inputRes.tool_input,
        blob_sha256: inputRes.blob_sha256,
        status: itemStatus,
        meta: {
          command: data['command'] ?? data['cmd'] ?? null,
          exitCode: data['exitCode'] ?? null,
          durationMs: data['durationMs'] ?? null,
          ...(inputRes.spilledBytes ? { spilled_bytes: inputRes.spilledBytes } : {}),
        },
      });

      const rawOutput =
        typeof data['aggregatedOutput'] === 'string'
          ? data['aggregatedOutput']
          : typeof data['output'] === 'string'
            ? data['output']
            : typeof data['stdout'] === 'string' || typeof data['stderr'] === 'string'
              ? [data['stdout'], data['stderr']].filter((v): v is string => typeof v === 'string' && v.length > 0).join('\n')
              : null;

      if (rawOutput !== null && rawOutput.length > 0) {
        const outRes = this.buildTextOrSpill(rawOutput);
        if (outRes.payload_ref) payloadRef = payloadRef ?? outRes.payload_ref;
        blocks.push({
          idx: bIdx++,
          type: 'tool_result',
          tool_name: 'commandExecution',
          tool_call_id: item.item_id,
          text: outRes.text,
          blob_sha256: outRes.blob_sha256,
          status: itemStatus,
        });
      }
    } else if (itemType === 'mcpToolCall') {
      role = 'assistant';
      kind = 'tool_call';
      const server = typeof data['server'] === 'string' ? data['server'] : null;
      const tool =
        typeof data['tool'] === 'string'
          ? data['tool']
          : typeof data['name'] === 'string'
            ? data['name']
            : typeof data['toolName'] === 'string'
              ? data['toolName']
              : null;
      const toolName = server && tool ? `${server}.${tool}` : tool ?? server ?? 'mcpToolCall';
      const rawArgs = data['arguments'] ?? data['input'] ?? {};
      const argsJson = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
      const argsRes = this.buildToolInputOrSpill(argsJson);
      if (argsRes.payload_ref) payloadRef = argsRes.payload_ref;

      blocks.push({
        idx: bIdx++,
        type: 'tool_use',
        tool_name: toolName,
        tool_call_id: item.item_id,
        tool_input: argsRes.tool_input,
        blob_sha256: argsRes.blob_sha256,
        status: itemStatus,
      });

      const resultVal = data['result'] ?? data['output'] ?? data['error'];
      if (resultVal !== undefined && resultVal !== null) {
        const resultStr = typeof resultVal === 'string' ? resultVal : JSON.stringify(resultVal);
        const resOut = this.buildTextOrSpill(resultStr);
        if (resOut.payload_ref) payloadRef = payloadRef ?? resOut.payload_ref;
        blocks.push({
          idx: bIdx++,
          type: 'tool_result',
          tool_name: toolName,
          tool_call_id: item.item_id,
          text: resOut.text,
          blob_sha256: resOut.blob_sha256,
          status: data['error'] ? 'error' : itemStatus,
        });
      }
    } else if (itemType === 'fileChange') {
      role = 'assistant';
      kind = 'file_change';
      const changes = Array.isArray(data['changes']) ? (data['changes'] as Record<string, unknown>[]) : [];
      const diffPieces: string[] = [];
      const files: string[] = [];
      for (const ch of changes) {
        if (!ch || typeof ch !== 'object') continue;
        const fPath = typeof ch['path'] === 'string' ? ch['path'] : typeof ch['filePath'] === 'string' ? ch['filePath'] : '';
        if (fPath) files.push(fPath);
        const diff = typeof ch['diff'] === 'string' ? ch['diff'] : typeof ch['patch'] === 'string' ? ch['patch'] : '';
        diffPieces.push(fPath ? `--- ${fPath}\n${diff}` : diff);
      }
      if (diffPieces.length === 0) {
        if (typeof data['path'] === 'string') files.push(data['path']);
        if (typeof data['diff'] === 'string') diffPieces.push(data['diff']);
        else if (typeof data['patch'] === 'string') diffPieces.push(data['patch']);
      }
      const rawDiff = diffPieces.filter(Boolean).join('\n') || JSON.stringify(data);
      const diffRes = this.buildTextOrSpill(rawDiff);
      if (diffRes.payload_ref) payloadRef = diffRes.payload_ref;

      blocks.push({
        idx: bIdx++,
        type: 'code',
        lang: 'diff',
        text: diffRes.text,
        blob_sha256: diffRes.blob_sha256,
        status: itemStatus,
        meta: { files, status: data['status'] ?? null },
      });
    } else if (itemType === 'webSearch') {
      role = 'assistant';
      kind = 'web_search';
      const query = typeof data['query'] === 'string' ? data['query'] : null;
      const inputJson = JSON.stringify({ query, action: data['action'] ?? null });
      const inputRes = this.buildToolInputOrSpill(inputJson);
      if (inputRes.payload_ref) payloadRef = inputRes.payload_ref;

      blocks.push({
        idx: bIdx++,
        type: 'tool_use',
        tool_name: 'webSearch',
        tool_call_id: item.item_id,
        tool_input: inputRes.tool_input,
        blob_sha256: inputRes.blob_sha256,
        status: itemStatus,
      });

      const results = Array.isArray(data['results'])
        ? data['results']
        : Array.isArray(data['citations'])
          ? data['citations']
          : null;
      if (results && results.length > 0) {
        const resStr = JSON.stringify(results);
        const resOut = this.buildTextOrSpill(resStr);
        if (resOut.payload_ref) payloadRef = payloadRef ?? resOut.payload_ref;
        blocks.push({
          idx: bIdx++,
          type: 'citation',
          text: resOut.text,
          blob_sha256: resOut.blob_sha256,
        });
      }
    } else if (itemType === 'imageGeneration' || itemType === 'imageView') {
      role = 'assistant';
      kind = 'image';
      const prompt = typeof data['prompt'] === 'string' ? data['prompt'] : null;
      const revisedPrompt = typeof data['revised_prompt'] === 'string' ? data['revised_prompt'] : null;
      const dataUris = findDataUrisInValue(data);

      if (dataUris.length > 0) {
        for (const uri of dataUris) {
          const spilled = this.lookupSpill(uri);
          if (spilled) {
            payloadRef = payloadRef ?? spilled.sha256;
            blocks.push({
              idx: bIdx++,
              type: 'image',
              text: prompt,
              blob_sha256: spilled.sha256,
              availability: 'full',
              status: itemStatus,
              meta: {
                mime: spilled.mime,
                bytes: spilled.bytes,
                prompt,
                revised_prompt: revisedPrompt,
              },
            });
          }
        }
      }

      if (blocks.length === 0) {
        const imgUrl =
          typeof data['image_url'] === 'string'
            ? data['image_url']
            : typeof data['url'] === 'string'
              ? data['url']
              : typeof data['path'] === 'string'
                ? data['path']
                : null;
        blocks.push({
          idx: bIdx++,
          type: 'image',
          text: prompt ?? imgUrl,
          availability: 'missing_ref',
          status: itemStatus,
          meta: { url: imgUrl, prompt, revised_prompt: revisedPrompt },
        });
      }
    } else if (itemType === 'contextCompaction') {
      role = 'system';
      kind = 'compaction';
      isSynthetic = true;
      const txt = typeof data['summary'] === 'string' ? data['summary'] : JSON.stringify(data);
      const res = this.buildTextOrSpill(txt);
      if (res.payload_ref) payloadRef = res.payload_ref;
      blocks.push({ idx: bIdx++, type: 'text', text: res.text, blob_sha256: res.blob_sha256 });
    } else if (itemType === 'sleep') {
      role = 'system';
      kind = 'notice';
      isSynthetic = true;
      blocks.push({ idx: bIdx++, type: 'text', text: JSON.stringify(data) });
    } else {
      // subAgentActivity, collabAgentToolCall, or unknown future item_type
      role = 'assistant';
      kind = itemType.includes('Tool') || itemType.includes('Agent') ? 'tool_call' : 'notice';
      isSynthetic = itemType === 'subAgentActivity';
      const jsonStr = JSON.stringify(data);
      const res = this.buildTextOrSpill(jsonStr);
      if (res.payload_ref) payloadRef = res.payload_ref;
      blocks.push({
        idx: bIdx++,
        type: 'text',
        text: res.text,
        blob_sha256: res.blob_sha256,
        meta: { item_type: itemType },
      });
    }

    const projectedText = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');

    return {
      external_id: item.item_id,
      parent_external_id: parentExternalId,
      ordinal,
      role,
      kind,
      created_at: ts,
      text: projectedText,
      is_active_branch: true,
      is_hidden: false,
      is_synthetic: isSynthetic,
      status: itemStatus,
      payload_ref: payloadRef,
      blocks,
    };
  }

  private projectRolloutOnly(records: CodexRolloutRecord[]): RawTurnProjection[] {
    const turns: RawTurnProjection[] = [];
    let ordinal = 0;
    let prevItemId: string | null = null;

    for (const record of records) {
      const projected = this.projectRolloutRecord(record, ordinal, prevItemId);
      if (projected) {
        ordinal++;
        prevItemId = projected.external_id;
        turns.push(projected);
      }
    }

    return turns;
  }

  private projectRolloutRecord(
    record: CodexRolloutRecord,
    ordinal: number,
    prevItemId: string | null
  ): RawTurnProjection | null {
    const recordType = typeof record.type === 'string' ? record.type : '';
    const ts = parseTimestampMs(record.timestamp) ?? this.init.created_at ?? null;
    const payload = (record.payload ?? {}) as Record<string, unknown>;

    if (recordType === 'turn_context') {
      const turnId = typeof payload['turn_id'] === 'string' ? payload['turn_id'] : `turn-${ordinal}`;
      const itemId = `tc-${turnId}-${ordinal}`;
      return {
        external_id: itemId,
        parent_external_id: prevItemId,
        ordinal,
        role: 'system',
        kind: 'turn_context',
        created_at: ts,
        text: `Turn context: ${turnId}`,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: true,
        blocks: [
          {
            idx: 0,
            type: 'text',
            text: `turn_id=${turnId}`,
            meta: payload,
          },
        ],
      };
    }

    if (recordType === 'response_item') {
      const pType = typeof payload['type'] === 'string' ? payload['type'] : 'message';
      const itemId =
        typeof payload['id'] === 'string'
          ? payload['id']
          : typeof payload['call_id'] === 'string'
            ? `${pType}-${payload['call_id']}-${ordinal}`
            : `item-${this.nativeData.session_id}-${ordinal}`;

      if (pType === 'reasoning') {
        const parts = [...extractTextFromParts(payload['summary']), ...extractTextFromParts(payload['content'])];
        const rawText = parts.join('\n');
        const res = this.buildTextOrSpill(rawText);
        return {
          external_id: itemId,
          parent_external_id: prevItemId,
          ordinal,
          role: 'assistant',
          kind: 'reasoning',
          created_at: ts,
          text: res.text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          payload_ref: res.payload_ref,
          blocks: [{ idx: 0, type: 'thinking', text: res.text, blob_sha256: res.blob_sha256 }],
        };
      }

      if (pType === 'function_call' || pType === 'custom_tool_call' || pType === 'local_shell_call') {
        const toolName =
          typeof payload['name'] === 'string'
            ? payload['name']
            : pType === 'local_shell_call'
              ? 'commandExecution'
              : pType;
        const argsRaw =
          typeof payload['arguments'] === 'string'
            ? payload['arguments']
            : JSON.stringify(payload['arguments'] ?? payload['action'] ?? {});
        const argsRes = this.buildToolInputOrSpill(argsRaw);
        return {
          external_id: itemId,
          parent_external_id: prevItemId,
          ordinal,
          role: 'assistant',
          kind: 'tool_call',
          created_at: ts,
          text: argsRes.tool_input ?? `[spilled:${argsRes.blob_sha256}]`,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          payload_ref: argsRes.payload_ref,
          blocks: [
            {
              idx: 0,
              type: 'tool_use',
              tool_name: toolName,
              tool_call_id: typeof payload['call_id'] === 'string' ? payload['call_id'] : itemId,
              tool_input: argsRes.tool_input,
              blob_sha256: argsRes.blob_sha256,
            },
          ],
        };
      }

      if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
        const outputRaw =
          typeof payload['output'] === 'string' ? payload['output'] : JSON.stringify(payload['output'] ?? '');
        const res = this.buildTextOrSpill(outputRaw);
        return {
          external_id: itemId,
          parent_external_id: prevItemId,
          ordinal,
          role: 'tool',
          kind: 'tool_result',
          created_at: ts,
          text: res.text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          payload_ref: res.payload_ref,
          blocks: [
            {
              idx: 0,
              type: 'tool_result',
              tool_call_id: typeof payload['call_id'] === 'string' ? payload['call_id'] : null,
              text: res.text,
              blob_sha256: res.blob_sha256,
            },
          ],
        };
      }

      // Default response_item message
      const rawRole = typeof payload['role'] === 'string' ? payload['role'].toLowerCase() : 'assistant';
      const role: SessionRole =
        rawRole === 'user' ? 'user' : rawRole === 'developer' ? 'developer' : rawRole === 'system' ? 'system' : 'assistant';

      const contentArr = Array.isArray(payload['content']) ? payload['content'] : [];
      const blocks: ViewBlock[] = [];
      let bIdx = 0;
      let payloadRef: string | null = null;

      for (const c of contentArr) {
        if (!c || typeof c !== 'object') continue;
        const cObj = c as Record<string, unknown>;
        const imageUri =
          typeof cObj['image_url'] === 'string'
            ? cObj['image_url']
            : typeof cObj['url'] === 'string'
              ? cObj['url']
              : null;
        if (imageUri && imageUri.startsWith('data:image/') && imageUri.includes(';base64,')) {
          const imgSpill = this.lookupSpill(imageUri);
          if (imgSpill) {
            payloadRef = payloadRef ?? imgSpill.sha256;
            blocks.push({
              idx: bIdx++,
              type: 'image',
              text: null,
              blob_sha256: imgSpill.sha256,
              availability: 'full',
              meta: { mime: imgSpill.mime, bytes: imgSpill.bytes },
            });
            continue;
          }
        }

        const text = typeof cObj['text'] === 'string' ? cObj['text'] : '';
        const res = this.buildTextOrSpill(text);
        if (res.payload_ref) payloadRef = payloadRef ?? res.payload_ref;
        blocks.push({
          idx: bIdx++,
          type: 'text',
          text: res.text,
          blob_sha256: res.blob_sha256,
        });
      }

      const projectedText = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');

      return {
        external_id: itemId,
        parent_external_id: prevItemId,
        ordinal,
        role,
        kind: 'message',
        created_at: ts,
        text: projectedText,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        payload_ref: payloadRef,
        blocks,
      };
    }

    return null;
  }
}

interface ParsedRolloutFile {
  sessionId: string;
  filePath: string;
  isArchived: boolean;
  cwd: string | null;
  parentSessionId: string | null;
  isSubagent: boolean;
  subagentName: string | null;
  originator: string | null;
  cliVersion: string | null;
  modelProvider: string | null;
  baseInstructionsSha: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  records: CodexRolloutRecord[];
  parseIssues: IntegrityIssue[];
}

function loadSessionIndex(codexRootDir: string | null): Map<string, string> {
  const titles = new Map<string, string>();
  if (!codexRootDir) return titles;

  const indexPath = path.join(codexRootDir, 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return titles;

  try {
    const buf = fs.readFileSync(indexPath);
    for (const line of iterJsonLines(buf)) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const id = typeof entry['id'] === 'string' ? entry['id'] : null;
        const threadName = typeof entry['thread_name'] === 'string' ? entry['thread_name'].trim() : null;
        if (id && threadName) {
          titles.set(id, threadName);
        }
      } catch {
        // skip malformed index lines
      }
    }
  } catch {
    // ignore read errors
  }

  return titles;
}

function findCodexRootDir(startPath: string): string | null {
  let cur = path.dirname(path.resolve(startPath));
  for (let i = 0; i < 5; i++) {
    if (
      fs.existsSync(path.join(cur, 'session_index.jsonl')) ||
      fs.readdirSync(cur).some((f) => /^thread_history_\d+\.sqlite$/i.test(f))
    ) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function getTableColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name?: string }[];
  return new Set(rows.map((r) => String(r.name ?? '')));
}

function loadSqliteHistory(
  sqlitePaths: readonly string[],
  ctx?: ParseCtx
): Map<string, { turns: CodexSqliteTurn[]; items: CodexSqliteItem[] }> {
  const byThread = new Map<string, { turns: CodexSqliteTurn[]; items: CodexSqliteItem[] }>();
  const ensureThread = (threadId: string) => {
    let entry = byThread.get(threadId);
    if (!entry) {
      entry = { turns: [], items: [] };
      byThread.set(threadId, entry);
    }
    return entry;
  };

  for (const sqlitePath of sqlitePaths) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(sqlitePath, {
        readOnly: true,
        enableForeignKeyConstraints: false,
      });

      const tables = new Set(
        (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name?: string }[]).map((r) =>
          String(r.name ?? '')
        )
      );

      if (tables.has('thread_turns')) {
        const cols = getTableColumns(db, 'thread_turns');
        const selectCols = [
          'thread_id',
          'turn_id',
          cols.has('status') ? 'status' : 'NULL AS status',
          cols.has('started_at') ? 'started_at' : 'NULL AS started_at',
          cols.has('completed_at') ? 'completed_at' : 'NULL AS completed_at',
          cols.has('duration_ms') ? 'duration_ms' : 'NULL AS duration_ms',
          cols.has('first_user_item_id') ? 'first_user_item_id' : 'NULL AS first_user_item_id',
          cols.has('final_agent_item_id') ? 'final_agent_item_id' : 'NULL AS final_agent_item_id',
          cols.has('root_turn_id') ? 'root_turn_id' : 'NULL AS root_turn_id',
        ];
        const orderCol = cols.has('started_at') ? 'started_at ASC, rowid ASC' : 'rowid ASC';
        const turnRows = db
          .prepare(`SELECT ${selectCols.join(', ')} FROM thread_turns ORDER BY ${orderCol}`)
          .all() as unknown as CodexSqliteTurn[];

        const seenTurnIds = new Set<string>();
        for (const t of turnRows) {
          if (!t.thread_id || !t.turn_id) continue;
          const key = `${t.thread_id}:${t.turn_id}`;
          if (seenTurnIds.has(key)) continue;
          seenTurnIds.add(key);
          ensureThread(t.thread_id).turns.push(t);
        }
      }

      if (tables.has('thread_items')) {
        const cols = getTableColumns(db, 'thread_items');
        const selectCols = [
          'thread_id',
          cols.has('turn_id') ? 'turn_id' : 'NULL AS turn_id',
          'item_id',
          cols.has('rollout_ordinal') ? 'rollout_ordinal' : 'NULL AS rollout_ordinal',
          cols.has('created_at_ms') ? 'created_at_ms' : 'NULL AS created_at_ms',
          cols.has('item_json') ? 'item_json' : 'NULL AS item_json',
          cols.has('item_type') ? 'item_type' : 'NULL AS item_type',
          cols.has('updated_at_ordinal') ? 'updated_at_ordinal' : 'NULL AS updated_at_ordinal',
          cols.has('started_at_ms') ? 'started_at_ms' : 'NULL AS started_at_ms',
          cols.has('completed_at_ms') ? 'completed_at_ms' : 'NULL AS completed_at_ms',
        ];
        const orderParts: string[] = [];
        if (cols.has('rollout_ordinal')) orderParts.push('rollout_ordinal ASC');
        if (cols.has('created_at_ms')) orderParts.push('created_at_ms ASC');
        orderParts.push('rowid ASC');
        const itemRows = db
          .prepare(`SELECT ${selectCols.join(', ')} FROM thread_items ORDER BY ${orderParts.join(', ')}`)
          .all() as unknown as CodexSqliteItem[];

        const seenItemIds = new Set<string>();
        for (const it of itemRows) {
          if (!it.thread_id || !it.item_id) continue;
          const key = `${it.thread_id}:${it.item_id}`;
          if (seenItemIds.has(key)) continue;
          seenItemIds.add(key);
          ensureThread(it.thread_id).items.push(it);
        }
      }
    } catch (err) {
      ctx?.log('warn', `Failed reading Codex SQLite ${sqlitePath}: ${(err as Error).message}`);
    } finally {
      db?.close();
    }
  }

  return byThread;
}

function parseRolloutFile(filePath: string, isArchived: boolean, ctx?: ParseCtx): ParsedRolloutFile | null {
  let buf: Buffer;
  try {
    buf = readBufferMaybeZstd(filePath);
  } catch (err) {
    ctx?.log('error', `Failed reading Codex rollout ${filePath}: ${(err as Error).message}`);
    return null;
  }

  let sessionId: string | null = null;
  let cwd: string | null = null;
  let parentSessionId: string | null = null;
  let isSubagent = false;
  let subagentName: string | null = null;
  let originator: string | null = null;
  let cliVersion: string | null = null;
  let modelProvider: string | null = null;
  let baseInstructionsSha: string | null = null;
  let createdAt: number | null = null;
  let updatedAt: number | null = null;

  const records: CodexRolloutRecord[] = [];
  const parseIssues: IntegrityIssue[] = [];

  for (const line of iterJsonLines(buf)) {
    let record: CodexRolloutRecord;
    try {
      record = JSON.parse(line) as CodexRolloutRecord;
    } catch {
      parseIssues.push({
        code: 'truncated_stream',
        severity: 'warn',
        message: `Malformed or truncated JSONL line skipped in ${path.basename(filePath)}`,
      });
      continue;
    }

    const recordType = typeof record.type === 'string' ? record.type : '';
    const ts = parseTimestampMs(record.timestamp);
    if (ts !== null) {
      if (createdAt === null) createdAt = ts;
      updatedAt = ts;
    }

    const payload = (record.payload ?? {}) as Record<string, unknown>;
    if (recordType === 'session_meta') {
      sessionId =
        typeof payload['session_id'] === 'string'
          ? payload['session_id']
          : typeof payload['id'] === 'string'
            ? payload['id']
            : sessionId;
      cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : cwd;
      const srcVal = payload['source'];
      const srcObj =
        srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal)
          ? (srcVal as Record<string, unknown>)
          : null;
      const srcSubagent =
        srcObj?.['subagent'] && typeof srcObj['subagent'] === 'object'
          ? (srcObj['subagent'] as Record<string, unknown>)
          : null;
      const threadSpawn =
        srcSubagent?.['thread_spawn'] && typeof srcSubagent['thread_spawn'] === 'object'
          ? (srcSubagent['thread_spawn'] as Record<string, unknown>)
          : null;

      const metaParent =
        (typeof payload['parent_thread_id'] === 'string' && payload['parent_thread_id']) ||
        (typeof payload['parent_session_id'] === 'string' && payload['parent_session_id']) ||
        (typeof threadSpawn?.['parent_thread_id'] === 'string' &&
          (threadSpawn['parent_thread_id'] as string)) ||
        null;
      if (metaParent) parentSessionId = metaParent;

      const metaRole =
        (typeof payload['agent_nickname'] === 'string' && payload['agent_nickname']) ||
        (typeof payload['agent_role'] === 'string' && payload['agent_role']) ||
        (typeof threadSpawn?.['agent_role'] === 'string' &&
          (threadSpawn['agent_role'] as string)) ||
        null;
      if (metaRole) subagentName = metaRole;

      if (metaParent || srcVal === 'subagent' || Boolean(srcSubagent) || Boolean(metaRole)) {
        isSubagent = true;
      }

      originator = typeof payload['originator'] === 'string' ? payload['originator'] : originator;
      cliVersion = typeof payload['cli_version'] === 'string' ? payload['cli_version'] : cliVersion;
      modelProvider = typeof payload['model_provider'] === 'string' ? payload['model_provider'] : modelProvider;

      if (typeof payload['base_instructions'] === 'string') {
        baseInstructionsSha = sha256Hex(payload['base_instructions']);
        payload['base_instructions_sha256'] = baseInstructionsSha;
        delete payload['base_instructions'];
      }
      partitionVendorFields(payload, KNOWN_META_KEYS, ctx);
    }

    records.push(record);
  }

  if (!sessionId && records.length === 0) {
    return null;
  }

  const fallbackId = path.basename(filePath).replace(/\.jsonl(?:\.zst)?$/i, '');
  return {
    sessionId: sessionId ?? fallbackId,
    filePath,
    isArchived,
    cwd,
    parentSessionId,
    isSubagent,
    subagentName,
    originator,
    cliVersion,
    modelProvider,
    baseInstructionsSha,
    createdAt,
    updatedAt,
    records,
    parseIssues,
  };
}

async function prepareSpillsAndBlobs(
  session: CodexNativeSession,
  createdAt: number | null,
  ctx: ParseCtx
): Promise<{ blobs: BlobAsset[]; spillByContentHash: Map<string, SpillRefInfo> }> {
  const blobsBySha = new Map<string, BlobAsset>();
  const spillByContentHash = new Map<string, SpillRefInfo>();
  const ts = createdAt ?? Date.now();

  const registerStringSpill = async (rawStr: string, mime = 'text/plain', ext = '.txt') => {
    if (Buffer.byteLength(rawStr, 'utf8') <= SPILL_THRESHOLD_BYTES) return;
    const contentKey = sha256Hex(rawStr);
    if (spillByContentHash.has(contentKey)) return;

    const bytes = Buffer.byteLength(rawStr, 'utf8');
    const sha256 = await ctx.spill(rawStr);
    const relPath = `blobs/${sha256.slice(0, 2)}/${sha256}${ext}`;
    if (!blobsBySha.has(sha256)) {
      blobsBySha.set(sha256, {
        sha256,
        mime,
        bytes,
        ext,
        rel_path: relPath,
        origin_kind: 'oversized_payload',
        created_at: ts,
      });
    }
    spillByContentHash.set(contentKey, {
      sha256,
      bytes,
      mime,
      preview: makePreview(rawStr, sha256, bytes),
    });
  };

  const registerDataUriSpill = async (uri: string) => {
    const contentKey = sha256Hex(uri);
    if (spillByContentHash.has(contentKey)) return;

    const parsed = parseBase64DataUri(uri);
    if (!parsed) return;

    const sha256 = await ctx.spill(parsed.buffer);
    const relPath = `blobs/${sha256.slice(0, 2)}/${sha256}${parsed.ext}`;
    if (!blobsBySha.has(sha256)) {
      blobsBySha.set(sha256, {
        sha256,
        mime: parsed.mime,
        bytes: parsed.buffer.length,
        ext: parsed.ext,
        rel_path: relPath,
        origin_kind: 'inline_base64',
        created_at: ts,
      });
    }
    spillByContentHash.set(contentKey, {
      sha256,
      bytes: parsed.buffer.length,
      mime: parsed.mime,
      preview: `[inline_image:${sha256}]`,
    });
  };

  for (const item of session.sqlite_items ?? []) {
    const data = safeJsonParse(item.item_json);
    const itemType = item.item_type ?? 'agentMessage';

    for (const uri of findDataUrisInValue(data)) {
      await registerDataUriSpill(uri);
    }

    if (itemType === 'commandExecution') {
      const inputObj: Record<string, unknown> = {
        command: data['command'] ?? data['cmd'] ?? null,
        cwd: data['cwd'] ?? null,
      };
      if (data['commandActions'] !== undefined) inputObj['commandActions'] = data['commandActions'];
      await registerStringSpill(JSON.stringify(inputObj), 'application/json', '.json');

      const rawOutput =
        typeof data['aggregatedOutput'] === 'string'
          ? data['aggregatedOutput']
          : typeof data['output'] === 'string'
            ? data['output']
            : typeof data['stdout'] === 'string' || typeof data['stderr'] === 'string'
              ? [data['stdout'], data['stderr']].filter((v): v is string => typeof v === 'string' && v.length > 0).join('\n')
              : null;
      if (rawOutput) await registerStringSpill(rawOutput, 'text/plain', '.txt');
    } else if (itemType === 'mcpToolCall') {
      const rawArgs = data['arguments'] ?? data['input'] ?? {};
      const argsJson = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
      await registerStringSpill(argsJson, 'application/json', '.json');

      const resultVal = data['result'] ?? data['output'] ?? data['error'];
      if (resultVal !== undefined && resultVal !== null) {
        await registerStringSpill(
          typeof resultVal === 'string' ? resultVal : JSON.stringify(resultVal),
          typeof resultVal === 'string' ? 'text/plain' : 'application/json',
          typeof resultVal === 'string' ? '.txt' : '.json'
        );
      }
    } else if (itemType === 'fileChange') {
      const changes = Array.isArray(data['changes']) ? (data['changes'] as Record<string, unknown>[]) : [];
      const diffPieces: string[] = [];
      for (const ch of changes) {
        if (!ch || typeof ch !== 'object') continue;
        const fPath = typeof ch['path'] === 'string' ? ch['path'] : typeof ch['filePath'] === 'string' ? ch['filePath'] : '';
        const diff = typeof ch['diff'] === 'string' ? ch['diff'] : typeof ch['patch'] === 'string' ? ch['patch'] : '';
        diffPieces.push(fPath ? `--- ${fPath}\n${diff}` : diff);
      }
      if (diffPieces.length === 0) {
        if (typeof data['diff'] === 'string') diffPieces.push(data['diff']);
        else if (typeof data['patch'] === 'string') diffPieces.push(data['patch']);
      }
      const rawDiff = diffPieces.filter(Boolean).join('\n') || JSON.stringify(data);
      await registerStringSpill(rawDiff, 'text/plain', '.txt');
    } else if (itemType === 'webSearch') {
      await registerStringSpill(
        JSON.stringify({ query: data['query'] ?? null, action: data['action'] ?? null }),
        'application/json',
        '.json'
      );
      const results = Array.isArray(data['results'])
        ? data['results']
        : Array.isArray(data['citations'])
          ? data['citations']
          : null;
      if (results && results.length > 0) {
        await registerStringSpill(JSON.stringify(results), 'application/json', '.json');
      }
    } else if (itemType === 'userMessage' || itemType === 'agentMessage') {
      const texts = [
        ...extractTextFromParts(data['content']),
        ...(typeof data['text'] === 'string' ? [data['text']] : []),
        ...(typeof data['message'] === 'string' ? [data['message']] : []),
      ];
      await registerStringSpill(texts.join('\n'), 'text/plain', '.txt');
    } else if (itemType === 'reasoning') {
      const parts = [
        ...extractTextFromParts(data['summary']),
        ...extractTextFromParts(data['content']),
        ...(typeof data['text'] === 'string' ? [data['text']] : []),
      ];
      await registerStringSpill(parts.join('\n'), 'text/plain', '.txt');
    } else if (itemType !== 'imageGeneration' && itemType !== 'imageView') {
      await registerStringSpill(JSON.stringify(data), 'application/json', '.json');
    }
  }

  for (const record of session.records) {
    if (record.type !== 'response_item') continue;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const pType = typeof payload['type'] === 'string' ? payload['type'] : 'message';

    for (const uri of findDataUrisInValue(payload)) {
      await registerDataUriSpill(uri);
    }

    if (pType === 'reasoning') {
      const parts = [...extractTextFromParts(payload['summary']), ...extractTextFromParts(payload['content'])];
      await registerStringSpill(parts.join('\n'), 'text/plain', '.txt');
    } else if (pType === 'function_call' || pType === 'custom_tool_call' || pType === 'local_shell_call') {
      const argsRaw =
        typeof payload['arguments'] === 'string'
          ? payload['arguments']
          : JSON.stringify(payload['arguments'] ?? payload['action'] ?? {});
      await registerStringSpill(argsRaw, 'application/json', '.json');
    } else if (pType === 'function_call_output' || pType === 'custom_tool_call_output') {
      const outputRaw =
        typeof payload['output'] === 'string' ? payload['output'] : JSON.stringify(payload['output'] ?? '');
      await registerStringSpill(outputRaw, 'text/plain', '.txt');
    } else if (Array.isArray(payload['content'])) {
      for (const c of payload['content']) {
        if (c && typeof c === 'object') {
          const text = (c as Record<string, unknown>)['text'];
          if (typeof text === 'string') {
            await registerStringSpill(text, 'text/plain', '.txt');
          }
        }
      }
    }
  }

  return {
    blobs: [...blobsBySha.values()],
    spillByContentHash,
  };
}

export class CodexLocalAdapter implements Adapter<CodexNativeSession> {
  readonly id: ProviderId = 'codex-local';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const evidence: string[] = [];
    const entries: string[] = [];
    const warnings: string[] = [];
    let confidence = 0;

    if (src.kind === 'dir') {
      const dir = src.path;
      try {
        const files = fs.readdirSync(dir);
        const hasSessions = files.includes('sessions');
        const hasArchived = files.includes('archived_sessions');
        const hasIndex = files.includes('session_index.jsonl');
        const sqliteFiles = files.filter((f) => /^thread_history_\d+\.sqlite$/i.test(f)).sort();

        if (hasSessions || hasArchived || sqliteFiles.length > 0) {
          confidence = 0.98;
          evidence.push(
            `Found Codex directory structure (sessions=${hasSessions}, archived=${hasArchived}, sqlite=${sqliteFiles.length > 0}, index=${hasIndex})`
          );

          if (hasSessions) {
            this.collectRolloutFiles(path.join(dir, 'sessions'), entries);
          }
          if (hasArchived) {
            this.collectRolloutFiles(path.join(dir, 'archived_sessions'), entries);
          }
          for (const sq of sqliteFiles) {
            entries.push(path.join(dir, sq));
          }
        }
      } catch (err) {
        warnings.push(`Dir probe error: ${(err as Error).message}`);
      }
    } else if (src.kind === 'file') {
      const base = path.basename(src.path);
      if (base.endsWith('.jsonl.zst') || base.endsWith('.jsonl') || /^thread_history_\d+\.sqlite$/i.test(base)) {
        entries.push(src.path);
        confidence = /^thread_history_\d+\.sqlite$/i.test(base) ? 0.92 : 0.85;
        evidence.push(`Matched Codex file: ${base}`);
      }
    } else if (src.kind === 'sqlite') {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(src.path, { readOnly: true, enableForeignKeyConstraints: false });
        const tables = new Set(
          (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name?: string }[]).map((r) =>
            String(r.name ?? '')
          )
        );
        if (tables.has('thread_items') || tables.has('thread_turns')) {
          entries.push(src.path);
          confidence = 0.96;
          evidence.push(`Matched Codex SQLite database: ${path.basename(src.path)}`);
        }
      } catch (err) {
        warnings.push(`SQLite probe error: ${(err as Error).message}`);
      } finally {
        db?.close();
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

  private collectRolloutFiles(dir: string, out: string[], depth = 0): void {
    if (depth > 8) return;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          this.collectRolloutFiles(full, out, depth + 1);
        } else if (item.name.endsWith('.jsonl.zst') || item.name.endsWith('.jsonl')) {
          out.push(full);
        }
      }
    } catch {
      // ignore walk errors
    }
  }

  async *plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask> {
    if (src.kind === 'dir') {
      const dir = src.path;
      const titleIndex = loadSessionIndex(dir);
      const activeRollouts: string[] = [];
      const archivedRollouts: string[] = [];
      const sessionsDir = path.join(dir, 'sessions');
      const archivedDir = path.join(dir, 'archived_sessions');
      if (fs.existsSync(sessionsDir)) {
        this.collectRolloutFiles(sessionsDir, activeRollouts);
      }
      if (fs.existsSync(archivedDir)) {
        this.collectRolloutFiles(archivedDir, archivedRollouts);
      }

      const sqliteFiles = fs
        .readdirSync(dir)
        .filter((f) => /^thread_history_\d+\.sqlite$/i.test(f))
        .sort()
        .map((f) => path.join(dir, f));

      // Fast path when there are no archived duplicates and no legacy thread_history sqlite:
      // yield one ImportTask per active rollout file for parallel parsing & fine-grained progress.
      if (archivedRollouts.length === 0 && sqliteFiles.length === 0) {
        for (const entry of activeRollouts) {
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
            payload: { titleIndex },
          };
        }
        return;
      }

      // When archived_sessions or thread_history SQLite are present, pre-deduplicate rollouts
      // and pre-load SQLite threads once, then yield one task per unique session.
      const sqliteMap = sqliteFiles.length > 0 ? loadSqliteHistory(sqliteFiles) : new Map();
      const rolloutBySession = new Map<string, ParsedRolloutFile>();
      const allRollouts: { filePath: string; isArchived: boolean }[] = [
        ...activeRollouts.map((filePath) => ({ filePath, isArchived: false })),
        ...archivedRollouts.map((filePath) => ({ filePath, isArchived: true })),
      ];

      for (const item of allRollouts) {
        const parsed = parseRolloutFile(item.filePath, item.isArchived);
        if (!parsed) continue;
        const existing = rolloutBySession.get(parsed.sessionId);
        if (!existing) {
          rolloutBySession.set(parsed.sessionId, parsed);
        } else {
          const takeNew =
            parsed.records.length > existing.records.length ||
            (parsed.records.length === existing.records.length && !parsed.isArchived && existing.isArchived);
          if (takeNew) {
            rolloutBySession.set(parsed.sessionId, parsed);
          }
        }
      }

      const allSessionIds = new Set<string>([...rolloutBySession.keys(), ...sqliteMap.keys()]);
      for (const sessionId of allSessionIds) {
        const rollout = rolloutBySession.get(sessionId);
        const sq = sqliteMap.get(sessionId);
        let size = 512;
        if (rollout) {
          try {
            size = fs.statSync(rollout.filePath).size;
          } catch {
            // ignore
          }
        }
        yield {
          id: sha256Hex(`${src.path}#codex#${sessionId}`),
          src,
          entry: rollout
            ? (sq ? `${rollout.filePath}#${sessionId}` : rollout.filePath)
            : `${sqliteFiles[0] ?? dir}#${sessionId}`,
          estimatedBytes: size,
          payload: {
            kind: 'codex_preplanned',
            sessionId,
            rollout,
            sq,
            title: titleIndex.get(sessionId) ?? null,
            sourceFile: rollout?.filePath ?? sqliteFiles[0] ?? dir,
          },
        };
      }
      return;
    }

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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<CodexNativeSession>[]> {
    const taskPayload = task.payload as
      | {
          kind?: string;
          sessionId?: string;
          rollout?: ParsedRolloutFile;
          sq?: { turns: CodexSqliteTurn[]; items: CodexSqliteItem[] };
          title?: string | null;
          sourceFile?: string;
          titleIndex?: Map<string, string>;
        }
      | undefined;

    if (taskPayload?.kind === 'codex_preplanned' && taskPayload.sessionId) {
      const { sessionId, rollout, sq, title, sourceFile } = taskPayload;
      if (rollout) {
        for (const issue of rollout.parseIssues) {
          ctx.log('warn', issue.message);
        }
        ctx.recordSourceFile?.(rollout.filePath);
      }
      const sqTimestamps = [
        ...(sq?.turns.map((t) => t.started_at) ?? []),
        ...(sq?.turns.map((t) => t.completed_at) ?? []),
        ...(sq?.items.map((i) => i.created_at_ms ?? i.started_at_ms) ?? []),
      ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const minSqTs = sqTimestamps.length > 0 ? Math.min(...sqTimestamps) : null;
      const maxSqTs = sqTimestamps.length > 0 ? Math.max(...sqTimestamps) : null;
      const createdAt =
        rollout?.createdAt != null && minSqTs != null
          ? Math.min(rollout.createdAt, minSqTs)
          : (rollout?.createdAt ?? minSqTs);
      const updatedAt =
        rollout?.updatedAt != null && maxSqTs != null
          ? Math.max(rollout.updatedAt, maxSqTs)
          : (rollout?.updatedAt ?? maxSqTs);

      const nativeSession: CodexNativeSession = {
        session_id: sessionId,
        source_file: sourceFile ?? task.src.path,
        title: title ?? null,
        cwd: rollout?.cwd ?? null,
        parent_session_id: rollout?.parentSessionId ?? null,
        is_subagent: rollout?.isSubagent ?? false,
        subagent_name: rollout?.subagentName ?? null,
        originator: rollout?.originator ?? null,
        cli_version: rollout?.cliVersion ?? null,
        model_provider: rollout?.modelProvider ?? null,
        base_instructions_sha256: rollout?.baseInstructionsSha ?? null,
        records: rollout?.records ?? [],
        sqlite_turns: sq?.turns,
        sqlite_items: sq?.items,
      };
      const { blobs, spillByContentHash } = await prepareSpillsAndBlobs(nativeSession, createdAt, ctx);
      return [
        new CodexSessionDocument(
          nativeSession,
          createdAt,
          updatedAt,
          rollout?.parseIssues ?? [],
          blobs,
          spillByContentHash
        ),
      ];
    }

    const targetPath = task.entry ?? task.src.path;
    ctx.log('info', `CodexLocalAdapter parsing: ${targetPath}`);

    let isDir = false;
    try {
      isDir = fs.statSync(targetPath).isDirectory();
    } catch (err) {
      ctx.log('error', `Failed accessing Codex source ${targetPath}: ${(err as Error).message}`);
      return [];
    }

    if (isDir) {
      return this.parseDirectory(targetPath, ctx);
    }

    // Single file or SQLite source
    const rootDir = findCodexRootDir(targetPath);
    const titleIndex = taskPayload?.titleIndex ?? loadSessionIndex(rootDir);

    if (/\.sqlite$/i.test(targetPath) || task.src.kind === 'sqlite') {
      const sqliteMap = loadSqliteHistory([targetPath], ctx);
      const docs: SessionDocument<CodexNativeSession>[] = [];
      for (const [threadId, data] of sqliteMap.entries()) {
        const timestamps = [
          ...data.turns.map((t) => t.started_at),
          ...data.turns.map((t) => t.completed_at),
          ...data.items.map((i) => i.created_at_ms ?? i.started_at_ms),
        ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        const createdAt = timestamps.length > 0 ? Math.min(...timestamps) : null;
        const updatedAt = timestamps.length > 0 ? Math.max(...timestamps) : null;

        const nativeSession: CodexNativeSession = {
          session_id: threadId,
          source_file: targetPath,
          title: titleIndex.get(threadId) ?? null,
          records: [],
          sqlite_turns: data.turns,
          sqlite_items: data.items,
        };
        const { blobs, spillByContentHash } = await prepareSpillsAndBlobs(nativeSession, createdAt, ctx);
        docs.push(new CodexSessionDocument(nativeSession, createdAt, updatedAt, [], blobs, spillByContentHash));
      }
      return docs;
    }

    // Single rollout file
    const parsed = parseRolloutFile(targetPath, targetPath.includes('archived_sessions'), ctx);
    if (!parsed) return [];

    const sqliteFiles = rootDir
      ? fs
          .readdirSync(rootDir)
          .filter((f) => /^thread_history_\d+\.sqlite$/i.test(f))
          .sort()
          .map((f) => path.join(rootDir, f))
      : [];
    const sqliteMap = sqliteFiles.length > 0 ? loadSqliteHistory(sqliteFiles, ctx) : new Map();
    const sq = sqliteMap.get(parsed.sessionId);

    const nativeSession: CodexNativeSession = {
      session_id: parsed.sessionId,
      source_file: parsed.filePath,
      title: titleIndex.get(parsed.sessionId) ?? null,
      cwd: parsed.cwd,
      parent_session_id: parsed.parentSessionId,
      is_subagent: parsed.isSubagent,
      subagent_name: parsed.subagentName,
      originator: parsed.originator,
      cli_version: parsed.cliVersion,
      model_provider: parsed.modelProvider,
      base_instructions_sha256: parsed.baseInstructionsSha,
      records: parsed.records,
      sqlite_turns: sq?.turns,
      sqlite_items: sq?.items,
    };

    const { blobs, spillByContentHash } = await prepareSpillsAndBlobs(nativeSession, parsed.createdAt, ctx);
    return [
      new CodexSessionDocument(
        nativeSession,
        parsed.createdAt,
        parsed.updatedAt,
        parsed.parseIssues,
        blobs,
        spillByContentHash
      ),
    ];
  }

  private async parseDirectory(dir: string, ctx: ParseCtx): Promise<SessionDocument<CodexNativeSession>[]> {
    const titleIndex = loadSessionIndex(dir);

    const activeRollouts: string[] = [];
    const archivedRollouts: string[] = [];
    const sessionsDir = path.join(dir, 'sessions');
    const archivedDir = path.join(dir, 'archived_sessions');
    if (fs.existsSync(sessionsDir)) {
      this.collectRolloutFiles(sessionsDir, activeRollouts);
    }
    if (fs.existsSync(archivedDir)) {
      this.collectRolloutFiles(archivedDir, archivedRollouts);
    }

    const sqliteFiles = fs
      .readdirSync(dir)
      .filter((f) => /^thread_history_\d+\.sqlite$/i.test(f))
      .sort()
      .map((f) => path.join(dir, f));
    const sqliteMap = loadSqliteHistory(sqliteFiles, ctx);

    // Parse & deduplicate rollout files by session_id (preferring sessions/ and fuller record lists)
    const rolloutBySession = new Map<string, ParsedRolloutFile>();
    const allRollouts: { filePath: string; isArchived: boolean }[] = [
      ...activeRollouts.map((filePath) => ({ filePath, isArchived: false })),
      ...archivedRollouts.map((filePath) => ({ filePath, isArchived: true })),
    ];

    for (const item of allRollouts) {
      if (sqliteMap.size === 0 && ctx.skipIfUnchanged?.(item.filePath)) {
        continue;
      }
      ctx.recordSourceFile?.(item.filePath);
      const parsed = parseRolloutFile(item.filePath, item.isArchived, ctx);
      if (!parsed) continue;
      const existing = rolloutBySession.get(parsed.sessionId);
      if (!existing) {
        rolloutBySession.set(parsed.sessionId, parsed);
      } else {
        // Keep the fuller rollout; on tie, prefer active sessions/ over archived_sessions/
        const takeNew =
          parsed.records.length > existing.records.length ||
          (parsed.records.length === existing.records.length && !parsed.isArchived && existing.isArchived);
        if (takeNew) {
          rolloutBySession.set(parsed.sessionId, parsed);
        }
      }
    }

    const allSessionIds = new Set<string>([...rolloutBySession.keys(), ...sqliteMap.keys()]);
    const docs: SessionDocument<CodexNativeSession>[] = [];

    for (const sessionId of allSessionIds) {
      const rollout = rolloutBySession.get(sessionId);
      const sq = sqliteMap.get(sessionId);

      const sqTimestamps = [
        ...(sq?.turns.map((t) => t.started_at) ?? []),
        ...(sq?.turns.map((t) => t.completed_at) ?? []),
        ...(sq?.items.map((i) => i.created_at_ms ?? i.started_at_ms) ?? []),
      ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

      const minSqTs = sqTimestamps.length > 0 ? Math.min(...sqTimestamps) : null;
      const maxSqTs = sqTimestamps.length > 0 ? Math.max(...sqTimestamps) : null;

      const createdAt =
        rollout?.createdAt != null && minSqTs != null
          ? Math.min(rollout.createdAt, minSqTs)
          : (rollout?.createdAt ?? minSqTs);
      const updatedAt =
        rollout?.updatedAt != null && maxSqTs != null
          ? Math.max(rollout.updatedAt, maxSqTs)
          : (rollout?.updatedAt ?? maxSqTs);

      const nativeSession: CodexNativeSession = {
        session_id: sessionId,
        source_file: rollout?.filePath ?? sqliteFiles[0] ?? dir,
        title: titleIndex.get(sessionId) ?? null,
        cwd: rollout?.cwd ?? null,
        parent_session_id: rollout?.parentSessionId ?? null,
        is_subagent: rollout?.isSubagent ?? false,
        subagent_name: rollout?.subagentName ?? null,
        originator: rollout?.originator ?? null,
        cli_version: rollout?.cliVersion ?? null,
        model_provider: rollout?.modelProvider ?? null,
        base_instructions_sha256: rollout?.baseInstructionsSha ?? null,
        records: rollout?.records ?? [],
        sqlite_turns: sq?.turns,
        sqlite_items: sq?.items,
      };

      const { blobs, spillByContentHash } = await prepareSpillsAndBlobs(nativeSession, createdAt, ctx);
      docs.push(
        new CodexSessionDocument(
          nativeSession,
          createdAt,
          updatedAt,
          rollout?.parseIssues ?? [],
          blobs,
          spillByContentHash
        )
      );
    }

    return docs;
  }
}

export const codexLocalAdapter = new CodexLocalAdapter();
