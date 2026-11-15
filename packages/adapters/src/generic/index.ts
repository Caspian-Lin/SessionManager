import fs from 'node:fs';
import path from 'node:path';
import {
  SPILL_THRESHOLD_BYTES,
  iterJsonLines,
  sha256Hex,
  type BlobAsset,
  type IntegrityIssue,
  type ProviderId,
  type SessionRole,
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

export interface GenericNativeSession {
  source_file: string;
  format: 'json' | 'markdown';
  raw_payload: unknown;
  raw_spill_sha256?: string | null;
}

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

function extractGenericMessageArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const key of ['messages', 'conversations', 'turns', 'history', 'items', 'entries', 'chat_messages']) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
  }
  return [];
}

export class GenericJsonSessionDocument extends BaseSessionDocument<GenericNativeSession> {
  private readonly messageList: unknown[];

  constructor(
    nativeData: GenericNativeSession,
    messageList: unknown[],
    title: string,
    parseIssues: IntegrityIssue[] = [],
    blobs: BlobAsset[] = []
  ) {
    super({
      provider: 'generic-json',
      rawFormat: 'generic-json/v1',
      nativeData,
      external_id: title,
      title,
      title_source: 'filename',
      blobs,
      parseIssues,
    });
    this.messageList = messageList;
  }

  protected projectTurns(): RawTurnProjection[] {
    const turns: RawTurnProjection[] = [];
    let ordinal = 0;
    let prevId: string | null = null;

    for (const msg of this.messageList) {
      if (!msg || typeof msg !== 'object') continue;
      const mObj = msg as Record<string, unknown>;

      const id = typeof mObj['id'] === 'string' ? mObj['id'] : `gen-${ordinal}`;
      const rawRole =
        typeof mObj['role'] === 'string'
          ? mObj['role'].toLowerCase()
          : typeof mObj['sender'] === 'string'
            ? mObj['sender'].toLowerCase()
            : typeof mObj['author'] === 'string'
              ? mObj['author'].toLowerCase()
              : 'user';

      const role: SessionRole =
        rawRole === 'assistant' || rawRole === 'bot' || rawRole === 'model' || rawRole === 'ai'
          ? 'assistant'
          : rawRole === 'system'
            ? 'system'
            : rawRole === 'tool'
              ? 'tool'
              : 'user';

      const content =
        typeof mObj['content'] === 'string'
          ? mObj['content']
          : typeof mObj['text'] === 'string'
            ? mObj['text']
            : typeof mObj['body'] === 'string'
              ? mObj['body']
              : JSON.stringify(mObj['content'] ?? mObj['text'] ?? mObj['body'] ?? msg);

      const parentExtId =
        typeof mObj['parent_id'] === 'string'
          ? mObj['parent_id']
          : typeof mObj['parent'] === 'string'
            ? mObj['parent']
            : prevId;

      turns.push({
        external_id: id,
        parent_external_id: parentExtId,
        ordinal: ordinal++,
        role,
        kind: 'message',
        created_at: parseFlexTimestamp(mObj['created_at'] ?? mObj['timestamp'] ?? mObj['create_time']),
        model: typeof mObj['model'] === 'string' ? mObj['model'] : null,
        text: content,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks: [{ idx: 0, type: 'text', text: content }],
      });
      prevId = id;
    }

    if (turns.length === 0 && this.nativeData.raw_payload !== undefined) {
      const previewSource =
        typeof this.nativeData.raw_payload === 'string'
          ? this.nativeData.raw_payload
          : JSON.stringify(this.nativeData.raw_payload, null, 2);
      const preview = previewSource.slice(0, 4096);
      turns.push({
        external_id: 'gen-raw-fallback-0',
        parent_external_id: null,
        ordinal: 0,
        role: 'system',
        kind: 'system_note',
        text: preview,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: true,
        payload_ref: this.nativeData.raw_spill_sha256 ?? null,
        blocks: [
          {
            idx: 0,
            type: 'text',
            text: preview,
            blob_sha256: this.nativeData.raw_spill_sha256 ?? null,
            availability: this.nativeData.raw_spill_sha256 ? 'full' : 'missing_ref',
          },
        ],
      });
    }

    return turns;
  }
}

export class GenericMdSessionDocument extends BaseSessionDocument<GenericNativeSession> {
  constructor(
    nativeData: GenericNativeSession,
    title: string,
    parseIssues: IntegrityIssue[] = [],
    blobs: BlobAsset[] = []
  ) {
    super({
      provider: 'generic-md',
      rawFormat: 'generic-md/v1',
      nativeData,
      external_id: title,
      title,
      title_source: 'filename',
      blobs,
      parseIssues,
    });
  }

  protected projectTurns(): RawTurnProjection[] {
    const raw = typeof this.nativeData.raw_payload === 'string' ? this.nativeData.raw_payload : '';
    const turns: RawTurnProjection[] = [];
    const lines = raw.split('\n');

    let currentRole: SessionRole = 'user';
    let currentBlocks: string[] = [];
    let ordinal = 0;
    let prevId: string | null = null;

    const flushTurn = () => {
      if (currentBlocks.length === 0) return;
      const text = currentBlocks.join('\n').trim();
      if (!text) return;

      const id = `md-item-${ordinal}`;
      turns.push({
        external_id: id,
        parent_external_id: prevId,
        ordinal: ordinal++,
        role: currentRole,
        kind: 'message',
        text,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks: [{ idx: 0, type: 'text', text }],
      });
      prevId = id;
      currentBlocks = [];
    };

    const TURN_HEADER_RE =
      /^(?:(?:#{1,4}\s*|>?\s*)\*{0,2}\[?(User|Human|Assistant|AI|Claude|ChatGPT|DeepSeek|System)\]?\*{0,2}\s*:?|(?:#{1,4}\s+)?\*\*(User|Human|Assistant|AI|Claude|ChatGPT|DeepSeek|System)\*\*\s*:?)\s*(.*)$/i;

    for (const line of lines) {
      const match = line.match(TURN_HEADER_RE);
      const roleToken = match?.[1] ?? match?.[2];
      if (match && roleToken) {
        flushTurn();
        const roleLabel = roleToken.toLowerCase();
        if (roleLabel === 'assistant' || roleLabel === 'ai' || roleLabel === 'claude' || roleLabel === 'chatgpt' || roleLabel === 'deepseek') {
          currentRole = 'assistant';
        } else if (roleLabel === 'system') {
          currentRole = 'system';
        } else {
          currentRole = 'user';
        }
        const trailing = (match[3] ?? '').trim();
        if (trailing) currentBlocks.push(trailing);
      } else {
        currentBlocks.push(line);
      }
    }
    flushTurn();

    if (turns.length === 0 && raw.trim().length > 0) {
      const trimmed = raw.trim();
      turns.push({
        external_id: 'md-0',
        ordinal: 0,
        role: 'user',
        kind: 'message',
        text: trimmed.slice(0, 8192),
        payload_ref: this.nativeData.raw_spill_sha256 ?? null,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks: [
          {
            idx: 0,
            type: 'text',
            text: trimmed.slice(0, 8192),
            blob_sha256: this.nativeData.raw_spill_sha256 ?? null,
          },
        ],
      });
    }

    return turns;
  }
}

export class GenericJsonAdapter implements Adapter<GenericNativeSession> {
  readonly id: ProviderId = 'generic-json';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    if (src.kind === 'dir') {
      try {
        const entries: string[] = [];
        for (const f of fs.readdirSync(src.path)) {
          const lower = f.toLowerCase();
          if (lower.endsWith('.json') || lower.endsWith('.jsonl')) {
            entries.push(path.join(src.path, f));
          }
        }
        if (entries.length > 0) {
          return {
            adapterId: this.id,
            version: 'generic-v1',
            confidence: 0.25,
            evidence: [`Directory contains ${entries.length} JSON/JSONL candidate file(s)`],
            entries,
            warnings: ['Generic JSON heuristic directory fallback'],
          };
        }
      } catch {
        // ignore
      }
      return null;
    }

    if (src.kind !== 'file') return null;
    const lower = src.path.toLowerCase();
    if (!lower.endsWith('.json') && !lower.endsWith('.jsonl')) {
      return null;
    }

    try {
      const sample = fs.readFileSync(src.path, { encoding: 'utf8', flag: 'r' }).slice(0, 8192);
      const isJsonArray = /^\s*\[/.test(sample);
      const isJsonObject = /^\s*\{/.test(sample);
      const hasMessages =
        sample.includes('"messages"') ||
        sample.includes('"conversations"') ||
        sample.includes('"turns"') ||
        sample.includes('"history"');
      const hasRole = sample.includes('"role"') || sample.includes('"sender"') || sample.includes('"author"');

      if (isJsonArray || hasMessages || hasRole || (lower.endsWith('.jsonl') && isJsonObject)) {
        return {
          adapterId: this.id,
          version: 'generic-v1',
          confidence: 0.35,
          evidence: ['JSON/JSONL file with heuristic conversational markers'],
          entries: [src.path],
          warnings: ['Generic JSON heuristic adapter: field completeness unverified'],
        };
      }
    } catch {
      // ignore
    }
    return null;
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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<GenericNativeSession>[]> {
    const filePath = task.entry ?? task.src.path;
    let rawBuf: Buffer;
    try {
      rawBuf = fs.readFileSync(filePath);
    } catch (err) {
      ctx.log('error', `GenericJson read error: ${(err as Error).message}`);
      return [];
    }

    const rawText = rawBuf.toString('utf8');
    let parsed: unknown;
    const issues: IntegrityIssue[] = [];

    if (filePath.toLowerCase().endsWith('.jsonl')) {
      const lines: unknown[] = [];
      for (const line of iterJsonLines(rawBuf)) {
        try {
          lines.push(JSON.parse(line));
        } catch {
          issues.push({
            code: 'truncated_stream',
            severity: 'warn',
            message: `Skipped malformed JSONL tail line in ${path.basename(filePath)}`,
          });
        }
      }
      parsed = lines;
    } else {
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        ctx.log('error', `GenericJson parse error: ${(err as Error).message}`);
        return [];
      }
    }

    const messageList = extractGenericMessageArray(parsed);
    for (const msg of messageList) {
      if (msg && typeof msg === 'object') {
        partitionVendorFields(
          msg as Record<string, unknown>,
          ['id', 'parent_id', 'parent', 'role', 'sender', 'author', 'content', 'text', 'body', 'created_at', 'timestamp', 'model'],
          ctx
        );
      }
    }

    const blobs: BlobAsset[] = [];
    let rawSpillSha: string | null = null;
    if (messageList.length === 0 || rawBuf.byteLength > SPILL_THRESHOLD_BYTES) {
      rawSpillSha = await ctx.spill(parsed);
      blobs.push({
        sha256: rawSpillSha,
        mime: 'application/json',
        bytes: Buffer.byteLength(JSON.stringify(parsed, null, 2), 'utf8'),
        ext: '.json',
        rel_path: `blobs/${rawSpillSha.slice(0, 2)}/${rawSpillSha}.json`,
        origin_kind: 'oversized_payload',
        created_at: Date.now(),
      });
      if (messageList.length === 0) {
        issues.push({
          code: 'parse_error',
          severity: 'info',
          message: `heuristic_raw_fallback: No standard message array recognized in ${path.basename(filePath)}; spilled raw payload to blob ${rawSpillSha}`,
        });
      }
    }

    const title = path.basename(filePath, path.extname(filePath));
    return [
      new GenericJsonSessionDocument(
        { source_file: filePath, format: 'json', raw_payload: parsed, raw_spill_sha256: rawSpillSha },
        messageList,
        title,
        issues,
        blobs
      ),
    ];
  }
}

export class GenericMdAdapter implements Adapter<GenericNativeSession> {
  readonly id: ProviderId = 'generic-md';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    if (src.kind === 'dir') {
      try {
        const entries = fs
          .readdirSync(src.path)
          .filter((f) => f.toLowerCase().endsWith('.md') || f.toLowerCase().endsWith('.markdown'))
          .map((f) => path.join(src.path, f));
        if (entries.length > 0) {
          return {
            adapterId: this.id,
            version: 'generic-md-v1',
            confidence: 0.25,
            evidence: [`Directory contains ${entries.length} Markdown candidate(s)`],
            entries,
            warnings: ['Generic Markdown heuristic directory fallback'],
          };
        }
      } catch {
        // ignore
      }
      return null;
    }

    if (src.kind !== 'file') return null;
    const base = path.basename(src.path).toLowerCase();
    if (base.endsWith('.md') || base.endsWith('.markdown')) {
      return {
        adapterId: this.id,
        version: 'generic-md-v1',
        confidence: 0.4,
        evidence: ['Markdown document candidate'],
        entries: [src.path],
        warnings: ['Generic Markdown adapter: conversation turns inferred from headers'],
      };
    }
    return null;
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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<GenericNativeSession>[]> {
    const filePath = task.entry ?? task.src.path;
    let rawBuf: Buffer;
    try {
      rawBuf = fs.readFileSync(filePath);
    } catch (err) {
      ctx.log('error', `GenericMd read error: ${(err as Error).message}`);
      return [];
    }

    const raw = rawBuf.toString('utf8');
    const blobs: BlobAsset[] = [];
    let rawSpillSha: string | null = null;
    if (rawBuf.byteLength > SPILL_THRESHOLD_BYTES) {
      rawSpillSha = await ctx.spill(raw);
      blobs.push({
        sha256: rawSpillSha,
        mime: 'text/plain',
        bytes: rawBuf.byteLength,
        ext: '.txt',
        rel_path: `blobs/${rawSpillSha.slice(0, 2)}/${rawSpillSha}.txt`,
        origin_kind: 'oversized_payload',
        created_at: Date.now(),
      });
    }

    const title = path.basename(filePath, path.extname(filePath));
    return [
      new GenericMdSessionDocument(
        { source_file: filePath, format: 'markdown', raw_payload: raw, raw_spill_sha256: rawSpillSha },
        title,
        [],
        blobs
      ),
    ];
  }
}

export const genericJsonAdapter = new GenericJsonAdapter();
export const genericMdAdapter = new GenericMdAdapter();
