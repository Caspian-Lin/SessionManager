import fs from 'node:fs';
import path from 'node:path';
import {
  iterJsonLines,
  sha256Hex,
  type IntegrityIssue,
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

export interface ClaudeCodeNativeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  isSidechain?: boolean;
  userType?: string;
  version?: string;
  message?: {
    role?: string;
    content?: unknown[];
    text?: string;
  };
  summary?: string;
  leafUuid?: string;
  [key: string]: unknown;
}

export interface ClaudeCodeNativeSession {
  session_id: string;
  source_file: string;
  cwd?: string | null;
  git_branch?: string | null;
  version?: string | null;
  records: ClaudeCodeNativeRecord[];
}

const KNOWN_LINE_KEYS = [
  'type',
  'uuid',
  'parentUuid',
  'sessionId',
  'cwd',
  'gitBranch',
  'timestamp',
  'isSidechain',
  'userType',
  'version',
  'message',
  'summary',
  'leafUuid',
] as const;

export class ClaudeCodeSessionDocument extends BaseSessionDocument<ClaudeCodeNativeSession> {
  constructor(
    nativeData: ClaudeCodeNativeSession,
    createdAt: number | null,
    updatedAt: number | null,
    parseIssues: IntegrityIssue[] = []
  ) {
    super({
      provider: 'claude-code-local',
      rawFormat: 'claude-code-jsonl/v1',
      nativeData,
      external_id: nativeData.session_id,
      title: null,
      title_source: null,
      created_at: createdAt,
      updated_at: updatedAt,
      cwd: nativeData.cwd ?? null,
      parseIssues,
    });
  }

  protected projectTurns(): RawTurnProjection[] {
    const turns: RawTurnProjection[] = [];
    let ordinal = 0;
    const createdAt = this.init.created_at ?? null;

    for (const record of this.nativeData.records) {
      const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : null;
      const recType = typeof record.type === 'string' ? record.type : 'user';
      const uuid = typeof record.uuid === 'string' ? record.uuid : `cc-${ordinal}`;
      const parentUuid = typeof record.parentUuid === 'string' ? record.parentUuid : null;
      const isSidechain = Boolean(record.isSidechain);

      if (recType === 'summary') {
        const summaryText = typeof record.summary === 'string' ? record.summary : '';
        const leafUuid = typeof record.leafUuid === 'string' ? record.leafUuid : null;

        turns.push({
          external_id: uuid,
          parent_external_id: parentUuid ?? leafUuid,
          ordinal: ordinal++,
          role: 'system',
          kind: 'compaction',
          created_at: ts ?? createdAt,
          text: summaryText,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          blocks: [
            {
              idx: 0,
              type: 'text',
              text: summaryText,
            },
          ],
        });
        continue;
      }

      const messageObj = record.message ?? {};
      const rawRole = typeof messageObj.role === 'string' ? messageObj.role : recType;
      const contentArr = Array.isArray(messageObj.content) ? messageObj.content : [];

      let role: SessionRole = rawRole === 'assistant' ? 'assistant' : rawRole === 'system' ? 'system' : 'user';
      let kind: TurnKind = 'message';

      const blocks: ViewBlock[] = [];
      let bIdx = 0;

      for (const c of contentArr) {
        if (!c || typeof c !== 'object') continue;
        const cObj = c as Record<string, unknown>;
        const typeStr = typeof cObj['type'] === 'string' ? cObj['type'] : 'text';

        if (typeStr === 'tool_result') {
          role = 'tool';
          kind = 'tool_result';
          const contentVal = cObj['content'];
          blocks.push({
            idx: bIdx++,
            type: 'tool_result',
            tool_call_id: typeof cObj['tool_use_id'] === 'string' ? cObj['tool_use_id'] : null,
            text: typeof contentVal === 'string' ? contentVal : JSON.stringify(contentVal ?? ''),
          });
        } else if (typeStr === 'tool_use') {
          kind = 'tool_call';
          blocks.push({
            idx: bIdx++,
            type: 'tool_use',
            tool_name: typeof cObj['name'] === 'string' ? cObj['name'] : null,
            tool_call_id: typeof cObj['id'] === 'string' ? cObj['id'] : null,
            tool_input: cObj['input'] ? JSON.stringify(cObj['input']) : null,
          });
        } else if (typeStr === 'thinking') {
          blocks.push({
            idx: bIdx++,
            type: 'thinking',
            text: typeof cObj['thinking'] === 'string' ? cObj['thinking'] : '',
          });
        } else {
          blocks.push({
            idx: bIdx++,
            type: 'text',
            text: typeof cObj['text'] === 'string' ? cObj['text'] : '',
          });
        }
      }

      if (blocks.length === 0 && typeof messageObj.text === 'string') {
        blocks.push({
          idx: bIdx++,
          type: 'text',
          text: messageObj.text,
        });
      }

      const projectedText = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');

      turns.push({
        external_id: uuid,
        parent_external_id: parentUuid,
        ordinal: ordinal++,
        role,
        kind,
        created_at: ts ?? createdAt,
        text: projectedText,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: isSidechain || recType === 'system',
        blocks,
      });
    }

    return turns;
  }
}

export class ClaudeCodeLocalAdapter implements Adapter<ClaudeCodeNativeSession> {
  readonly id: ProviderId = 'claude-code-local';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const evidence: string[] = [];
    const entries: string[] = [];
    const warnings: string[] = [];
    let confidence = 0;

    if (src.kind === 'dir') {
      const projDir = path.join(src.path, 'projects');
      if (fs.existsSync(projDir)) {
        confidence = 0.95;
        evidence.push(`Found Claude Code projects directory: ${projDir}`);
        this.collectJsonlFiles(projDir, entries, 50);
      } else {
        const base = path.basename(src.path).toLowerCase();
        if (base === '.claude') {
          confidence = 0.7;
          evidence.push('.claude directory signature');
        }
      }
    } else if (src.kind === 'file') {
      const base = path.basename(src.path).toLowerCase();
      if (base.endsWith('.jsonl')) {
        try {
          const sample = fs.readFileSync(src.path, { encoding: 'utf8', flag: 'r' }).slice(0, 8192);
          if (sample.includes('"sessionId"') && sample.includes('"parentUuid"') && sample.includes('"gitBranch"')) {
            confidence = 0.99;
            evidence.push('Discovered sessionId, parentUuid, and gitBranch in JSONL');
            entries.push(src.path);
          }
        } catch (err) {
          warnings.push(`File probe error: ${(err as Error).message}`);
        }
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

  private collectJsonlFiles(dir: string, out: string[], limit: number, depth = 0): void {
    if (depth > 4 || out.length >= limit) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.collectJsonlFiles(full, out, limit, depth + 1);
        } else if (entry.name.endsWith('.jsonl')) {
          out.push(full);
          if (out.length >= limit) break;
        }
      }
    } catch {
      // ignore
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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<ClaudeCodeNativeSession>[]> {
    const filePath = task.entry ?? task.src.path;
    ctx.log('info', `ClaudeCodeLocalAdapter parsing: ${filePath}`);

    let raw: Buffer;
    try {
      raw = fs.readFileSync(filePath);
    } catch (err) {
      ctx.log('error', `Failed reading Claude Code file: ${(err as Error).message}`);
      return [];
    }

    let sessionId: string | null = null;
    let cwd: string | null = null;
    let gitBranch: string | null = null;
    let version: string | null = null;
    let createdAt: number | null = null;
    let updatedAt: number | null = null;

    const records: ClaudeCodeNativeRecord[] = [];
    const parseIssues: IntegrityIssue[] = [];

    for (const line of iterJsonLines(raw)) {
      let record: ClaudeCodeNativeRecord;
      try {
        record = JSON.parse(line) as ClaudeCodeNativeRecord;
      } catch {
        parseIssues.push({
          code: 'truncated_stream',
          severity: 'warn',
          message: `Truncated or malformed JSONL line ignored in ${path.basename(filePath)}`,
        });
        continue;
      }

      if (typeof record.sessionId === 'string') sessionId = record.sessionId;
      if (typeof record.cwd === 'string') cwd = record.cwd;
      if (typeof record.gitBranch === 'string') gitBranch = record.gitBranch;
      if (typeof record.version === 'string') version = record.version;

      const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : null;
      if (ts) {
        if (!createdAt) createdAt = ts;
        updatedAt = ts;
      }

      partitionVendorFields(record, KNOWN_LINE_KEYS, ctx);
      records.push(record);
    }

    if (!sessionId && records.length === 0) return [];

    const nativeSession: ClaudeCodeNativeSession = {
      session_id: sessionId ?? path.basename(filePath, '.jsonl'),
      source_file: filePath,
      cwd,
      git_branch: gitBranch,
      version,
      records,
    };

    return [new ClaudeCodeSessionDocument(nativeSession, createdAt, updatedAt, parseIssues)];
  }
}

export const claudeCodeLocalAdapter = new ClaudeCodeLocalAdapter();
