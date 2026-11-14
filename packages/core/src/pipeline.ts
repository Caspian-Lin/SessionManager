import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AdapterRegistry,
  defaultAdapterRegistry,
  type ParseCtx,
  type SessionDocument,
  type SourceRef,
} from '@sm/adapters';
import {
  computeLshBands,
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

export interface PipelineOptions {
  registry?: AdapterRegistry;
  existingSessions?: readonly SessionDocument[];
  previousBatchSessions?: readonly SessionDocument[];
  previousBatchId?: number | null;
  storage?: PipelineStorageOptions;
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
  sessions: SessionDocument[];
  decisions: PipelineDecisionEntry[];
  report: IntegrityReport;
}

interface StoredConversationEntry {
  row: ConversationRow;
  view: ConversationViewModel;
}

const TRANSIENT_SQLITE_SUFFIXES = ['-wal', '-shm', '-journal'];

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
export async function computeSourceSha256(src: SourceRef): Promise<string> {
  if (src.kind === 'file' || src.kind === 'sqlite') {
    try {
      const { sha256 } = await hashFileSha256(src.path);
      return sha256;
    } catch {
      return sha256Hex(src.path);
    }
  }

  try {
    const files: string[] = [];
    collectFilesRecursive(src.path, src.path, files);

    const withRel = files
      .map((fullPath) => ({
        fullPath,
        relPath: path.relative(src.path, fullPath).split(path.sep).join('/'),
      }))
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

    const manifestHash = crypto.createHash('sha256');
    for (const entry of withRel) {
      const { sha256, size } = await hashFileSha256(entry.fullPath);
      manifestHash.update(`${entry.relPath}\0${size}\0${sha256}\n`);
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

function rowToViewModel(repo: ArchiveRepository, conv: ConversationRow): ConversationViewModel {
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

  constructor(initialEntries: readonly StoredConversationEntry[]) {
    for (const entry of initialEntries) {
      this.add(entry);
    }
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
    const meta = entry.view.meta;
    if (meta.external_id) {
      this.byExtId.set(meta.external_id, entry);
    }
    if (meta.content_hash && entry.view.nodes.length > 0) {
      this.byContentHash.set(meta.content_hash, entry);
    }
    if (meta.head_hash) {
      const list = this.byHeadHash.get(meta.head_hash) ?? [];
      if (!list.includes(entry)) list.push(entry);
      this.byHeadHash.set(meta.head_hash, list);
    }
    if (meta.fingerprint && entry.view.nodes.length > 0) {
      try {
        for (const band of computeLshBands(meta.fingerprint)) {
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

    // Tier 1: Exact external_id match within same provider
    if (meta.external_id) {
      const extMatch = this.byExtId.get(meta.external_id);
      if (extMatch) {
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
      const remaining = new Set<StoredConversationEntry>();
      const startIdx = Math.max(0, this.all.length - 1000);
      for (let i = startIdx; i < this.all.length; i++) {
        const cand = this.all[i]!;
        if (!candidateSet.has(cand) && cand.view.nodes.length > 0) {
          remaining.add(cand);
        }
      }
      best = this.pickBestCandidate(doc, view, remaining);
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

    // ── 1. STAGE: Compute deterministic source sha256 ───────
    const sourceSha256 = await computeSourceSha256(src);

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
        async spill(payload: unknown): Promise<string> {
          const asset = await blobStore.spillPayload(payload, 'oversized_payload');
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

      const sessions: SessionDocument[] = [];
      for await (const task of adapter.plan(src, bestProbe)) {
        const taskDocs = await adapter.parse(task, ctx);
        sessions.push(...taskDocs);
      }

      // ── 4. VALIDATE: Run per-type native structural validation ──
      for (const doc of sessions) {
        issues.push(...doc.validate());
      }

      // Store each SessionDocument's native JSON as a content-addressed blob before synchronous tx
      const nativeBlobs: BlobAsset[] = [];
      for (const doc of sessions) {
        const nativeBuf = Buffer.from(doc.toNativeJson(), 'utf8');
        const asset = await blobStore.putBlob(
          nativeBuf,
          'native_session',
          'application/json',
          '.json'
        );
        nativeBlobs.push(asset);
      }

      // ── 5 & 6. DEDUPE, DIFF & COMMIT IN TRANSACTION ──────
      const prevBatch = repo.getLatestCompletedBatch(adapter.id, batchId);
      const existingRows = repo.getConversationsByProvider(adapter.id, false);
      const existingEntries: StoredConversationEntry[] = existingRows.map((row) => ({
        row,
        view: rowToViewModel(repo, row),
      }));

      const prevSnapshotViews = options?.previousBatchSessions
        ? options.previousBatchSessions
        : prevBatch
          ? existingEntries
              .filter((entry) => entry.row.last_batch_id === prevBatch.id)
              .map((entry) => entry.view)
          : [];

      const diffStats = buildBatchDiffStats(
        prevSnapshotViews,
        sessions,
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

          const updateMeta = {
            title: meta.title,
            title_source: meta.title_source,
            summary: meta.summary,
            updated_at: meta.updated_at,
            exported_at: meta.exported_at,
            default_model: meta.default_model,
            cwd: meta.cwd,
            blob_count: view.blobs.length,
            head_hash: meta.head_hash,
            content_hash: meta.content_hash,
            fingerprint: meta.fingerprint,
            raw_format: meta.raw_format,
            raw_blob_sha256: nativeBlob.sha256,
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
              item_count: view.nodes.length,
              char_count: meta.char_count,
              blob_count: view.blobs.length,
              head_hash: meta.head_hash,
              content_hash: meta.content_hash,
              fingerprint: meta.fingerprint,
              raw_format: meta.raw_format,
              raw_blob_sha256: nativeBlob.sha256,
              batch_id: batchId,
              items: insertItems,
              blobs: view.blobs,
            });
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
            repo.updateConversationIdentical(matched.row.id, batchId, meta.exported_at);
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
            }
            repo.appendConversationItems(matched.row.id, batchId, itemsToAppend, {
              ...updateMeta,
              diff_json: diffPayload,
            });
            const oldContentHash = matched.row.content_hash;
            const oldHeadHash = matched.row.head_hash;
            matched.row = repo.getConversationById(matched.row.id)!;
            matched.view = rowToViewModel(repo, matched.row);
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
            const oldContentHash = matched.row.content_hash;
            const oldHeadHash = matched.row.head_hash;
            matched.row = repo.getConversationById(matched.row.id)!;
            matched.view = rowToViewModel(repo, matched.row);
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
              const oldContentHash = matched.row.content_hash;
              const oldHeadHash = matched.row.head_hash;
              matched.row = repo.getConversationById(matched.row.id)!;
              matched.view = rowToViewModel(repo, matched.row);
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
              item_count: view.nodes.length,
              char_count: meta.char_count,
              blob_count: view.blobs.length,
              head_hash: meta.head_hash,
              content_hash: meta.content_hash,
              fingerprint: meta.fingerprint,
              raw_format: meta.raw_format,
              raw_blob_sha256: nativeBlob.sha256,
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

      return {
        sourceSha256,
        adapterId: bestProbe.adapterId,
        adapterVersion: bestProbe.version,
        batchId,
        skipped_identical_batch: false,
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
