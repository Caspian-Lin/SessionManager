import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  OCA_SPILL_THRESHOLD_BYTES,
  sha256Hex,
  type OcaBlock,
  type OcaConversationDraft,
  type OcaItemDraft,
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
      // In case of multiple frames or external decoder requirement, return raw
      return buf;
    }
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

export class CodexLocalAdapter implements Adapter {
  readonly id: OcaProviderId = 'codex-local';

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
          evidence.push(`Found Codex directory structure (sessions=${hasSessions}, sqlite=${hasSqlite}, index=${hasIndex})`);

          // Collect sample rollout files from sessions
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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<OcaConversationDraft[]> {
    const filePath = task.entry ?? task.src.path;
    ctx.log('info', `CodexLocalAdapter parsing file: ${filePath}`);

    let buf: Buffer;
    try {
      buf = readBufferMaybeZstd(filePath);
    } catch (err) {
      ctx.log('error', `Failed reading Codex rollout ${filePath}: ${(err as Error).message}`);
      return [];
    }

    const lines = buf.toString('utf8').split('\n');

    let sessionId: string | null = null;
    let cwd: string | null = null;
    let originator: string | null = null;
    let cliVersion: string | null = null;
    let modelProvider: string | null = null;
    let baseInstructionsSha: string | null = null;
    let createdAt: number | null = null;
    let updatedAt: number | null = null;
    let unmappedMeta: Record<string, unknown> | undefined;

    const items: OcaItemDraft[] = [];
    let ordinal = 0;
    let prevItemId: string | null = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        // Tolerant to truncated tail lines
        continue;
      }

      const recordType = typeof record['type'] === 'string' ? record['type'] : '';
      const timestampStr = typeof record['timestamp'] === 'string' ? record['timestamp'] : null;
      const ts = timestampStr ? Date.parse(timestampStr) : null;
      if (ts) {
        if (!createdAt) createdAt = ts;
        updatedAt = ts;
      }

      const payload = (record['payload'] ?? {}) as Record<string, unknown>;

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

        // Hash base instructions rather than storing giant prompt in body
        if (typeof payload['base_instructions'] === 'string') {
          baseInstructionsSha = sha256Hex(payload['base_instructions']);
        }

        unmappedMeta = partitionVendorFields(payload, KNOWN_META_KEYS, ctx);
      } else if (recordType === 'turn_context') {
        const turnId = typeof payload['turn_id'] === 'string' ? payload['turn_id'] : `turn-${ordinal}`;
        const itemId = `tc-${turnId}-${ordinal}`;
        items.push({
          external_id: itemId,
          parent_external_id: prevItemId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'turn_context',
          created_at: ts ?? createdAt,
          text: `Turn context: ${turnId}`,
          text_len: 20,
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
          ext: {
            codex: {
              turn_id: turnId,
              collaboration_mode_kind:
                typeof payload['collaboration_mode_kind'] === 'string' ? payload['collaboration_mode_kind'] : null,
            },
          },
        });
        prevItemId = itemId;
      } else if (recordType === 'response_item') {
        const rawRole = typeof payload['role'] === 'string' ? payload['role'].toLowerCase() : 'assistant';
        const role: OcaRole = rawRole === 'user' ? 'user' : 'assistant';
        const itemId = `item-${sessionId ?? 's'}-${ordinal}`;

        const contentArr = Array.isArray(payload['content']) ? payload['content'] : [];
        const blocks: OcaBlock[] = [];
        let bIdx = 0;

        for (const c of contentArr) {
          if (!c || typeof c !== 'object') continue;
          const cObj = c as Record<string, unknown>;
          const text = typeof cObj['text'] === 'string' ? cObj['text'] : '';

          let payloadRef: string | null = null;
          if (Buffer.byteLength(text, 'utf8') > OCA_SPILL_THRESHOLD_BYTES) {
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

        items.push({
          external_id: itemId,
          parent_external_id: prevItemId,
          ordinal: ordinal++,
          role,
          kind: 'message',
          created_at: ts ?? createdAt,
          text: projectedText,
          text_len: projectedText.length,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          blocks,
          ext: {
            codex: {
              originator,
              cli_version: cliVersion,
              model_provider: modelProvider,
              base_instructions_sha256: baseInstructionsSha,
              rollout_ordinal: typeof record['ordinal'] === 'number' ? record['ordinal'] : ordinal,
            },
          },
        });
        prevItemId = itemId;
      }
    }

    if (!sessionId && items.length === 0) {
      return [];
    }

    return [
      {
        provider: this.id,
        external_id: sessionId ?? path.basename(filePath, path.extname(filePath)),
        title: null,
        title_source: null,
        cwd,
        created_at: createdAt,
        updated_at: updatedAt,
        default_model: modelProvider,
        items,
        ext: {
          codex: {
            originator,
            cli_version: cliVersion,
            model_provider: modelProvider,
            base_instructions_sha256: baseInstructionsSha,
          },
          ...(unmappedMeta ? { _unmapped: unmappedMeta } : {}),
        },
      },
    ];
  }
}

export const codexLocalAdapter = new CodexLocalAdapter();
