import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

const ZSTD_MAGIC = 0xfd2fb528;

function readBufferMaybeZstd(filePath: string): Buffer {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
    try {
      return zlib.zstdDecompressSync(buf);
    } catch {
      // In case of multi-frame zstd where native zlib fails, return raw buf for fallback or outer reader
      return buf;
    }
  }
  return buf;
}

const KNOWN_EVENT_KEYS = ['type', 'seq', 'time', 'data'] as const;

export class DshLocalAdapter implements Adapter {
  readonly id: OcaProviderId = 'dsh-local';

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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<OcaConversationDraft[]> {
    const filePath = task.entry ?? task.src.path;
    ctx.log('info', `DshLocalAdapter parsing: ${filePath}`);

    let buf: Buffer;
    try {
      buf = readBufferMaybeZstd(filePath);
    } catch (err) {
      ctx.log('error', `Failed reading DSH session file: ${(err as Error).message}`);
      return [];
    }

    const lines = buf.toString('utf8').split('\n');

    let sessionId: string | null = null;
    let title: string | null = null;
    let cwd: string | null = null;
    let createdAt: number | null = null;
    let updatedAt: number | null = null;
    let agentPreset: string | null = null;
    let delegationDepth: number | null = null;
    let permissionPreset: string | null = null;
    let sandboxMode: string | null = null;

    const items: OcaItemDraft[] = [];
    let ordinal = 0;
    let prevId: string | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const evtType = typeof record['type'] === 'string' ? record['type'] : '';
      const seq = typeof record['seq'] === 'number' ? record['seq'] : ordinal;
      const timeVal = typeof record['time'] === 'number' ? record['time'] : null;
      if (timeVal) {
        const ms = timeVal < 10000000000 ? timeVal * 1000 : timeVal;
        if (!createdAt) createdAt = ms;
        updatedAt = ms;
      }

      const data = record['data'] as Record<string, unknown> | string | undefined;
      const unmapped = partitionVendorFields(record, KNOWN_EVENT_KEYS, ctx);

      if (evtType === 'session') {
        if (data && typeof data === 'object') {
          const dObj = data as Record<string, unknown>;
          sessionId = typeof dObj['id'] === 'string' ? dObj['id'] : sessionId;
          cwd = typeof dObj['cwd'] === 'string' ? dObj['cwd'] : cwd;
          agentPreset = typeof dObj['agentPreset'] === 'string' ? dObj['agentPreset'] : null;
          delegationDepth = typeof dObj['delegationDepth'] === 'number' ? dObj['delegationDepth'] : null;
        }
      } else if (evtType === 'session/title') {
        if (typeof data === 'string') {
          title = data;
        } else if (data && typeof data === 'object' && typeof (data as Record<string, unknown>)['title'] === 'string') {
          title = (data as Record<string, unknown>)['title'] as string;
        }
      } else if (evtType === 'permission/preset') {
        if (typeof data === 'string') permissionPreset = data;
      } else if (evtType === 'sandbox/mode') {
        if (typeof data === 'string') sandboxMode = data;
      } else if (evtType === 'user/message') {
        const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        const id = `dsh-${seq}`;
        items.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'user',
          kind: 'message',
          created_at: updatedAt,
          text,
          text_len: text.length,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks: [{ idx: 0, type: 'text', text }],
          ext: {
            dsh: { seq, agent_preset: agentPreset },
            ...(unmapped ? { _unmapped: unmapped } : {}),
          },
        });
        prevId = id;
      } else if (evtType === 'agent/inbox/spliced') {
        // Spliced context injection (e.g. policy change) -> synthetic system item
        const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        const id = `dsh-${seq}`;
        items.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'system_note',
          created_at: updatedAt,
          text,
          text_len: text.length,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          blocks: [{ idx: 0, type: 'text', text }],
          ext: {
            dsh: { seq, sandbox_mode: sandboxMode },
            ...(unmapped ? { _unmapped: unmapped } : {}),
          },
        });
        prevId = id;
      } else if (evtType === 'assistant/message') {
        const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        const id = `dsh-${seq}`;
        items.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'assistant',
          kind: 'message',
          created_at: updatedAt,
          text,
          text_len: text.length,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks: [{ idx: 0, type: 'text', text }],
          ext: {
            dsh: { seq },
            ...(unmapped ? { _unmapped: unmapped } : {}),
          },
        });
        prevId = id;
      } else if (evtType === 'tool/call') {
        const id = `dsh-${seq}`;
        const inputStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
        items.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'assistant',
          kind: 'tool_call',
          created_at: updatedAt,
          text: inputStr,
          text_len: inputStr.length,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks: [{ idx: 0, type: 'tool_use', tool_input: inputStr }],
          ext: {
            dsh: { seq },
            ...(unmapped ? { _unmapped: unmapped } : {}),
          },
        });
        prevId = id;
      } else if (evtType === 'tool/result') {
        const id = `dsh-${seq}`;
        const resStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
        items.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'tool',
          kind: 'tool_result',
          created_at: updatedAt,
          text: resStr,
          text_len: resStr.length,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks: [{ idx: 0, type: 'tool_result', text: resStr }],
          ext: {
            dsh: { seq },
            ...(unmapped ? { _unmapped: unmapped } : {}),
          },
        });
        prevId = id;
      } else if (evtType.startsWith('compaction/')) {
        const id = `dsh-${seq}`;
        const summary = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        items.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'compaction',
          created_at: updatedAt,
          text: summary,
          text_len: summary.length,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          blocks: [{ idx: 0, type: 'text', text: summary }],
          ext: {
            dsh: { seq },
          },
        });
        prevId = id;
      }
    }

    if (!sessionId && items.length === 0) return [];

    return [
      {
        provider: this.id,
        external_id: sessionId ?? path.basename(filePath),
        title,
        title_source: title ? 'provider' : null,
        cwd,
        created_at: createdAt,
        updated_at: updatedAt,
        items,
        ext: {
          dsh: {
            agent_preset: agentPreset,
            delegation_depth: delegationDepth,
            permission_preset: permissionPreset,
            sandbox_mode: sandboxMode,
          },
        },
      },
    ];
  }
}

export const dshLocalAdapter = new DshLocalAdapter();
