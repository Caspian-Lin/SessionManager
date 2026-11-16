import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AdapterRegistry,
  defaultAdapterRegistry,
  type ImportTask,
  type ParseCtx,
  type ProbeResult,
  type SessionDocument,
  type SourceRef,
} from '@sm/adapters';
import {
  computeLshBands,
  decodeMinHash128,
  sha256Hex,
  streamTopLevelJsonArray,
  type BlobAsset,
  type ConversationViewModel,
  type IntegrityIssue,
  type IntegrityReport,
  type ItemStatus,
  type ProviderId,
  type SessionRole,
  type TitleSource,
  type TurnKind,
  type ViewBlock,
  type ViewNode,
} from '@sm/shared';
import {
  ArchiveRepository,
  BlobStore,
  RawStore,
  type ArchiveDatabase,
  type ConversationRow,
  type InsertItemInput,
  type ItemRow,
} from '@sm/store';
import {
  decideConversationMerge,
  estimateConversationSimilarity,
  isSubsequence,
  type DedupeDecision,
} from './deduper.js';
import { buildBatchDiffStats } from './diff-reporter.js';

export interface PipelineStorageOptions {
  db: ArchiveDatabase;
  repository?: ArchiveRepository;
  rawStore?: RawStore;
  blobStore?: BlobStore;
  archiveRoot?: string;
  batchKind?: string;
  accountId?: number | null;
}

export type PipelineStage = 'probe' | 'plan' | 'parse' | 'commit' | 'done';

export interface PipelineProgressEvent {
  stage: PipelineStage;
  adapterId?: string;
  completed: number;
  total: number;
  skipped: number;
  bytesProcessed: number;
  totalBytes: number;
  currentEntry?: string;
}

export interface PipelineOptions {
  registry?: AdapterRegistry;
  existingSessions?: readonly SessionDocument[];
  previousBatchSessions?: readonly SessionDocument[];
  previousBatchId?: number | null;
  incremental?: boolean;
  concurrency?: number;
  storage?: PipelineStorageOptions;
  onProgress?: (event: PipelineProgressEvent) => void;
  onCommit?: (sessions: SessionDocument[], report: IntegrityReport) => Promise<void> | void;
}

export interface PipelineDecisionEntry {
  externalId: string | null;
  conversationId?: number;
  matchedConversationId?: number | null;
  decision: DedupeDecision;
  similarity?: number;
}

export interface PipelineResult {
  sourceSha256: string;
  adapterId: string;
  adapterVersion: string;
  batchId?: number;
  skipped_identical_batch?: boolean;
  skipped_unchanged_files?: number;
  sessions: SessionDocument[];
  decisions: PipelineDecisionEntry[];
  report: IntegrityReport;
}

interface StoredConversationEntry {
  row: ConversationRow;
  view: ConversationViewModel;
  resetView?: () => void;
}

const TRANSIENT_SQLITE_SUFFIXES = ['-wal', '-shm', '-journal'];
const IGNORED_DIR_NAMES = new Set([
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
  '.tmp',
  'tmp',
  'cache',
  'node_modules',
  'dsh-runtimes',
  'ds-harness-remote',
  'vendor_imports',
  'worktrees',
  'shell_snapshots',
  'log',
  'logs',
  'repos',
  'crash',
  'node-fallback',
  'plugin-workspace',
  'image-cache',
  'snapshot',
  'tool-output',
  'shell',
]);

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const cap = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIdx = 0;

  async function runWorker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx]!, idx);
    }
  }

  await Promise.all(Array.from({ length: cap }, () => runWorker()));
  return results;
}

async function hashFileSha256(filePath: string): Promise<{ sha256: string; size: number }> {
  const stat = await fs.promises.stat(filePath);
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { sha256: hash.digest('hex'), size: stat.size };
}

function collectFilesRecursive(dirPath: string, rootDir: string, out: string[]): void {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name.toLowerCase())) continue;
      collectFilesRecursive(fullPath, rootDir, out);
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (TRANSIENT_SQLITE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
        continue;
      }
      out.push(fullPath);
    }
  }
}

/**
 * Computes a deterministic SHA-256 digest for a file, SQLite database, or directory manifest.
 */
export async function computeSourceSha256(src: SourceRef, probe?: ProbeResult): Promise<string> {
  if (src.kind === 'file' || src.kind === 'sqlite') {
    try {
      const { sha256 } = await hashFileSha256(src.path);
      return sha256;
    } catch {
      return sha256Hex(src.path);
    }
  }

  try {
    let files: string[];
    const canUseProbeEntries =
      probe &&
      probe.adapterId !== 'sm-native' &&
      probe.entries.length > 0 &&
      probe.entries.every((e) => !e.includes('::') && !e.includes('#'));

    if (canUseProbeEntries) {
      files = [...new Set(probe.entries)].filter((f) => {
        try {
          return fs.statSync(f).isFile();
        } catch {
          return false;
        }
      });
    } else {
      files = [];
      collectFilesRecursive(src.path, src.path, files);
    }

    const withRel = files
      .map((fullPath) => ({
        fullPath,
        relPath: path.relative(src.path, fullPath).split(path.sep).join('/'),
      }))
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

    const hashed = await mapWithConcurrency(withRel, 8, async (item) => {
      const { sha256, size } = await hashFileSha256(item.fullPath);
      return { ...item, sha256, size };
    });

    const manifestHash = crypto.createHash('sha256');
    for (const entry of hashed) {
      manifestHash.update(`${entry.relPath}\0${entry.size}\0${entry.sha256}\n`);
    }
    return manifestHash.digest('hex');
  } catch {
    return sha256Hex(src.path);
  }
}

function deriveBatchKind(src: SourceRef): string {
  if (src.kind === 'dir') return 'local_dir';
  if (src.kind === 'sqlite') return 'sqlite';
  return src.path.toLowerCase().endsWith('.zip') ? 'export_zip' : 'single_file';
}

async function streamToBuffer(input: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
  if (Buffer.isBuffer(input)) return input;
  const chunks: Buffer[] = [];
  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8'));
  }
  return Buffer.concat(chunks);
}

function parseBlocksJson(blocksJson: string | null): ViewBlock[] {
  if (!blocksJson) return [];
  try {
    const parsed: unknown = JSON.parse(blocksJson);
    return Array.isArray(parsed) ? (parsed as ViewBlock[]) : [];
  } catch {
    return [];
  }
}

export function rowToSummaryViewModel(
  repo: ArchiveRepository,
  conv: ConversationRow
): ConversationViewModel {
  const items = repo.getConversationItemSummaries(conv.id);
  const idToExtId = new Map<number, string>();
  for (const item of items) {
    idToExtId.set(item.id, item.external_id ?? String(item.id));
  }

  const nodes: ViewNode[] = items.map((item) => ({
    external_id: item.external_id ?? String(item.id),
    parent_external_id:
      item.parent_id != null ? (idToExtId.get(item.parent_id) ?? null) : null,
    ordinal: item.ordinal,
    depth: item.depth,
    role: item.role as SessionRole,
    kind: item.kind as TurnKind,
    created_at: item.created_at,
    model: item.model,
    text: '',
    text_len: item.text_len,
    content_hash: item.content_hash,
    is_active_branch: item.is_active_branch === 1,
    is_hidden: item.is_hidden === 1,
    is_synthetic: item.is_synthetic === 1,
    status: (item.status as ItemStatus) ?? null,
    payload_ref: item.payload_ref,
    blocks: [],
  }));

  return {
    meta: {
      provider: conv.provider as ProviderId,
      external_id: conv.external_id,
      title: conv.title,
      title_source: (conv.title_source as TitleSource) ?? null,
      summary: conv.summary,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      exported_at: conv.exported_at,
      default_model: conv.default_model,
      cwd: conv.cwd,
      message_count: conv.item_count,
      char_count: conv.char_count,
      blob_count: conv.blob_count,
      head_hash: conv.head_hash,
      content_hash: conv.content_hash ?? '',
      fingerprint: conv.fingerprint ?? '',
      raw_format: conv.raw_format ?? '',
    },
    nodes,
    blobs: [],
  };
}

function makeStoredEntry(repo: ArchiveRepository, row: ConversationRow): StoredConversationEntry {
  let cached: ConversationViewModel | null = null;
  return {
    row,
    get view(): ConversationViewModel {
      if (!cached) {
        cached = rowToSummaryViewModel(repo, this.row);
      }
      return cached;
    },
    set view(v: ConversationViewModel) {
      cached = v;
    },
    resetView() {
      cached = null;
    },
  };
}

export function rowToViewModel(repo: ArchiveRepository, conv: ConversationRow): ConversationViewModel {
  const items: ItemRow[] = repo.getConversationItems(conv.id, true);
  const idToExtId = new Map<number, string>();
  for (const item of items) {
    idToExtId.set(item.id, item.external_id ?? String(item.id));
  }

  const nodes: ViewNode[] = items.map((item) => ({
    external_id: item.external_id ?? String(item.id),
    parent_external_id:
      item.parent_id != null ? (idToExtId.get(item.parent_id) ?? null) : null,
    ordinal: item.ordinal,
    depth: item.depth,
    role: item.role as SessionRole,
    kind: item.kind as TurnKind,
    created_at: item.created_at,
    model: item.model,
    text: item.text ?? '',
    text_len: item.text_len,
    content_hash: item.content_hash,
    is_active_branch: item.is_active_branch === 1,
    is_hidden: item.is_hidden === 1,
    is_synthetic: item.is_synthetic === 1,
    status: (item.status as ItemStatus) ?? null,
    payload_ref: item.payload_ref,
    blocks: parseBlocksJson(item.blocks_json),
  }));

  return {
    meta: {
      provider: conv.provider as ProviderId,
      external_id: conv.external_id,
      title: conv.title,
      title_source: (conv.title_source as TitleSource) ?? null,
      summary: conv.summary,
      created_at: conv.created_at,
      updated_at: conv.updated_at,
      exported_at: conv.exported_at,
      default_model: conv.default_model,
      cwd: conv.cwd,
      message_count: conv.item_count,
      char_count: conv.char_count,
      blob_count: conv.blob_count,
      head_hash: conv.head_hash,
      content_hash: conv.content_hash ?? '',
      fingerprint: conv.fingerprint ?? '',
      raw_format: conv.raw_format ?? '',
    },
    nodes,
    blobs: [],
  };
}

function buildInsertItems(doc: SessionDocument, view: ConversationViewModel): InsertItemInput[] {
  const toolNameByExtId = new Map<string, string | null>();
  for (const chunk of doc.extractSearchChunks()) {
    toolNameByExtId.set(chunk.external_id, chunk.tool_name);
  }

  return view.nodes.map((node) => ({
    external_id: node.external_id,
    parent_external_id: node.parent_external_id,
    ordinal: node.ordinal,
    depth: node.depth,
    role: node.role,
    kind: node.kind,
    created_at: node.created_at,
    model: node.model,
    tool_name: toolNameByExtId.get(node.external_id) ?? null,
    text: node.text,
    text_len: node.text_len,
    blocks: node.blocks,
    content_hash: node.content_hash,
    is_active_branch: node.is_active_branch,
    is_hidden: node.is_hidden,
    is_synthetic: node.is_synthetic,
    status: node.status,
    payload_ref: node.payload_ref,
  }));
}

function buildDiffPayload(
  decision: DedupeDecision,
  existingView: ConversationViewModel,
  incomingView: ConversationViewModel,
  similarity: number
): Record<string, unknown> {
  const oldSet = new Set(existingView.nodes.map((n) => n.content_hash));
  const newSet = new Set(incomingView.nodes.map((n) => n.content_hash));
  const addedHashes = [...newSet].filter((h) => !oldSet.has(h));
  const removedHashes = [...oldSet].filter((h) => !newSet.has(h));
  const commonCount = [...newSet].filter((h) => oldSet.has(h)).length;

  return {
    status: decision,
    similarity,
    common_count: commonCount,
    added_hashes: addedHashes,
    removed_hashes: removedHashes,
    previous_item_count: existingView.nodes.length,
    new_item_count: incomingView.nodes.length,
  };
}

class SameProviderIndex {
  readonly byExtId = new Map<string, StoredConversationEntry>();
  readonly byContentHash = new Map<string, StoredConversationEntry>();
  readonly byHeadHash = new Map<string, StoredConversationEntry[]>();
  readonly byLshBand = new Map<string, Set<StoredConversationEntry>>();
  readonly all: StoredConversationEntry[] = [];
  private readonly fpSigCache = new WeakMap<StoredConversationEntry, Uint32Array | null>();

  constructor(initialEntries: readonly StoredConversationEntry[]) {
    for (const entry of initialEntries) {
      this.add(entry);
    }
  }

  private getSig(entry: StoredConversationEntry): Uint32Array | null {
    if (this.fpSigCache.has(entry)) {
      return this.fpSigCache.get(entry) ?? null;
    }
    const fp = entry.row.fingerprint;
    if (!fp) {
      this.fpSigCache.set(entry, null);
      return null;
    }
    try {
      const sig = decodeMinHash128(fp);
      this.fpSigCache.set(entry, sig);
      return sig;
    } catch {
      this.fpSigCache.set(entry, null);
      return null;
    }
  }

  private static fastSigSim(a: Uint32Array, b: Uint32Array): number {
    let matches = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] === b[i]) matches++;
    }
    return len > 0 ? matches / len : 0;
  }

  add(entry: StoredConversationEntry): void {
    this.all.push(entry);
    this.indexEntry(entry);
  }

  update(entry: StoredConversationEntry, oldContentHash: string | null, oldHeadHash: string | null): void {
    if (oldContentHash && this.byContentHash.get(oldContentHash) === entry) {
      this.byContentHash.delete(oldContentHash);
    }
    if (oldHeadHash) {
      const list = this.byHeadHash.get(oldHeadHash);
      if (list) {
        this.byHeadHash.set(
          oldHeadHash,
          list.filter((e) => e !== entry)
        );
      }
    }
    this.indexEntry(entry);
  }

  private indexEntry(entry: StoredConversationEntry): void {
    const row = entry.row;
    if (row.external_id) {
      this.byExtId.set(row.external_id, entry);
    }
    if (row.content_hash && row.item_count > 0) {
      this.byContentHash.set(row.content_hash, entry);
    }
    if (row.head_hash) {
      const list = this.byHeadHash.get(row.head_hash) ?? [];
      if (!list.includes(entry)) list.push(entry);
      this.byHeadHash.set(row.head_hash, list);
    }
    if (row.fingerprint && row.item_count > 0) {
      try {
        for (const band of computeLshBands(row.fingerprint)) {
          let bucket = this.byLshBand.get(band);
          if (!bucket) {
            bucket = new Set();
            this.byLshBand.set(band, bucket);
          }
          bucket.add(entry);
        }
      } catch {
        // Ignore invalid legacy fingerprint
      }
    }
  }

  findMatch(doc: SessionDocument, view: ConversationViewModel): {
    matched: StoredConversationEntry | null;
    decision: DedupeDecision;
    similarity: number;
  } {
    const meta = view.meta;

    // Tier 1: Exact external_id match within same provider (fast-path when content_hash unchanged)
    if (meta.external_id) {
      const extMatch = this.byExtId.get(meta.external_id);
      if (extMatch) {
        if (
          extMatch.row.content_hash &&
          meta.content_hash &&
          extMatch.row.content_hash === meta.content_hash
        ) {
          return { matched: extMatch, decision: 'identical', similarity: 1.0 };
        }
        const decision = decideConversationMerge(doc, extMatch.view);
        const similarity = estimateConversationSimilarity(doc, extMatch.view);
        return { matched: extMatch, decision, similarity };
      }
    }

    if (view.nodes.length === 0) {
      return { matched: null, decision: 'new', similarity: 0 };
    }

    // Tier 2: Exact Merkle content_hash match
    const contentMatch = this.byContentHash.get(meta.content_hash);
    if (contentMatch) {
      return { matched: contentMatch, decision: 'identical', similarity: 1.0 };
    }

    // Tier 3 & 4: head_hash + LSH band candidates, falling back to same-provider scan
    const candidateSet = new Set<StoredConversationEntry>();
    if (meta.head_hash) {
      for (const cand of this.byHeadHash.get(meta.head_hash) ?? []) {
        candidateSet.add(cand);
      }
    }
    if (meta.fingerprint) {
      try {
        for (const band of computeLshBands(meta.fingerprint)) {
          for (const cand of this.byLshBand.get(band) ?? []) {
            candidateSet.add(cand);
          }
        }
      } catch {
        // Ignore malformed fingerprint
      }
    }

    let best = this.pickBestCandidate(doc, view, candidateSet);
    if (!best && this.all.length > candidateSet.size) {
      // LSH (16x8) has ~18% miss rate near 0.75 Jaccard; scan remaining recent conversations
      // using pre-decoded uint32 MinHash comparison and O(1) first-node check before running full diff.
      let incomingSig: Uint32Array | null = null;
      if (meta.fingerprint) {
        try {
          incomingSig = decodeMinHash128(meta.fingerprint);
        } catch {
          incomingSig = null;
        }
      }
      const incomingHashSet = new Set<string>();
      for (const n of view.nodes) {
        incomingHashSet.add(n.content_hash);
      }
      const incomingCount = view.nodes.length;

      const remaining = new Set<StoredConversationEntry>();
      const startIdx = Math.max(0, this.all.length - 1000);
      for (let i = startIdx; i < this.all.length; i++) {
        const cand = this.all[i]!;
        if (candidateSet.has(cand) || cand.row.item_count === 0) continue;

        let plausible = false;
        if (incomingSig) {
          const candSig = this.getSig(cand);
          if (candSig && SameProviderIndex.fastSigSim(incomingSig, candSig) >= 0.75) {
            plausible = true;
          }
        }
        if (!plausible && cand.row.item_count < incomingCount) {
          const firstNode = cand.view.nodes[0];
          if (firstNode && incomingHashSet.has(firstNode.content_hash)) {
            plausible = true;
          }
        }
        if (plausible) {
          remaining.add(cand);
        }
      }
      if (remaining.size > 0) {
        best = this.pickBestCandidate(doc, view, remaining);
      }
    }

    if (best) {
      return best;
    }

    return { matched: null, decision: 'new', similarity: 0 };
  }

  private pickBestCandidate(
    doc: SessionDocument,
    view: ConversationViewModel,
    candidates: Iterable<StoredConversationEntry>
  ): {
    matched: StoredConversationEntry;
    decision: DedupeDecision;
    similarity: number;
  } | null {
    let bestEntry: StoredConversationEntry | null = null;
    let bestDecision: DedupeDecision = 'new';
    let bestSim = 0;

    for (const cand of candidates) {
      if (cand.view.nodes.length === 0) continue;
      const decision = decideConversationMerge(doc, cand.view);
      if (decision === 'new') continue;
      const sim = estimateConversationSimilarity(view, cand.view);
      if (!bestEntry || sim > bestSim) {
        bestEntry = cand;
        bestDecision = decision;
        bestSim = sim;
      }
    }

    if (!bestEntry) return null;
    return { matched: bestEntry, decision: bestDecision, similarity: bestSim };
  }
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
    const emitProgress = (evt: PipelineProgressEvent) => {
      options?.onProgress?.(evt);
    };

    // ── 1. PROBE FIRST: Match best adapter so directory hashing skips runtimes/caches ──
    emitProgress({
      stage: 'probe',
      completed: 0,
      total: 0,
      skipped: 0,
      bytesProcessed: 0,
      totalBytes: 0,
      currentEntry: src.path,
    });
    const probeResults = await registry.probeSource(src);
    if (probeResults.length === 0) {
      throw new Error(`No compatible adapter found for source: ${src.path}`);
    }

    const bestProbe = probeResults[0]!;
    const adapter = registry.get(bestProbe.adapterId as ProviderId);
    if (!adapter) {
      throw new Error(`Adapter ${bestProbe.adapterId} not found in registry`);
    }

    // ── 2. STAGE: Compute deterministic source sha256 ───────
    const sourceSha256 = await computeSourceSha256(src, bestProbe);

    // ── Storage wiring & L0 Batch Idempotency Check ─────────
    const storageOpt = options?.storage;
    if (!storageOpt) {
      return this.runInMemory(src, sourceSha256, bestProbe, adapter, options);
    }

    const db = storageOpt.db;
    const repo = storageOpt.repository ?? new ArchiveRepository(db);
    const archiveRoot =
      storageOpt.archiveRoot ??
      (db.path !== ':memory:'
        ? path.dirname(path.resolve(db.path))
        : fs.mkdtempSync(path.join(os.tmpdir(), 'sm-archive-')));
    const rawStore = storageOpt.rawStore ?? new RawStore(archiveRoot);
    const blobStore = storageOpt.blobStore ?? new BlobStore(archiveRoot);
    const batchKind = storageOpt.batchKind ?? deriveBatchKind(src);

    const existingBatch = repo.findBatchBySourceSha(adapter.id, batchKind, sourceSha256);
    if (existingBatch && existingBatch.status === 'ok') {
      emitProgress({
        stage: 'done',
        adapterId: bestProbe.adapterId,
        completed: 1,
        total: 1,
        skipped: 1,
        bytesProcessed: 0,
        totalBytes: 0,
      });
      const existingReport: IntegrityReport = existingBatch.report_json
        ? (JSON.parse(existingBatch.report_json) as IntegrityReport)
        : {
            schema_version: 'v1',
            provider: adapter.id,
            adapter_id: bestProbe.adapterId,
            adapter_version: bestProbe.version,
            generated_at: existingBatch.imported_at,
            issues: [],
            unrecognized_field_counts: {},
          };
      return {
        sourceSha256,
        adapterId: bestProbe.adapterId,
        adapterVersion: bestProbe.version,
        batchId: existingBatch.id,
        skipped_identical_batch: true,
        sessions: [],
        decisions: [],
        report: existingReport,
      };
    }

    let batchId: number;
    if (existingBatch) {
      // Retry of previously failed/incomplete batch with same (provider, kind, source_sha256)
      batchId = existingBatch.id;
      db.prepare(`DELETE FROM import_file WHERE batch_id = ?`).run(batchId);
      db.prepare(`UPDATE import_batch SET status = 'running', imported_at = ? WHERE id = ?`).run(
        Date.now(),
        batchId
      );
    } else {
      batchId = repo.createBatch({
        provider: adapter.id,
        adapter_id: bestProbe.adapterId,
        adapter_version: bestProbe.version,
        account_id: storageOpt.accountId ?? null,
        kind: batchKind,
        source_path: src.path,
        source_sha256: sourceSha256,
        status: 'running',
      });
    }

    const unrecognizedFieldCounts: Record<string, number> = {};
    const issues: IntegrityIssue[] = [];
    const recordedFiles = new Set<string>();
    let persistedFileCount = 0;

    const recordImportFileOnce = (
      relPath: string,
      sha256: string,
      size: number,
      role: string,
      mtime: number | null = null
    ) => {
      const key = `${relPath}::${sha256}`;
      if (recordedFiles.has(key)) return;
      recordedFiles.add(key);
      persistedFileCount++;
      repo.insertImportFile({
        batch_id: batchId,
        rel_path: relPath,
        sha256,
        size,
        mtime,
        role,
        parsed_ok: true,
      });
    };

    try {
      // Record primary source file in import_file for single-file / sqlite imports
      if (src.kind === 'file' || src.kind === 'sqlite') {
        try {
          const stat = await fs.promises.stat(src.path);
          recordImportFileOnce(
            path.basename(src.path),
            sourceSha256,
            stat.size,
            'source',
            Math.floor(stat.mtimeMs)
          );
        } catch {
          // Ignore stat failures if virtual/missing
        }
      }

      // ── 3. PARSE: Real ParseCtx wired to RawStore, BlobStore & streamTopLevelJsonArray ──
      const ctx: ParseCtx = {
        async persistRaw(
          entry: string,
          bytes: Buffer | NodeJS.ReadableStream
        ): Promise<{ sha256: string; path: string }> {
          const buf = await streamToBuffer(bytes);
          const persisted = await rawStore.persistRaw(adapter.id, entry, buf);
          recordImportFileOnce(entry, persisted.sha256, persisted.size, 'raw_asset');
          return { sha256: persisted.sha256, path: persisted.relPath };
        },
        async *streamArray<T>(readable: NodeJS.ReadableStream): AsyncIterable<T> {
          const buf = await streamToBuffer(readable);
          for (const item of streamTopLevelJsonArray<T>(buf)) {
            yield item;
          }
        },
        async spill(payload, binary): Promise<string> {
          const asset = binary && Buffer.isBuffer(payload)
            ? await blobStore.putBlob(payload, binary.originKind, binary.mime, binary.ext)
            : await blobStore.spillPayload(payload, 'oversized_payload');
          repo.upsertBlob(asset);
          return asset.sha256;
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

      const incremental = options?.incremental !== false;
      const knownFiles = incremental && src.kind === 'dir'
        ? repo.getLatestImportFilesByProvider(adapter.id)
        : new Map();
      let skippedUnchangedFiles = 0;
      const skippedRelPaths = new Set<string>();
      const sessionSourceRelPath = new WeakMap<SessionDocument, { relPath: string; size: number }>();

      const checkAndRecordUnchanged = (absFilePath: string): boolean => {
        if (
          !incremental ||
          src.kind !== 'dir' ||
          adapter.id === 'sm-native' ||
          /\.(sqlite|sqlite3|db)$/i.test(absFilePath)
        ) {
          return false;
        }
        try {
          const st = fs.statSync(absFilePath);
          if (!st.isFile()) return false;
          const relPath = path.relative(src.path, absFilePath).replace(/\\/g, '/');
          const prevFile = knownFiles.get(relPath);
          if (!prevFile || prevFile.size !== st.size) return false;
          const mtimeMs = Math.floor(st.mtimeMs);
          if (prevFile.mtime === mtimeMs) {
            recordImportFileOnce(relPath, prevFile.sha256, st.size, 'source_unchanged', mtimeMs);
            skippedUnchangedFiles++;
            skippedRelPaths.add(relPath);
            return true;
          }
          const sha = sha256Hex(fs.readFileSync(absFilePath));
          if (sha === prevFile.sha256) {
            recordImportFileOnce(relPath, sha, st.size, 'source_unchanged', mtimeMs);
            skippedUnchangedFiles++;
            skippedRelPaths.add(relPath);
            return true;
          }
        } catch {
          // ignore
        }
        return false;
      };

      const diskFileMetaCache = new Map<
        string,
        Promise<{ relPath: string; size: number; sha256: string; mtimeMs: number } | null>
      >();

      const getDiskFileMeta = (absFilePath: string) => {
        const key = path.resolve(absFilePath);
        let pending = diskFileMetaCache.get(key);
        if (!pending) {
          pending = (async () => {
            try {
              const st = await fs.promises.stat(key);
              if (!st.isFile()) return null;
              const relPath = path.relative(src.path, key).replace(/\\/g, '/');
              const { sha256 } = await hashFileSha256(key);
              return { relPath, size: st.size, sha256, mtimeMs: Math.floor(st.mtimeMs) };
            } catch {
              return null;
            }
          })();
          diskFileMetaCache.set(key, pending);
        }
        return pending;
      };

      const recordDiskSourceFile = (absFilePath: string): void => {
        if (src.kind !== 'dir') return;
        const key = path.resolve(absFilePath);
        if (diskFileMetaCache.has(key)) return;
        try {
          const st = fs.statSync(key);
          if (!st.isFile()) return;
          const relPath = path.relative(src.path, key).replace(/\\/g, '/');
          const sha = sha256Hex(fs.readFileSync(key));
          const meta = { relPath, size: st.size, sha256: sha, mtimeMs: Math.floor(st.mtimeMs) };
          diskFileMetaCache.set(key, Promise.resolve(meta));
          recordImportFileOnce(relPath, sha, st.size, 'source', meta.mtimeMs);
        } catch {
          // ignore
        }
      };

      ctx.skipIfUnchanged = checkAndRecordUnchanged;
      ctx.recordSourceFile = recordDiskSourceFile;

      const plannedTasks: ImportTask[] = [];
      for await (const task of adapter.plan(src, bestProbe)) {
        plannedTasks.push(task);
      }

      const totalTasks = plannedTasks.length;
      const totalPlannedBytes = plannedTasks.reduce(
        (sum, t) => sum + Math.max(0, t.estimatedBytes || 0),
        0
      );
      emitProgress({
        stage: 'plan',
        adapterId: bestProbe.adapterId,
        completed: 0,
        total: totalTasks,
        skipped: 0,
        bytesProcessed: 0,
        totalBytes: totalPlannedBytes,
      });

      const workerConcurrency = Math.max(
        1,
        Math.min(options?.concurrency ?? Math.min(8, Math.max(2, os.cpus().length)), 16)
      );
      let completedTasks = 0;
      let bytesProcessed = 0;
      let lastProgressEmitMs = 0;

      const maybeEmitParseProgress = (currentEntry?: string, force = false) => {
        if (!options?.onProgress) return;
        const now = Date.now();
        if (!force && completedTasks < totalTasks && now - lastProgressEmitMs < 60) {
          return;
        }
        lastProgressEmitMs = now;
        emitProgress({
          stage: 'parse',
          adapterId: bestProbe.adapterId,
          completed: completedTasks,
          total: totalTasks,
          skipped: skippedUnchangedFiles,
          bytesProcessed,
          totalBytes: totalPlannedBytes,
          currentEntry,
        });
      };

      interface ParsedTaskSlot {
        docs: SessionDocument[];
        nativeBlobs: BlobAsset[];
        diskMetas: Array<{ doc: SessionDocument; relPath: string; size: number }>;
      }

      const parsedSlots = await mapWithConcurrency<ImportTask, ParsedTaskSlot>(
        plannedTasks,
        workerConcurrency,
        async (task) => {
          if (
            src.kind === 'dir' &&
            task.entry &&
            !task.entry.includes('::zip::') &&
            !task.entry.includes('#')
          ) {
            if (checkAndRecordUnchanged(task.entry)) {
              completedTasks++;
              bytesProcessed += Math.max(0, task.estimatedBytes || 0);
              maybeEmitParseProgress(task.entry);
              return { docs: [], nativeBlobs: [], diskMetas: [] };
            }
          }

          const taskDocs = await adapter.parse(task, ctx);
          const slotBlobs: BlobAsset[] = [];
          const diskMetas: Array<{ doc: SessionDocument; relPath: string; size: number }> = [];

          for (const td of taskDocs) {
            if (src.kind === 'dir') {
              const nativeSource = (td.nativeData as { source_file?: unknown } | null)?.source_file;
              const entryFile = task.entry ? task.entry.split('#')[0] : undefined;
              const diskFile =
                typeof nativeSource === 'string' && fs.existsSync(nativeSource)
                  ? nativeSource
                  : entryFile &&
                      !entryFile.includes('::zip::') &&
                      fs.existsSync(entryFile) &&
                      fs.statSync(entryFile).isFile()
                    ? entryFile
                    : null;
              if (diskFile) {
                const fileMeta = await getDiskFileMeta(diskFile);
                if (fileMeta) {
                  recordImportFileOnce(
                    fileMeta.relPath,
                    fileMeta.sha256,
                    fileMeta.size,
                    'source',
                    fileMeta.mtimeMs
                  );
                  diskMetas.push({ doc: td, relPath: fileMeta.relPath, size: fileMeta.size });
                }
              }
            }

            issues.push(...td.validate());
            const nativeBuf = Buffer.from(td.toNativeJson(), 'utf8');
            const asset = await blobStore.putBlob(
              nativeBuf,
              'native_session',
              'application/json',
              '.json'
            );
            slotBlobs.push(asset);
          }

          // Clear transient SQLite preloaded payload after parsing so memory stays flat
          if ('payload' in task) {
            task.payload = undefined;
          }

          completedTasks++;
          bytesProcessed += Math.max(0, task.estimatedBytes || 0);
          maybeEmitParseProgress(task.entry);
          return { docs: taskDocs, nativeBlobs: slotBlobs, diskMetas };
        }
      );

      maybeEmitParseProgress(undefined, true);

      const sessions: SessionDocument[] = [];
      const nativeBlobs: BlobAsset[] = [];
      for (const slot of parsedSlots) {
        for (const dm of slot.diskMetas) {
          sessionSourceRelPath.set(dm.doc, { relPath: dm.relPath, size: dm.size });
        }
        sessions.push(...slot.docs);
        nativeBlobs.push(...slot.nativeBlobs);
      }

      // ── 5 & 6. DEDUPE, DIFF & COMMIT IN TRANSACTION ──────
      emitProgress({
        stage: 'commit',
        adapterId: bestProbe.adapterId,
        completed: 0,
        total: sessions.length,
        skipped: skippedUnchangedFiles,
        bytesProcessed: totalPlannedBytes,
        totalBytes: totalPlannedBytes,
      });

      const prevBatch = repo.getLatestCompletedBatch(adapter.id, batchId);
      const providersInBatch = new Set<string>([adapter.id]);
      for (const doc of sessions) {
        providersInBatch.add(doc.provider);
      }
      const existingRows: ConversationRow[] = [];
      for (const prov of providersInBatch) {
        existingRows.push(...repo.getConversationsByProvider(prov, false));
      }
      const existingEntries: StoredConversationEntry[] = existingRows.map((row) =>
        makeStoredEntry(repo, row)
      );

      const prevSnapshotViews = options?.previousBatchSessions
        ? options.previousBatchSessions
        : prevBatch
          ? existingEntries
              .filter((entry) => entry.row.last_batch_id === prevBatch.id)
              .map((entry) => entry.view)
          : [];

      const effectiveNextSessions: Array<SessionDocument | ConversationViewModel> = [...sessions];
      if (skippedRelPaths.size > 0) {
        const parsedExtIds = new Set(
          sessions.map((s) => `${s.provider}:${s.getMeta().external_id ?? ''}`)
        );
        for (const entry of existingEntries) {
          const extId = entry.row.external_id;
          if (!extId || parsedExtIds.has(`${entry.row.provider}:${extId}`)) continue;
          const cursor = repo.getSyncCursor(entry.row.provider, extId);
          if (cursor?.file_rel_path && skippedRelPaths.has(cursor.file_rel_path)) {
            effectiveNextSessions.push(entry.view);
          }
        }
      }

      const diffStats = buildBatchDiffStats(
        prevSnapshotViews,
        effectiveNextSessions,
        options?.previousBatchId !== undefined ? options.previousBatchId : (prevBatch?.id ?? null)
      );

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

      const decisions: PipelineDecisionEntry[] = [];
      const decisionCounts: Record<DedupeDecision, number> = {
        new: 0,
        identical: 0,
        superset_append: 0,
        branch_revision: 0,
        auto_merge_fingerprint: 0,
        candidate_review: 0,
      };

      let totalItems = 0;
      const seenBlobShas = new Set<string>();

      db.transaction(() => {
        const index = new SameProviderIndex(existingEntries);

        for (let i = 0; i < sessions.length; i++) {
          const doc = sessions[i]!;
          const nativeBlob = nativeBlobs[i]!;
          const view = doc.toViewModel();
          const meta = view.meta;
          totalItems += view.nodes.length;

          // Upsert native session slice blob and all asset/spill blobs
          repo.upsertBlob(nativeBlob);
          seenBlobShas.add(nativeBlob.sha256);
          for (const asset of view.blobs) {
            repo.upsertBlob(asset);
            seenBlobShas.add(asset.sha256);
          }

          const { matched, decision, similarity } = index.findMatch(doc, view);
          decisionCounts[decision]++;
          const insertItems = buildInsertItems(doc, view);

          const projectId = meta.cwd ? repo.upsertProjectFromCwd(meta.cwd, meta.provider) : null;
          const subagentFlags: Record<string, unknown> | null =
            meta.is_subagent || meta.parent_external_id || meta.subagent_name
              ? {
                  ...(meta.parent_external_id
                    ? { parent_external_id: meta.parent_external_id }
                    : {}),
                  is_subagent: Boolean(meta.is_subagent || meta.parent_external_id),
                  ...(meta.subagent_name ? { subagent_name: meta.subagent_name } : {}),
                }
              : null;
          const srcInfo = sessionSourceRelPath.get(doc);
          const updateSyncCursor = () => {
            if (!meta.external_id) return;
            const maxOrd = view.nodes.reduce((m, n) => Math.max(m, n.ordinal), -1);
            let maxDshSeq: number | undefined;
            if (meta.provider === 'dsh-local') {
              for (const n of view.nodes) {
                const match = /^dsh-(\d+)$/.exec(n.external_id);
                if (match) {
                  const seqNum = Number(match[1]);
                  if (maxDshSeq === undefined || seqNum > maxDshSeq) maxDshSeq = seqNum;
                }
              }
            }
            repo.setSyncCursor(meta.provider, meta.external_id, {
              ...(meta.provider === 'codex-local' ? { next_rollout_ordinal: maxOrd + 1 } : {}),
              ...(maxDshSeq !== undefined ? { last_dsh_seq: maxDshSeq } : {}),
              ...(srcInfo ? { file_rel_path: srcInfo.relPath, file_size: srcInfo.size } : {}),
              updated_at: Date.now(),
            });
          };

          const updateMeta = {
            title: meta.title,
            title_source: meta.title_source,
            summary: meta.summary,
            updated_at: meta.updated_at,
            exported_at: meta.exported_at,
            default_model: meta.default_model,
            cwd: meta.cwd,
            project_id: projectId,
            blob_count: view.blobs.length,
            head_hash: meta.head_hash,
            content_hash: meta.content_hash,
            fingerprint: meta.fingerprint,
            raw_format: meta.raw_format,
            raw_blob_sha256: nativeBlob.sha256,
            ...(subagentFlags ? { flags_json: subagentFlags } : {}),
          };

          if (decision === 'new' || !matched) {
            const convId = repo.insertConversation({
              provider: meta.provider,
              account_id: storageOpt.accountId ?? null,
              external_id: meta.external_id,
              title: meta.title,
              title_source: meta.title_source,
              summary: meta.summary,
              created_at: meta.created_at,
              updated_at: meta.updated_at,
              exported_at: meta.exported_at,
              default_model: meta.default_model,
              cwd: meta.cwd,
              project_id: projectId,
              item_count: view.nodes.length,
              char_count: meta.char_count,
              blob_count: view.blobs.length,
              head_hash: meta.head_hash,
              content_hash: meta.content_hash,
              fingerprint: meta.fingerprint,
              raw_format: meta.raw_format,
              raw_blob_sha256: nativeBlob.sha256,
              flags_json: subagentFlags,
              batch_id: batchId,
              items: insertItems,
              blobs: view.blobs,
            });
            updateSyncCursor();
            const insertedRow = repo.getConversationById(convId)!;
            index.add({ row: insertedRow, view });
            decisions.push({
              externalId: meta.external_id ?? null,
              conversationId: convId,
              matchedConversationId: null,
              decision: 'new',
              similarity: 0,
            });
          } else if (decision === 'identical') {
            repo.updateConversationIdentical(
              matched.row.id,
              batchId,
              meta.exported_at,
              subagentFlags
            );
            if (projectId !== null && matched.row.project_id === null) {
              repo.setConversationProject(matched.row.id, projectId);
            }
            updateSyncCursor();
            matched.row.last_batch_id = batchId;
            if (meta.exported_at != null) matched.row.exported_at = meta.exported_at;
            decisions.push({
              externalId: meta.external_id ?? null,
              conversationId: matched.row.id,
              matchedConversationId: matched.row.id,
              decision: 'identical',
              similarity: 1.0,
            });
          } else if (decision === 'superset_append') {
            const diffPayload = buildDiffPayload('superset_append', matched.view, view, similarity);
            let itemsToAppend = insertItems;
            if (matched.row.external_id !== meta.external_id) {
              const existingHashSet = new Set(matched.view.nodes.map((n) => n.content_hash));
              itemsToAppend = insertItems.filter((it) => !existingHashSet.has(it.content_hash));
            } else if (meta.external_id) {
              const prevCursor = repo.getSyncCursor(meta.provider, meta.external_id);
              if (meta.provider === 'codex-local' && prevCursor?.next_rollout_ordinal !== undefined) {
                itemsToAppend = itemsToAppend.filter(
                  (it) => it.ordinal >= prevCursor.next_rollout_ordinal!
                );
              } else if (meta.provider === 'dsh-local' && prevCursor?.last_dsh_seq !== undefined) {
                itemsToAppend = itemsToAppend.filter((it) => {
                  const m = it.external_id ? /^dsh-(\d+)$/.exec(it.external_id) : null;
                  return !m || Number(m[1]) > prevCursor.last_dsh_seq!;
                });
              }
            }
            repo.appendConversationItems(matched.row.id, batchId, itemsToAppend, {
              ...updateMeta,
              diff_json: diffPayload,
            });
            updateSyncCursor();
            const oldContentHash = matched.row.content_hash;
            const oldHeadHash = matched.row.head_hash;
            matched.row = repo.getConversationById(matched.row.id)!;
            matched.view = view;
            index.update(matched, oldContentHash, oldHeadHash);
            decisions.push({
              externalId: meta.external_id ?? null,
              conversationId: matched.row.id,
              matchedConversationId: matched.row.id,
              decision: 'superset_append',
              similarity,
            });
          } else if (decision === 'branch_revision') {
            const diffPayload = buildDiffPayload('branch_revision', matched.view, view, similarity);
            repo.saveBranchRevision(matched.row.id, batchId, insertItems, diffPayload, updateMeta);
            updateSyncCursor();
            const oldContentHash = matched.row.content_hash;
            const oldHeadHash = matched.row.head_hash;
            matched.row = repo.getConversationById(matched.row.id)!;
            matched.view = view;
            index.update(matched, oldContentHash, oldHeadHash);
            decisions.push({
              externalId: meta.external_id ?? null,
              conversationId: matched.row.id,
              matchedConversationId: matched.row.id,
              decision: 'branch_revision',
              similarity,
            });
          } else if (decision === 'auto_merge_fingerprint') {
            const existingHashes = matched.view.nodes.map((n) => n.content_hash);
            const incomingHashes = view.nodes.map((n) => n.content_hash);
            if (
              incomingHashes.length <= existingHashes.length &&
              isSubsequence(incomingHashes, existingHashes)
            ) {
              repo.updateConversationIdentical(matched.row.id, batchId, meta.exported_at);
              matched.row.last_batch_id = batchId;
            } else {
              const diffPayload = buildDiffPayload(
                'auto_merge_fingerprint',
                matched.view,
                view,
                similarity
              );
              repo.saveBranchRevision(matched.row.id, batchId, insertItems, diffPayload, updateMeta);
            updateSyncCursor();
              const oldContentHash = matched.row.content_hash;
              const oldHeadHash = matched.row.head_hash;
              matched.row = repo.getConversationById(matched.row.id)!;
              matched.view = view;
              index.update(matched, oldContentHash, oldHeadHash);
            }
            decisions.push({
              externalId: meta.external_id ?? null,
              conversationId: matched.row.id,
              matchedConversationId: matched.row.id,
              decision: 'auto_merge_fingerprint',
              similarity,
            });
          } else {
            // candidate_review (0.75 <= sim < 0.90)
            const convId = repo.insertConversation({
              provider: meta.provider,
              account_id: storageOpt.accountId ?? null,
              external_id: meta.external_id,
              title: meta.title,
              title_source: meta.title_source,
              summary: meta.summary,
              created_at: meta.created_at,
              updated_at: meta.updated_at,
              exported_at: meta.exported_at,
              default_model: meta.default_model,
              cwd: meta.cwd,
              project_id: projectId,
              item_count: view.nodes.length,
              char_count: meta.char_count,
              blob_count: view.blobs.length,
              head_hash: meta.head_hash,
              content_hash: meta.content_hash,
              fingerprint: meta.fingerprint,
              raw_format: meta.raw_format,
              raw_blob_sha256: nativeBlob.sha256,
              flags_json: subagentFlags,
              batch_id: batchId,
              items: insertItems,
              blobs: view.blobs,
            });
            repo.insertDedupeCandidate(convId, matched.row.id, similarity, 'minhash_similarity');
            const insertedRow = repo.getConversationById(convId)!;
            index.add({ row: insertedRow, view });
            decisions.push({
              externalId: meta.external_id ?? null,
              conversationId: convId,
              matchedConversationId: matched.row.id,
              decision: 'candidate_review',
              similarity,
            });
          }
        }

        const batchStats = {
          files: persistedFileCount,
          skipped_unchanged_files: skippedUnchangedFiles,
          conversations: sessions.length,
          items: totalItems,
          blobs: seenBlobShas.size,
          decisions: decisionCounts,
        };
        repo.updateBatchStatus(batchId, 'ok', batchStats, report);
      });

      if (options?.onCommit) {
        await options.onCommit(sessions, report);
      }

      emitProgress({
        stage: 'done',
        adapterId: bestProbe.adapterId,
        completed: totalTasks,
        total: totalTasks,
        skipped: skippedUnchangedFiles,
        bytesProcessed: totalPlannedBytes,
        totalBytes: totalPlannedBytes,
      });

      return {
        sourceSha256,
        adapterId: bestProbe.adapterId,
        adapterVersion: bestProbe.version,
        batchId,
        skipped_identical_batch: false,
        skipped_unchanged_files: skippedUnchangedFiles,
        sessions,
        decisions,
        report,
      };
    } catch (err) {
      try {
        repo.updateBatchStatus(batchId, 'failed', null, {
          schema_version: 'v1',
          provider: adapter.id,
          adapter_id: bestProbe.adapterId,
          adapter_version: bestProbe.version,
          generated_at: Date.now(),
          issues: [
            ...issues,
            {
              code: 'parse_error',
              severity: 'error',
              message: err instanceof Error ? err.message : String(err),
            },
          ],
          unrecognized_field_counts: unrecognizedFieldCounts,
        });
      } catch {
        // Preserve original error
      }
      throw err;
    }
  }

  private async runInMemory(
    src: SourceRef,
    sourceSha256: string,
    bestProbe: { adapterId: string; version: string },
    adapter: NonNullable<ReturnType<AdapterRegistry['get']>>,
    options?: PipelineOptions
  ): Promise<PipelineResult> {
    const unrecognizedFieldCounts: Record<string, number> = {};
    const issues: IntegrityIssue[] = [];

    const ctx: ParseCtx = {
      async persistRaw(entry: string, bytes: Buffer | NodeJS.ReadableStream): Promise<{ sha256: string; path: string }> {
        const buf = await streamToBuffer(bytes);
        return { sha256: sha256Hex(buf), path: entry };
      },
      async *streamArray<T>(readable: NodeJS.ReadableStream): AsyncIterable<T> {
        const buf = await streamToBuffer(readable);
        for (const item of streamTopLevelJsonArray<T>(buf)) {
          yield item;
        }
      },
      async spill(payload: unknown): Promise<string> {
        if (Buffer.isBuffer(payload)) return sha256Hex(payload);
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
    for await (const task of adapter.plan(src, bestProbe as Parameters<typeof adapter.plan>[1])) {
      const taskDocs = await adapter.parse(task, ctx);
      sessions.push(...taskDocs);
    }

    for (const doc of sessions) {
      issues.push(...doc.validate());
    }

    const existingMap = new Map<string, SessionDocument>();
    if (options?.existingSessions) {
      for (const ex of options.existingSessions) {
        const meta = ex.getMeta();
        if (meta.external_id) {
          existingMap.set(`${meta.provider}:${meta.external_id}`, ex);
        }
      }
    }

    const decisions: PipelineDecisionEntry[] = [];
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
