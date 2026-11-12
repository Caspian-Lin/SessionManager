import fs from 'node:fs';
import {
  AdapterRegistry,
  defaultAdapterRegistry,
  type Adapter,
  type ImportTask,
  type ParseCtx,
  type ProbeResult,
  type SourceRef,
} from '@sm/adapters';
import {
  sha256Hex,
  validateAndNormalizeDraft,
  type OcaConversation,
  type OcaConversationDraft,
  type OcaIntegrityIssue,
  type OcaIntegrityReport,
  type OcaProviderId,
} from '@sm/oca';
import { decideConversationMerge, type DedupeDecision } from './deduper.js';
import { buildBatchDiffStats } from './diff-reporter.js';

export interface PipelineOptions {
  registry?: AdapterRegistry;
  existingConversations?: readonly OcaConversation[];
  previousBatchConversations?: readonly OcaConversation[];
  previousBatchId?: number | null;
  onCommit?: (conversations: OcaConversation[], report: OcaIntegrityReport) => Promise<void> | void;
}

export interface PipelineResult {
  sourceSha256: string;
  adapterId: string;
  adapterVersion: string;
  conversations: OcaConversation[];
  decisions: { externalId: string | null; decision: DedupeDecision }[];
  report: OcaIntegrityReport;
}

/**
 * Complete ImportPipeline orchestrating the 6-stage lifecycle:
 * stage -> probe -> parse -> validate -> dedupe -> commit
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
    const adapter = registry.get(bestProbe.adapterId as OcaProviderId);
    if (!adapter) {
      throw new Error(`Adapter ${bestProbe.adapterId} not found in registry`);
    }

    // ── 3. PARSE: Slice into tasks & parse into drafts ──────
    const unrecognizedFieldCounts: Record<string, number> = {};
    const issues: OcaIntegrityIssue[] = [];

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

    const drafts: OcaConversationDraft[] = [];
    for await (const task of adapter.plan(src, bestProbe)) {
      const taskDrafts = await adapter.parse(task, ctx);
      drafts.push(...taskDrafts);
    }

    // ── 4. VALIDATE: Validate & normalize into OcaConversation ──
    const conversations: OcaConversation[] = [];
    for (const draft of drafts) {
      const { conversation, issues: valIssues } = validateAndNormalizeDraft(draft);
      conversations.push(conversation);
      issues.push(...valIssues);
    }

    // ── 5. DEDUPE: Compare against existing conversations ───
    const existingMap = new Map<string, OcaConversation>();
    if (options?.existingConversations) {
      for (const ex of options.existingConversations) {
        if (ex.external_id) {
          existingMap.set(ex.external_id, ex);
        }
      }
    }

    const decisions: { externalId: string | null; decision: DedupeDecision }[] = [];
    for (const conv of conversations) {
      const matchedExisting = conv.external_id ? existingMap.get(conv.external_id) ?? null : null;
      const decision = decideConversationMerge(conv, matchedExisting);
      decisions.push({
        externalId: conv.external_id ?? null,
        decision,
      });
    }

    // Optional cross-batch diff calculation
    const diffStats = options?.previousBatchConversations
      ? buildBatchDiffStats(options.previousBatchConversations, conversations, options.previousBatchId)
      : undefined;

    // ── 6. COMMIT: Assemble report & finalize ────────────────
    const report: OcaIntegrityReport = {
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
      await options.onCommit(conversations, report);
    }

    return {
      sourceSha256,
      adapterId: bestProbe.adapterId,
      adapterVersion: bestProbe.version,
      conversations,
      decisions,
      report,
    };
  }
}
