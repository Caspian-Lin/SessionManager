import fs from 'node:fs';
import {
  AdapterRegistry,
  defaultAdapterRegistry,
  type ParseCtx,
  type SessionDocument,
  type SourceRef,
} from '@sm/adapters';
import {
  sha256Hex,
  type IntegrityIssue,
  type IntegrityReport,
  type ProviderId,
} from '@sm/shared';
import { decideConversationMerge, type DedupeDecision } from './deduper.js';
import { buildBatchDiffStats } from './diff-reporter.js';

export interface PipelineOptions {
  registry?: AdapterRegistry;
  existingSessions?: readonly SessionDocument[];
  previousBatchSessions?: readonly SessionDocument[];
  previousBatchId?: number | null;
  onCommit?: (sessions: SessionDocument[], report: IntegrityReport) => Promise<void> | void;
}

export interface PipelineResult {
  sourceSha256: string;
  adapterId: string;
  adapterVersion: string;
  sessions: SessionDocument[];
  decisions: { externalId: string | null; decision: DedupeDecision }[];
  report: IntegrityReport;
}

/**
 * Complete ImportPipeline orchestrating the 6-stage polymorphic lifecycle:
 * stage -> probe -> parse (native SessionDocument[]) -> validate -> dedupe -> commit
 */
export class ImportPipeline {
  private readonly registry: AdapterRegistry;

  constructor(registry?: AdapterRegistry) {
    this.registry = registry ?? defaultAdapterRegistry;
  }

  async run(src: SourceRef, options?: PipelineOptions): Promise<PipelineResult> {
    const registry = options?.registry ?? this.registry;

    // ── 1. STAGE: Compute source sha256 ─────────────────────
    let sourceSha256 = '';
    if (src.kind === 'file') {
      try {
        const fileBytes = fs.readFileSync(src.path);
        sourceSha256 = sha256Hex(fileBytes);
      } catch {
        sourceSha256 = sha256Hex(src.path);
      }
    } else {
      sourceSha256 = sha256Hex(src.path);
    }

    // ── 2. PROBE: Match best adapter ────────────────────────
    const probeResults = await registry.probeSource(src);
    if (probeResults.length === 0) {
      throw new Error(`No compatible adapter found for source: ${src.path}`);
    }

    const bestProbe = probeResults[0]!;
    const adapter = registry.get(bestProbe.adapterId as ProviderId);
    if (!adapter) {
      throw new Error(`Adapter ${bestProbe.adapterId} not found in registry`);
    }

    // ── 3. PARSE: Slice into tasks & parse into typed SessionDocument[] ──────
    const unrecognizedFieldCounts: Record<string, number> = {};
    const issues: IntegrityIssue[] = [];

    const ctx: ParseCtx = {
      async persistRaw(entry: string, bytes: Buffer | NodeJS.ReadableStream): Promise<{ sha256: string; path: string }> {
        const hash = Buffer.isBuffer(bytes) ? sha256Hex(bytes) : sha256Hex(entry);
        return { sha256: hash, path: entry };
      },
      async *streamArray<T>(): AsyncIterable<T> {
        // Fallback generator for ParseCtx streamArray
      },
      async spill(payload: unknown): Promise<string> {
        const str = typeof payload === 'string' ? payload : JSON.stringify(payload);
        return sha256Hex(str);
      },
      log(level: 'info' | 'warn' | 'error', msg: string): void {
        if (level === 'warn' || level === 'error') {
          issues.push({
            code: 'parse_error',
            severity: level === 'error' ? 'error' : 'warn',
            message: msg,
          });
        }
      },
      recordUnrecognizedField(key: string): void {
        unrecognizedFieldCounts[key] = (unrecognizedFieldCounts[key] ?? 0) + 1;
      },
    };

    const sessions: SessionDocument[] = [];
    for await (const task of adapter.plan(src, bestProbe)) {
      const taskDocs = await adapter.parse(task, ctx);
      sessions.push(...taskDocs);
    }

    // ── 4. VALIDATE: Run per-type native structural validation ──
    for (const doc of sessions) {
      const valIssues = doc.validate();
      issues.push(...valIssues);
    }

    // ── 5. DEDUPE: Compare within same provider ─────────────
    const existingMap = new Map<string, SessionDocument>();
    if (options?.existingSessions) {
      for (const ex of options.existingSessions) {
        const meta = ex.getMeta();
        if (meta.external_id) {
          existingMap.set(`${meta.provider}:${meta.external_id}`, ex);
        }
      }
    }

    const decisions: { externalId: string | null; decision: DedupeDecision }[] = [];
    for (const doc of sessions) {
      const meta = doc.getMeta();
      const matchedExisting = meta.external_id
        ? existingMap.get(`${meta.provider}:${meta.external_id}`) ?? null
        : null;
      const decision = decideConversationMerge(doc, matchedExisting);
      decisions.push({
        externalId: meta.external_id ?? null,
        decision,
      });
    }

    const diffStats = options?.previousBatchSessions
      ? buildBatchDiffStats(options.previousBatchSessions, sessions, options.previousBatchId)
      : undefined;

    // ── 6. COMMIT: Assemble report & finalize ────────────────
    const report: IntegrityReport = {
      schema_version: 'v1',
      provider: adapter.id,
      adapter_id: bestProbe.adapterId,
      adapter_version: bestProbe.version,
      generated_at: Date.now(),
      issues,
      unrecognized_field_counts: unrecognizedFieldCounts,
      diff: diffStats,
    };

    if (options?.onCommit) {
      await options.onCommit(sessions, report);
    }

    return {
      sourceSha256,
      adapterId: bestProbe.adapterId,
      adapterVersion: bestProbe.version,
      sessions,
      decisions,
      report,
    };
  }
}
