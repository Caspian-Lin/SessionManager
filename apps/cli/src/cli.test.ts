import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '@sm/shared';
import { ArchiveDatabase } from '@sm/store';
import {
  SYNTHETIC_JPEG_BYTES,
  SYNTHETIC_PNG_BYTES,
  createRichSyntheticOpenAiExport,
  createSyntheticCodexDir,
  createZipBuffer,
} from '../../../packages/fixtures/src/index.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..');
const CLI_BIN = path.resolve(REPO_ROOT, 'apps', 'cli', 'dist', 'index.js');

const tempDirs: string[] = [];

function makeTempDir(prefix = 'sm-cli-e2e-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function runSm(args: string[], cwd = REPO_ROOT): string {
  return execFileSync(process.execPath, [CLI_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('@sm/cli E2E closed-loop integration (Issues #6, #19)', () => {
  it('executes full closed loop: probe -> import -> L0 idempotent re-import -> shrunk/grown revision -> ls -> show -> search (EN + 2/3-char CJK) -> verify -> reindex -> export (native/md/jsonl)', () => {
    const workDir = makeTempDir();
    const archiveDir = path.join(workDir, 'archive');
    const dbPath = path.join(archiveDir, 'archive.db');

    // 1. Prepare OpenAI ZIP fixture & Codex local dir fixture
    const richOpenAi = createRichSyntheticOpenAiExport();
    const zipV1Path = path.join(workDir, 'openai-v1.zip');
    fs.writeFileSync(zipV1Path, richOpenAi.toZipBuffer());

    const codexDir = path.join(workDir, '.codex');
    const codexFixture = createSyntheticCodexDir(codexDir);

    // ── PROBE ───────────────────────────────────────────────────────────────
    const probeOpenAiRaw = runSm(['probe', zipV1Path, '--json']);
    const probeOpenAi = JSON.parse(probeOpenAiRaw) as {
      adapterId: string;
      version: string;
      confidence: number;
      evidence: string[];
      warnings: string[];
      entryCount: number;
      entries: string[];
    };
    expect(probeOpenAi.adapterId).toBe('openai-web');
    expect(probeOpenAi.confidence).toBeGreaterThanOrEqual(0.99);
    expect(probeOpenAi.entryCount).toBe(2);
    expect(probeOpenAi.entries).toEqual(['conversations-000.json', 'conversations-001.json']);
    expect(probeOpenAi.evidence.length).toBeGreaterThan(0);

    const probeCodexRaw = runSm(['probe', codexDir, '--kind', 'codex', '--json']);
    const probeCodex = JSON.parse(probeCodexRaw) as {
      adapterId: string;
      confidence: number;
      entryCount: number;
    };
    expect(probeCodex.adapterId).toBe('codex-local');
    expect(probeCodex.confidence).toBeGreaterThanOrEqual(0.95);
    expect(probeCodex.entryCount).toBeGreaterThanOrEqual(3);

    // ── IMPORT (OpenAI ZIP v1) ──────────────────────────────────────────────
    const importV1Out = runSm(['import', zipV1Path, '--db', dbPath]);
    expect(importV1Out).toContain('Import succeeded!');
    expect(importV1Out).toContain('Batch #1');
    expect(importV1Out).toContain('openai-web');
    expect(importV1Out).toContain('Conversations:  2');
    expect(importV1Out).toContain('+2 added');

    // ── RE-IMPORT SAME SOURCE (L0 Idempotent 0 new) ─────────────────────────
    const reimportOut = runSm(['import', zipV1Path, '--db', dbPath]);
    expect(reimportOut).toContain('L0 idempotent skip');
    expect(reimportOut).toContain('Batch #1');
    expect(reimportOut).toContain('0 new conversations');

    // ── IMPORT CODEX LOCAL DIR + L0 RE-IMPORT ───────────────────────────────
    const importCodexOut = runSm(['import', codexDir, '--db', dbPath]);
    expect(importCodexOut).toContain('Import succeeded!');
    expect(importCodexOut).toContain('codex-local');
    expect(importCodexOut).toContain('Conversations:  3');

    const reimportCodexOut = runSm(['import', codexDir, '--db', dbPath]);
    expect(reimportCodexOut).toContain('L0 idempotent skip');
    expect(reimportCodexOut).toContain('0 new conversations');

    // ── IMPORT MODIFIED / SHRUNK OPENAI ZIP v2 (with CJK content) ───────────
    // Clone conv1 and prune nodes (shrunk + branch_revision), grow conv2 with CJK text
    const conv1Shrunk = JSON.parse(JSON.stringify(richOpenAi.shard0[0])) as {
      id: string;
      conversation_id: string;
      title: string;
      update_time: number;
      current_node: string;
      mapping: Record<string, Record<string, unknown>>;
    };
    // Keep only root, sys-ctx, and user-1 (pruning assistant responses -> shrunk!)
    conv1Shrunk.update_time = 1715000900;
    conv1Shrunk.current_node = 'node-user-1';
    delete conv1Shrunk.mapping['node-asst-active'];
    delete conv1Shrunk.mapping['node-asst-alt'];
    delete conv1Shrunk.mapping['node-orphan-01'];
    delete conv1Shrunk.mapping['node-noise-only'];

    const conv2GrownCjk = JSON.parse(JSON.stringify(richOpenAi.shard1[0])) as {
      id: string;
      conversation_id: string;
      title: string;
      update_time: number;
      current_node: string;
      mapping: Record<string, Record<string, unknown>>;
    };
    conv2GrownCjk.title = '分布式全文检索与缓存架构';
    conv2GrownCjk.update_time = 1715100900;
    conv2GrownCjk.current_node = 's2-user-cjk';
    conv2GrownCjk.mapping['s2-asst-1']!['children'] = ['s2-user-cjk'];
    conv2GrownCjk.mapping['s2-user-cjk'] = {
      id: 's2-user-cjk',
      parent: 's2-asst-1',
      children: [],
      message: {
        id: 's2-user-cjk',
        author: { role: 'user' },
        create_time: 1715100200,
        content: {
          content_type: 'text',
          parts: ['请分析 SQLite 全文检索 与 缓存 一致性策略。'],
        },
      },
    };

    const zipV2Path = path.join(workDir, 'openai-v2-shrunk.zip');
    const zipV2Buf = createZipBuffer([
      {
        name: 'export_manifest.json',
        data: JSON.stringify({ export_version: '2', shards: ['conversations-000.json', 'conversations-001.json'] }),
      },
      { name: 'conversations-000.json', data: JSON.stringify([conv1Shrunk]) },
      { name: 'conversations-001.json', data: JSON.stringify([conv2GrownCjk]) },
      { name: 'file-synth-png-01.dat', data: SYNTHETIC_PNG_BYTES },
      { name: 'user-999/file_synth_jpg_02.dat', data: SYNTHETIC_JPEG_BYTES },
    ]);
    fs.writeFileSync(zipV2Path, zipV2Buf);

    const importV2Out = runSm(['import', zipV2Path, '--db', dbPath]);
    expect(importV2Out).toContain('Import succeeded!');
    expect(importV2Out).toContain('~1 grown');
    expect(importV2Out).toContain('!1 shrunk');
    expect(importV2Out).toContain('conv-openai-rich-01');

    // ── LS ──────────────────────────────────────────────────────────────────
    const lsOut = runSm(['ls', '--db', dbPath]);
    expect(lsOut).toContain('openai-web');
    expect(lsOut).toContain('codex-local');
    expect(lsOut).toContain('Showing 5 conversation(s).');

    const lsOpenAiJson = JSON.parse(runSm(['ls', '--provider', 'openai-web', '--json', '--db', dbPath])) as {
      id: number;
      external_id: string;
      revision_count: number;
    }[];
    expect(lsOpenAiJson).toHaveLength(2);
    const richConv1 = lsOpenAiJson.find((c) => c.external_id === 'conv-openai-rich-01')!;
    const richConv2 = lsOpenAiJson.find((c) => c.external_id === 'conv-openai-rich-02')!;
    expect(richConv1.revision_count).toBe(2);
    expect(richConv2.revision_count).toBe(2);

    // ── SHOW (default collapsed synthetic/active vs --all-branches --include-synthetic) ──
    const showDefault = runSm(['show', String(richConv1.id), '--db', dbPath]);
    expect(showDefault).toContain('Rich OpenAI Multimodal & Branched Session');
    expect(showDefault).toContain('Rev #1');
    expect(showDefault).toContain('Rev #2');
    expect(showDefault).toContain('[synthetic] Collapsed');
    expect(showDefault).toContain('--all-branches');
    expect(showDefault).toContain(`blob:${sha256Hex(SYNTHETIC_PNG_BYTES)}`);

    const showExpanded = runSm([
      'show',
      '--all-branches',
      '--include-synthetic',
      String(richConv1.id),
      '--db',
      dbPath,
    ]);
    expect(showExpanded).toContain('[synthetic]');
    expect(showExpanded).toContain('side-branch');
    expect(showExpanded).toContain('superseded_by=');

    const showCodex = runSm(['show', codexFixture.sessionIds[0]!, '--include-synthetic', '--db', dbPath]);
    expect(showCodex).toContain('Codex SQLite & Spill Architecture');
    expect(showCodex).toContain('[tool_call] github.list_issues');
    expect(showCodex).toContain('[payload_ref] blob:');
    expect(showCodex).toContain(`blob:${sha256Hex(codexFixture.inlinePngBytes)}`);

    // ── SEARCH (English + 2-char CJK + 3-char CJK + Mixed) ──────────────────
    const searchEn = JSON.parse(runSm(['search', 'list_issues', '--json', '--db', dbPath])) as {
      strategy: string;
      hits: { tool_name: string | null }[];
    };
    expect(searchEn.strategy).toBe('uni');
    expect(searchEn.hits.length).toBeGreaterThanOrEqual(1);
    expect(searchEn.hits[0]!.tool_name).toBe('github.list_issues');

    const searchCjk2 = JSON.parse(runSm(['search', '缓存', '--json', '--db', dbPath])) as {
      strategy: string;
      hits: { text: string | null }[];
    };
    expect(searchCjk2.strategy).toBe('like');
    expect(searchCjk2.hits.length).toBeGreaterThanOrEqual(1);
    expect(searchCjk2.hits[0]!.text).toContain('缓存');

    const searchCjk2Miss = JSON.parse(runSm(['search', '量子', '--json', '--db', dbPath])) as {
      strategy: string;
      hits: unknown[];
    };
    expect(searchCjk2Miss.strategy).toBe('like');
    expect(searchCjk2Miss.hits).toHaveLength(0);

    const searchCjk3 = JSON.parse(runSm(['search', '全文检索', '--json', '--db', dbPath])) as {
      strategy: string;
      hits: { text: string | null }[];
    };
    expect(searchCjk3.strategy).toBe('tri');
    expect(searchCjk3.hits.length).toBeGreaterThanOrEqual(1);
    expect(searchCjk3.hits.some((h) => h.text?.includes('全文检索'))).toBe(true);

    const searchMixed = JSON.parse(runSm(['search', 'SQLite 缓存', '--json', '--db', dbPath])) as {
      strategy: string;
      hits: { text: string | null }[];
    };
    expect(searchMixed.strategy).toBe('mixed');
    expect(searchMixed.hits.length).toBeGreaterThanOrEqual(1);

    // ── VERIFY (+ --out report) ─────────────────────────────────────────────
    const reportDir = path.join(workDir, 'verify-reports');
    const verifyOut = runSm(['verify', '--batch', '3', '--out', reportDir, '--db', dbPath]);
    expect(verifyOut).toContain('Orphan Nodes:              ✓ None');
    expect(verifyOut).toContain('Timestamp Anomalies:       ✓ None');
    expect(verifyOut).toContain('All present');
    expect(verifyOut).toContain('SHRUNK:      1');
    expect(verifyOut).toContain('conv-openai-rich-01');

    const verifyJsonPath = path.join(reportDir, 'verify-report.json');
    const verifyMdPath = path.join(reportDir, 'verify-report.md');
    expect(fs.existsSync(verifyJsonPath)).toBe(true);
    expect(fs.existsSync(verifyMdPath)).toBe(true);
    const verifyReportJson = JSON.parse(fs.readFileSync(verifyJsonPath, 'utf8')) as {
      diff: { shrunk_conversations: number; shrunk_conversation_ids: string[] };
    };
    expect(verifyReportJson.diff.shrunk_conversations).toBe(1);
    expect(verifyReportJson.diff.shrunk_conversation_ids).toContain('conv-openai-rich-01');
    expect(fs.readFileSync(verifyMdPath, 'utf8')).toContain('conv-openai-rich-01');

    // ── REINDEX ─────────────────────────────────────────────────────────────
    const dbCheck = ArchiveDatabase.openArchiveDb(dbPath);
    try {
      dbCheck.prepare(`UPDATE conversation SET item_count = 999, char_count = 999999 WHERE id = ?`).run(
        richConv1.id
      );
    } finally {
      dbCheck.close();
    }

    const reindexOut = runSm(['reindex', '--db', dbPath]);
    expect(reindexOut).toContain('Successfully reindexed 5 conversation(s)');

    const reindexJson = JSON.parse(runSm(['reindex', '--db', dbPath, '--json'])) as {
      ok: boolean;
      conversationCount: number;
      ftsRebuilt: boolean;
    };
    expect(reindexJson.ok).toBe(true);
    expect(reindexJson.conversationCount).toBe(5);
    expect(reindexJson.ftsRebuilt).toBe(true);

    const dbAfterReindex = ArchiveDatabase.openArchiveDb(dbPath);
    try {
      const row = dbAfterReindex
        .prepare(`SELECT item_count, char_count FROM conversation WHERE id = ?`)
        .get(richConv1.id) as { item_count: number; char_count: number };
      expect(row.item_count).toBe(2); // active branch nodes in shrunk conv1: node-sys-ctx + node-user-1
      expect(row.char_count).toBeGreaterThan(0);
      expect(row.char_count).toBeLessThan(999999);
      expect(dbAfterReindex.getMeta('last_reindex_at')).toBeTruthy();
    } finally {
      dbAfterReindex.close();
    }

    // ── EXPORT (native / md / jsonl) ────────────────────────────────────────
    const nativeExportDir = path.join(workDir, 'export-native');
    const nativeOut = runSm(['export', '--format', 'native', '--out', nativeExportDir, '--db', dbPath]);
    expect(nativeOut).toContain('Exported native archive');

    const manifestPath = path.join(nativeExportDir, 'native-manifest.json');
    const sessionsPath = path.join(nativeExportDir, 'sessions.json');
    const nativeJsonlPath = path.join(nativeExportDir, 'conversations.jsonl');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(sessionsPath)).toBe(true);
    expect(fs.existsSync(nativeJsonlPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      format: string;
      conversation_count: number;
      blob_count: number;
      conversations_file: string;
      blobs_dir: string;
    };
    expect(manifest.format).toBe('native-slice');
    expect(manifest.conversation_count).toBe(5);
    expect(manifest.blob_count).toBeGreaterThanOrEqual(5); // native sessions + png + jpg + oversized spill

    const exportedSessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) as {
      id: number;
      raw_blob_sha256: string | null;
      raw_blob_rel_path: string | null;
    }[];
    expect(exportedSessions).toHaveLength(5);
    for (const s of exportedSessions) {
      expect(s.raw_blob_sha256).toBeTruthy();
      expect(s.raw_blob_rel_path).toBeTruthy();
      const copiedBlob = path.join(nativeExportDir, s.raw_blob_rel_path!);
      expect(fs.existsSync(copiedBlob)).toBe(true);
      expect(sha256Hex(fs.readFileSync(copiedBlob))).toBe(s.raw_blob_sha256);
    }

    // Verify .dat PNG/JPEG blobs were also copied into <out>/blobs/
    const pngSha = sha256Hex(SYNTHETIC_PNG_BYTES);
    const jpgSha = sha256Hex(SYNTHETIC_JPEG_BYTES);
    expect(fs.existsSync(path.join(nativeExportDir, 'blobs', pngSha.slice(0, 2), `${pngSha}.png`))).toBe(true);
    expect(fs.existsSync(path.join(nativeExportDir, 'blobs', jpgSha.slice(0, 2), `${jpgSha}.jpg`))).toBe(true);

    // Markdown export
    const mdExportDir = path.join(workDir, 'export-md');
    runSm(['export', '--format', 'md', '--out', mdExportDir, '--db', dbPath]);
    const mdFiles = fs.readdirSync(mdExportDir).filter((f) => f.endsWith('.md'));
    expect(mdFiles).toHaveLength(5);
    const sampleMd = fs.readFileSync(path.join(mdExportDir, mdFiles[0]!), 'utf8');
    expect(sampleMd).toContain('raw_format:');
    expect(sampleMd).toContain('content_hash:');

    // JSONL export
    const jsonlExportDir = path.join(workDir, 'export-jsonl');
    runSm(['export', '--format', 'jsonl', '--out', jsonlExportDir, '--db', dbPath]);
    const jsonlLines = fs
      .readFileSync(path.join(jsonlExportDir, 'conversations.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(jsonlLines).toHaveLength(5);
    expect(() => JSON.parse(jsonlLines[0]!)).not.toThrow();

    // Native export with --json (for SmCliRunner)
    const nativeJsonExportDir = path.join(workDir, 'export-native-json');
    const nativeJsonOut = JSON.parse(
      runSm(['export', '--format', 'native', '--out', nativeJsonExportDir, '--db', dbPath, '--json'])
    ) as {
      ok: boolean;
      format: string;
      conversationCount: number;
      copiedBlobs: number;
    };
    expect(nativeJsonOut.ok).toBe(true);
    expect(nativeJsonOut.format).toBe('native');
    expect(nativeJsonOut.conversationCount).toBe(5);
    expect(nativeJsonOut.copiedBlobs).toBeGreaterThanOrEqual(5);

    // Portable Windows packager script (--skip-build)
    const portableOutDir = path.join(workDir, 'win-portable');
    const packagerScript = path.resolve(REPO_ROOT, 'scripts', 'build-win-portable.mjs');
    const packRes = execFileSync(
      process.execPath,
      [packagerScript, '--out', portableOutDir, '--skip-build'],
      { encoding: 'utf8' }
    );
    expect(packRes).toContain('Portable bundle staged');
    expect(fs.existsSync(path.join(portableOutDir, 'sm.cmd'))).toBe(true);
    expect(fs.existsSync(path.join(portableOutDir, 'sm-ui.cmd'))).toBe(true);
    expect(fs.existsSync(path.join(portableOutDir, 'runtime', 'apps', 'cli', 'dist', 'index.js'))).toBe(true);
    const portableManifest = JSON.parse(
      fs.readFileSync(path.join(portableOutDir, 'portable-manifest.json'), 'utf8')
    ) as { architecture: string; resident_daemon: boolean };
    expect(portableManifest.architecture).toBe('cqrs-hybrid-direct');
    expect(portableManifest.resident_daemon).toBe(false);
  });

  it('reports exact duplicate clusters, dedupe_candidate pairs in sm dedupe, and missing blobs in sm verify', () => {
    const workDir = makeTempDir();
    const archiveDir = path.join(workDir, 'archive');
    const dbPath = path.join(archiveDir, 'archive.db');

    // Build 25 shared turns to trigger MinHash candidate_review (0.75 <= sim < 0.90)
    const makeConv = (id: string, title: string, turns: { id: string; role: 'user' | 'assistant'; text: string }[]) => {
      const mapping: Record<string, unknown> = {};
      let prev: string | null = null;
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i]!;
        mapping[t.id] = {
          id: t.id,
          parent: prev,
          children: i + 1 < turns.length ? [turns[i + 1]!.id] : [],
          message: {
            id: t.id,
            author: { role: t.role },
            create_time: 1715000000 + i * 10,
            content: { content_type: 'text', parts: [t.text] },
          },
        };
        prev = t.id;
      }
      return {
        id,
        conversation_id: id,
        title,
        create_time: 1715000000,
        update_time: 1715000500,
        current_node: prev,
        mapping,
      };
    };

    const base25 = Array.from({ length: 25 }, (_, i) => ({
      id: `t-${i}`,
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      text: `Shared turn ${i} discussing deterministic archive verification`,
    }));

    const nearDup25 = [
      ...base25.slice(0, 22),
      { id: 'nd-22', role: 'user' as const, text: 'Modified question 22' },
      { id: 'nd-23', role: 'assistant' as const, text: 'Modified answer 23' },
      { id: 'nd-24', role: 'user' as const, text: 'Modified question 24' },
    ];

    const batchFile = path.join(workDir, 'dedupe-batch.json');
    fs.writeFileSync(
      batchFile,
      JSON.stringify([
        makeConv('cand-a', 'Candidate Base', base25),
        makeConv('cand-b', 'Candidate Similar', nearDup25),
      ]),
      'utf8'
    );

    runSm(['import', batchFile, '--db', dbPath]);

    const dedupeJson = JSON.parse(runSm(['dedupe', '--json', '--db', dbPath])) as {
      exactDuplicateClusters: unknown[];
      dedupeCandidates: { a_title: string; b_title: string; similarity: number; reason: string }[];
    };
    expect(dedupeJson.dedupeCandidates.length).toBeGreaterThanOrEqual(1);
    expect(dedupeJson.dedupeCandidates[0]!.similarity).toBeGreaterThanOrEqual(0.75);
    expect(dedupeJson.dedupeCandidates[0]!.reason).toBe('minhash_similarity');

    // Delete one blob on disk and ensure sm verify detects it
    const db = ArchiveDatabase.openArchiveDb(dbPath);
    let deletedRelPath = '';
    try {
      const blobRow = db.prepare(`SELECT rel_path FROM blob LIMIT 1`).get() as { rel_path: string };
      deletedRelPath = blobRow.rel_path;
      fs.unlinkSync(path.join(archiveDir, deletedRelPath));
    } finally {
      db.close();
    }

    const verifyOut = runSm(['verify', '--json', '--db', dbPath]);
    const verifyJson = JSON.parse(verifyOut) as {
      missingBlobsOnDisk: { rel_path: string }[];
      report: { issues: { code: string }[] };
    };
    expect(verifyJson.missingBlobsOnDisk.some((b) => b.rel_path === deletedRelPath)).toBe(true);
    expect(verifyJson.report.issues.some((i) => i.code === 'orphan_blob_ref')).toBe(true);
  });
});
