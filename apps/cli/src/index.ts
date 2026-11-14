#!/usr/bin/env node
/**
 * @sm/cli — Session Manager Command Line Interface (`sm`)
 *
 * Commands:
 *   sm probe <path> [--kind auto|<provider>] [--json]
 *   sm import <path> [--kind auto|<provider>] [--db <archive.db>] [--json]
 *   sm ls [--provider <id>] [--limit <n>] [--db <archive.db>] [--json]
 *   sm show <id> [--all-branches] [--include-synthetic] [--json] [--db <archive.db>]
 *   sm search <query> [--limit <n>] [--provider <id>] [--role <role>] [--db <archive.db>] [--json]
 *   sm verify [--batch <id>] [--out <path>] [--db <archive.db>] [--json]
 *   sm dedupe [--db <archive.db>] [--json]
 *   sm export --format native|md|jsonl --out <dir> [--provider <id>] [--db <archive.db>] [--json]
 *   sm reindex [--db <archive.db>] [--json]
 *   sm --help / sm --version
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdapterRegistry,
  defaultAdapterRegistry,
  type ProbeResult,
  type SourceRef,
} from '@sm/adapters';
import {
  ArchiveService,
  exportNativeManifest,
  formatConversationMarkdown,
  formatIntegrityReportJson,
  formatIntegrityReportMarkdown,
  type PipelineResult,
} from '@sm/core';
import type {
  BlobAsset,
  BlobOriginKind,
  ConversationViewModel,
  IntegrityIssue,
  IntegrityReport,
  ItemStatus,
  ProviderId,
  SessionRole,
  TitleSource,
  TurnKind,
  ViewBlock,
  ViewNode,
} from '@sm/shared';
import {
  ArchiveDatabase,
  BlobStore,
  RawStore,
  type BlobRow,
  type ConversationRow,
  type ItemRow,
} from '@sm/store';

const VERSION = '0.1.0';

const BOOLEAN_FLAGS = new Set([
  'json',
  'all-branches',
  'include-synthetic',
  'include-hidden',
  'help',
  'version',
]);

const KIND_ALIASES: Record<string, ProviderId> = {
  openai: 'openai-web',
  'openai-web': 'openai-web',
  anthropic: 'anthropic-web',
  'anthropic-web': 'anthropic-web',
  deepseek: 'deepseek-web',
  'deepseek-web': 'deepseek-web',
  codex: 'codex-local',
  'codex-local': 'codex-local',
  claude: 'claude-code-local',
  'claude-code': 'claude-code-local',
  'claude-code-local': 'claude-code-local',
  dsh: 'dsh-local',
  'dsh-local': 'dsh-local',
  json: 'generic-json',
  'generic-json': 'generic-json',
  md: 'generic-md',
  markdown: 'generic-md',
  'generic-md': 'generic-md',
};

export interface ParsedArgs {
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let subcommand: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = val !== 'false' && val !== '0';
        } else {
          flags[key] = val;
        }
        continue;
      }

      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      if (key === 'h') flags['help'] = true;
      else if (key === 'v') flags['version'] = true;
      else if (key === 'j') flags['json'] = true;
      else flags[key] = true;
    } else if (!subcommand) {
      subcommand = arg;
    } else {
      positional.push(arg);
    }
  }

  return { subcommand, positional, flags };
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.flags['version'] || args.subcommand === '--version' || args.subcommand === '-v') {
    console.log(`sm version ${VERSION}`);
    return;
  }

  if (
    args.flags['help'] ||
    !args.subcommand ||
    args.subcommand === '--help' ||
    args.subcommand === 'help'
  ) {
    printHelp();
    return;
  }

  switch (args.subcommand) {
    case 'probe':
      await runProbe(args);
      break;
    case 'import':
      await runImport(args);
      break;
    case 'ls':
    case 'list':
      await runList(args);
      break;
    case 'show':
      await runShow(args);
      break;
    case 'search':
      await runSearch(args);
      break;
    case 'verify':
      await runVerify(args);
      break;
    case 'dedupe':
      await runDedupe(args);
      break;
    case 'export':
      await runExport(args);
      break;
    case 'reindex':
      await runReindex(args);
      break;
    default:
      throw new CliError(
        `Unknown subcommand "${args.subcommand}". Run "sm --help" for available commands.`
      );
  }
}

class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

function printHelp(): void {
  console.log(`
Session Manager CLI (sm) — Local AI Conversation Archive v${VERSION}

Usage:
  sm <command> [arguments] [options]

Commands:
  probe <path>                 Probe conversation source or zip and output adapter profile
                               Options: --kind auto|<provider>, --json
  import <path>                Import conversation logs/export into archive database
                               Options: --kind auto|<provider>, --db <archive.db>, --json
  ls                           List archived conversations
                               Options: --provider <id>, --limit <n>, --db <archive.db>, --json
  show <id>                    Inspect conversation metadata, revisions, and item tree
                               Options: --all-branches, --include-synthetic, --json, --db <archive.db>
  search <query>               Full-text search conversations & item snippets (FTS5 + CJK router)
                               Options: --limit <n>, --provider <id>, --role <role>, --db <archive.db>, --json
  verify                       Run structural, blob, and cross-batch diff integrity checks
                               Options: --batch <id>, --out <path>, --db <archive.db>, --json
  dedupe                       List exact duplicate clusters and similarity candidate pairs
                               Options: --db <archive.db>, --json
  export                       Export archive conversations to folder
                               Options: --format native|md|jsonl, --out <dir>, --provider <id>, --db <archive.db>, --json
  reindex                      Rebuild FTS5 search indexes and recalculate conversation counts
                               Options: --db <archive.db>, --json

Global Flags:
  -h, --help                   Display this help message
  -v, --version                Display CLI version
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers: Source Resolution, Store Setup & View Reconstruction
// ─────────────────────────────────────────────────────────────────────────────

function resolveSourceRef(targetPath: string): SourceRef {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    throw new CliError(`Path does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return { kind: 'dir', path: resolved };
  }
  const lower = resolved.toLowerCase();
  if (
    lower.endsWith('.sqlite') ||
    lower.endsWith('.sqlite3') ||
    lower.endsWith('.db') ||
    lower.endsWith('.vscdb')
  ) {
    return { kind: 'sqlite', path: resolved };
  }
  return { kind: 'file', path: resolved };
}

function resolveKindRegistry(kindFlag: string | boolean | undefined): {
  providerId?: ProviderId;
  registry: AdapterRegistry;
} {
  if (!kindFlag || kindFlag === true || kindFlag === 'auto') {
    return { registry: defaultAdapterRegistry };
  }
  const normalized = kindFlag.trim().toLowerCase();
  const providerId = KIND_ALIASES[normalized];
  if (!providerId) {
    throw new CliError(
      `Unknown adapter kind "${kindFlag}". Supported: auto, ${Object.values(KIND_ALIASES)
        .filter((v, idx, arr) => arr.indexOf(v) === idx)
        .join(', ')}`
    );
  }
  const adapter = defaultAdapterRegistry.get(providerId);
  if (!adapter) {
    throw new CliError(`Adapter "${providerId}" is not registered.`);
  }
  const scoped = new AdapterRegistry(false);
  scoped.register(adapter);
  return { providerId, registry: scoped };
}

function openCliArchive(
  flags: Record<string, string | boolean>,
  registry: AdapterRegistry = defaultAdapterRegistry
): { service: ArchiveService; dbPath: string; archiveRoot: string } {
  const dbPath = path.resolve(typeof flags['db'] === 'string' ? flags['db'] : './archive.db');
  const archiveRoot = path.dirname(dbPath);
  const db = ArchiveDatabase.openArchiveDb(dbPath);
  db.migrate();
  const rawStore = new RawStore(archiveRoot);
  const blobStore = new BlobStore(archiveRoot);
  const service = new ArchiveService(db, {
    archiveRoot,
    rawStore,
    blobStore,
    registry,
  });
  return { service, dbPath, archiveRoot };
}

function measureSourceSize(src: SourceRef): { fileCount: number; totalBytes: number } {
  if (src.kind !== 'dir') {
    const stat = fs.statSync(src.path);
    return { fileCount: 1, totalBytes: stat.size };
  }
  let fileCount = 0;
  let totalBytes = 0;
  const stack: string[] = [src.path];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        fileCount++;
        try {
          totalBytes += fs.statSync(full).size;
        } catch {
          // ignore unreadable entry
        }
      }
    }
  }
  return { fileCount, totalBytes };
}

function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed json
  }
  return {};
}

function normalizeExportBlobRelPath(row: BlobRow): string {
  if (row.rel_path.startsWith('blobs/')) {
    return row.rel_path;
  }
  const ext = row.ext ?? (path.extname(row.rel_path) || '.bin');
  return path.posix.join('blobs', row.sha256.slice(0, 2), `${row.sha256}${ext}`);
}

function blobRowToAsset(row: BlobRow, overrideRelPath?: string): BlobAsset {
  return {
    sha256: row.sha256,
    mime: row.mime,
    bytes: row.bytes,
    ext: row.ext,
    width: row.width,
    height: row.height,
    duration_ms: row.duration_ms,
    rel_path: overrideRelPath ?? row.rel_path,
    origin_kind: row.origin_kind as BlobOriginKind,
    created_at: row.created_at,
  };
}

function collectBlobShasFromItems(
  conv: ConversationRow,
  items: readonly ItemRow[]
): Set<string> {
  const shas = new Set<string>();
  if (conv.raw_blob_sha256) {
    shas.add(conv.raw_blob_sha256);
  }
  for (const item of items) {
    if (item.payload_ref) {
      shas.add(item.payload_ref);
    }
    const blocks = parseJsonArray<ViewBlock>(item.blocks_json);
    for (const b of blocks) {
      if (b.blob_sha256) {
        shas.add(b.blob_sha256);
      }
    }
  }
  return shas;
}

function buildViewModelFromRows(
  service: ArchiveService,
  conv: ConversationRow,
  activeItems: readonly ItemRow[],
  allItemsForBlobs: readonly ItemRow[]
): { view: ConversationViewModel; blobRows: BlobRow[] } {
  const idToExtId = new Map<number, string>();
  for (const item of activeItems) {
    idToExtId.set(item.id, item.external_id ?? String(item.id));
  }

  const nodes: ViewNode[] = activeItems.map((item) => ({
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
    blocks: parseJsonArray<ViewBlock>(item.blocks_json),
  }));

  const blobShas = collectBlobShasFromItems(conv, allItemsForBlobs);
  const blobRows: BlobRow[] = [];
  for (const sha of blobShas) {
    const row = service.repository.getBlobBySha256(sha);
    if (row) {
      blobRows.push(row);
    }
  }

  const view: ConversationViewModel = {
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
      raw_format: conv.raw_format ?? conv.provider,
    },
    nodes,
    blobs: blobRows.map((br) => blobRowToAsset(br, normalizeExportBlobRelPath(br))),
  };

  return { view, blobRows };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Subcommand: sm probe <path> [--kind auto|<provider>] [--json]
// ─────────────────────────────────────────────────────────────────────────────

async function runProbe(args: ParsedArgs): Promise<void> {
  const targetPath = args.positional[0];
  if (!targetPath) {
    throw new CliError('"sm probe" requires a <path> argument.');
  }

  const src = resolveSourceRef(targetPath);
  const { providerId, registry } = resolveKindRegistry(args.flags['kind']);
  const isJson = Boolean(args.flags['json']);

  let results: ProbeResult[];
  if (providerId) {
    const adapter = registry.get(providerId)!;
    const single = await adapter.probe(src);
    results = single && single.confidence > 0 ? [single] : [];
  } else {
    results = await registry.probeSource(src);
  }

  const { fileCount, totalBytes } = measureSourceSize(src);
  const best = results[0] ?? null;

  if (!best) {
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            path: src.path,
            sourceKind: src.kind,
            matched: false,
            fileCount,
            totalBytes,
            humanSize: formatBytes(totalBytes),
            candidates: [],
          },
          null,
          2
        )
      );
    }
    throw new CliError(
      providerId
        ? `Source "${src.path}" did not match adapter "${providerId}".`
        : `No compatible adapter matched source: ${src.path}`
    );
  }

  const report = {
    path: src.path,
    sourceKind: src.kind,
    matched: true,
    adapterId: best.adapterId,
    version: best.version,
    confidence: best.confidence,
    evidence: best.evidence,
    warnings: best.warnings,
    entryCount: best.entries.length,
    entries: best.entries,
    fileCount,
    totalBytes,
    humanSize: formatBytes(totalBytes),
    candidates: results.map((r) => ({
      adapterId: r.adapterId,
      version: r.version,
      confidence: r.confidence,
      entryCount: r.entries.length,
    })),
    probedAt: Date.now(),
  };

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('\n=== Session Manager Probe Report ===');
  console.log(`Target:      ${report.path}`);
  console.log(`Source Kind: ${report.sourceKind}`);
  console.log(`Adapter ID:  ${report.adapterId}`);
  console.log(`Version:     ${report.version}`);
  console.log(`Confidence:  ${(report.confidence * 100).toFixed(1)}%`);
  console.log(`Files:       ${report.fileCount} (${report.humanSize})`);
  console.log(`Entries:     ${report.entryCount}`);
  if (report.entries.length > 0) {
    const preview = report.entries.slice(0, 10);
    for (const entry of preview) {
      console.log(`  - ${entry}`);
    }
    if (report.entries.length > preview.length) {
      console.log(`  ... and ${report.entries.length - preview.length} more`);
    }
  }
  console.log('Evidence:');
  if (report.evidence.length === 0) {
    console.log('  (none)');
  } else {
    for (const ev of report.evidence) {
      console.log(`  * ${ev}`);
    }
  }
  if (report.warnings.length > 0) {
    console.log('Warnings:');
    for (const w of report.warnings) {
      console.log(`  ! ${w}`);
    }
  }
  console.log('====================================\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Subcommand: sm import <path> [--kind auto|<provider>] [--db <archive.db>]
// ─────────────────────────────────────────────────────────────────────────────

async function runImport(args: ParsedArgs): Promise<void> {
  const targetPath = args.positional[0];
  if (!targetPath) {
    throw new CliError('"sm import" requires a <path> argument.');
  }

  const src = resolveSourceRef(targetPath);
  const { registry } = resolveKindRegistry(args.flags['kind']);
  const isJson = Boolean(args.flags['json']);
  const { service, dbPath } = openCliArchive(args.flags, registry);

  try {
    const result: PipelineResult = await service.importSource(src, { registry });
    const batch = result.batchId != null ? service.repository.getBatch(result.batchId) : null;
    const stats = parseJsonObject(batch?.stats_json ?? null);
    const diff = result.report.diff;

    const decisionCounts: Record<string, number> = {};
    for (const d of result.decisions) {
      decisionCounts[d.decision] = (decisionCounts[d.decision] ?? 0) + 1;
    }

    const totalItems =
      typeof stats['items'] === 'number'
        ? stats['items']
        : result.sessions.reduce((sum, s) => sum + s.getMeta().message_count, 0);
    const totalBlobs = typeof stats['blobs'] === 'number' ? stats['blobs'] : 0;

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            dbPath,
            batchId: result.batchId ?? null,
            provider: result.report.provider,
            adapterId: result.adapterId,
            adapterVersion: result.adapterVersion,
            sourceSha256: result.sourceSha256,
            skipped_identical_batch: Boolean(result.skipped_identical_batch),
            conversations: result.sessions.length,
            items: totalItems,
            blobs: totalBlobs,
            decisions: decisionCounts,
            diff: diff ?? null,
            issuesCount: result.report.issues.length,
          },
          null,
          2
        )
      );
      return;
    }

    if (result.skipped_identical_batch) {
      console.log(
        `\n✔ L0 idempotent skip: source already imported in Batch #${result.batchId} (${result.report.provider}, sha256=${result.sourceSha256.slice(0, 12)}..., 0 new conversations).`
      );
      if (diff) {
        console.log(
          `  Previous Diff:  +${diff.added_conversations} added, ~${diff.grown_conversations} grown, !${diff.shrunk_conversations} shrunk, =${diff.identical_conversations} identical`
        );
      }
      console.log('');
      return;
    }

    console.log(`\n✔ Import succeeded! (Batch #${result.batchId}) -> "${dbPath}"`);
    console.log(`  Provider:       ${result.report.provider} (${result.adapterId}@${result.adapterVersion})`);
    console.log(`  Source SHA256:  ${result.sourceSha256.slice(0, 16)}...`);
    console.log(`  Conversations:  ${result.sessions.length}`);
    console.log(`  Items:          ${totalItems}`);
    console.log(`  Blobs:          ${totalBlobs}`);
    if (Object.keys(decisionCounts).length > 0) {
      const summary = Object.entries(decisionCounts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      console.log(`  Decisions:      ${summary}`);
    }
    if (diff) {
      console.log(
        `  Diff Stats:     +${diff.added_conversations} added, ~${diff.grown_conversations} grown, !${diff.shrunk_conversations} shrunk, =${diff.identical_conversations} identical`
      );
      if (diff.shrunk_conversations > 0) {
        console.log(
          `  ⚠ Shrunk IDs:   ${diff.shrunk_conversation_ids.join(', ')}`
        );
      }
    }
    if (result.report.issues.length > 0) {
      const errors = result.report.issues.filter((i) => i.severity === 'error').length;
      const warns = result.report.issues.filter((i) => i.severity === 'warn').length;
      console.log(`  Issues:         ${result.report.issues.length} (${errors} error, ${warns} warn)`);
    }
    console.log('');
  } finally {
    service.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Subcommand: sm ls [--provider <id>] [--limit <n>] [--db <archive.db>]
// ─────────────────────────────────────────────────────────────────────────────

async function runList(args: ParsedArgs): Promise<void> {
  const provider = typeof args.flags['provider'] === 'string' ? args.flags['provider'] : undefined;
  const limitParam = typeof args.flags['limit'] === 'string' ? args.flags['limit'] : undefined;
  const limit = Math.min(Math.max(parseInt(limitParam ?? '25', 10) || 25, 1), 500);
  const isJson = Boolean(args.flags['json']);

  const { service } = openCliArchive(args.flags);
  try {
    const rows = service.listConversations({ provider, limit });

    if (isJson) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    if (rows.length === 0) {
      console.log('No conversations found in archive.');
      return;
    }

    console.log('\nID   Provider          Items  Revs  Updated              Title [Head Hash]');
    console.log('─'.repeat(92));
    for (const r of rows) {
      const id = String(r.id).padEnd(4);
      const prov = r.provider.slice(0, 16).padEnd(17);
      const items = String(r.item_count).padStart(5);
      const revs = String(r.revision_count).padStart(4);
      const updated = r.updated_at
        ? new Date(r.updated_at).toISOString().slice(0, 19).replace('T', ' ')
        : 'N/A'.padEnd(19);
      const title = (r.title ?? 'Untitled').slice(0, 32);
      const hash = r.head_hash ? ` [${r.head_hash.slice(0, 8)}]` : '';
      console.log(`${id} ${prov} ${items}  ${revs}  ${updated}  ${title}${hash}`);
    }
    console.log('─'.repeat(92));
    console.log(`Showing ${rows.length} conversation(s).\n`);
  } finally {
    service.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Subcommand: sm show <id> [--all-branches] [--include-synthetic] [--json]
// ─────────────────────────────────────────────────────────────────────────────

function resolveConversationByArg(service: ArchiveService, idArg: string): ConversationRow | null {
  if (/^\d+$/.test(idArg.trim())) {
    const byId = service.repository.getConversationById(parseInt(idArg.trim(), 10));
    if (byId) return byId;
  }
  const stmt = service.db.prepare(
    `SELECT * FROM conversation WHERE external_id = ? AND deleted_at IS NULL LIMIT 1`
  );
  const byExt = stmt.get(idArg.trim()) as ConversationRow | undefined;
  return byExt ?? null;
}

async function runShow(args: ParsedArgs): Promise<void> {
  const idArg = args.positional[0];
  if (!idArg) {
    throw new CliError('"sm show" requires a <id> argument.');
  }

  const allBranches = Boolean(args.flags['all-branches']);
  const includeSynthetic = Boolean(args.flags['include-synthetic']);
  const isJson = Boolean(args.flags['json']);

  const { service } = openCliArchive(args.flags);
  try {
    const conv = resolveConversationByArg(service, idArg);
    if (!conv) {
      throw new CliError(`Conversation "${idArg}" not found.`);
    }

    const revisions = service.repository.getConversationRevisions(conv.id);
    const allItems = service.repository.getConversationItems(conv.id, false);
    const inactiveBranchCount = allItems.filter((i) => i.is_active_branch === 0).length;
    const syntheticCount = allItems.filter((i) => i.is_synthetic === 1).length;

    const branchFiltered = allBranches
      ? allItems
      : allItems.filter((i) => i.is_active_branch === 1);

    // Preload referenced blob rows for display
    const blobShas = collectBlobShasFromItems(conv, allItems);
    const blobMap = new Map<string, BlobRow>();
    for (const sha of blobShas) {
      const row = service.repository.getBlobBySha256(sha);
      if (row) blobMap.set(sha, row);
    }

    if (isJson) {
      const visibleItems = includeSynthetic
        ? branchFiltered
        : branchFiltered.filter((i) => i.is_synthetic === 0);
      console.log(
        JSON.stringify(
          {
            conversation: conv,
            revisions: revisions.map((r) => ({
              ...r,
              diff: r.diff_json ? parseJsonObject(r.diff_json) : null,
            })),
            items: visibleItems.map((item) => ({
              ...item,
              is_active_branch: item.is_active_branch === 1,
              is_hidden: item.is_hidden === 1,
              is_synthetic: item.is_synthetic === 1,
              blocks: parseJsonArray<ViewBlock>(item.blocks_json),
              flags: item.flags_json ? parseJsonObject(item.flags_json) : null,
            })),
            blobs: Object.fromEntries(blobMap.entries()),
            stats: {
              total_items: allItems.length,
              inactive_branch_count: inactiveBranchCount,
              synthetic_count: syntheticCount,
              displayed_count: visibleItems.length,
            },
          },
          null,
          2
        )
      );
      return;
    }

    console.log('\n=== Conversation Detail ===');
    console.log(`ID:            #${conv.id}`);
    console.log(`Provider:      ${conv.provider} (raw_format=${conv.raw_format ?? 'N/A'})`);
    console.log(`External ID:   ${conv.external_id ?? 'N/A'}`);
    console.log(`Title:         ${conv.title ?? 'Untitled'} (source=${conv.title_source ?? 'N/A'})`);
    console.log(`Model:         ${conv.default_model ?? 'N/A'}`);
    if (conv.cwd) console.log(`CWD:           ${conv.cwd}`);
    console.log(
      `Timestamps:    created=${formatTs(conv.created_at)} | updated=${formatTs(conv.updated_at)} | exported=${formatTs(conv.exported_at)}`
    );
    console.log(
      `Counts:        items=${conv.item_count}, chars=${conv.char_count}, blobs=${conv.blob_count}, revisions=${conv.revision_count}`
    );
    console.log(`Head Hash:     ${conv.head_hash ?? 'N/A'}`);
    console.log(`Content Hash:  ${conv.content_hash ?? 'N/A'}`);
    if (conv.raw_blob_sha256) {
      const rawBlob = blobMap.get(conv.raw_blob_sha256);
      console.log(
        `Raw Session:   blob:${conv.raw_blob_sha256}${rawBlob ? ` (${rawBlob.rel_path}, ${formatBytes(rawBlob.bytes)})` : ''}`
      );
    }

    console.log('\n--- Revision History ---');
    if (revisions.length === 0) {
      console.log('  (no revision records)');
    } else {
      for (const rev of revisions) {
        const diffObj = rev.diff_json ? parseJsonObject(rev.diff_json) : null;
        const diffStatus = diffObj && typeof diffObj['status'] === 'string' ? ` [${diffObj['status']}]` : '';
        console.log(
          `  Rev #${rev.revision_no} | batch=#${rev.batch_id ?? '-'} | items=${rev.item_count ?? '-'} | chars=${rev.char_count ?? '-'} | hash=${rev.content_hash.slice(0, 12)}...${diffStatus}`
        );
      }
    }

    console.log('\n--- Items & Branches ---');
    if (!allBranches && inactiveBranchCount > 0) {
      console.log(
        `  (${inactiveBranchCount} inactive/superseded branch item(s) hidden; pass --all-branches to show)`
      );
    }

    let collapsedSyntheticRun: ItemRow[] = [];
    const flushSyntheticRun = () => {
      if (collapsedSyntheticRun.length === 0) return;
      const kinds = [...new Set(collapsedSyntheticRun.map((x) => x.kind))].join(', ');
      console.log(
        `  [synthetic] Collapsed ${collapsedSyntheticRun.length} synthetic item(s) (kinds: ${kinds}; pass --include-synthetic to expand)`
      );
      collapsedSyntheticRun = [];
    };

    for (const item of branchFiltered) {
      if (!includeSynthetic && item.is_synthetic === 1) {
        collapsedSyntheticRun.push(item);
        continue;
      }
      flushSyntheticRun();

      const indent = '  '.repeat(Math.min(item.depth, 6) + 1);
      const flags = parseJsonObject(item.flags_json);
      const branchTag =
        item.is_active_branch === 1
          ? 'active'
          : typeof flags['superseded_by'] === 'string'
            ? `side-branch superseded_by=${flags['superseded_by']}`
            : 'side-branch';
      const badges = [`[${branchTag}]`];
      if (item.is_synthetic === 1) badges.push('[synthetic]');
      if (item.is_hidden === 1) badges.push('[hidden]');
      const modelStr = item.model ? ` (${item.model})` : '';
      const extStr = item.external_id ? ` id=${item.external_id}` : '';
      const toolStr = item.tool_name ? ` tool=${item.tool_name}` : '';

      console.log(
        `${indent}#${item.ordinal} ${badges.join(' ')} ${item.role}/${item.kind}${modelStr}${toolStr}${extStr}`
      );

      if (item.text && item.text.trim().length > 0) {
        const preview = item.text.length > 300 ? `${item.text.slice(0, 300)}...` : item.text;
        console.log(`${indent}  ${preview.replace(/\r?\n/g, `\n${indent}  `)}`);
      }

      const blocks = parseJsonArray<ViewBlock>(item.blocks_json);
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const inputPreview = b.tool_input
            ? b.tool_input.length > 120
              ? `${b.tool_input.slice(0, 120)}...`
              : b.tool_input
            : '';
          const spillRef = b.blob_sha256 ? ` blob:${b.blob_sha256}` : '';
          console.log(
            `${indent}  [tool_call] ${b.tool_name ?? 'tool'}${b.tool_call_id ? ` (${b.tool_call_id})` : ''}${spillRef}${inputPreview ? ` ${inputPreview}` : ''}`
          );
        } else if (b.type === 'tool_result') {
          const spillRef = b.blob_sha256 ? ` blob:${b.blob_sha256}` : '';
          console.log(
            `${indent}  [tool_result] status=${b.status ?? 'ok'}${spillRef}`
          );
        } else if (b.blob_sha256) {
          const blob = blobMap.get(b.blob_sha256);
          console.log(
            `${indent}  [blob:${b.type}] sha256=${b.blob_sha256} avail=${b.availability ?? 'full'}${blob ? ` (${blob.mime}, ${blob.rel_path})` : ''}`
          );
        }
      }

      if (item.payload_ref) {
        const blob = blobMap.get(item.payload_ref);
        console.log(
          `${indent}  [payload_ref] blob:${item.payload_ref}${blob ? ` (${blob.rel_path}, ${formatBytes(blob.bytes)})` : ''}`
        );
      }
    }
    flushSyntheticRun();
    console.log('===========================\n');
  } finally {
    service.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Subcommand: sm search <query> [--limit <n>] [--provider <id>]
// ─────────────────────────────────────────────────────────────────────────────

async function runSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ').trim();
  if (!query) {
    throw new CliError('"sm search" requires a <query> string.');
  }

  const limitParam = typeof args.flags['limit'] === 'string' ? args.flags['limit'] : undefined;
  const limit = Math.min(Math.max(parseInt(limitParam ?? '20', 10) || 20, 1), 200);
  const provider = typeof args.flags['provider'] === 'string' ? args.flags['provider'] : undefined;
  const role = typeof args.flags['role'] === 'string' ? args.flags['role'] : undefined;
  const isJson = Boolean(args.flags['json']);

  const { service } = openCliArchive(args.flags);
  try {
    const result = service.search(query, {
      limit,
      provider,
      role,
      includeSynthetic: true,
      downweightSynthetic: true,
    });

    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(
      `\nSearch results for "${result.query}" (strategy: ${result.strategy}, total: ${result.total}):`
    );
    console.log('─'.repeat(84));

    if (result.hits.length === 0) {
      console.log('No matches found.\n');
      return;
    }

    for (const h of result.hits) {
      const synthBadge = h.is_synthetic ? ' [synthetic]' : '';
      const toolBadge = h.tool_name ? ` (tool: ${h.tool_name})` : '';
      console.log(
        `[Conv #${h.conversation_id}] (${h.provider}) "${h.conversation_title ?? 'Untitled'}" - [${h.role}/${h.kind}]${synthBadge}${toolBadge} [strategy=${result.strategy}, source=${h.match_source}, score=${h.score.toFixed(3)}]`
      );
      console.log(`  Hit: ${h.snippet.replace(/\r?\n/g, ' ')}\n`);
    }
    console.log(`Showing ${result.hits.length} of ${result.total} hit(s).\n`);
  } finally {
    service.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Subcommand: sm verify [--batch <id>] [--out <path>] [--db <archive.db>]
// ─────────────────────────────────────────────────────────────────────────────

async function runVerify(args: ParsedArgs): Promise<void> {
  const batchParam = typeof args.flags['batch'] === 'string' ? args.flags['batch'] : undefined;
  const outParam = typeof args.flags['out'] === 'string' ? args.flags['out'] : undefined;
  const isJson = Boolean(args.flags['json']);

  let batchId: number | undefined;
  if (batchParam !== undefined) {
    batchId = parseInt(batchParam, 10);
    if (!Number.isFinite(batchId) || batchId <= 0) {
      throw new CliError(`Invalid --batch id: "${batchParam}"`);
    }
  }

  const { service } = openCliArchive(args.flags);
  try {
    if (batchId !== undefined && !service.repository.getBatch(batchId)) {
      throw new CliError(`Import batch #${batchId} not found.`);
    }

    const verification = service.verify(batchId);

    // Check blobs on disk & dangling blob references
    const allBlobs = service.db
      .prepare(`SELECT * FROM blob ORDER BY id ASC`)
      .all() as unknown as BlobRow[];
    const blobShaSet = new Set(allBlobs.map((b) => b.sha256));
    const missingBlobsOnDisk: { sha256: string; rel_path: string }[] = [];
    for (const b of allBlobs) {
      if (!service.blobStore.hasBlob(b.rel_path)) {
        missingBlobsOnDisk.push({ sha256: b.sha256, rel_path: b.rel_path });
      }
    }

    const missingBlobRefs: { source: string; sha256: string }[] = [];
    const convBlobs = service.db
      .prepare(`SELECT id, raw_blob_sha256 FROM conversation WHERE deleted_at IS NULL AND raw_blob_sha256 IS NOT NULL`)
      .all() as { id: number; raw_blob_sha256: string }[];
    for (const cb of convBlobs) {
      if (!blobShaSet.has(cb.raw_blob_sha256)) {
        missingBlobRefs.push({ source: `conversation:${cb.id}`, sha256: cb.raw_blob_sha256 });
      }
    }

    const itemPayloads = service.db
      .prepare(`SELECT id, payload_ref, blocks_json FROM item WHERE payload_ref IS NOT NULL OR blocks_json IS NOT NULL`)
      .all() as { id: number; payload_ref: string | null; blocks_json: string | null }[];
    for (const it of itemPayloads) {
      if (it.payload_ref && !blobShaSet.has(it.payload_ref)) {
        missingBlobRefs.push({ source: `item:${it.id}:payload_ref`, sha256: it.payload_ref });
      }
      for (const block of parseJsonArray<ViewBlock>(it.blocks_json)) {
        if (block.blob_sha256 && !blobShaSet.has(block.blob_sha256)) {
          missingBlobRefs.push({ source: `item:${it.id}:block:${block.idx}`, sha256: block.blob_sha256 });
        }
      }
    }

    const extraIssues: IntegrityIssue[] = [];
    if (
      verification.orphanItems > 0 &&
      !verification.report.issues.some((i) => i.code === 'orphan_node')
    ) {
      extraIssues.push({
        code: 'orphan_node',
        severity: 'warn',
        message: `Detected ${verification.orphanItems} item(s) referencing missing parent_id`,
      });
    }
    if (
      verification.timeAnomalies > 0 &&
      !verification.report.issues.some((i) => i.code === 'time_anomaly')
    ) {
      extraIssues.push({
        code: 'time_anomaly',
        severity: 'warn',
        message: `Detected ${verification.timeAnomalies} conversation(s) with timestamp anomalies`,
      });
    }
    for (const mb of missingBlobsOnDisk) {
      extraIssues.push({
        code: 'orphan_blob_ref',
        severity: 'error',
        message: `Blob file missing on disk: ${mb.rel_path} (sha256=${mb.sha256})`,
      });
    }
    for (const mr of missingBlobRefs) {
      extraIssues.push({
        code: 'orphan_blob_ref',
        severity: 'error',
        message: `Missing blob metadata for ${mr.source}: sha256=${mr.sha256}`,
      });
    }

    const enrichedReport: IntegrityReport = {
      ...verification.report,
      issues: [...verification.report.issues, ...extraIssues],
    };

    const writtenReports: string[] = [];
    if (outParam) {
      const resolvedOut = path.resolve(outParam);
      const lowerOut = resolvedOut.toLowerCase();
      if (lowerOut.endsWith('.json')) {
        fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
        fs.writeFileSync(resolvedOut, formatIntegrityReportJson(enrichedReport), 'utf8');
        writtenReports.push(resolvedOut);
      } else if (lowerOut.endsWith('.md')) {
        fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
        fs.writeFileSync(resolvedOut, formatIntegrityReportMarkdown(enrichedReport), 'utf8');
        writtenReports.push(resolvedOut);
      } else {
        fs.mkdirSync(resolvedOut, { recursive: true });
        const jsonOut = path.join(resolvedOut, 'verify-report.json');
        const mdOut = path.join(resolvedOut, 'verify-report.md');
        fs.writeFileSync(jsonOut, formatIntegrityReportJson(enrichedReport), 'utf8');
        fs.writeFileSync(mdOut, formatIntegrityReportMarkdown(enrichedReport), 'utf8');
        writtenReports.push(jsonOut, mdOut);
      }
    }

    const batchesToDisplay =
      batchId !== undefined
        ? [service.repository.getBatch(batchId)!]
        : service.listBatches(5);

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            batchId: verification.batchId,
            orphanItems: verification.orphanItems,
            timeAnomalies: verification.timeAnomalies,
            totalBlobs: allBlobs.length,
            missingBlobsOnDisk,
            missingBlobRefs,
            report: enrichedReport,
            writtenReports,
          },
          null,
          2
        )
      );
      return;
    }

    console.log('\n=== Session Manager Integrity Verification ===');
    console.log(
      `- Orphan Nodes:              ${verification.orphanItems === 0 ? '✓ None' : `⚠ ${verification.orphanItems} detected`}`
    );
    console.log(
      `- Timestamp Anomalies:       ${verification.timeAnomalies === 0 ? '✓ None' : `⚠ ${verification.timeAnomalies} detected`}`
    );
    console.log(
      `- Blobs Checked on Disk:     ${allBlobs.length} total, ${missingBlobsOnDisk.length === 0 && missingBlobRefs.length === 0 ? '✓ All present' : `⚠ ${missingBlobsOnDisk.length} missing on disk, ${missingBlobRefs.length} broken ref(s)`}`
    );

    if (missingBlobsOnDisk.length > 0) {
      for (const mb of missingBlobsOnDisk) {
        console.log(`  ! Missing blob: ${mb.rel_path} (${mb.sha256})`);
      }
    }

    console.log('\n--- Batch Verification & Diff Summaries ---');
    if (batchesToDisplay.length === 0) {
      console.log('  (no import batches recorded)');
    } else {
      for (const b of batchesToDisplay) {
        const rep = b.report_json ? (JSON.parse(b.report_json) as IntegrityReport) : null;
        const diff = rep?.diff;
        console.log(`Batch #${b.id} (${b.provider}) - Status: ${b.status}`);
        if (diff) {
          console.log(`  + Added:       ${diff.added_conversations}`);
          console.log(`  ~ Grown:       ${diff.grown_conversations}`);
          if (diff.shrunk_conversations > 0) {
            console.log(
              `  ⚠ SHRUNK:      ${diff.shrunk_conversations} (Upstream content deleted/pruned: ${diff.shrunk_conversation_ids.join(', ')})`
            );
          } else {
            console.log(`  ✓ Shrunk:      0 (No upstream loss)`);
          }
          console.log(`  - Disappeared: ${diff.disappeared_conversations}`);
          console.log(`  = Identical:   ${diff.identical_conversations}`);
        }
      }
    }

    if (writtenReports.length > 0) {
      console.log('\n--- Exported Verification Report(s) ---');
      for (const p of writtenReports) {
        console.log(`  ✔ ${p}`);
      }
    }
    console.log('==============================================\n');
  } finally {
    service.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Subcommand: sm dedupe [--db <archive.db>] [--json]
// ─────────────────────────────────────────────────────────────────────────────

async function runDedupe(args: ParsedArgs): Promise<void> {
  const isJson = Boolean(args.flags['json']);
  const { service } = openCliArchive(args.flags);

  try {
    const exactClusters = service.db
      .prepare(`
        SELECT content_hash, count(*) AS count, group_concat(id) AS ids
        FROM conversation
        WHERE content_hash IS NOT NULL AND deleted_at IS NULL
        GROUP BY content_hash
        HAVING count > 1
      `)
      .all() as { content_hash: string; count: number; ids: string }[];

    const candidateRows = service.listDedupeCandidates();
    const enrichedCandidates = candidateRows.map((c) => {
      const convA = service.repository.getConversationById(c.a_id);
      const convB = service.repository.getConversationById(c.b_id);
      return {
        ...c,
        a_provider: convA?.provider ?? null,
        a_title: convA?.title ?? null,
        a_external_id: convA?.external_id ?? null,
        b_provider: convB?.provider ?? null,
        b_title: convB?.title ?? null,
        b_external_id: convB?.external_id ?? null,
      };
    });

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            exactDuplicateClusters: exactClusters,
            dedupeCandidates: enrichedCandidates,
          },
          null,
          2
        )
      );
      return;
    }

    console.log('\n=== Session Manager Deduplication Scanner ===');
    console.log(`- Exact Duplicate Clusters: ${exactClusters.length}`);
    for (const d of exactClusters) {
      console.log(
        `  Hash ${d.content_hash.slice(0, 16)}... -> ${d.count} conversations (IDs: ${d.ids})`
      );
    }

    console.log(`\n- Dedupe Candidate Pairs (${enrichedCandidates.length}):`);
    if (enrichedCandidates.length === 0) {
      console.log('  No dedupe_candidate pairs recorded.');
    } else {
      for (const c of enrichedCandidates) {
        console.log(
          `  #${c.id} [${(c.similarity * 100).toFixed(1)}% | ${c.status} | ${c.reason}] Conv #${c.a_id} ("${c.a_title ?? 'Untitled'}") <-> Conv #${c.b_id} ("${c.b_title ?? 'Untitled'}")`
        );
      }
    }
    console.log('=============================================\n');
  } finally {
    service.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Subcommand: sm export --format native|md|jsonl --out <dir>
// ─────────────────────────────────────────────────────────────────────────────

async function runExport(args: ParsedArgs): Promise<void> {
  const format = (typeof args.flags['format'] === 'string' ? args.flags['format'] : 'native').toLowerCase();
  const outDir = typeof args.flags['out'] === 'string' ? args.flags['out'] : undefined;
  const provider = typeof args.flags['provider'] === 'string' ? args.flags['provider'] : undefined;
  const isJson = Boolean(args.flags['json']);

  if (!outDir) {
    throw new CliError('"sm export" requires --out <dir> parameter.');
  }
  if (format !== 'native' && format !== 'md' && format !== 'jsonl') {
    throw new CliError(`Unsupported export format "${format}". Expected: native, md, jsonl`);
  }

  const resolvedOut = path.resolve(outDir);
  fs.mkdirSync(resolvedOut, { recursive: true });

  const { service, dbPath } = openCliArchive(args.flags);
  try {
    const convs = service.listConversations({ provider, limit: 100_000 });
    if (!isJson) {
      console.log(`Exporting ${convs.length} conversation(s) to "${resolvedOut}" in format "${format}"...`);
    }

    const entries: {
      conv: ConversationRow;
      view: ConversationViewModel;
      blobRows: BlobRow[];
    }[] = [];

    const allBlobRowsBySha = new Map<string, BlobRow>();

    for (const conv of convs) {
      const activeItems = service.repository.getConversationItems(conv.id, true);
      const allItems = service.repository.getConversationItems(conv.id, false);
      const { view, blobRows } = buildViewModelFromRows(service, conv, activeItems, allItems);
      entries.push({ conv, view, blobRows });
      for (const br of blobRows) {
        allBlobRowsBySha.set(br.sha256, br);
      }
    }

    if (format === 'md') {
      const files: string[] = [];
      for (const { conv, view } of entries) {
        const safeTitle = (conv.title ?? `conv_${conv.id}`).replace(
          /[^a-zA-Z0-9_\u4e00-\u9fa5-]/g,
          '_'
        );
        const mdFile = path.join(resolvedOut, `${conv.id}_${safeTitle}.md`);
        const md = formatConversationMarkdown(view);
        fs.writeFileSync(mdFile, md, 'utf8');
        files.push(mdFile);
      }
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              dbPath,
              format,
              outDir: resolvedOut,
              conversationCount: entries.length,
              files,
            },
            null,
            2
          )
        );
      } else {
        console.log(`✔ Exported ${entries.length} Markdown file(s) to ${resolvedOut}`);
      }
      return;
    }

    if (format === 'jsonl') {
      const jsonlPath = path.join(resolvedOut, 'conversations.jsonl');
      const lines = entries.map(({ conv, view }) =>
        JSON.stringify({
          id: conv.id,
          raw_blob_sha256: conv.raw_blob_sha256,
          revision_count: conv.revision_count,
          ...view,
        })
      );
      fs.writeFileSync(jsonlPath, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
      if (isJson) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              dbPath,
              format,
              outDir: resolvedOut,
              conversationCount: entries.length,
              jsonlPath,
            },
            null,
            2
          )
        );
      } else {
        console.log(`✔ Written JSONL file: ${jsonlPath}`);
      }
      return;
    }

    // format === 'native'
    const allBlobAssets = [...allBlobRowsBySha.values()].map((br) =>
      blobRowToAsset(br, normalizeExportBlobRelPath(br))
    );
    const manifest = exportNativeManifest(
      entries.map((e) => e.view),
      allBlobAssets,
      {
        generator: `sm-cli/${VERSION}`,
        conversationsFile: 'conversations.jsonl',
        blobsDir: 'blobs',
      }
    );

    const jsonlPath = path.join(resolvedOut, 'conversations.jsonl');
    const jsonlLines = entries.map(({ conv, view }) =>
      JSON.stringify({
        id: conv.id,
        raw_blob_sha256: conv.raw_blob_sha256,
        revision_count: conv.revision_count,
        ...view,
      })
    );
    fs.writeFileSync(jsonlPath, jsonlLines.length > 0 ? jsonlLines.join('\n') + '\n' : '', 'utf8');

    const sessionsPayload = entries.map(({ conv, view }) => {
      const rawBlob = conv.raw_blob_sha256 ? allBlobRowsBySha.get(conv.raw_blob_sha256) : undefined;
      return {
        id: conv.id,
        provider: conv.provider,
        external_id: conv.external_id,
        raw_format: conv.raw_format,
        raw_blob_sha256: conv.raw_blob_sha256,
        raw_blob_rel_path: rawBlob ? normalizeExportBlobRelPath(rawBlob) : null,
        revision_count: conv.revision_count,
        meta: view.meta,
        nodes: view.nodes,
        blobs: view.blobs,
      };
    });
    const sessionsPath = path.join(resolvedOut, 'sessions.json');
    fs.writeFileSync(sessionsPath, JSON.stringify(sessionsPayload, null, 2), 'utf8');

    const manifestPath = path.join(resolvedOut, 'native-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    // Copy all referenced blobs (including raw_blob_sha256 native session JSON blobs) into <out>/blobs/
    let copiedBlobs = 0;
    let missingBlobs = 0;
    for (const blobRow of allBlobRowsBySha.values()) {
      const srcAbs = service.blobStore.getBlobAbsPath(blobRow.rel_path);
      if (!fs.existsSync(srcAbs)) {
        missingBlobs++;
        continue;
      }
      const destRel = normalizeExportBlobRelPath(blobRow);
      const destAbs = path.join(resolvedOut, destRel);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(srcAbs, destAbs);
      copiedBlobs++;
    }

    if (isJson) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dbPath,
            format,
            outDir: resolvedOut,
            conversationCount: entries.length,
            copiedBlobs,
            missingBlobs,
            manifestPath,
            sessionsPath,
            jsonlPath,
          },
          null,
          2
        )
      );
    } else {
      console.log(
        `✔ Exported native archive to ${resolvedOut} (${entries.length} conversations, ${copiedBlobs} blobs copied${missingBlobs > 0 ? `, ${missingBlobs} missing` : ''})`
      );
    }
  } finally {
    service.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Subcommand: sm reindex [--db <archive.db>] [--json]
// ─────────────────────────────────────────────────────────────────────────────

async function runReindex(args: ParsedArgs): Promise<void> {
  const isJson = Boolean(args.flags['json']);
  const { service, dbPath } = openCliArchive(args.flags);
  try {
    if (!isJson) {
      console.log('Rebuilding FTS5 indexes and recalculating conversation statistics...');
    }

    const convCount = service.db.transaction(() => {
      const convs = service.db
        .prepare(`SELECT id FROM conversation WHERE deleted_at IS NULL`)
        .all() as { id: number }[];
      const aggStmt = service.db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(text_len), 0) AS total_len
        FROM item WHERE conversation_id = ? AND is_active_branch = 1
      `);
      const updStmt = service.db.prepare(`
        UPDATE conversation
        SET item_count = ?, char_count = ?
        WHERE id = ?
      `);

      for (const c of convs) {
        const stats = aggStmt.get(c.id) as { count: number; total_len: number };
        updStmt.run(stats.count, stats.total_len, c.id);
      }
      return convs.length;
    });

    service.rebuildFts();
    if (isJson) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dbPath,
            conversationCount: convCount,
            ftsRebuilt: true,
          },
          null,
          2
        )
      );
    } else {
      console.log(`✔ Successfully reindexed ${convCount} conversation(s) and rebuilt FTS5 indexes.`);
    }
  } finally {
    service.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting Utilities & Entrypoint Guard
// ─────────────────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTs(ts: number | null): string {
  if (ts == null) return 'N/A';
  return new Date(ts).toISOString();
}

function isExecutedAsMain(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    const selfPath = fs.realpathSync(fileURLToPath(import.meta.url));
    const invokedPath = fs.realpathSync(path.resolve(entryArg));
    return selfPath === invokedPath;
  } catch {
    return false;
  }
}

if (isExecutedAsMain()) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  });
}
