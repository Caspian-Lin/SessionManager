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
    model?: string;
    content?: string | unknown[];
    text?: string;
  };
  summary?: string;
  leafUuid?: string;
  [key: string]: unknown;
}

export interface ClaudeCodeNativeSession {
  session_id: string;
  source_file: string;
  source_files?: string[];
  parent_session_id?: string | null;
  is_subagent?: boolean;
  subagent_name?: string | null;
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
  'agentId',
  'userType',
  'version',
  'message',
  'summary',
  'leafUuid',
] as const;

function isSubagentJsonlFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return /(?:^|\/)subagents\//i.test(normalized) || /^agent-/i.test(path.basename(filePath));
}

function readHeaderInfo(filePath: string): { sessionId: string | null; agentId: string | null; isSidechain: boolean } {
  let sessionId: string | null = null;
  let agentId: string | null = null;
  let isSidechain = false;
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16384);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of iterJsonLines(buf.subarray(0, bytesRead))) {
      try {
        const rec = JSON.parse(line) as { sessionId?: unknown; agentId?: unknown; isSidechain?: unknown };
        if (!sessionId && typeof rec.sessionId === 'string' && rec.sessionId.trim().length > 0) {
          sessionId = rec.sessionId.trim();
        }
        if (!agentId && typeof rec.agentId === 'string' && rec.agentId.trim().length > 0) {
          agentId = rec.agentId.trim();
        }
        if (rec.isSidechain === true) {
          isSidechain = true;
        }
      } catch {
        // continue to next complete line
      }
    }
  } catch {
    // ignore
  }
  return { sessionId, agentId, isSidechain };
}

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
      parent_external_id: nativeData.parent_session_id ?? null,
      is_subagent: Boolean(nativeData.is_subagent || nativeData.parent_session_id),
      subagent_name: nativeData.subagent_name ?? null,
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
      const parsedTs = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
      const ts = Number.isNaN(parsedTs) ? null : parsedTs;
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
      const msgModel = typeof messageObj.model === 'string' ? messageObj.model : null;

      let role: SessionRole = rawRole === 'assistant' ? 'assistant' : rawRole === 'system' ? 'system' : 'user';
      let kind: TurnKind = 'message';

      const blocks: ViewBlock[] = [];
      let bIdx = 0;

      if (typeof messageObj.content === 'string') {
        blocks.push({ idx: bIdx++, type: 'text', text: messageObj.content });
      } else if (Array.isArray(messageObj.content)) {
        let sawToolResult = false;
        let sawNonToolContent = false;
        for (const c of messageObj.content) {
          if (typeof c === 'string') {
            sawNonToolContent = true;
            blocks.push({ idx: bIdx++, type: 'text', text: c });
            continue;
          }
          if (!c || typeof c !== 'object') continue;
          const cObj = c as Record<string, unknown>;
          const typeStr = typeof cObj['type'] === 'string' ? cObj['type'] : 'text';

          if (typeStr === 'tool_result') {
            sawToolResult = true;
            kind = 'tool_result';
            const contentVal = cObj['content'];
            blocks.push({
              idx: bIdx++,
              type: 'tool_result',
              tool_call_id: typeof cObj['tool_use_id'] === 'string' ? cObj['tool_use_id'] : null,
              text: typeof contentVal === 'string' ? contentVal : JSON.stringify(contentVal ?? ''),
            });
          } else if (typeStr === 'tool_use') {
            sawNonToolContent = true;
            kind = 'tool_call';
            blocks.push({
              idx: bIdx++,
              type: 'tool_use',
              tool_name: typeof cObj['name'] === 'string' ? cObj['name'] : null,
              tool_call_id: typeof cObj['id'] === 'string' ? cObj['id'] : null,
              tool_input: cObj['input'] ? JSON.stringify(cObj['input']) : null,
            });
          } else if (typeStr === 'thinking') {
            sawNonToolContent = true;
            blocks.push({
              idx: bIdx++,
              type: 'thinking',
              text: typeof cObj['thinking'] === 'string' ? cObj['thinking'] : '',
            });
          } else {
            sawNonToolContent = true;
            blocks.push({
              idx: bIdx++,
              type: 'text',
              text: typeof cObj['text'] === 'string' ? cObj['text'] : '',
            });
          }
        }
        if (sawToolResult && !sawNonToolContent) {
          role = 'tool';
        } else if (sawToolResult && role === 'user') {
          role = 'tool';
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
        model: msgModel,
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
  private readonly plannedGroups = new Map<string, string[]>();

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
        this.collectJsonlFiles(projDir, entries, 2000);
      } else {
        const directJsonls: string[] = [];
        this.collectJsonlFiles(src.path, directJsonls, 2000, 1);
        for (const jf of directJsonls) {
          try {
            const sample = fs.readFileSync(jf, 'utf8').slice(0, 8192);
            if (sample.includes('"sessionId"') && sample.includes('"parentUuid"')) {
              confidence = 0.95;
              entries.push(jf);
            }
          } catch {
            // ignore
          }
        }
        if (entries.length > 0) {
          evidence.push(`Found ${entries.length} Claude Code project JSONL file(s) in ${src.path}`);
        } else if (path.basename(src.path).toLowerCase() === '.claude') {
          confidence = 0.7;
          evidence.push('.claude directory signature');
        }
      }
    } else if (src.kind === 'file') {
      const base = path.basename(src.path).toLowerCase();
      if (base.endsWith('.jsonl')) {
        try {
          const sample = fs.readFileSync(src.path, { encoding: 'utf8', flag: 'r' }).slice(0, 8192);
          if (sample.includes('"sessionId"') && sample.includes('"parentUuid"')) {
            confidence = sample.includes('"gitBranch"') ? 0.99 : 0.94;
            evidence.push('Discovered sessionId and parentUuid in JSONL');
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
    if (src.kind === 'dir' && probe.entries.length > 1) {
      const groups = new Map<string, string[]>();
      for (const entry of probe.entries) {
        const header = readHeaderInfo(entry);
        const sid = header.sessionId ?? `file::${entry}`;
        let groupKey = sid;
        if (isSubagentJsonlFile(entry) || (header.isSidechain && header.agentId !== null)) {
          const baseName = path.basename(entry, '.jsonl');
          const agentTag = header.agentId ?? (baseName.replace(/^agent-/i, '') || baseName);
          groupKey = `${sid}:subagent:${agentTag}`;
        }
        const list = groups.get(groupKey) ?? [];
        list.push(entry);
        groups.set(groupKey, list);
      }

      for (const [sid, groupFiles] of groups.entries()) {
        groupFiles.sort();
        let totalSize = 0;
        for (const f of groupFiles) {
          try {
            totalSize += fs.statSync(f).size;
          } catch {
            // ignore
          }
        }
        const taskId = sha256Hex(`${src.path}#session:${sid}#${groupFiles.join('|')}`);
        this.plannedGroups.set(taskId, groupFiles);
        yield {
          id: taskId,
          src,
          entry: groupFiles[0],
          estimatedBytes: totalSize,
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
      const taskId = sha256Hex(`${src.path}#${entry}#0`);
      this.plannedGroups.set(taskId, [entry]);
      yield {
        id: taskId,
        src,
        entry,
        estimatedBytes: size,
      };
    }
  }

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<ClaudeCodeNativeSession>[]> {
    const filePaths = this.plannedGroups.get(task.id) ?? [task.entry ?? task.src.path];
    const primaryFile = filePaths[0] ?? task.src.path;
    ctx.log('info', `ClaudeCodeLocalAdapter parsing (${filePaths.length} file(s)): ${primaryFile}`);

    let sessionId: string | null = null;
    let agentId: string | null = null;
    let hasSidechainRecord = false;
    let cwd: string | null = null;
    let gitBranch: string | null = null;
    let version: string | null = null;
    let createdAt: number | null = null;
    let updatedAt: number | null = null;

    const recordEntries: Array<{ record: ClaudeCodeNativeRecord; ts: number; seqIdx: number }> = [];
    const seenUuids = new Map<string, number>();
    const parseIssues: IntegrityIssue[] = [];
    let globalIdx = 0;

    for (const filePath of filePaths) {
      let raw: Buffer;
      try {
        raw = fs.readFileSync(filePath);
      } catch (err) {
        ctx.log('error', `Failed reading Claude Code file ${filePath}: ${(err as Error).message}`);
        continue;
      }

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
        if (typeof record['agentId'] === 'string') agentId = record['agentId'];
        if (record.isSidechain === true) hasSidechainRecord = true;
        if (typeof record.cwd === 'string') cwd = record.cwd;
        if (typeof record.gitBranch === 'string') gitBranch = record.gitBranch;
        if (typeof record.version === 'string') version = record.version;

        const parsedTs = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
        const ts = Number.isNaN(parsedTs) ? null : parsedTs;
        if (ts !== null) {
          if (createdAt === null || ts < createdAt) createdAt = ts;
          if (updatedAt === null || ts > updatedAt) updatedAt = ts;
        }

        partitionVendorFields(record, KNOWN_LINE_KEYS, ctx);
        const sortTs = ts ?? Number.MAX_SAFE_INTEGER;
        const uuid = typeof record.uuid === 'string' ? record.uuid : null;

        if (uuid && seenUuids.has(uuid)) {
          const prevSlot = seenUuids.get(uuid)!;
          recordEntries[prevSlot] = { record, ts: sortTs, seqIdx: recordEntries[prevSlot]!.seqIdx };
        } else {
          if (uuid) seenUuids.set(uuid, recordEntries.length);
          recordEntries.push({ record, ts: sortTs, seqIdx: globalIdx++ });
        }
      }
    }

    if (filePaths.length > 1) {
      recordEntries.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.seqIdx - b.seqIdx));
    }

    const records = recordEntries.map((e) => e.record);
    if (!sessionId && records.length === 0) return [];

    const isSubagentFile = filePaths.every((f) => isSubagentJsonlFile(f));
    const isSubagent = isSubagentFile || (hasSidechainRecord && (Boolean(agentId) || /^agent-/i.test(path.basename(primaryFile))));
    const baseName = path.basename(primaryFile, '.jsonl');
    const resolvedAgentTag = agentId ?? (baseName.replace(/^agent-/i, '') || baseName);
    const parentSessionId = isSubagent && sessionId ? sessionId : null;
    const effectiveExternalId =
      isSubagent && parentSessionId
        ? `${parentSessionId}:subagent:${resolvedAgentTag}`
        : sessionId ?? baseName;

    const nativeSession: ClaudeCodeNativeSession = {
      session_id: effectiveExternalId,
      source_file: primaryFile,
      source_files: filePaths.length > 1 ? filePaths : undefined,
      parent_session_id: parentSessionId,
      is_subagent: isSubagent,
      subagent_name: isSubagent ? resolvedAgentTag : null,
      cwd,
      git_branch: gitBranch,
      version,
      records,
    };

    return [new ClaudeCodeSessionDocument(nativeSession, createdAt, updatedAt, parseIssues)];
  }
}

export const claudeCodeLocalAdapter = new ClaudeCodeLocalAdapter();
