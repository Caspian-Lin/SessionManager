import fs from 'node:fs';
import path from 'node:path';
import {
  SPILL_THRESHOLD_BYTES,
  decompressZstd,
  isZstdBuffer,
  iterJsonLines,
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

export interface CodexRolloutRecord {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface CodexNativeSession {
  session_id: string;
  source_file: string;
  cwd?: string | null;
  originator?: string | null;
  cli_version?: string | null;
  model_provider?: string | null;
  base_instructions_sha256?: string | null;
  records: CodexRolloutRecord[];
}

function readBufferMaybeZstd(filePath: string): Buffer {
  const buf = fs.readFileSync(filePath);
  if (isZstdBuffer(buf)) {
    return decompressZstd(buf);
  }
  return buf;
}

const KNOWN_META_KEYS = [
  'session_id',
  'id',
  'cwd',
  'originator',
  'cli_version',
  'model_provider',
  'base_instructions',
  'history_mode',
] as const;

export class CodexSessionDocument extends BaseSessionDocument<CodexNativeSession> {
  constructor(
    nativeData: CodexNativeSession,
    createdAt: number | null,
    updatedAt: number | null,
    parseIssues: IntegrityIssue[] = []
  ) {
    super({
      provider: 'codex-local',
      rawFormat: 'codex-rollout/v1',
      nativeData,
      external_id: nativeData.session_id,
      title: null,
      title_source: null,
      created_at: createdAt,
      updated_at: updatedAt,
      default_model: nativeData.model_provider ?? null,
      cwd: nativeData.cwd ?? null,
      parseIssues,
    });
  }

  protected projectTurns(): RawTurnProjection[] {
    const turns: RawTurnProjection[] = [];
    let ordinal = 0;
    let prevItemId: string | null = null;
    const createdAt = this.init.created_at ?? null;

    for (const record of this.nativeData.records) {
      const recordType = typeof record.type === 'string' ? record.type : '';
      const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : null;
      const payload = (record.payload ?? {}) as Record<string, unknown>;

      if (recordType === 'turn_context') {
        const turnId = typeof payload['turn_id'] === 'string' ? payload['turn_id'] : `turn-${ordinal}`;
        const itemId = `tc-${turnId}-${ordinal}`;
        turns.push({
          external_id: itemId,
          parent_external_id: prevItemId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'turn_context',
          created_at: ts ?? createdAt,
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
        });
        prevItemId = itemId;
      } else if (recordType === 'response_item') {
        const rawRole = typeof payload['role'] === 'string' ? payload['role'].toLowerCase() : 'assistant';
        const role: SessionRole = rawRole === 'user' ? 'user' : 'assistant';
        const itemId = `item-${this.nativeData.session_id}-${ordinal}`;

        const contentArr = Array.isArray(payload['content']) ? payload['content'] : [];
        const blocks: ViewBlock[] = [];
        let bIdx = 0;

        for (const c of contentArr) {
          if (!c || typeof c !== 'object') continue;
          const cObj = c as Record<string, unknown>;
          const text = typeof cObj['text'] === 'string' ? cObj['text'] : '';

          let payloadRef: string | null = null;
          if (Buffer.byteLength(text, 'utf8') > SPILL_THRESHOLD_BYTES) {
            payloadRef = sha256Hex(text);
          }

          blocks.push({
            idx: bIdx++,
            type: 'text',
            text,
            blob_sha256: payloadRef,
          });
        }

        const projectedText = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');

        turns.push({
          external_id: itemId,
          parent_external_id: prevItemId,
          ordinal: ordinal++,
          role,
          kind: 'message',
          created_at: ts ?? createdAt,
          text: projectedText,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks,
        });
        prevItemId = itemId;
      }
    }

    return turns;
  }
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
        const hasSqlite = files.some((f) => /^thread_history_\d+\.sqlite$/i.test(f));

        if (hasSessions || hasArchived || hasSqlite) {
          confidence = 0.98;
          evidence.push(
            `Found Codex directory structure (sessions=${hasSessions}, sqlite=${hasSqlite}, index=${hasIndex})`
          );

          const sessionsDir = path.join(dir, 'sessions');
          if (fs.existsSync(sessionsDir)) {
            this.collectRolloutFiles(sessionsDir, entries, 50);
          }
        }
      } catch (err) {
        warnings.push(`Dir probe error: ${(err as Error).message}`);
      }
    } else if (src.kind === 'file') {
      const base = path.basename(src.path);
      if (base.endsWith('.jsonl.zst') || base.endsWith('.jsonl') || /^thread_history_\d+\.sqlite$/i.test(base)) {
        entries.push(src.path);
        confidence = 0.85;
        evidence.push(`Matched Codex file: ${base}`);
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

  private collectRolloutFiles(dir: string, out: string[], limit: number, depth = 0): void {
    if (depth > 5 || out.length >= limit) return;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          this.collectRolloutFiles(full, out, limit, depth + 1);
        } else if (item.name.endsWith('.jsonl.zst') || item.name.endsWith('.jsonl')) {
          out.push(full);
          if (out.length >= limit) break;
        }
      }
    } catch {
      // ignore walk errors
    }
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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<CodexNativeSession>[]> {
    const filePath = task.entry ?? task.src.path;
    ctx.log('info', `CodexLocalAdapter parsing file: ${filePath}`);

    let buf: Buffer;
    try {
      buf = readBufferMaybeZstd(filePath);
    } catch (err) {
      ctx.log('error', `Failed reading Codex rollout ${filePath}: ${(err as Error).message}`);
      return [];
    }

    let sessionId: string | null = null;
    let cwd: string | null = null;
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
      const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : null;
      if (ts) {
        if (!createdAt) createdAt = ts;
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
        cwd = typeof payload['cwd'] === 'string' ? payload['cwd'] : null;
        originator = typeof payload['originator'] === 'string' ? payload['originator'] : null;
        cliVersion = typeof payload['cli_version'] === 'string' ? payload['cli_version'] : null;
        modelProvider = typeof payload['model_provider'] === 'string' ? payload['model_provider'] : null;

        if (typeof payload['base_instructions'] === 'string') {
          baseInstructionsSha = sha256Hex(payload['base_instructions']);
          // Strip huge base_instructions from native slice, keep sha256 reference
          payload['base_instructions_sha256'] = baseInstructionsSha;
          delete payload['base_instructions'];
        }
        partitionVendorFields(payload, KNOWN_META_KEYS, ctx);
      }

      records.push(record);
    }

    if (!sessionId && records.length === 0) {
      return [];
    }

    const nativeSession: CodexNativeSession = {
      session_id: sessionId ?? path.basename(filePath, path.extname(filePath)),
      source_file: filePath,
      cwd,
      originator,
      cli_version: cliVersion,
      model_provider: modelProvider,
      base_instructions_sha256: baseInstructionsSha,
      records,
    };

    return [new CodexSessionDocument(nativeSession, createdAt, updatedAt, parseIssues)];
  }
}

export const codexLocalAdapter = new CodexLocalAdapter();
