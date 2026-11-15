import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdapterRegistry, SourceRef } from '@sm/adapters';
import type { IntegrityIssue, IntegrityReport, ProviderId } from '@sm/shared';
import {
  ArchiveDatabase,
  ArchiveRepository,
  BlobStore,
  RawStore,
  type ConversationRow,
  type DedupeCandidateRow,
  type ImportBatchRow,
  type ItemRow,
  type ListConversationsOptions,
  type ProjectRow,
  type TagRow,
  type VacuumReport,
} from '@sm/store';
import {
  formatIntegrityReportJson,
  formatIntegrityReportMarkdown,
} from './diff-reporter.js';
import {
  ImportPipeline,
  type PipelineOptions,
  type PipelineResult,
} from './pipeline.js';
import {
  exportProviderRawArchive,
  type ProviderRawExportOptions,
  type ProviderRawExportReport,
} from './raw-exporter.js';
import {
  executeArchiveSearch,
  type ArchiveSearchOptions,
  type ArchiveSearchResult,
} from './search-router.js';

export interface ArchiveServiceOptions {
  archiveRoot?: string;
  repository?: ArchiveRepository;
  rawStore?: RawStore;
  blobStore?: BlobStore;
  registry?: AdapterRegistry;
}

export interface ArchiveVerificationResult {
  batchId: number | null;
  report: IntegrityReport;
  markdown: string;
  json: string;
  orphanItems: number;
  timeAnomalies: number;
}

/**
 * High-level facade coordinating SQLite persistence, raw/blob storage,
 * deduplicated batch imports, FTS5 search, and verification reports.
 */
export class ArchiveService {
  public readonly db: ArchiveDatabase;
  public readonly archiveRoot: string;
  public readonly repository: ArchiveRepository;
  public readonly rawStore: RawStore;
  public readonly blobStore: BlobStore;
  public readonly pipeline: ImportPipeline;

  constructor(db: ArchiveDatabase, options: ArchiveServiceOptions = {}) {
    this.db = db;
    this.archiveRoot =
      options.archiveRoot ??
      (db.path !== ':memory:'
        ? path.dirname(path.resolve(db.path))
        : fs.mkdtempSync(path.join(os.tmpdir(), 'sm-archive-')));
    this.repository = options.repository ?? new ArchiveRepository(db);
    this.rawStore = options.rawStore ?? new RawStore(this.archiveRoot);
    this.blobStore = options.blobStore ?? new BlobStore(this.archiveRoot);
    this.pipeline = new ImportPipeline(options.registry);
  }

  /**
   * Opens (and migrates) an archive database at `dbPath` and initializes stores under `archiveRoot`.
   */
  static open(
    dbPath: string,
    options: Omit<ArchiveServiceOptions, 'repository'> = {}
  ): ArchiveService {
    const db = ArchiveDatabase.openArchiveDb(dbPath);
    db.migrate();
    return new ArchiveService(db, options);
  }

  async importSource(
    src: SourceRef,
    options: Omit<PipelineOptions, 'storage'> & {
      batchKind?: string;
      accountId?: number | null;
    } = {}
  ): Promise<PipelineResult> {
    const { batchKind, accountId, ...pipelineOpts } = options;
    return this.pipeline.run(src, {
      ...pipelineOpts,
      storage: {
        db: this.db,
        repository: this.repository,
        rawStore: this.rawStore,
        blobStore: this.blobStore,
        archiveRoot: this.archiveRoot,
        batchKind,
        accountId,
      },
    });
  }

  search(query: string, options?: ArchiveSearchOptions): ArchiveSearchResult {
    return executeArchiveSearch(this.db, query, options);
  }

  listConversations(options?: ListConversationsOptions): ConversationRow[] {
    return this.repository.listConversations(options);
  }

  getConversation(
    convId: number,
    activeOnly = false
  ): { conversation: ConversationRow; items: ItemRow[] } | null {
    const conversation = this.repository.getConversationById(convId);
    if (!conversation) return null;
    const items = this.repository.getConversationItems(convId, activeOnly);
    return { conversation, items };
  }

  listBatches(limit = 50): ImportBatchRow[] {
    return this.repository.listBatches(limit);
  }

  listDedupeCandidates(status?: string): DedupeCandidateRow[] {
    return this.repository.listDedupeCandidates(status);
  }

  listProjects(): Array<ProjectRow & { conversation_count: number }> {
    return this.repository.listProjects();
  }

  setStarred(convId: number, starred: boolean): boolean {
    return this.repository.setConversationStarred(convId, starred);
  }

  addTag(convId: number, tagName: string, color?: string | null): TagRow {
    return this.repository.addConversationTag(convId, tagName, color ?? null);
  }

  removeTag(convId: number, tagName: string): boolean {
    return this.repository.removeConversationTag(convId, tagName);
  }

  listTags(convId?: number): Array<TagRow & { conversation_count?: number }> {
    return convId !== undefined
      ? this.repository.listConversationTags(convId)
      : this.repository.listAllTags();
  }

  softDeleteConversation(convId: number): boolean {
    return this.repository.softDeleteConversation(convId);
  }

  restoreConversation(convId: number): boolean {
    return this.repository.restoreConversation(convId);
  }

  vacuum(opts: { olderThanMs?: number; dryRun?: boolean; purgeBlobs?: boolean } = {}): VacuumReport {
    return this.repository.vacuumArchive(this.blobStore, opts);
  }

  async exportProviderRaw(
    outTarget: string,
    opts: ProviderRawExportOptions = {}
  ): Promise<ProviderRawExportReport> {
    return exportProviderRawArchive(this, outTarget, opts);
  }

  /**
   * Builds a verification summary and formatted Markdown/JSON reports for a batch
   * (defaults to the most recent batch in the archive).
   */
  verify(batchId?: number): ArchiveVerificationResult {
    const targetBatch =
      batchId !== undefined
        ? this.repository.getBatch(batchId)
        : (this.repository.listBatches(1)[0] ?? null);

    const orphanRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM item WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM item)`
      )
      .get() as { cnt: number };
    const timeRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM conversation WHERE deleted_at IS NULL AND ((created_at IS NOT NULL AND updated_at IS NOT NULL AND updated_at < created_at) OR created_at < 0)`
      )
      .get() as { cnt: number };

    let report: IntegrityReport;
    if (targetBatch?.report_json) {
      report = JSON.parse(targetBatch.report_json) as IntegrityReport;
    } else {
      const dbIssues: IntegrityIssue[] = [];
      if (orphanRow.cnt > 0) {
        dbIssues.push({
          code: 'orphan_node',
          severity: 'warn',
          message: `Detected ${orphanRow.cnt} item(s) referencing missing parent_id`,
        });
      }
      if (timeRow.cnt > 0) {
        dbIssues.push({
          code: 'time_anomaly',
          severity: 'warn',
          message: `Detected ${timeRow.cnt} conversation(s) with timestamp anomalies`,
        });
      }
      report = {
        schema_version: 'v1',
        provider: (targetBatch?.provider ?? 'generic-json') as ProviderId,
        adapter_id: targetBatch?.adapter_id ?? 'archive-verify',
        adapter_version: targetBatch?.adapter_version ?? '1.0.0',
        generated_at: Date.now(),
        issues: dbIssues,
        unrecognized_field_counts: {},
      };
    }

    return {
      batchId: targetBatch?.id ?? null,
      report,
      markdown: formatIntegrityReportMarkdown(report),
      json: formatIntegrityReportJson(report),
      orphanItems: orphanRow.cnt,
      timeAnomalies: timeRow.cnt,
    };
  }

  rebuildFts(): void {
    this.db.rebuildFts();
  }

  close(): void {
    this.db.close();
  }
}
