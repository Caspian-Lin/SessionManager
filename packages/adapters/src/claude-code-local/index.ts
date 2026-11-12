import fs from 'node:fs';
import path from 'node:path';
import {
  sha256Hex,
  type OcaBlock,
  type OcaConversationDraft,
  type OcaItemDraft,
  type OcaItemKind,
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

export class ClaudeCodeLocalAdapter implements Adapter {
  readonly id: OcaProviderId = 'claude-code-local';

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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<OcaConversationDraft[]> {
    const filePath = task.entry ?? task.src.path;
    ctx.log('info', `ClaudeCodeLocalAdapter parsing: ${filePath}`);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      ctx.log('error', `Failed reading Claude Code file: ${(err as Error).message}`);
      return [];
    }

    const lines = raw.split('\n');

    let sessionId: string | null = null;
    let cwd: string | null = null;
    let gitBranch: string | null = null;
    let version: string | null = null;
    let createdAt: number | null = null;
    let updatedAt: number | null = null;

    const items: OcaItemDraft[] = [];
    let ordinal = 0;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (!line || !line.trim()) continue;

      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        // Fault tolerant: ignore truncated last line or malformed line
        continue;
      }

      if (typeof record['sessionId'] === 'string') sessionId = record['sessionId'];
      if (typeof record['cwd'] === 'string') cwd = record['cwd'];
      if (typeof record['gitBranch'] === 'string') gitBranch = record['gitBranch'];
      if (typeof record['version'] === 'string') version = record['version'];

      const tsStr = typeof record['timestamp'] === 'string' ? record['timestamp'] : null;
      const ts = tsStr ? Date.parse(tsStr) : null;
      if (ts) {
        if (!createdAt) createdAt = ts;
        updatedAt = ts;
      }

      const recType = typeof record['type'] === 'string' ? record['type'] : 'user';
      const uuid = typeof record['uuid'] === 'string' ? record['uuid'] : `cc-${ordinal}`;
      const parentUuid = typeof record['parentUuid'] === 'string' ? record['parentUuid'] : null;
      const isSidechain = Boolean(record['isSidechain']);
      const userType = typeof record['userType'] === 'string' ? record['userType'] : null;

      const unmapped = partitionVendorFields(record, KNOWN_LINE_KEYS, ctx);

      if (recType === 'summary') {
        const summaryText = typeof record['summary'] === 'string' ? record['summary'] : '';
        const leafUuid = typeof record['leafUuid'] === 'string' ? record['leafUuid'] : null;

        items.push({
          external_id: uuid,
          parent_external_id: parentUuid ?? leafUuid,
          ordinal: ordinal++,
          role: 'system',
          kind: 'compaction',
          created_at: ts ?? createdAt,
          text: summaryText,
          text_len: summaryText.length,
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
          ext: {
            claude_code: {
              leaf_uuid: leafUuid,
            },
            ...(unmapped ? { _unmapped: unmapped } : {}),
          },
        });
        continue;
      }

      const messageObj = (record['message'] ?? {}) as Record<string, unknown>;
      const rawRole = typeof messageObj['role'] === 'string' ? messageObj['role'] : recType;
      const contentArr = Array.isArray(messageObj['content']) ? messageObj['content'] : [];

      let role: OcaRole = rawRole === 'assistant' ? 'assistant' : rawRole === 'system' ? 'system' : 'user';
      let kind: OcaItemKind = 'message';

      const blocks: OcaBlock[] = [];
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

      if (blocks.length === 0 && typeof messageObj['text'] === 'string') {
        blocks.push({
          idx: bIdx++,
          type: 'text',
          text: messageObj['text'],
        });
      }

      const projectedText = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');

      items.push({
        external_id: uuid,
        parent_external_id: parentUuid,
        ordinal: ordinal++,
        role,
        kind,
        created_at: ts ?? createdAt,
        text: projectedText,
        text_len: projectedText.length,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: isSidechain || recType === 'system',
        blocks,
        ext: {
          claude_code: {
            git_branch: gitBranch,
            user_type: userType,
            version,
            sidechain: isSidechain,
          },
          ...(unmapped ? { _unmapped: unmapped } : {}),
        },
      });
    }

    if (!sessionId && items.length === 0) return [];

    return [
      {
        provider: this.id,
        external_id: sessionId ?? path.basename(filePath, '.jsonl'),
        title: null,
        title_source: null,
        cwd,
        created_at: createdAt,
        updated_at: updatedAt,
        items,
        ext: {
          claude_code: {
            git_branch: gitBranch,
            version,
          },
        },
      },
    ];
  }
}

export const claudeCodeLocalAdapter = new ClaudeCodeLocalAdapter();
