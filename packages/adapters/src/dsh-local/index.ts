import fs from 'node:fs';
import path from 'node:path';
import {
  decompressZstd,
  isZstdBuffer,
  iterJsonLines,
  sha256Hex,
  type IntegrityIssue,
  type ProviderId,
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

export interface DshNativeEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: unknown;
  [key: string]: unknown;
}

export interface DshNativeSession {
  session_id: string;
  source_file: string;
  title?: string | null;
  cwd?: string | null;
  agent_preset?: string | null;
  delegation_depth?: number | null;
  permission_preset?: string | null;
  sandbox_mode?: string | null;
  events: DshNativeEvent[];
}

function readBufferMaybeZstd(filePath: string): Buffer {
  const buf = fs.readFileSync(filePath);
  if (isZstdBuffer(buf)) {
    return decompressZstd(buf);
  }
  return buf;
}

const KNOWN_EVENT_KEYS = ['type', 'seq', 'time', 'data'] as const;

export class DshSessionDocument extends BaseSessionDocument<DshNativeSession> {
  constructor(
    nativeData: DshNativeSession,
    createdAt: number | null,
    updatedAt: number | null,
    parseIssues: IntegrityIssue[] = []
  ) {
    super({
      provider: 'dsh-local',
      rawFormat: 'dsh-session/v4',
      nativeData,
      external_id: nativeData.session_id,
      title: nativeData.title ?? null,
      title_source: nativeData.title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      cwd: nativeData.cwd ?? null,
      parseIssues,
    });
  }

  protected projectTurns(): RawTurnProjection[] {
    const turns: RawTurnProjection[] = [];
    let ordinal = 0;
    let prevId: string | null = null;
    let latestTime: number | null = this.init.created_at ?? null;

    for (const record of this.nativeData.events) {
      const evtType = typeof record.type === 'string' ? record.type : '';
      const seq = typeof record.seq === 'number' ? record.seq : ordinal;
      if (typeof record.time === 'number') {
        latestTime = record.time < 10000000000 ? record.time * 1000 : record.time;
      }
      const data = record.data;

      if (evtType === 'user/message') {
        const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        const id = `dsh-${seq}`;
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'user',
          kind: 'message',
          created_at: latestTime,
          text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks: [{ idx: 0, type: 'text', text }],
        });
        prevId = id;
      } else if (evtType === 'agent/inbox/spliced') {
        const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        const id = `dsh-${seq}`;
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'system_note',
          created_at: latestTime,
          text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          blocks: [{ idx: 0, type: 'text', text }],
        });
        prevId = id;
      } else if (evtType === 'assistant/message') {
        const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        const id = `dsh-${seq}`;
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'assistant',
          kind: 'message',
          created_at: latestTime,
          text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks: [{ idx: 0, type: 'text', text }],
        });
        prevId = id;
      } else if (evtType === 'tool/call') {
        const id = `dsh-${seq}`;
        const inputStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'assistant',
          kind: 'tool_call',
          created_at: latestTime,
          text: inputStr,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks: [{ idx: 0, type: 'tool_use', tool_input: inputStr }],
        });
        prevId = id;
      } else if (evtType === 'tool/result') {
        const id = `dsh-${seq}`;
        const resStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'tool',
          kind: 'tool_result',
          created_at: latestTime,
          text: resStr,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks: [{ idx: 0, type: 'tool_result', text: resStr }],
        });
        prevId = id;
      } else if (evtType.startsWith('compaction/')) {
        const id = `dsh-${seq}`;
        const summary = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'compaction',
          created_at: latestTime,
          text: summary,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          blocks: [{ idx: 0, type: 'text', text: summary }],
        });
        prevId = id;
      }
    }

    return turns;
  }
}

export class DshLocalAdapter implements Adapter<DshNativeSession> {
  readonly id: ProviderId = 'dsh-local';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const evidence: string[] = [];
    const entries: string[] = [];
    const warnings: string[] = [];
    let confidence = 0;

    if (src.kind === 'dir') {
      const base = path.basename(src.path).toLowerCase();
      if (base === '.dsh' || fs.existsSync(path.join(src.path, 'sessions'))) {
        confidence = 0.95;
        evidence.push(`Found DSH sessions directory in: ${src.path}`);
        this.collectSessionFiles(path.join(src.path, 'sessions'), entries, 50);
      }
    } else if (src.kind === 'file') {
      const base = path.basename(src.path);
      if (/^session(\.v\d+)?\.jsonl(\.zst|\.zstd)?$/i.test(base)) {
        confidence = 0.98;
        evidence.push(`Matched DSH session file pattern: ${base}`);
        entries.push(src.path);
      }
    }

    if (confidence <= 0) return null;

    return {
      adapterId: this.id,
      version: 'v4',
      confidence,
      evidence,
      entries,
      warnings,
    };
  }

  private collectSessionFiles(dir: string, out: string[], limit: number, depth = 0): void {
    if (depth > 5 || out.length >= limit) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.collectSessionFiles(full, out, limit, depth + 1);
        } else if (/^session(\.v\d+)?\.jsonl(\.zst|\.zstd)?$/i.test(entry.name)) {
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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<DshNativeSession>[]> {
    const filePath = task.entry ?? task.src.path;
    ctx.log('info', `DshLocalAdapter parsing: ${filePath}`);

    let buf: Buffer;
    try {
      buf = readBufferMaybeZstd(filePath);
    } catch (err) {
      ctx.log('error', `Failed reading DSH session file: ${(err as Error).message}`);
      return [];
    }

    let sessionId: string | null = null;
    let title: string | null = null;
    let cwd: string | null = null;
    let createdAt: number | null = null;
    let updatedAt: number | null = null;
    let agentPreset: string | null = null;
    let delegationDepth: number | null = null;
    let permissionPreset: string | null = null;
    let sandboxMode: string | null = null;

    const events: DshNativeEvent[] = [];
    const parseIssues: IntegrityIssue[] = [];

    for (const line of iterJsonLines(buf)) {
      let record: DshNativeEvent;
      try {
        record = JSON.parse(line) as DshNativeEvent;
      } catch {
        parseIssues.push({
          code: 'truncated_stream',
          severity: 'warn',
          message: `Malformed or truncated DSH event line skipped in ${path.basename(filePath)}`,
        });
        continue;
      }

      const evtType = typeof record.type === 'string' ? record.type : '';
      // Skip raw streaming delta chunks when storing native slice if final message exists,
      // keeping structural events intact
      if (evtType === 'assistant/chunk' || evtType.endsWith('-chunks')) {
        continue;
      }

      if (typeof record.time === 'number') {
        const ms = record.time < 10000000000 ? record.time * 1000 : record.time;
        if (!createdAt) createdAt = ms;
        updatedAt = ms;
      }

      const data = record.data as Record<string, unknown> | string | undefined;
      partitionVendorFields(record, KNOWN_EVENT_KEYS, ctx);

      if (evtType === 'session' && data && typeof data === 'object') {
        const dObj = data as Record<string, unknown>;
        sessionId = typeof dObj['id'] === 'string' ? dObj['id'] : sessionId;
        cwd = typeof dObj['cwd'] === 'string' ? dObj['cwd'] : cwd;
        agentPreset = typeof dObj['agentPreset'] === 'string' ? dObj['agentPreset'] : null;
        delegationDepth = typeof dObj['delegationDepth'] === 'number' ? dObj['delegationDepth'] : null;
      } else if (evtType === 'session/title') {
        if (typeof data === 'string') {
          title = data;
        } else if (data && typeof data === 'object' && typeof data['title'] === 'string') {
          title = data['title'];
        }
      } else if (evtType === 'permission/preset' && typeof data === 'string') {
        permissionPreset = data;
      } else if (evtType === 'sandbox/mode' && typeof data === 'string') {
        sandboxMode = data;
      }

      events.push(record);
    }

    if (!sessionId && events.length === 0) return [];

    const nativeSession: DshNativeSession = {
      session_id: sessionId ?? path.basename(filePath),
      source_file: filePath,
      title,
      cwd,
      agent_preset: agentPreset,
      delegation_depth: delegationDepth,
      permission_preset: permissionPreset,
      sandbox_mode: sandboxMode,
      events,
    };

    return [new DshSessionDocument(nativeSession, createdAt, updatedAt, parseIssues)];
  }
}

export const dshLocalAdapter = new DshLocalAdapter();
