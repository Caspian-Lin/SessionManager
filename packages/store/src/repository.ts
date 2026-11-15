import * as fs from 'node:fs';
import * as path from 'node:path';
import { sha256Hex } from '@sm/shared';
import type {
  BlobAsset,
  IntegrityReport,
  ItemStatus,
  ProviderId,
  SessionRole,
  TitleSource,
  TurnKind,
  ViewBlock,
} from '@sm/shared';
import type { ArchiveDatabase } from './db.js';
import type { BlobStore } from './blob-store.js';

export interface ImportBatchRow {
  id: number;
  provider: string;
  adapter_id: string;
  adapter_version: string;
  account_id: number | null;
  kind: string;
  source_path: string | null;
  source_sha256: string;
  exported_at: number | null;
  imported_at: number;
  status: string;
  stats_json: string | null;
  report_json: string | null;
}

export interface ImportFileRow {
  id: number;
  batch_id: number;
  rel_path: string;
  sha256: string;
  size: number;
  mtime: number | null;
  role: string | null;
  parsed_ok: number;
  error: string | null;
}

export interface ConversationRow {
  id: number;
  provider: string;
  account_id: number | null;
  external_id: string | null;
  title: string | null;
  title_source: string | null;
  summary: string | null;
  created_at: number | null;
  updated_at: number | null;
  exported_at: number | null;
  default_model: string | null;
  cwd: string | null;
  project_id: number | null;
  item_count: number;
  char_count: number;
  blob_count: number;
  head_hash: string | null;
  content_hash: string | null;
  fingerprint: string | null;
  raw_format: string | null;
  raw_blob_sha256: string | null;
  revision_count: number;
  first_batch_id: number | null;
  last_batch_id: number | null;
  starred: number;
  archived: number;
  deleted_at: number | null;
  flags_json: string | null;
}

export interface ConversationRevisionRow {
  id: number;
  conversation_id: number;
  batch_id: number | null;
  revision_no: number;
  content_hash: string;
  item_count: number | null;
  char_count: number | null;
  diff_json: string | null;
  created_at: number;
}

export interface ItemRow {
  id: number;
  conversation_id: number;
  parent_id: number | null;
  external_id: string | null;
  ordinal: number;
  depth: number;
  role: string;
  kind: string;
  created_at: number | null;
  model: string | null;
  tool_name: string | null;
  text: string | null;
  text_len: number;
  blocks_json: string | null;
  content_hash: string;
  is_active_branch: number;
  is_hidden: number;
  is_synthetic: number;
  status: string | null;
  payload_ref: string | null;
  flags_json: string | null;
}

export interface BlobRow {
  id: number;
  sha256: string;
  mime: string;
  bytes: number;
  ext: string | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  rel_path: string;
  origin_kind: string;
  created_at: number;
}

export interface DedupeCandidateRow {
  id: number;
  a_id: number;
  b_id: number;
  similarity: number;
  reason: string;
  status: string;
  decided_at: number | null;
  created_at: number;
}

export interface CreateBatchInput {
  provider: ProviderId | string;
  adapter_id: string;
  adapter_version: string;
  account_id?: number | null;
  kind: string;
  source_path?: string | null;
  source_sha256: string;
  exported_at?: number | null;
  imported_at?: number;
  status?: string;
  stats_json?: string | Record<string, unknown> | null;
  report_json?: string | IntegrityReport | Record<string, unknown> | null;
}

export interface InsertImportFileInput {
  batch_id: number;
  rel_path: string;
  sha256: string;
  size: number;
  mtime?: number | null;
  role?: string | null;
  parsed_ok?: boolean | number;
  error?: string | null;
}

export interface ProjectRow {
  id: number;
  name: string;
  provider: string | null;
  external_id: string | null;
  root_path: string | null;
}

export interface TagRow {
  id: number;
  name: string;
  color: string | null;
}

export interface SyncCursorState {
  next_rollout_ordinal?: number;
  last_dsh_seq?: number;
  file_rel_path?: string;
  file_size?: number;
  updated_at: number;
}

export interface VacuumReport {
  deleted_conversations: number;
  purged_blobs: number;
  purged_blob_bytes: number;
  reclaimed_tags: number;
  dry_run: boolean;
}

export interface ListConversationsOptions {
  provider?: string;
  limit?: number;
  offset?: number;
  starred?: boolean;
  archived?: boolean;
  project_id?: number;
  batch_id?: number;
  tag?: string;
  include_deleted?: boolean;
  only_deleted?: boolean;
}

export interface InsertItemInput {
  external_id: string | null;
  parent_external_id?: string | null;
  ordinal: number;
  depth?: number;
  role: SessionRole | string;
  kind: TurnKind | string;
  created_at?: number | null;
  model?: string | null;
  tool_name?: string | null;
  text?: string | null;
  text_len?: number;
  blocks?: readonly ViewBlock[];
  blocks_json?: string | null;
  content_hash: string;
  is_active_branch?: boolean | number;
  is_hidden?: boolean | number;
  is_synthetic?: boolean | number;
  status?: ItemStatus | string | null;
  payload_ref?: string | null;
  flags_json?: string | Record<string, unknown> | null;
}

export interface InsertConversationInput {
  provider: ProviderId | string;
  account_id?: number | null;
  external_id?: string | null;
  title?: string | null;
  title_source?: TitleSource | string | null;
  summary?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  exported_at?: number | null;
  default_model?: string | null;
  cwd?: string | null;
  project_id?: number | null;
  item_count?: number;
  char_count?: number;
  blob_count?: number;
  head_hash?: string | null;
  content_hash?: string | null;
  fingerprint?: string | null;
  raw_format?: string | null;
  raw_blob_sha256?: string | null;
  batch_id?: number | null;
  first_batch_id?: number | null;
  last_batch_id?: number | null;
  starred?: boolean | number;
  archived?: boolean | number;
  flags_json?: string | Record<string, unknown> | null;
  items?: readonly InsertItemInput[];
  blobs?: readonly BlobAsset[];
  record_initial_revision?: boolean;
}

export interface ConversationUpdateMeta {
  title?: string | null;
  title_source?: TitleSource | string | null;
  summary?: string | null;
  updated_at?: number | null;
  exported_at?: number | null;
  default_model?: string | null;
  cwd?: string | null;
  project_id?: number | null;
  item_count?: number;
  char_count?: number;
  blob_count?: number;
  head_hash?: string | null;
  content_hash?: string | null;
  fingerprint?: string | null;
  raw_format?: string | null;
  raw_blob_sha256?: string | null;
  flags_json?: string | Record<string, unknown> | null;
  diff_json?: string | Record<string, unknown> | null;
}

function serializeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function parseFlagsObject(flagsJson: string | null | undefined): Record<string, unknown> {
  if (!flagsJson) return {};
  try {
    const parsed: unknown = JSON.parse(flagsJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed legacy flags_json
  }
  return {};
}

function deriveToolName(item: InsertItemInput): string | null {
  if (item.tool_name !== undefined) return item.tool_name ?? null;
  if (item.blocks) {
    const found = item.blocks.find((b) => Boolean(b.tool_name));
    if (found?.tool_name) return found.tool_name;
  }
  return null;
}

function serializeItemBlocks(item: InsertItemInput): string | null {
  if (item.blocks_json !== undefined) return item.blocks_json ?? null;
  if (item.blocks !== undefined) return JSON.stringify(item.blocks);
  return null;
}

/**
 * Data Access Object (DAO) for the SessionManager SQLite archive.
 * Encapsulates batch idempotency, conversation/item CRUD, content-addressed blob metadata,
 * revision tracking (append & branch superseding), and dedupe candidates.
 */
export class ArchiveRepository {
  public readonly db: ArchiveDatabase;
  private readonly stmtCache = new Map<string, ReturnType<ArchiveDatabase['prepare']>>();

  constructor(db: ArchiveDatabase) {
    this.db = db;
  }

  private cachedStmt(key: string, sql: string): ReturnType<ArchiveDatabase['prepare']> {
    let stmt = this.stmtCache.get(key);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(key, stmt);
    }
    return stmt;
  }

  // ── Batch Management (L0 Idempotency & History) ─────────────────────────

  findBatchBySourceSha(provider: string, kind: string, sourceSha256: string): ImportBatchRow | null {
    const stmt = this.db.prepare(
      `SELECT * FROM import_batch WHERE provider = ? AND kind = ? AND source_sha256 = ? LIMIT 1`
    );
    const row = stmt.get(provider, kind, sourceSha256) as ImportBatchRow | undefined;
    return row ?? null;
  }

  createBatch(input: CreateBatchInput): number {
    const stmt = this.db.prepare(`
      INSERT INTO import_batch (
        provider, adapter_id, adapter_version, account_id, kind,
        source_path, source_sha256, exported_at, imported_at, status,
        stats_json, report_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      input.provider,
      input.adapter_id,
      input.adapter_version,
      input.account_id ?? null,
      input.kind,
      input.source_path ?? null,
      input.source_sha256,
      input.exported_at ?? null,
      input.imported_at ?? Date.now(),
      input.status ?? 'running',
      serializeJson(input.stats_json),
      serializeJson(input.report_json)
    );
    return Number(res.lastInsertRowid);
  }

  updateBatchStatus(
    batchId: number,
    status: string,
    stats?: unknown | null,
    report?: IntegrityReport | unknown | null
  ): void {
    const sets: string[] = ['status = ?'];
    const params: (string | number | null)[] = [status];

    if (stats !== undefined) {
      sets.push('stats_json = ?');
      params.push(serializeJson(stats));
    }
    if (report !== undefined) {
      sets.push('report_json = ?');
      params.push(serializeJson(report));
    }

    params.push(batchId);
    const stmt = this.db.prepare(`UPDATE import_batch SET ${sets.join(', ')} WHERE id = ?`);
    stmt.run(...params);
  }

  insertImportFile(input: InsertImportFileInput): number {
    const stmt = this.db.prepare(`
      INSERT INTO import_file (
        batch_id, rel_path, sha256, size, mtime, role, parsed_ok, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const res = stmt.run(
      input.batch_id,
      input.rel_path,
      input.sha256,
      input.size,
      input.mtime ?? null,
      input.role ?? null,
      input.parsed_ok ? 1 : 0,
      input.error ?? null
    );
    return Number(res.lastInsertRowid);
  }

  getBatch(batchId: number): ImportBatchRow | null {
    const stmt = this.db.prepare(`SELECT * FROM import_batch WHERE id = ? LIMIT 1`);
    const row = stmt.get(batchId) as ImportBatchRow | undefined;
    return row ?? null;
  }

  listBatches(limit = 50): ImportBatchRow[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const stmt = this.db.prepare(
      `SELECT * FROM import_batch ORDER BY imported_at DESC, id DESC LIMIT ?`
    );
    return stmt.all(safeLimit) as unknown as ImportBatchRow[];
  }

  getLatestCompletedBatch(provider: string, excludeBatchId?: number): ImportBatchRow | null {
    if (excludeBatchId !== undefined) {
      const stmt = this.db.prepare(`
        SELECT * FROM import_batch
        WHERE provider = ? AND status = 'ok' AND id != ?
        ORDER BY imported_at DESC, id DESC
        LIMIT 1
      `);
      const row = stmt.get(provider, excludeBatchId) as ImportBatchRow | undefined;
      return row ?? null;
    }

    const stmt = this.db.prepare(`
      SELECT * FROM import_batch
      WHERE provider = ? AND status = 'ok'
      ORDER BY imported_at DESC, id DESC
      LIMIT 1
    `);
    const row = stmt.get(provider) as ImportBatchRow | undefined;
    return row ?? null;
  }

  getImportFilesByBatch(batchId: number): ImportFileRow[] {
    const stmt = this.db.prepare(`SELECT * FROM import_file WHERE batch_id = ? ORDER BY id ASC`);
    return stmt.all(batchId) as unknown as ImportFileRow[];
  }

  // ── Conversation Queries ────────────────────────────────────────────────

  getConversationsByProvider(provider: string, includeDeleted = false): ConversationRow[] {
    const deletedClause = includeDeleted ? '' : 'AND deleted_at IS NULL';
    const stmt = this.db.prepare(`
      SELECT * FROM conversation
      WHERE provider = ? ${deletedClause}
      ORDER BY updated_at DESC, id DESC
    `);
    return stmt.all(provider) as unknown as ConversationRow[];
  }

  getConversationByExternalId(provider: string, externalId: string): ConversationRow | null {
    const stmt = this.db.prepare(`
      SELECT * FROM conversation
      WHERE provider = ? AND external_id = ? AND deleted_at IS NULL
      LIMIT 1
    `);
    const row = stmt.get(provider, externalId) as ConversationRow | undefined;
    return row ?? null;
  }

  getConversationById(id: number, includeDeleted = false): ConversationRow | null {
    const deletedClause = includeDeleted ? '' : 'AND deleted_at IS NULL';
    const stmt = this.db.prepare(`
      SELECT * FROM conversation WHERE id = ? ${deletedClause} LIMIT 1
    `);
    const row = stmt.get(id) as ConversationRow | undefined;
    return row ?? null;
  }

  listConversations(opts: ListConversationsOptions = {}): ConversationRow[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.only_deleted) {
      conditions.push('c.deleted_at IS NOT NULL');
    } else if (!opts.include_deleted) {
      conditions.push('c.deleted_at IS NULL');
    }
    if (opts.provider !== undefined) {
      conditions.push('c.provider = ?');
      params.push(opts.provider);
    }
    if (opts.starred !== undefined) {
      conditions.push('c.starred = ?');
      params.push(opts.starred ? 1 : 0);
    }
    if (opts.archived !== undefined) {
      conditions.push('c.archived = ?');
      params.push(opts.archived ? 1 : 0);
    }
    if (opts.project_id !== undefined) {
      conditions.push('c.project_id = ?');
      params.push(opts.project_id);
    }
    if (opts.batch_id !== undefined) {
      conditions.push('c.last_batch_id = ?');
      params.push(opts.batch_id);
    }
    if (opts.tag !== undefined && opts.tag.trim().length > 0) {
      conditions.push(
        `EXISTS (SELECT 1 FROM conversation_tag ct JOIN tag t ON t.id = ct.tag_id WHERE ct.conversation_id = c.id AND t.name = ?)`
      );
      params.push(opts.tag.trim());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.floor(opts.limit ?? 50));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const stmt = this.db.prepare(`
      SELECT c.* FROM conversation c
      ${where}
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(...params, limit, offset) as unknown as ConversationRow[];
  }

  getConversationItems(convId: number, activeOnly = false): ItemRow[] {
    const activeClause = activeOnly ? 'AND is_active_branch = 1' : '';
    const key = activeOnly ? 'getConvItemsActive' : 'getConvItemsAll';
    const stmt = this.cachedStmt(key, `
      SELECT id, conversation_id, parent_id, external_id, ordinal, depth,
             role, kind, created_at, model, tool_name, text, text_len,
             blocks_json, content_hash, is_active_branch, is_hidden,
             is_synthetic, status, payload_ref, flags_json
      FROM item
      WHERE conversation_id = ? ${activeClause}
      ORDER BY ordinal ASC, id ASC
    `);
    return stmt.all(convId) as unknown as ItemRow[];
  }

  /**
   * Lightweight active-branch item projection for dedupe/diff checks that omits
   * bulky `text` and `blocks_json` columns and skips JSON parsing.
   */
  getConversationItemSummaries(convId: number): Omit<ItemRow, 'text' | 'blocks_json' | 'flags_json' | 'tool_name' | 'conversation_id'>[] {
    const stmt = this.cachedStmt('getConvItemSummaries', `
      SELECT id, parent_id, external_id, ordinal, depth,
             role, kind, created_at, model, text_len,
             content_hash, is_active_branch, is_hidden,
             is_synthetic, status, payload_ref
      FROM item
      WHERE conversation_id = ? AND is_active_branch = 1
      ORDER BY ordinal ASC, id ASC
    `);
    return stmt.all(convId) as unknown as Omit<
      ItemRow,
      'text' | 'blocks_json' | 'flags_json' | 'tool_name' | 'conversation_id'
    >[];
  }

  getConversationRevisions(convId: number): ConversationRevisionRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM conversation_revision
      WHERE conversation_id = ?
      ORDER BY revision_no ASC, id ASC
    `);
    return stmt.all(convId) as unknown as ConversationRevisionRow[];
  }

  // ── Blob Persistence ────────────────────────────────────────────────────

  upsertBlob(asset: BlobAsset): void {
    const stmt = this.cachedStmt('upsertBlob', `
      INSERT INTO blob (
        sha256, mime, bytes, ext, width, height, duration_ms, rel_path, origin_kind, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        width = COALESCE(blob.width, excluded.width),
        height = COALESCE(blob.height, excluded.height),
        duration_ms = COALESCE(blob.duration_ms, excluded.duration_ms)
    `);
    stmt.run(
      asset.sha256,
      asset.mime,
      asset.bytes,
      asset.ext ?? null,
      asset.width ?? null,
      asset.height ?? null,
      asset.duration_ms ?? null,
      asset.rel_path,
      asset.origin_kind,
      asset.created_at
    );
  }

  getBlobBySha256(sha256: string): BlobRow | null {
    const stmt = this.db.prepare(`SELECT * FROM blob WHERE sha256 = ? LIMIT 1`);
    const row = stmt.get(sha256) as BlobRow | undefined;
    return row ?? null;
  }

  // ── Conversation & Revision Writes ──────────────────────────────────────

  private insertItemsWithParentResolution(
    convId: number,
    items: readonly InsertItemInput[],
    extIdToRowId: Map<string, number>
  ): number[] {
    const insertStmt = this.cachedStmt('insertItem', `
      INSERT INTO item (
        conversation_id, parent_id, external_id, ordinal, depth,
        role, kind, created_at, model, tool_name, text, text_len,
        blocks_json, content_hash, is_active_branch, is_hidden,
        is_synthetic, status, payload_ref, flags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertedIds: number[] = [];
    const pendingParents: { itemId: number; parentExtId: string }[] = [];

    for (const item of items) {
      const parentId =
        item.parent_external_id != null ? (extIdToRowId.get(item.parent_external_id) ?? null) : null;
      const textVal = item.text ?? null;
      const textLen = item.text_len ?? (textVal ? textVal.length : 0);

      const res = insertStmt.run(
        convId,
        parentId,
        item.external_id ?? null,
        item.ordinal,
        item.depth ?? 0,
        item.role,
        item.kind,
        item.created_at ?? null,
        item.model ?? null,
        deriveToolName(item),
        textVal,
        textLen,
        serializeItemBlocks(item),
        item.content_hash,
        item.is_active_branch === undefined ? 1 : item.is_active_branch ? 1 : 0,
        item.is_hidden ? 1 : 0,
        item.is_synthetic ? 1 : 0,
        item.status ?? null,
        item.payload_ref ?? null,
        serializeJson(item.flags_json)
      );

      const itemId = Number(res.lastInsertRowid);
      insertedIds.push(itemId);

      if (item.external_id) {
        extIdToRowId.set(item.external_id, itemId);
      }
      if (item.parent_external_id && parentId === null) {
        pendingParents.push({ itemId, parentExtId: item.parent_external_id });
      }
    }

    if (pendingParents.length > 0) {
      const updateParentStmt = this.cachedStmt(
        'updateItemParent',
        `UPDATE item SET parent_id = ? WHERE id = ?`
      );
      for (const pending of pendingParents) {
        const resolvedParentId = extIdToRowId.get(pending.parentExtId);
        if (resolvedParentId !== undefined) {
          updateParentStmt.run(resolvedParentId, pending.itemId);
        }
      }
    }

    return insertedIds;
  }

  private applyConversationMetaUpdate(
    convId: number,
    batchId: number,
    nextRevisionNo: number,
    updatedMeta: ConversationUpdateMeta
  ): { itemCount: number; charCount: number; contentHash: string | null } {
    const existing = this.db
      .prepare(`SELECT * FROM conversation WHERE id = ?`)
      .get(convId) as ConversationRow | undefined;
    if (!existing) {
      throw new Error(`Conversation #${convId} not found`);
    }

    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(text_len), 0) AS chars
         FROM item WHERE conversation_id = ? AND is_active_branch = 1`
      )
      .get(convId) as { cnt: number; chars: number };

    const itemCount = updatedMeta.item_count ?? agg.cnt;
    const charCount = updatedMeta.char_count ?? agg.chars;
    const contentHash =
      updatedMeta.content_hash !== undefined ? updatedMeta.content_hash : existing.content_hash;

    const mergedFlagsJson =
      updatedMeta.flags_json !== undefined
        ? serializeJson({
            ...parseFlagsObject(existing.flags_json),
            ...parseFlagsObject(serializeJson(updatedMeta.flags_json)),
          })
        : existing.flags_json;

    this.db
      .prepare(`
        UPDATE conversation SET
          title = ?,
          title_source = ?,
          summary = ?,
          updated_at = ?,
          exported_at = ?,
          default_model = ?,
          cwd = ?,
          project_id = ?,
          item_count = ?,
          char_count = ?,
          blob_count = ?,
          head_hash = ?,
          content_hash = ?,
          fingerprint = ?,
          raw_format = ?,
          raw_blob_sha256 = ?,
          flags_json = ?,
          last_batch_id = ?,
          revision_count = ?
        WHERE id = ?
      `)
      .run(
        updatedMeta.title !== undefined ? updatedMeta.title : existing.title,
        updatedMeta.title_source !== undefined ? updatedMeta.title_source : existing.title_source,
        updatedMeta.summary !== undefined ? updatedMeta.summary : existing.summary,
        updatedMeta.updated_at !== undefined ? updatedMeta.updated_at : existing.updated_at,
        updatedMeta.exported_at !== undefined ? updatedMeta.exported_at : existing.exported_at,
        updatedMeta.default_model !== undefined ? updatedMeta.default_model : existing.default_model,
        updatedMeta.cwd !== undefined ? updatedMeta.cwd : existing.cwd,
        updatedMeta.project_id !== undefined ? updatedMeta.project_id : existing.project_id,
        itemCount,
        charCount,
        updatedMeta.blob_count !== undefined ? updatedMeta.blob_count : existing.blob_count,
        updatedMeta.head_hash !== undefined ? updatedMeta.head_hash : existing.head_hash,
        contentHash,
        updatedMeta.fingerprint !== undefined ? updatedMeta.fingerprint : existing.fingerprint,
        updatedMeta.raw_format !== undefined ? updatedMeta.raw_format : existing.raw_format,
        updatedMeta.raw_blob_sha256 !== undefined
          ? updatedMeta.raw_blob_sha256
          : existing.raw_blob_sha256,
        mergedFlagsJson,
        batchId,
        nextRevisionNo,
        convId
      );

    return { itemCount, charCount, contentHash };
  }

  insertConversation(input: InsertConversationInput): number {
    return this.db.transaction(() => {
      const items = input.items ?? [];
      const itemCount = input.item_count ?? items.length;
      const charCount =
        input.char_count ??
        items.reduce((sum, it) => sum + (it.text_len ?? (it.text ? it.text.length : 0)), 0);
      const blobCount = input.blob_count ?? (input.blobs ? input.blobs.length : 0);
      const firstBatchId = input.first_batch_id ?? input.batch_id ?? null;
      const lastBatchId = input.last_batch_id ?? input.batch_id ?? null;

      const res = this.db
        .prepare(`
          INSERT INTO conversation (
            provider, account_id, external_id, title, title_source, summary,
            created_at, updated_at, exported_at, default_model, cwd, project_id,
            item_count, char_count, blob_count, head_hash, content_hash,
            fingerprint, raw_format, raw_blob_sha256, revision_count,
            first_batch_id, last_batch_id, starred, archived, flags_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `)
        .run(
          input.provider,
          input.account_id ?? null,
          input.external_id ?? null,
          input.title ?? null,
          input.title_source ?? null,
          input.summary ?? null,
          input.created_at ?? null,
          input.updated_at ?? null,
          input.exported_at ?? null,
          input.default_model ?? null,
          input.cwd ?? null,
          input.project_id ?? null,
          itemCount,
          charCount,
          blobCount,
          input.head_hash ?? null,
          input.content_hash ?? null,
          input.fingerprint ?? null,
          input.raw_format ?? null,
          input.raw_blob_sha256 ?? null,
          firstBatchId,
          lastBatchId,
          input.starred ? 1 : 0,
          input.archived ? 1 : 0,
          serializeJson(input.flags_json)
        );

      const convId = Number(res.lastInsertRowid);

      if (input.blobs && input.blobs.length > 0) {
        for (const asset of input.blobs) {
          this.upsertBlob(asset);
        }
      }

      if (items.length > 0) {
        const extIdToRowId = new Map<string, number>();
        this.insertItemsWithParentResolution(convId, items, extIdToRowId);
      }

      if (input.content_hash && input.record_initial_revision !== false) {
        this.db
          .prepare(`
            INSERT OR IGNORE INTO conversation_revision (
              conversation_id, batch_id, revision_no, content_hash,
              item_count, char_count, diff_json, created_at
            ) VALUES (?, ?, 1, ?, ?, ?, NULL, ?)
          `)
          .run(convId, firstBatchId, input.content_hash, itemCount, charCount, Date.now());
      }

      return convId;
    });
  }

  updateConversationIdentical(
    convId: number,
    batchId: number,
    exportedAt?: number | null,
    mergeFlags?: Record<string, unknown> | null
  ): void {
    if (mergeFlags && Object.keys(mergeFlags).length > 0) {
      const existing = this.db
        .prepare(`SELECT flags_json FROM conversation WHERE id = ?`)
        .get(convId) as { flags_json: string | null } | undefined;
      const merged = {
        ...parseFlagsObject(existing?.flags_json),
        ...mergeFlags,
      };
      this.db
        .prepare(`
          UPDATE conversation
          SET last_batch_id = ?,
              exported_at = COALESCE(?, exported_at),
              flags_json = ?
          WHERE id = ?
        `)
        .run(batchId, exportedAt ?? null, JSON.stringify(merged), convId);
      return;
    }

    this.db
      .prepare(`
        UPDATE conversation
        SET last_batch_id = ?,
            exported_at = COALESCE(?, exported_at)
        WHERE id = ?
      `)
      .run(batchId, exportedAt ?? null, convId);
  }

  appendConversationItems(
    convId: number,
    batchId: number,
    newItems: readonly InsertItemInput[],
    updatedMeta: ConversationUpdateMeta = {}
  ): number {
    return this.db.transaction(() => {
      const conv = this.db
        .prepare(`SELECT revision_count, content_hash FROM conversation WHERE id = ?`)
        .get(convId) as { revision_count: number; content_hash: string | null } | undefined;
      if (!conv) {
        throw new Error(`Conversation #${convId} not found`);
      }

      const maxRevRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(revision_no), 0) AS max_rev FROM conversation_revision WHERE conversation_id = ?`
        )
        .get(convId) as { max_rev: number };
      const nextRevNo = Math.max(conv.revision_count, maxRevRow.max_rev) + 1;

      const existingRows = this.db
        .prepare(`SELECT id, external_id, is_active_branch FROM item WHERE conversation_id = ?`)
        .all(convId) as { id: number; external_id: string | null; is_active_branch: number }[];

      const extIdToRowId = new Map<string, number>();
      const existingExtIds = new Set<string>();
      for (const row of existingRows) {
        if (row.external_id) {
          existingExtIds.add(row.external_id);
          if (row.is_active_branch === 1) {
            extIdToRowId.set(row.external_id, row.id);
          }
        }
      }

      const itemsToInsert = newItems.filter(
        (it) => !it.external_id || !existingExtIds.has(it.external_id)
      );

      if (itemsToInsert.length > 0) {
        this.insertItemsWithParentResolution(convId, itemsToInsert, extIdToRowId);
      }

      const { itemCount, charCount, contentHash } = this.applyConversationMetaUpdate(
        convId,
        batchId,
        nextRevNo,
        updatedMeta
      );

      const revHash =
        contentHash ?? sha256Hex(`append:${convId}:${nextRevNo}:${itemsToInsert.length}`);
      const diffJson =
        serializeJson(updatedMeta.diff_json) ??
        JSON.stringify({ status: 'superset_append', added_count: itemsToInsert.length });

      this.db
        .prepare(`
          INSERT INTO conversation_revision (
            conversation_id, batch_id, revision_no, content_hash,
            item_count, char_count, diff_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id, content_hash) DO UPDATE SET
            batch_id = excluded.batch_id,
            diff_json = COALESCE(excluded.diff_json, conversation_revision.diff_json)
        `)
        .run(convId, batchId, nextRevNo, revHash, itemCount, charCount, diffJson, Date.now());

      return nextRevNo;
    });
  }

  saveBranchRevision(
    convId: number,
    batchId: number,
    items: readonly InsertItemInput[],
    diffJson: string | Record<string, unknown> | null,
    updatedMeta: ConversationUpdateMeta = {}
  ): number {
    return this.db.transaction(() => {
      const conv = this.db
        .prepare(`SELECT revision_count, content_hash FROM conversation WHERE id = ?`)
        .get(convId) as { revision_count: number; content_hash: string | null } | undefined;
      if (!conv) {
        throw new Error(`Conversation #${convId} not found`);
      }

      const maxRevRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(revision_no), 0) AS max_rev FROM conversation_revision WHERE conversation_id = ?`
        )
        .get(convId) as { max_rev: number };
      const nextRevNo = Math.max(conv.revision_count, maxRevRow.max_rev) + 1;
      const now = Date.now();

      const existingRows = this.db
        .prepare(
          `SELECT id, external_id, content_hash, is_active_branch, flags_json
           FROM item WHERE conversation_id = ?`
        )
        .all(convId) as {
        id: number;
        external_id: string | null;
        content_hash: string;
        is_active_branch: number;
        flags_json: string | null;
      }[];

      const incomingByExtId = new Map<string, InsertItemInput>();
      for (const item of items) {
        if (item.external_id) {
          incomingByExtId.set(item.external_id, item);
        }
      }

      const extIdToRowId = new Map<string, number>();
      const keptExtIds = new Set<string>();
      const keptRowMap = new Map<string, number>();
      const supersededActiveRows: typeof existingRows = [];
      const rekeyStmt = this.db.prepare(
        `UPDATE item SET external_id = ?, flags_json = ? WHERE id = ?`
      );

      for (const row of existingRows) {
        const extId = row.external_id;
        const incoming = extId ? incomingByExtId.get(extId) : undefined;

        if (
          row.is_active_branch === 1 &&
          extId &&
          incoming &&
          incoming.content_hash === row.content_hash
        ) {
          // Unchanged active item: keep in place
          keptExtIds.add(extId);
          keptRowMap.set(extId, row.id);
          extIdToRowId.set(extId, row.id);
          continue;
        }

        // Re-key any existing row (active or previously superseded) whose external_id collides with incoming
        if (extId && incoming) {
          const archivedExtId = `${extId}::superseded::b${batchId}::r${nextRevNo}::${row.id}`;
          const mergedFlags: Record<string, unknown> = {
            ...parseFlagsObject(row.flags_json),
            original_external_id: extId,
          };
          rekeyStmt.run(archivedExtId, JSON.stringify(mergedFlags), row.id);
          row.flags_json = JSON.stringify(mergedFlags);
        }

        if (row.is_active_branch === 1) {
          supersededActiveRows.push(row);
        }
      }

      const itemsToInsert = items.filter((it) => !it.external_id || !keptExtIds.has(it.external_id));
      const insertedIds = this.insertItemsWithParentResolution(convId, itemsToInsert, extIdToRowId);

      // Map newly inserted items by external_id so superseded items can reference their replacement
      const replacementRowByExtId = new Map<string, number>();
      for (let i = 0; i < itemsToInsert.length; i++) {
        const extId = itemsToInsert[i]?.external_id;
        const insertedId = insertedIds[i];
        if (extId && insertedId !== undefined) {
          replacementRowByExtId.set(extId, insertedId);
        }
      }

      // Update parent_id/ordinal/depth/is_active_branch for kept items if their parent was replaced
      const updateKeptStmt = this.db.prepare(
        `UPDATE item SET parent_id = ?, ordinal = ?, depth = ?, is_active_branch = ? WHERE id = ?`
      );
      for (const [extId, rowId] of keptRowMap.entries()) {
        const incoming = incomingByExtId.get(extId)!;
        const resolvedParentId =
          incoming.parent_external_id != null
            ? (extIdToRowId.get(incoming.parent_external_id) ?? null)
            : null;
        updateKeptStmt.run(
          resolvedParentId,
          incoming.ordinal,
          incoming.depth ?? 0,
          incoming.is_active_branch === undefined ? 1 : incoming.is_active_branch ? 1 : 0,
          rowId
        );
      }

      // Mark superseded active rows inactive with superseded_by metadata
      const deactivateStmt = this.db.prepare(
        `UPDATE item SET is_active_branch = 0, flags_json = ? WHERE id = ?`
      );
      for (const oldRow of supersededActiveRows) {
        const flags = parseFlagsObject(oldRow.flags_json);
        const replacementId = oldRow.external_id
          ? replacementRowByExtId.get(oldRow.external_id)
          : undefined;
        flags['superseded_by'] =
          replacementId !== undefined ? `item:${replacementId}` : `batch:${batchId}`;
        flags['superseded_batch_id'] = batchId;
        flags['superseded_revision'] = nextRevNo;
        flags['superseded_at'] = now;
        deactivateStmt.run(JSON.stringify(flags), oldRow.id);
      }

      const { itemCount, charCount, contentHash } = this.applyConversationMetaUpdate(
        convId,
        batchId,
        nextRevNo,
        updatedMeta
      );

      const revHash =
        contentHash ?? sha256Hex(`branch:${convId}:${nextRevNo}:${itemsToInsert.length}`);

      this.db
        .prepare(`
          INSERT INTO conversation_revision (
            conversation_id, batch_id, revision_no, content_hash,
            item_count, char_count, diff_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id, content_hash) DO UPDATE SET
            batch_id = excluded.batch_id,
            diff_json = COALESCE(excluded.diff_json, conversation_revision.diff_json)
        `)
        .run(
          convId,
          batchId,
          nextRevNo,
          revHash,
          itemCount,
          charCount,
          serializeJson(diffJson),
          now
        );

      return nextRevNo;
    });
  }

  // ── Dedupe Candidates ───────────────────────────────────────────────────

  insertDedupeCandidate(aId: number, bId: number, similarity: number, reason: string): number {
    const [firstId, secondId] = aId <= bId ? [aId, bId] : [bId, aId];
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO dedupe_candidate (a_id, b_id, similarity, reason, status, created_at)
        VALUES (?, ?, ?, ?, 'open', ?)
        ON CONFLICT(a_id, b_id) DO UPDATE SET
          similarity = MAX(dedupe_candidate.similarity, excluded.similarity),
          reason = excluded.reason
      `)
      .run(firstId, secondId, similarity, reason, now);

    const row = this.db
      .prepare(`SELECT id FROM dedupe_candidate WHERE a_id = ? AND b_id = ?`)
      .get(firstId, secondId) as { id: number };
    return row.id;
  }

  listDedupeCandidates(status?: string): DedupeCandidateRow[] {
    if (status !== undefined) {
      const stmt = this.db.prepare(`
        SELECT * FROM dedupe_candidate
        WHERE status = ?
        ORDER BY similarity DESC, id DESC
      `);
      return stmt.all(status) as unknown as DedupeCandidateRow[];
    }

    const stmt = this.db.prepare(`
      SELECT * FROM dedupe_candidate
      ORDER BY similarity DESC, id DESC
    `);
    return stmt.all() as unknown as DedupeCandidateRow[];
  }

  // ── Incremental Sync Watermarks & Cursors (#15) ─────────────────────────

  getLatestImportFilesByProvider(provider: string): Map<string, ImportFileRow> {
    const stmt = this.db.prepare(`
      SELECT f.*
      FROM import_file f
      JOIN import_batch b ON b.id = f.batch_id
      WHERE b.provider = ? AND b.status = 'ok' AND f.parsed_ok = 1
      ORDER BY f.id ASC
    `);
    const rows = stmt.all(provider) as unknown as ImportFileRow[];
    const byRelPath = new Map<string, ImportFileRow>();
    for (const row of rows) {
      byRelPath.set(row.rel_path, row);
    }
    return byRelPath;
  }

  getSyncCursor(provider: string, externalId: string): SyncCursorState | null {
    const key = `cursor:${provider}:${externalId}`;
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as SyncCursorState;
    } catch {
      return null;
    }
  }

  setSyncCursor(provider: string, externalId: string, state: SyncCursorState): void {
    const key = `cursor:${provider}:${externalId}`;
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(key, JSON.stringify(state));
  }

  // ── Projects, Tags, Stars & Soft-Delete Governance (#21) ────────────────

  upsertProjectFromCwd(cwd: string | null | undefined, provider = 'local'): number | null {
    const info = deriveProjectFromCwd(cwd);
    if (!info) return null;

    const existing = this.db
      .prepare(`SELECT id FROM project WHERE provider = ? AND external_id = ? LIMIT 1`)
      .get(provider, info.externalId) as { id: number } | undefined;
    if (existing) return existing.id;

    const res = this.db
      .prepare(`INSERT INTO project (name, provider, external_id, root_path) VALUES (?, ?, ?, ?)`)
      .run(info.name, provider, info.externalId, info.rootPath);
    return Number(res.lastInsertRowid);
  }

  setConversationProject(convId: number, projectId: number | null): void {
    this.db.prepare(`UPDATE conversation SET project_id = ? WHERE id = ?`).run(projectId, convId);
  }

  listProjects(): Array<ProjectRow & { conversation_count: number }> {
    const stmt = this.db.prepare(`
      SELECT p.*, COUNT(c.id) AS conversation_count
      FROM project p
      LEFT JOIN conversation c ON c.project_id = p.id AND c.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY conversation_count DESC, p.name ASC
    `);
    return stmt.all() as unknown as Array<ProjectRow & { conversation_count: number }>;
  }

  setConversationStarred(convId: number, starred: boolean): boolean {
    const res = this.db
      .prepare(`UPDATE conversation SET starred = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(starred ? 1 : 0, convId);
    return Number(res.changes) > 0;
  }

  setConversationArchived(convId: number, archived: boolean): boolean {
    const res = this.db
      .prepare(`UPDATE conversation SET archived = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(archived ? 1 : 0, convId);
    return Number(res.changes) > 0;
  }

  addConversationTag(convId: number, tagName: string, color: string | null = null): TagRow {
    const clean = tagName.trim();
    if (!clean) throw new Error('Tag name cannot be empty');

    return this.db.transaction(() => {
      this.db
        .prepare(`INSERT OR IGNORE INTO tag (name, color) VALUES (?, ?)`)
        .run(clean, color);
      const tagRow = this.db
        .prepare(`SELECT * FROM tag WHERE name = ? LIMIT 1`)
        .get(clean) as unknown as TagRow;
      this.db
        .prepare(`INSERT OR IGNORE INTO conversation_tag (conversation_id, tag_id) VALUES (?, ?)`)
        .run(convId, tagRow.id);
      return tagRow;
    });
  }

  removeConversationTag(convId: number, tagName: string): boolean {
    const clean = tagName.trim();
    const res = this.db
      .prepare(
        `DELETE FROM conversation_tag
         WHERE conversation_id = ?
           AND tag_id IN (SELECT id FROM tag WHERE name = ?)`
      )
      .run(convId, clean);
    return Number(res.changes) > 0;
  }

  listConversationTags(convId: number): TagRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM tag t
         JOIN conversation_tag ct ON ct.tag_id = t.id
         WHERE ct.conversation_id = ?
         ORDER BY t.name ASC`
      )
      .all(convId) as unknown as TagRow[];
  }

  listAllTags(): Array<TagRow & { conversation_count: number }> {
    return this.db
      .prepare(
        `SELECT t.*, COUNT(c.id) AS conversation_count
         FROM tag t
         LEFT JOIN conversation_tag ct ON ct.tag_id = t.id
         LEFT JOIN conversation c ON c.id = ct.conversation_id AND c.deleted_at IS NULL
         GROUP BY t.id
         ORDER BY conversation_count DESC, t.name ASC`
      )
      .all() as unknown as Array<TagRow & { conversation_count: number }>;
  }

  softDeleteConversation(convId: number): boolean {
    const res = this.db
      .prepare(`UPDATE conversation SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(Date.now(), convId);
    return Number(res.changes) > 0;
  }

  restoreConversation(convId: number): boolean {
    const res = this.db
      .prepare(`UPDATE conversation SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL`)
      .run(convId);
    return Number(res.changes) > 0;
  }

  vacuumArchive(
    blobStore?: BlobStore,
    opts: { olderThanMs?: number; dryRun?: boolean; purgeBlobs?: boolean } = {}
  ): VacuumReport {
    const cutoff =
      opts.olderThanMs !== undefined ? Date.now() - Math.max(0, opts.olderThanMs) : Number.MAX_SAFE_INTEGER;
    const dryRun = Boolean(opts.dryRun);
    const purgeBlobs = opts.purgeBlobs !== false;

    const victimConvs = this.db
      .prepare(`SELECT id FROM conversation WHERE deleted_at IS NOT NULL AND deleted_at <= ?`)
      .all(cutoff) as { id: number }[];

    if (dryRun) {
      const referenced = this.collectReferencedBlobShas(new Set(victimConvs.map((v) => v.id)));
      const allBlobs = this.db.prepare(`SELECT sha256, bytes FROM blob`).all() as {
        sha256: string;
        bytes: number;
      }[];
      const orphanBlobs = purgeBlobs ? allBlobs.filter((b) => !referenced.has(b.sha256)) : [];
      return {
        deleted_conversations: victimConvs.length,
        purged_blobs: orphanBlobs.length,
        purged_blob_bytes: orphanBlobs.reduce((acc, b) => acc + b.bytes, 0),
        reclaimed_tags: 0,
        dry_run: true,
      };
    }

    const removedFiles: { rel_path: string; bytes: number }[] = [];
    let deletedConversations = 0;
    let reclaimedTags = 0;

    this.db.transaction(() => {
      for (const victim of victimConvs) {
        this.db
          .prepare(`DELETE FROM dedupe_candidate WHERE a_id = ? OR b_id = ?`)
          .run(victim.id, victim.id);
        const del = this.db.prepare(`DELETE FROM conversation WHERE id = ?`).run(victim.id);
        deletedConversations += Number(del.changes);
      }

      const tagDel = this.db
        .prepare(`DELETE FROM tag WHERE id NOT IN (SELECT DISTINCT tag_id FROM conversation_tag)`)
        .run();
      reclaimedTags = Number(tagDel.changes);

      if (purgeBlobs) {
        const referenced = this.collectReferencedBlobShas();
        const allBlobs = this.db
          .prepare(`SELECT sha256, rel_path, bytes FROM blob`)
          .all() as { sha256: string; rel_path: string; bytes: number }[];
        const delBlobStmt = this.db.prepare(`DELETE FROM blob WHERE sha256 = ?`);
        for (const b of allBlobs) {
          if (!referenced.has(b.sha256)) {
            delBlobStmt.run(b.sha256);
            removedFiles.push({ rel_path: b.rel_path, bytes: b.bytes });
          }
        }
      }
    });

    if (blobStore) {
      for (const f of removedFiles) {
        try {
          const abs = blobStore.getBlobAbsPath(f.rel_path);
          if (fs.existsSync(abs)) {
            fs.unlinkSync(abs);
          }
        } catch {
          // ignore best-effort unlink error
        }
      }
    }

    if (deletedConversations > 0 || removedFiles.length > 0) {
      try {
        this.db.exec('VACUUM;');
      } catch {
        // ignore if WAL lock prevents compact
      }
    }

    return {
      deleted_conversations: deletedConversations,
      purged_blobs: removedFiles.length,
      purged_blob_bytes: removedFiles.reduce((acc, f) => acc + f.bytes, 0),
      reclaimed_tags: reclaimedTags,
      dry_run: false,
    };
  }

  private collectReferencedBlobShas(excludedConvIds: Set<number> = new Set()): Set<string> {
    const refs = new Set<string>();
    const convRows = this.db
      .prepare(`SELECT id, raw_blob_sha256 FROM conversation WHERE raw_blob_sha256 IS NOT NULL`)
      .all() as { id: number; raw_blob_sha256: string }[];
    for (const c of convRows) {
      if (!excludedConvIds.has(c.id)) {
        refs.add(c.raw_blob_sha256);
      }
    }

    const itemRows = this.db
      .prepare(
        `SELECT conversation_id, payload_ref, blocks_json FROM item
         WHERE payload_ref IS NOT NULL OR blocks_json IS NOT NULL`
      )
      .all() as { conversation_id: number; payload_ref: string | null; blocks_json: string | null }[];
    for (const it of itemRows) {
      if (excludedConvIds.has(it.conversation_id)) continue;
      if (it.payload_ref) refs.add(it.payload_ref);
      if (it.blocks_json) {
        try {
          const parsed = JSON.parse(it.blocks_json) as Array<{ blob_sha256?: string | null }>;
          if (Array.isArray(parsed)) {
            for (const b of parsed) {
              if (typeof b?.blob_sha256 === 'string' && b.blob_sha256) {
                refs.add(b.blob_sha256);
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
    return refs;
  }
}

const SYSTEM_NOISE_PATH_PREFIXES = [
  'c:/windows',
  'c:/program files',
  'c:/program files (x86)',
  'c:/programdata',
  '/windows',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/tmp',
  '/private/tmp',
];

export function deriveProjectFromCwd(
  cwd: string | null | undefined
): { name: string; rootPath: string; externalId: string } | null {
  if (!cwd || typeof cwd !== 'string') return null;
  const trimmed = cwd.trim();
  if (!trimmed) return null;

  const forward = trimmed.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!forward || /^[a-z]:$/i.test(forward)) return null;

  const lower = forward.toLowerCase();
  if (SYSTEM_NOISE_PATH_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`))) {
    return null;
  }
  if (/\/(temp|tmp)(\/|$)/i.test(lower) && !lower.includes('/workspace/')) {
    if (lower.includes('/appdata/local/temp') || lower === '/tmp' || lower.startsWith('/tmp/')) {
      return null;
    }
  }
  // Exclude bare user home folder (C:/Users/foo, /Users/foo, /home/foo, /root)
  if (/^(?:[a-z]:\/users\/[^/]+|\/users\/[^/]+|\/home\/[^/]+|\/root)$/i.test(forward)) {
    return null;
  }

  let rootPath = trimmed;
  try {
    if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
      let cur = path.resolve(trimmed);
      for (let i = 0; i < 4; i++) {
        if (fs.existsSync(path.join(cur, '.git'))) {
          rootPath = cur;
          break;
        }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
  } catch {
    // ignore filesystem errors on non-existent historical paths
  }

  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const baseName = normalizedRoot.split('/').filter(Boolean).pop();
  if (!baseName) return null;

  return {
    name: baseName,
    rootPath: normalizedRoot,
    externalId: normalizedRoot.toLowerCase(),
  };
}
