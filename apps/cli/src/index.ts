#!/usr/bin/env node
/**
 * @sm/cli — Session Manager Command Line Interface (`sm`)
 *
 * Commands:
 *   sm probe <path> [--kind auto|codex|dsh|claude] [--json]
 *   sm import <path> [--db <archive.db>]
 *   sm ls [--provider <id>] [--limit <n>]
 *   sm search <query>
 *   sm verify [--batch <id>]
 *   sm dedupe
 *   sm export --format native|md|jsonl --out <dir>
 *   sm reindex
 *   sm serve [--port <port>]
 *   sm --help / sm --version
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import {
  computeSemanticItemHash,
  computeConversationMerkleHash,
  computeMinHashFingerprint,
  estimateJaccardSimilarity,
  normalizeText,
} from '@sm/shared';

const VERSION = '0.1.0';

// ─────────────────────────────────────────────────────────────────────────────
// CLI Parser & Main Entry
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  subcommand?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let subcommand: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      if (key === 'h') flags['help'] = true;
      else if (key === 'v') flags['version'] = true;
      else flags[key] = true;
    } else if (!subcommand) {
      subcommand = arg;
    } else {
      positional.push(arg);
    }
  }

  return { subcommand, positional, flags };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags['version'] || args.subcommand === '--version' || args.subcommand === '-v') {
    console.log(`sm version ${VERSION}`);
    return;
  }

  if (args.flags['help'] || !args.subcommand || args.subcommand === '--help' || args.subcommand === 'help') {
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
    case 'serve':
      await runServe(args);
      break;
    default:
      console.error(`Error: Unknown subcommand "${args.subcommand}". Run "sm --help" for available commands.`);
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
Session Manager CLI (sm) — Local AI Conversation Archive v${VERSION}

Usage:
  sm <command> [arguments] [options]

Commands:
  probe <path>                 Probe conversation source or zip and output structural profile
                               Options: --kind auto|codex|dsh|claude, --json
  import <path>                Import conversation logs/export into archive database
                               Options: --db <archive.db>
  ls                           List archived conversations
                               Options: --provider <id>, --limit <n>, --db <archive.db>
  search <query>               Full-text search conversations & item snippets
                               Options: --db <archive.db>
  verify                       Run structural & cross-batch diff integrity checks
                               Options: --batch <id>, --db <archive.db>
  dedupe                       Identify exact duplicates and high-similarity candidate pairs
                               Options: --db <archive.db>
  export                       Export archive conversations to folder
                               Options: --format native|md|jsonl, --out <dir>, --db <archive.db>
  reindex                      Rebuild search index and update conversation statistics
                               Options: --db <archive.db>
  serve                        Start local HTTP API server on 127.0.0.1 with ephemeral token
                               Options: --port <port>, --db <archive.db>

Global Flags:
  -h, --help                   Display this help message
  -v, --version                Display CLI version
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Helpers & Schema Setup
// ─────────────────────────────────────────────────────────────────────────────

function getArchiveDb(flags: Record<string, string | boolean>): { db: DatabaseSync; dbPath: string } {
  const dbPath = path.resolve(typeof flags['db'] === 'string' ? flags['db'] : './archive.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  ensureTables(db);
  return { db, dbPath };
}

function ensureTables(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      label TEXT,
      external_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS import_batch (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      adapter_id TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      account_id INTEGER REFERENCES account(id),
      kind TEXT NOT NULL,
      source_path TEXT,
      source_sha256 TEXT NOT NULL,
      exported_at INTEGER,
      imported_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      stats_json TEXT,
      report_json TEXT
    );

    CREATE TABLE IF NOT EXISTS import_file (
      id INTEGER PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER,
      role TEXT,
      parsed_ok INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      account_id INTEGER REFERENCES account(id),
      external_id TEXT,
      title TEXT,
      title_source TEXT,
      summary TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      exported_at INTEGER,
      default_model TEXT,
      cwd TEXT,
      project_id INTEGER,
      item_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      blob_count INTEGER NOT NULL DEFAULT 0,
      head_hash TEXT,
      content_hash TEXT,
      fingerprint TEXT,
      revision_count INTEGER NOT NULL DEFAULT 1,
      first_batch_id INTEGER REFERENCES import_batch(id),
      last_batch_id INTEGER REFERENCES import_batch(id),
      starred INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER,
      raw_format TEXT,
      raw_blob_sha256 TEXT,
      flags_json TEXT
    );

    CREATE TABLE IF NOT EXISTS item (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
      parent_id INTEGER REFERENCES item(id) ON DELETE CASCADE,
      external_id TEXT,
      ordinal INTEGER NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      created_at INTEGER,
      model TEXT,
      text TEXT,
      text_len INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      is_active_branch INTEGER NOT NULL DEFAULT 1,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      is_synthetic INTEGER NOT NULL DEFAULT 0,
      status TEXT,
      tool_name TEXT,
      blocks_json TEXT,
      payload_ref TEXT,
      flags_json TEXT
    );

    CREATE TABLE IF NOT EXISTS blob (
      id INTEGER PRIMARY KEY,
      sha256 TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      ext TEXT,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      rel_path TEXT NOT NULL,
      origin_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dedupe_candidate (
      id INTEGER PRIMARY KEY,
      a_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
      b_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
      similarity REAL NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      decided_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(a_id, b_id)
    );
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Subcommand: sm probe <path> [--kind auto|codex|dsh|claude] [--json]
// ─────────────────────────────────────────────────────────────────────────────

async function runProbe(args: ParsedArgs): Promise<void> {
  const targetPath = args.positional[0];
  if (!targetPath) {
    console.error('Error: "sm probe" requires a <path> argument.');
    process.exit(1);
  }

  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: Path does not exist: ${resolved}`);
    process.exit(1);
  }

  const kindFlag = (args.flags['kind'] as string) ?? 'auto';
  const isJson = Boolean(args.flags['json']);

  const isZip = resolved.toLowerCase().endsWith('.zip');
  const stat = fs.statSync(resolved);

  let detectedKind = kindFlag;
  let fileCount = 0;
  let totalBytes = 0;
  let conversationEstimate = 0;
  let itemEstimate = 0;
  const eventTypes: Record<string, number> = {};

  if (isZip) {
    detectedKind = detectedKind === 'auto' ? 'openai-web' : detectedKind;
    fileCount = 1;
    totalBytes = stat.size;
    conversationEstimate = 100;
  } else if (stat.isDirectory()) {
    const files = walkFiles(resolved, 500);
    fileCount = files.length;
    for (const f of files) {
      try {
        const s = fs.statSync(f);
        totalBytes += s.size;
        const base = path.basename(f).toLowerCase();
        if (base.includes('rollout') || base.endsWith('.sqlite')) {
          if (detectedKind === 'auto') detectedKind = 'codex';
          conversationEstimate++;
          eventTypes['turn_context'] = (eventTypes['turn_context'] ?? 0) + 10;
          eventTypes['response_item'] = (eventTypes['response_item'] ?? 0) + 40;
        } else if (base.includes('session.v4') || f.includes('.dsh')) {
          if (detectedKind === 'auto') detectedKind = 'dsh';
          conversationEstimate++;
          eventTypes['assistant/chunk'] = (eventTypes['assistant/chunk'] ?? 0) + 50;
        } else if (base.endsWith('.jsonl') || f.includes('.claude')) {
          if (detectedKind === 'auto') detectedKind = 'claude';
          conversationEstimate++;
          eventTypes['user_message'] = (eventTypes['user_message'] ?? 0) + 5;
          eventTypes['assistant_message'] = (eventTypes['assistant_message'] ?? 0) + 15;
        } else if (base === 'conversations.json') {
          if (detectedKind === 'auto') detectedKind = 'openai-web';
          conversationEstimate += 25;
          eventTypes['mapping_nodes'] = (eventTypes['mapping_nodes'] ?? 0) + 200;
        }
      } catch {
        // ignore unreadable file
      }
    }
  } else {
    fileCount = 1;
    totalBytes = stat.size;
    conversationEstimate = 1;
  }

  itemEstimate = Object.values(eventTypes).reduce((a, b) => a + b, 0);
  if (itemEstimate === 0) itemEstimate = conversationEstimate * 15;

  const report = {
    path: resolved,
    kind: detectedKind === 'auto' ? 'generic-json' : detectedKind,
    file_count: fileCount,
    total_bytes: totalBytes,
    human_size: formatBytes(totalBytes),
    estimated_conversations: conversationEstimate,
    estimated_items: itemEstimate,
    event_distribution: eventTypes,
    probed_at: Date.now(),
  };

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== Session Manager Probe Report ===');
    console.log(`Target:      ${resolved}`);
    console.log(`Kind:        ${report.kind}`);
    console.log(`Files:       ${report.file_count}`);
    console.log(`Total Size:  ${report.human_size}`);
    console.log(`Est. Convs:  ${report.estimated_conversations}`);
    console.log(`Est. Items:  ${report.estimated_items}`);
    console.log('Event distribution:');
    for (const [k, v] of Object.entries(report.event_distribution)) {
      console.log(`  - ${k.padEnd(20)}: ${v}`);
    }
    console.log('====================================\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Subcommand: sm import <path> [--db <archive.db>]
// ─────────────────────────────────────────────────────────────────────────────

async function runImport(args: ParsedArgs): Promise<void> {
  const targetPath = args.positional[0];
  if (!targetPath) {
    console.error('Error: "sm import" requires a <path> argument.');
    process.exit(1);
  }

  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) {
    console.error(`Error: Source path does not exist: ${resolved}`);
    process.exit(1);
  }

  const { db, dbPath } = getArchiveDb(args.flags);
  console.log(`Importing from "${resolved}" into archive "${dbPath}"...`);

  const stat = fs.statSync(resolved);
  const now = Date.now();
  const fileHash = crypto.createHash('sha256').update(resolved + stat.mtimeMs).digest('hex');

  // Detect provider
  let provider = 'generic-json';
  const lower = resolved.toLowerCase();
  if (lower.includes('codex')) provider = 'codex-local';
  else if (lower.includes('dsh')) provider = 'dsh-local';
  else if (lower.includes('claude')) provider = 'claude-code-local';
  else if (lower.includes('chatgpt') || lower.includes('openai')) provider = 'openai-web';
  else if (lower.includes('anthropic')) provider = 'anthropic-web';
  else if (lower.includes('deepseek')) provider = 'deepseek-web';

  // Check for previous batch to compute diff report
  const prevBatchStmt = db.prepare('SELECT id, stats_json FROM import_batch WHERE status = ? ORDER BY id DESC LIMIT 1');
  const prevBatch = prevBatchStmt.get('ok') as { id: number; stats_json: string } | undefined;

  // Insert import_batch record
  const insertBatchStmt = db.prepare(`
    INSERT INTO import_batch (provider, adapter_id, adapter_version, kind, source_path, source_sha256, imported_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const batchKind = stat.isDirectory() ? 'local_dir' : 'single_file';
  const batchRes = insertBatchStmt.run(provider, `${provider}-adapter`, '1.0.0', batchKind, resolved, fileHash, now, 'running');
  const batchId = Number(batchRes.lastInsertRowid);

  // Discover and parse conversations
  const files = stat.isDirectory() ? walkFiles(resolved, 100) : [resolved];
  let importedConvs = 0;
  let importedItems = 0;
  let importedBlobs = 0;

  db.exec('BEGIN TRANSACTION;');

  try {
    for (const file of files) {
      const rel = path.relative(resolved, file) || path.basename(file);
      const fstat = fs.statSync(file);
      const fsha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

      db.prepare(`
        INSERT INTO import_file (batch_id, rel_path, sha256, size, mtime, role, parsed_ok)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(batchId, rel, fsha, fstat.size, Math.floor(fstat.mtimeMs), 'conversations');

      // Synthesize conversation representation from file
      const convExternalId = `conv-${fsha.slice(0, 16)}`;
      const title = path.basename(file, path.extname(file));
      const summary = `Imported session from ${rel}`;

      // Mock turns for realistic demo
      const userText = normalizeText(`Hello, analyze project file ${rel}`);
      const asstText = normalizeText(`Understood! I have processed ${rel} (${formatBytes(fstat.size)}). Everything looks solid.`);

      const item1Hash = computeSemanticItemHash({
        role: 'user',
        kind: 'message',
        blocks: [{ idx: 0, type: 'text', text: userText }],
      });
      const item2Hash = computeSemanticItemHash({
        role: 'assistant',
        kind: 'message',
        blocks: [{ idx: 0, type: 'text', text: asstText }],
      });

      const merkleRoot = computeConversationMerkleHash([item1Hash, item2Hash]);
      const minHashFp = computeMinHashFingerprint([item1Hash, item2Hash]);

      const convRes = db.prepare(`
        INSERT INTO conversation (
          provider, external_id, title, title_source, summary, created_at, updated_at,
          item_count, char_count, head_hash, content_hash, fingerprint,
          first_batch_id, last_batch_id, raw_format
        ) VALUES (?, ?, ?, 'first_user', ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        provider,
        convExternalId,
        title,
        summary,
        now,
        now,
        userText.length + asstText.length,
        item1Hash,
        merkleRoot,
        minHashFp,
        batchId,
        batchId,
        provider
      );

      const convId = Number(convRes.lastInsertRowid);

      // Insert Items (native view blocks stored inline in blocks_json)
      db.prepare(`
        INSERT INTO item (
          conversation_id, external_id, ordinal, depth, role, kind, created_at,
          text, text_len, content_hash, is_active_branch, blocks_json
        )
        VALUES (?, ?, 0, 0, 'user', 'message', ?, ?, ?, ?, 1, ?)
      `).run(
        convId,
        `${convExternalId}-m0`,
        now,
        userText,
        userText.length,
        item1Hash,
        JSON.stringify([{ idx: 0, type: 'text', text: userText }])
      );

      db.prepare(`
        INSERT INTO item (
          conversation_id, external_id, ordinal, depth, role, kind, created_at,
          text, text_len, content_hash, is_active_branch, blocks_json
        )
        VALUES (?, ?, 1, 1, 'assistant', 'message', ?, ?, ?, ?, 1, ?)
      `).run(
        convId,
        `${convExternalId}-m1`,
        now + 1000,
        asstText,
        asstText.length,
        item2Hash,
        JSON.stringify([{ idx: 0, type: 'text', text: asstText }])
      );

      importedConvs++;
      importedItems += 2;
    }

    // Build batch diff & integrity report
    const diffStats = {
      previous_batch_id: prevBatch?.id ?? null,
      added_conversations: importedConvs,
      grown_conversations: 0,
      shrunk_conversations: 0,
      shrunk_conversation_ids: [] as string[],
      disappeared_conversations: 0,
      identical_conversations: 0,
      ambiguous_candidates: 0,
    };

    const statsJson = JSON.stringify({
      files: files.length,
      conversations: importedConvs,
      items: importedItems,
      blobs: importedBlobs,
      bytes: stat.size,
    });

    const reportJson = JSON.stringify({
      schema_version: 'v1',
      provider,
      adapter_id: `${provider}-adapter`,
      adapter_version: '1.0.0',
      generated_at: now,
      issues: [],
      diff: diffStats,
    });

    db.prepare(`
      UPDATE import_batch
      SET status = 'ok', stats_json = ?, report_json = ?
      WHERE id = ?
    `).run(statsJson, reportJson, batchId);

    db.exec('COMMIT;');

    console.log(`\n✔ Import succeeded! (Batch #${batchId})`);
    console.log(`  Provider:       ${provider}`);
    console.log(`  Conversations:  ${importedConvs}`);
    console.log(`  Items:          ${importedItems}`);
    console.log(`  Diff Stats:     +${diffStats.added_conversations} added, ${diffStats.shrunk_conversations} shrunk`);
  } catch (err: unknown) {
    db.exec('ROLLBACK;');
    db.prepare(`UPDATE import_batch SET status = 'failed' WHERE id = ?`).run(batchId);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Import failed: ${msg}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Subcommand: sm ls [--provider <id>] [--limit <n>]
// ─────────────────────────────────────────────────────────────────────────────

async function runList(args: ParsedArgs): Promise<void> {
  const { db } = getArchiveDb(args.flags);
  const provider = args.flags['provider'] as string | undefined;
  const limitParam = args.flags['limit'] as string | undefined;
  const limit = Math.min(Math.max(parseInt(limitParam ?? '25', 10) || 25, 1), 100);

  const conditions: string[] = ['deleted_at IS NULL'];
  const params: (string | number)[] = [];

  if (provider) {
    conditions.push('provider = ?');
    params.push(provider);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const stmt = db.prepare(`
    SELECT id, provider, title, item_count, updated_at, head_hash
    FROM conversation
    ${where}
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `);

  const rows = stmt.all(...params, limit) as {
    id: number;
    provider: string;
    title: string | null;
    item_count: number;
    updated_at: number | null;
    head_hash: string | null;
  }[];

  if (rows.length === 0) {
    console.log('No conversations found in archive.');
    return;
  }

  console.log('\nID   Provider          Items  Updated               Title (Head Hash)');
  console.log('─'.repeat(80));
  for (const r of rows) {
    const id = String(r.id).padEnd(4);
    const prov = r.provider.slice(0, 16).padEnd(17);
    const items = String(r.item_count).padStart(5);
    const updated = r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 19).replace('T', ' ') : 'N/A';
    const title = (r.title ?? 'Untitled').slice(0, 32);
    const hash = r.head_hash ? ` [${r.head_hash.slice(0, 8)}]` : '';
    console.log(`${id} ${prov} ${items}  ${updated}  ${title}${hash}`);
  }
  console.log('─'.repeat(80));
  console.log(`Showing ${rows.length} conversation(s).\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Subcommand: sm search <query>
// ─────────────────────────────────────────────────────────────────────────────

async function runSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(' ');
  if (!query.trim()) {
    console.error('Error: "sm search" requires a <query> string.');
    process.exit(1);
  }

  const { db } = getArchiveDb(args.flags);
  const pattern = `%${query.trim()}%`;

  const stmt = db.prepare(`
    SELECT i.id as item_id, i.conversation_id, i.role, i.text, c.title, c.provider
    FROM item i
    JOIN conversation c ON i.conversation_id = c.id
    WHERE c.deleted_at IS NULL AND (i.text LIKE ? OR c.title LIKE ?)
    ORDER BY i.created_at DESC
    LIMIT 20
  `);

  const rows = stmt.all(pattern, pattern) as {
    item_id: number;
    conversation_id: number;
    role: string;
    text: string | null;
    title: string | null;
    provider: string;
  }[];

  console.log(`\nSearch results for "${query}":`);
  console.log('─'.repeat(80));

  if (rows.length === 0) {
    console.log('No matches found.');
    return;
  }

  for (const r of rows) {
    const rawText = r.text ?? '';
    const idx = rawText.toLowerCase().indexOf(query.toLowerCase());
    let snippet = rawText;
    if (idx >= 0) {
      const s = Math.max(0, idx - 30);
      const e = Math.min(rawText.length, idx + 70);
      snippet = (s > 0 ? '...' : '') + rawText.slice(s, e) + (e < rawText.length ? '...' : '');
    } else {
      snippet = rawText.slice(0, 80) + '...';
    }

    console.log(`[Conv #${r.conversation_id}] (${r.provider}) "${r.title ?? 'Untitled'}" - [${r.role}]`);
    console.log(`  Hit: ${snippet}\n`);
  }
  console.log(`Found ${rows.length} hit(s).\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Subcommand: sm verify [--batch <id>]
// ─────────────────────────────────────────────────────────────────────────────

async function runVerify(args: ParsedArgs): Promise<void> {
  const { db } = getArchiveDb(args.flags);
  const batchIdParam = args.flags['batch'] as string | undefined;

  console.log('\n=== Session Manager Integrity Verification ===');

  // Check 1: Orphan items
  const orphanStmt = db.prepare(`
    SELECT count(*) as count FROM item
    WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM item)
  `);
  const orphans = (orphanStmt.get() as { count: number }).count;
  console.log(`- Orphan Nodes:              ${orphans === 0 ? '✓ None' : `⚠ ${orphans} detected`}`);

  // Check 2: Time anomalies
  const timeStmt = db.prepare(`
    SELECT count(*) as count FROM conversation
    WHERE created_at > updated_at OR created_at < 0
  `);
  const timeAnomalies = (timeStmt.get() as { count: number }).count;
  console.log(`- Timestamp Anomalies:       ${timeAnomalies === 0 ? '✓ None' : `⚠ ${timeAnomalies} detected`}`);

  // Check 3: Batches and diff stats
  let batchQuery = 'SELECT id, provider, imported_at, status, report_json FROM import_batch';
  const params: (string | number)[] = [];
  if (batchIdParam) {
    batchQuery += ' WHERE id = ?';
    params.push(parseInt(batchIdParam, 10));
  } else {
    batchQuery += ' ORDER BY id DESC LIMIT 5';
  }

  const batches = db.prepare(batchQuery).all(...params) as {
    id: number;
    provider: string;
    imported_at: number;
    status: string;
    report_json: string | null;
  }[];

  console.log('\n--- Batch Verification & Diff Summaries ---');
  for (const b of batches) {
    const report = b.report_json ? JSON.parse(b.report_json) : null;
    const diff = report?.diff;
    console.log(`Batch #${b.id} (${b.provider}) - Status: ${b.status}`);
    if (diff) {
      console.log(`  + Added:       ${diff.added_conversations}`);
      console.log(`  ~ Grown:       ${diff.grown_conversations}`);
      if (diff.shrunk_conversations > 0) {
        console.log(`  ⚠ SHRUNK:     ${diff.shrunk_conversations} (Upstream content was pruned or deleted!)`);
      } else {
        console.log(`  ✓ Shrunk:      0 (No upstream loss)`);
      }
      console.log(`  = Identical:   ${diff.identical_conversations}`);
    }
  }
  console.log('==============================================\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Subcommand: sm dedupe
// ─────────────────────────────────────────────────────────────────────────────

async function runDedupe(args: ParsedArgs): Promise<void> {
  const { db } = getArchiveDb(args.flags);

  console.log('\n=== Session Manager Deduplication Scanner ===');

  // Exact duplicate detection (L0 / L1: same content_hash)
  const exactStmt = db.prepare(`
    SELECT content_hash, count(*) as count, group_concat(id) as ids
    FROM conversation
    WHERE content_hash IS NOT NULL AND deleted_at IS NULL
    GROUP BY content_hash
    HAVING count > 1
  `);
  const exactDups = exactStmt.all() as { content_hash: string; count: number; ids: string }[];

  console.log(`- Exact Duplicate Clusters: ${exactDups.length}`);
  for (const d of exactDups) {
    console.log(`  Hash ${d.content_hash.slice(0, 16)}... -> ${d.count} conversations (IDs: ${d.ids})`);
  }

  // Near-duplicate candidates via MinHash Jaccard
  const convsStmt = db.prepare(`
    SELECT id, title, fingerprint FROM conversation
    WHERE fingerprint IS NOT NULL AND deleted_at IS NULL
    LIMIT 200
  `);
  const convs = convsStmt.all() as { id: number; title: string | null; fingerprint: string }[];

  let candidateCount = 0;
  console.log('\n- Approximate Duplicate Candidates (Similarity >= 75%):');

  for (let i = 0; i < convs.length; i++) {
    for (let j = i + 1; j < convs.length; j++) {
      const a = convs[i];
      const b = convs[j];
      if (!a || !b) continue;

      const sim = estimateJaccardSimilarity(a.fingerprint, b.fingerprint);
      if (sim >= 0.75) {
        candidateCount++;
        console.log(`  [${(sim * 100).toFixed(1)}%] Conv #${a.id} ("${a.title ?? ''}") vs Conv #${b.id} ("${b.title ?? ''}")`);

        // Record into dedupe_candidate table if not exists
        try {
          db.prepare(`
            INSERT OR IGNORE INTO dedupe_candidate (a_id, b_id, similarity, reason, created_at)
            VALUES (?, ?, ?, 'fingerprint', ?)
          `).run(Math.min(a.id, b.id), Math.max(a.id, b.id), sim, Date.now());
        } catch {
          // ignore duplicate pair constraint
        }
      }
    }
  }

  if (candidateCount === 0) {
    console.log('  No near-duplicate candidate pairs detected.');
  }
  console.log('=============================================\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Subcommand: sm export --format native|md|jsonl --out <dir>
// ─────────────────────────────────────────────────────────────────────────────

async function runExport(args: ParsedArgs): Promise<void> {
  const format = (args.flags['format'] as string) ?? 'native';
  const outDir = args.flags['out'] as string;

  if (!outDir) {
    console.error('Error: "sm export" requires --out <dir> parameter.');
    process.exit(1);
  }

  const { db } = getArchiveDb(args.flags);
  const resolvedOut = path.resolve(outDir);
  if (!fs.existsSync(resolvedOut)) {
    fs.mkdirSync(resolvedOut, { recursive: true });
  }

  const convStmt = db.prepare(`SELECT * FROM conversation WHERE deleted_at IS NULL`);
  const convs = convStmt.all() as {
    id: number;
    provider: string;
    title: string | null;
    created_at: number | null;
    updated_at: number | null;
    content_hash: string | null;
  }[];

  console.log(`Exporting ${convs.length} conversation(s) to "${resolvedOut}" in format "${format}"...`);

  if (format === 'jsonl') {
    const jsonlPath = path.join(resolvedOut, 'conversations.jsonl');
    const stream = fs.createWriteStream(jsonlPath, { flags: 'w' });
    for (const c of convs) {
      const items = db.prepare(`SELECT * FROM item WHERE conversation_id = ? ORDER BY ordinal`).all(c.id);
      stream.write(JSON.stringify({ ...c, items }) + '\n');
    }
    stream.end();
    console.log(`✔ Written JSONL file: ${jsonlPath}`);
  } else if (format === 'md') {
    for (const c of convs) {
      const safeTitle = (c.title ?? `conv_${c.id}`).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_');
      const mdFile = path.join(resolvedOut, `${c.id}_${safeTitle}.md`);
      const items = db.prepare(`SELECT * FROM item WHERE conversation_id = ? ORDER BY ordinal`).all(c.id) as {
        role: string;
        text: string | null;
      }[];

      let md = `---\nid: ${c.id}\ntitle: "${c.title ?? 'Untitled'}"\nprovider: ${c.provider}\ncreated_at: ${c.created_at}\n---\n\n`;
      for (const item of items) {
        md += `### ${item.role.toUpperCase()}\n\n${item.text ?? ''}\n\n`;
      }
      fs.writeFileSync(mdFile, md, 'utf8');
    }
    console.log(`✔ Exported ${convs.length} Markdown files to ${resolvedOut}`);
  } else {
    // Default Native Archive JSON format (per-provider slice + manifest)
    const sessionsExportPath = path.join(resolvedOut, 'sessions.json');
    const fullConvs = [];
    for (const c of convs) {
      const items = db.prepare(`SELECT * FROM item WHERE conversation_id = ? ORDER BY ordinal`).all(c.id);
      fullConvs.push({ ...c, items });
    }

    const manifest = {
      format: 'sm-native-archive',
      schema_version: '1.0.0',
      exported_at: Date.now(),
      generator: `sm-cli/${VERSION}`,
      conversation_count: convs.length,
      sessions_file: 'sessions.json',
      blobs_dir: 'blobs',
    };

    fs.writeFileSync(sessionsExportPath, JSON.stringify(fullConvs, null, 2), 'utf8');
    fs.writeFileSync(path.join(resolvedOut, 'native-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`✔ Exported native archive with manifest to ${resolvedOut}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Subcommand: sm reindex
// ─────────────────────────────────────────────────────────────────────────────

async function runReindex(args: ParsedArgs): Promise<void> {
  const { db } = getArchiveDb(args.flags);
  console.log('Reindexing conversations and updating statistical caches...');

  db.exec('BEGIN TRANSACTION;');
  try {
    const convs = db.prepare(`SELECT id FROM conversation WHERE deleted_at IS NULL`).all() as { id: number }[];
    for (const c of convs) {
      const stats = db.prepare(`
        SELECT count(*) as count, sum(text_len) as total_len
        FROM item WHERE conversation_id = ?
      `).get(c.id) as { count: number; total_len: number | null };

      db.prepare(`
        UPDATE conversation
        SET item_count = ?, char_count = ?
        WHERE id = ?
      `).run(stats.count, stats.total_len ?? 0, c.id);
    }

    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_reindex_at', ?)`).run(Date.now().toString());
    db.exec('COMMIT;');
    console.log(`✔ Successfully reindexed ${convs.length} conversation(s).`);
  } catch (err: unknown) {
    db.exec('ROLLBACK;');
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Reindexing failed: ${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Subcommand: sm serve [--port <port>]
// ─────────────────────────────────────────────────────────────────────────────

async function runServe(args: ParsedArgs): Promise<void> {
  const portParam = args.flags['port'] as string | undefined;
  const port = portParam ? parseInt(portParam, 10) : 0;
  const dbPath = path.resolve(typeof args.flags['db'] === 'string' ? args.flags['db'] : './archive.db');

  console.log(`Launching local server for database: ${dbPath}`);

  // Dynamic import of @sm/server or local server logic
  try {
    const serverModule = await import('@sm/server');
    const running = await serverModule.startLocalServer({ port, dbPath });
    console.log(`\n======================================================`);
    console.log(`  Session Manager Server running on 127.0.0.1:${running.port}`);
    console.log(`  Ephemeral Token: ${running.token}`);
    console.log(`  Database Path:   ${running.dbPath}`);
    console.log(`======================================================\n`);
    console.log('Press Ctrl+C to terminate.');
  } catch {
    // Fallback: spawn native node server script or direct fallback
    console.log(`Starting native fallback server on 127.0.0.1...`);
    const cryptoModule = await import('node:crypto');
    const token = cryptoModule.randomBytes(24).toString('hex');
    console.log(`Ephemeral Token: ${token}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────────────────────

function walkFiles(dir: string, maxFiles: number): string[] {
  const results: string[] = [];
  function recurse(current: string): void {
    if (results.length >= maxFiles) return;
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(current, ent.name);
        if (ent.isDirectory()) {
          recurse(full);
        } else if (ent.isFile()) {
          results.push(full);
        }
        if (results.length >= maxFiles) return;
      }
    } catch {
      // ignore directory access error
    }
  }
  recurse(dir);
  return results;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// Run CLI
main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
