import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SPILL_THRESHOLD_BYTES,
  ZipArchive,
  createZipBuffer,
  sha256Hex,
  type IntegrityIssue,
} from '@sm/shared';
import {
  AdapterRegistry,
  OpenAiSessionDocument,
  anthropicWebAdapter,
  claudeCodeLocalAdapter,
  codexLocalAdapter,
  deepseekWebAdapter,
  defaultAdapterRegistry,
  dshLocalAdapter,
  openaiWebAdapter,
  type Adapter,
  type ParseCtx,
  type SessionDocument,
  type SourceRef,
} from './index.js';
import {
  SYNTHETIC_JPEG_BYTES,
  SYNTHETIC_PNG_BYTES,
  createRichSyntheticOpenAiExport,
  createSyntheticAnthropicExport,
  createSyntheticClaudeCodeJsonl,
  createSyntheticCodexDir,
  createSyntheticDeepSeekExport,
  createSyntheticDshSessionJsonl,
  createSyntheticOpenAiExport,
} from '../../fixtures/src/index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'sm-adapters-test-'): string {
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

interface MockParseCtxResult {
  ctx: ParseCtx;
  persistedRaw: { entry: string; sha256: string; bytes: number }[];
  spilled: { sha256: string; size: number }[];
  logs: { level: string; msg: string }[];
  unrecognizedKeys: string[];
}

function createMockParseCtx(): MockParseCtxResult {
  const persistedRaw: { entry: string; sha256: string; bytes: number }[] = [];
  const spilled: { sha256: string; size: number }[] = [];
  const logs: { level: string; msg: string }[] = [];
  const unrecognizedKeys: string[] = [];

  const ctx: ParseCtx = {
    async persistRaw(entry: string, bytes: Buffer | NodeJS.ReadableStream) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(entry);
      const sha256 = sha256Hex(buf);
      persistedRaw.push({ entry, sha256, bytes: buf.length });
      return { sha256, path: `blobs/${sha256.slice(0, 2)}/${sha256}` };
    },
    async *streamArray<T>() {
      // unused in sync buffer fixtures
    },
    async spill(payload: unknown) {
      const raw = Buffer.isBuffer(payload)
        ? payload
        : typeof payload === 'string'
          ? Buffer.from(payload, 'utf8')
          : Buffer.from(JSON.stringify(payload), 'utf8');
      const sha256 = sha256Hex(raw);
      spilled.push({ sha256, size: raw.length });
      return sha256;
    },
    log(level, msg) {
      logs.push({ level, msg });
    },
    recordUnrecognizedField(key) {
      unrecognizedKeys.push(key);
    },
  };

  return { ctx, persistedRaw, spilled, logs, unrecognizedKeys };
}

async function runAdapterLifecycle<T>(adapter: Adapter<T>, src: SourceRef, ctx: ParseCtx): Promise<{
  probe: NonNullable<Awaited<ReturnType<Adapter<T>['probe']>>>;
  tasksCount: number;
  docs: SessionDocument<T>[];
}> {
  const probe = await adapter.probe(src);
  expect(probe).not.toBeNull();
  const docs: SessionDocument<T>[] = [];
  let tasksCount = 0;
  for await (const task of adapter.plan(src, probe!)) {
    tasksCount++;
    const parsed = await adapter.parse(task, ctx);
    docs.push(...parsed);
  }
  return { probe: probe!, tasksCount, docs };
}

describe('@sm/shared ZIP reader/writer utility', () => {
  it('writes and reads stored + deflated entries and lists Central Directory', () => {
    const dir = makeTempDir();
    const zipPath = path.join(dir, 'sample.zip');
    const zipBuf = createZipBuffer([
      { name: 'hello.txt', data: 'Hello ZIP!', compress: true },
      { name: 'raw.dat', data: SYNTHETIC_PNG_BYTES, compress: false },
    ]);
    fs.writeFileSync(zipPath, zipBuf);

    const zip = ZipArchive.open(zipPath);
    try {
      const entries = zip.listEntries();
      expect(entries.map((e) => e.name)).toEqual(['hello.txt', 'raw.dat']);
      expect(zip.readEntryText('hello.txt')).toBe('Hello ZIP!');
      expect(zip.readEntry('raw.dat').equals(SYNTHETIC_PNG_BYTES)).toBe(true);
      expect(() => zip.readEntry('missing.txt')).toThrow(/not found/i);
    } finally {
      zip.close();
    }
  });
});

describe('@sm/adapters openai-web (JSON, ZIP, .dat, branches, memory)', () => {
  it('probes, plans, and parses single JSON export deterministically', async () => {
    const dir = makeTempDir();
    const jsonPath = path.join(dir, 'conversations.json');
    fs.writeFileSync(jsonPath, createSyntheticOpenAiExport().toJsonString(), 'utf8');

    const { ctx } = createMockParseCtx();
    const run1 = await runAdapterLifecycle(openaiWebAdapter, { kind: 'file', path: jsonPath }, ctx);
    const run2 = await runAdapterLifecycle(openaiWebAdapter, { kind: 'file', path: jsonPath }, ctx);

    expect(run1.probe.confidence).toBeGreaterThanOrEqual(0.95);
    expect(run1.docs).toHaveLength(1);
    expect(run1.docs[0]!.getMeta().fingerprint).toBe(run2.docs[0]!.getMeta().fingerprint);
    expect(run1.docs[0]!.getMeta().content_hash).toBe(run2.docs[0]!.getMeta().content_hash);
    expect(run1.docs[0]!.validate()).toEqual([]);

    // Runtime-noise-only hidden message should not produce memory candidates
    const doc = run1.docs[0] as OpenAiSessionDocument;
    expect(doc.getMemoryCandidates()).toEqual([]);
  });

  it('parses multi-shard ZIP + .dat blobs, branches, orphan repair, and user_context_message_data', async () => {
    const dir = makeTempDir();
    const rich = createRichSyntheticOpenAiExport();
    const zipPath = path.join(dir, 'chatgpt-export.zip');
    fs.writeFileSync(zipPath, rich.toZipBuffer());

    const exportDir = path.join(dir, 'extracted');
    rich.writeToDir(exportDir);

    const zipCtx = createMockParseCtx();
    const zipRes = await runAdapterLifecycle(openaiWebAdapter, { kind: 'file', path: zipPath }, zipCtx.ctx);

    const dirCtx = createMockParseCtx();
    const dirRes = await runAdapterLifecycle(openaiWebAdapter, { kind: 'dir', path: exportDir }, dirCtx.ctx);

    expect(zipRes.probe.entries).toEqual(['conversations-000.json', 'conversations-001.json']);
    expect(zipRes.tasksCount).toBe(2);
    expect(zipRes.docs).toHaveLength(2);
    expect(dirRes.docs).toHaveLength(2);

    // Registry picks openai-web with highest confidence for the ZIP
    const registryMatches = await defaultAdapterRegistry.probeSource({ kind: 'file', path: zipPath });
    expect(registryMatches[0]?.adapterId).toBe('openai-web');
    expect(registryMatches[0]?.confidence).toBeGreaterThanOrEqual(0.99);

    const richDoc = zipRes.docs[0] as OpenAiSessionDocument;
    const dirRichDoc = dirRes.docs[0] as OpenAiSessionDocument;

    // Deterministic fingerprint & content_hash between ZIP and extracted directory
    expect(richDoc.getMeta().fingerprint).toBe(dirRichDoc.getMeta().fingerprint);
    expect(richDoc.getMeta().content_hash).toBe(dirRichDoc.getMeta().content_hash);

    // Validate reports orphan node repair only for genuinely missing parent (not structural message-less root)
    const issues: IntegrityIssue[] = richDoc.validate();
    const orphanIssues = issues.filter((i) => i.code === 'orphan_node');
    expect(orphanIssues.map((i) => i.item_external_id)).toEqual(['node-orphan-01']);

    // ViewModel has branches, hidden message, and aligned .dat BlobAssets
    const view = richDoc.toViewModel();
    const pngSha = sha256Hex(SYNTHETIC_PNG_BYTES);
    const jpgSha = sha256Hex(SYNTHETIC_JPEG_BYTES);

    expect(view.blobs.map((b) => b.sha256).sort()).toEqual([pngSha, jpgSha].sort());
    const pngBlob = view.blobs.find((b) => b.sha256 === pngSha)!;
    const jpgBlob = view.blobs.find((b) => b.sha256 === jpgSha)!;
    expect(pngBlob.mime).toBe('image/png');
    expect(pngBlob.origin_kind).toBe('export_dat');
    expect(jpgBlob.mime).toBe('image/jpeg');
    expect(jpgBlob.origin_kind).toBe('export_dat');

    const userNode = view.nodes.find((n) => n.external_id === 'node-user-1')!;
    const imageBlocks = userNode.blocks.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(2);
    expect(imageBlocks.map((b) => b.blob_sha256).sort()).toEqual([pngSha, jpgSha].sort());
    expect(imageBlocks.every((b) => b.availability === 'full')).toBe(true);

    // Active vs inactive regenerate branches
    expect(view.nodes.find((n) => n.external_id === 'node-asst-active')?.is_active_branch).toBe(true);
    expect(view.nodes.find((n) => n.external_id === 'node-asst-alt')?.is_active_branch).toBe(false);

    // Hidden flag & user_context_message_data memory extraction (filtering noise)
    const sysCtxNode = view.nodes.find((n) => n.external_id === 'node-sys-ctx')!;
    expect(sysCtxNode.is_hidden).toBe(true);
    expect(sysCtxNode.is_synthetic).toBe(true);

    const memoryBlocks = sysCtxNode.blocks.filter((b) => b.meta?.['memory_candidate'] === true);
    expect(memoryBlocks).toHaveLength(2);
    expect(memoryBlocks.map((b) => b.text)).toEqual([
      'Prefers TypeScript and strict SQLite schemas.',
      'Always verify with unit tests before concluding.',
    ]);

    const noiseOnlyNode = view.nodes.find((n) => n.external_id === 'node-noise-only')!;
    expect(noiseOnlyNode.blocks.some((b) => b.meta?.['memory_candidate'] === true)).toBe(false);

    expect(richDoc.getMemoryCandidates()).toEqual([
      {
        field: 'about_user_message',
        text: 'Prefers TypeScript and strict SQLite schemas.',
        item_external_id: 'node-sys-ctx',
      },
      {
        field: 'about_model_message',
        text: 'Always verify with unit tests before concluding.',
        item_external_id: 'node-sys-ctx',
      },
    ]);
  });
});

describe('@sm/adapters codex-local (rollout, archived, session_index, sqlite, spill)', () => {
  it('aligns SQLite thread_turns/items with rollouts, deduplicates archived, maps all item_types, and spills >32KB & base64', async () => {
    const dir = makeTempDir();
    const codexDir = path.join(dir, '.codex');
    const fixture = createSyntheticCodexDir(codexDir);

    const mock1 = createMockParseCtx();
    const res1 = await runAdapterLifecycle(codexLocalAdapter, { kind: 'dir', path: codexDir }, mock1.ctx);
    const mock2 = createMockParseCtx();
    const res2 = await runAdapterLifecycle(codexLocalAdapter, { kind: 'dir', path: codexDir }, mock2.ctx);

    expect(res1.probe.confidence).toBeGreaterThanOrEqual(0.95);
    // 3 unique sessions (session1 deduplicated across sessions/ & archived_sessions/, session2 archived rollout, session3 sqlite-only)
    expect(res1.docs).toHaveLength(3);

    const byId = new Map(res1.docs.map((d) => [d.getMeta().external_id, d]));
    const doc1 = byId.get(fixture.sessionIds[0]!)!;
    const doc2 = byId.get(fixture.sessionIds[1]!)!;
    const doc3 = byId.get(fixture.sessionIds[2]!)!;

    expect(doc1.getMeta().title).toBe('Codex SQLite & Spill Architecture');
    expect(doc1.getMeta().title_source).toBe('provider');
    expect(doc2.getMeta().title).toBe('Archived Codex Rollout Session');
    expect(doc2.getMeta().title_source).toBe('provider');
    expect(doc3.getMeta().title).toBe('SQLite-Only Codex Thread');
    expect(doc3.getMeta().title_source).toBe('provider');

    // Deterministic fingerprint across runs
    const byId2 = new Map(res2.docs.map((d) => [d.getMeta().external_id, d]));
    for (const sid of fixture.sessionIds) {
      expect(byId.get(sid)!.getMeta().fingerprint).toBe(byId2.get(sid)!.getMeta().fingerprint);
      expect(byId.get(sid)!.getMeta().content_hash).toBe(byId2.get(sid)!.getMeta().content_hash);
    }

    // No oversized_inline_payload warnings
    const doc1Issues = doc1.validate();
    expect(doc1Issues.some((i) => i.code === 'oversized_inline_payload')).toBe(false);

    const view1 = doc1.toViewModel();
    // Verify all 8 item_types + turn_context + trailing rollout record are represented
    expect(view1.nodes.some((n) => n.kind === 'turn_context' && n.is_synthetic)).toBe(true);
    expect(view1.nodes.some((n) => n.external_id === 'item-user-1' && n.role === 'user')).toBe(true);
    expect(view1.nodes.some((n) => n.external_id === 'item-reason-2' && n.kind === 'reasoning')).toBe(true);
    expect(
      view1.nodes.some(
        (n) =>
          n.external_id === 'item-mcp-4' &&
          n.blocks.some((b) => b.tool_name === 'github.list_issues')
      )
    ).toBe(true);
    expect(view1.nodes.some((n) => n.external_id === 'item-fc-5' && n.kind === 'file_change')).toBe(true);
    expect(view1.nodes.some((n) => n.external_id === 'item-ws-6' && n.kind === 'web_search')).toBe(true);
    expect(view1.nodes.some((n) => n.external_id === 'item-agent-8' && n.role === 'assistant')).toBe(true);
    expect(view1.nodes.some((n) => n.text.includes('Trailing unprojected rollout summary.'))).toBe(true);

    // >32KB commandExecution output spilled via ctx.spill()
    const cmdNode = view1.nodes.find((n) => n.external_id === 'item-cmd-3')!;
    expect(cmdNode.payload_ref).toBeTruthy();
    const cmdResultBlock = cmdNode.blocks.find((b) => b.type === 'tool_result')!;
    expect(cmdResultBlock.blob_sha256).toBe(cmdNode.payload_ref);
    expect(Buffer.byteLength(cmdResultBlock.text ?? '', 'utf8')).toBeLessThan(SPILL_THRESHOLD_BYTES);

    // Inline base64 imageGeneration spilled via ctx.spill()
    const imgNode = view1.nodes.find((n) => n.external_id === 'item-img-7')!;
    const imgBlock = imgNode.blocks.find((b) => b.type === 'image')!;
    const expectedPngSha = sha256Hex(fixture.inlinePngBytes);
    expect(imgBlock.blob_sha256).toBe(expectedPngSha);
    expect(imgBlock.availability).toBe('full');
    expect(imgNode.payload_ref).toBe(expectedPngSha);

    expect(view1.blobs.some((b) => b.sha256 === cmdNode.payload_ref && b.origin_kind === 'oversized_payload')).toBe(true);
    expect(view1.blobs.some((b) => b.sha256 === expectedPngSha && b.origin_kind === 'inline_base64' && b.mime === 'image/png')).toBe(true);
    expect(mock1.spilled.length).toBeGreaterThanOrEqual(2);
  });

  it('removes 50-file cap when probing large Codex directories and supports sqlite SourceRef', async () => {
    const dir = makeTempDir();
    const codexDir = path.join(dir, 'codex-many');
    const sessionsDir = path.join(codexDir, 'sessions', '2026', '06');
    fs.mkdirSync(sessionsDir, { recursive: true });

    for (let i = 0; i < 60; i++) {
      const sid = `thread-many-${String(i).padStart(3, '0')}`;
      const line = JSON.stringify({
        timestamp: '2026-06-13T10:00:00.000Z',
        ordinal: 0,
        type: 'session_meta',
        payload: { session_id: sid },
      });
      fs.writeFileSync(path.join(sessionsDir, `rollout-${sid}.jsonl`), line + '\n');
    }

    const probe = await codexLocalAdapter.probe({ kind: 'dir', path: codexDir });
    expect(probe).not.toBeNull();
    expect(probe!.entries.length).toBe(60);

    // Also verify sqlite SourceRef directly
    const sqDir = makeTempDir();
    const sqFixture = createSyntheticCodexDir(sqDir);
    const { ctx } = createMockParseCtx();
    const sqRes = await runAdapterLifecycle(codexLocalAdapter, { kind: 'sqlite', path: sqFixture.sqlitePath }, ctx);
    expect(sqRes.docs).toHaveLength(2);
  });
});

describe('@sm/adapters remaining providers (anthropic-web, deepseek-web, claude-code-local, dsh-local)', () => {
  it('anthropic-web: probe, plan, parse, viewModel, validate, and deterministic fingerprint', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'conversations.json');
    fs.writeFileSync(filePath, createSyntheticAnthropicExport().toJsonString(), 'utf8');

    const { ctx } = createMockParseCtx();
    const r1 = await runAdapterLifecycle(anthropicWebAdapter, { kind: 'file', path: filePath }, ctx);
    const r2 = await runAdapterLifecycle(anthropicWebAdapter, { kind: 'file', path: filePath }, ctx);

    expect(r1.probe.confidence).toBeGreaterThanOrEqual(0.95);
    expect(r1.docs).toHaveLength(1);
    const doc = r1.docs[0]!;
    expect(doc.getMeta().fingerprint).toBe(r2.docs[0]!.getMeta().fingerprint);
    expect(doc.getMeta().title).toBe('Synthetic Claude Conversation');

    const issues = doc.validate();
    expect(issues.some((i) => i.code === 'attachment_extracted_only')).toBe(true);
    const view = doc.toViewModel();
    expect(view.nodes).toHaveLength(2);
    expect(view.nodes[0]!.role).toBe('user');
    expect(view.nodes[1]!.blocks.some((b) => b.type === 'thinking')).toBe(true);
    expect(view.nodes[1]!.blocks.some((b) => b.type === 'tool_use')).toBe(true);
  });

  it('deepseek-web: probe, plan, parse, viewModel, validate, and deterministic fingerprint', async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'deepseek-export.json');
    fs.writeFileSync(filePath, createSyntheticDeepSeekExport().toJsonString(), 'utf8');

    const { ctx } = createMockParseCtx();
    const r1 = await runAdapterLifecycle(deepseekWebAdapter, { kind: 'file', path: filePath }, ctx);
    const r2 = await runAdapterLifecycle(deepseekWebAdapter, { kind: 'file', path: filePath }, ctx);

    expect(r1.probe.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r1.docs).toHaveLength(1);
    const doc = r1.docs[0]!;
    expect(doc.getMeta().fingerprint).toBe(r2.docs[0]!.getMeta().fingerprint);
    expect(doc.validate()).toEqual([]);

    const view = doc.toViewModel();
    expect(view.nodes).toHaveLength(2);
    expect(view.nodes[1]!.blocks.some((b) => b.type === 'thinking')).toBe(true);
  });

  it('claude-code-local: probe, plan, parse, viewModel, validate, and deterministic fingerprint', async () => {
    const dir = makeTempDir();
    const ccDir = path.join(dir, '.claude', 'projects', 'c--lab-sm');
    fs.mkdirSync(ccDir, { recursive: true });
    const filePath = path.join(ccDir, 'session-claude-code-synth-001.jsonl');
    fs.writeFileSync(filePath, createSyntheticClaudeCodeJsonl(), 'utf8');

    const { ctx } = createMockParseCtx();
    const r1 = await runAdapterLifecycle(claudeCodeLocalAdapter, { kind: 'dir', path: path.join(dir, '.claude') }, ctx);
    const r2 = await runAdapterLifecycle(claudeCodeLocalAdapter, { kind: 'file', path: filePath }, ctx);

    expect(r1.probe.confidence).toBeGreaterThanOrEqual(0.95);
    expect(r1.docs).toHaveLength(1);
    expect(r2.docs).toHaveLength(1);
    expect(r1.docs[0]!.getMeta().fingerprint).toBe(r2.docs[0]!.getMeta().fingerprint);
    expect(r1.docs[0]!.validate()).toEqual([]);

    const view = r1.docs[0]!.toViewModel();
    expect(view.nodes.some((n) => n.role === 'tool' && n.kind === 'tool_result')).toBe(true);
    expect(view.nodes.some((n) => n.kind === 'compaction' && n.is_synthetic)).toBe(true);
  });

  it('dsh-local: probe, plan, parse multi-frame zstd, viewModel, validate, and deterministic fingerprint', async () => {
    const dir = makeTempDir();
    const sessDir = path.join(dir, '.dsh', 'sessions', 'proj-a', 'dsh-synth-001');
    fs.mkdirSync(sessDir, { recursive: true });
    const filePath = path.join(sessDir, 'session.v4.jsonl.zstd');

    const rawLines = createSyntheticDshSessionJsonl().trim().split('\n');
    const frame1 = zlib.zstdCompressSync(Buffer.from(rawLines.slice(0, 3).join('\n') + '\n', 'utf8'));
    const frame2 = zlib.zstdCompressSync(Buffer.from(rawLines.slice(3).join('\n') + '\n', 'utf8'));
    fs.writeFileSync(filePath, Buffer.concat([frame1, frame2]));

    const { ctx } = createMockParseCtx();
    const r1 = await runAdapterLifecycle(dshLocalAdapter, { kind: 'dir', path: path.join(dir, '.dsh') }, ctx);
    const r2 = await runAdapterLifecycle(dshLocalAdapter, { kind: 'file', path: filePath }, ctx);

    expect(r1.probe.confidence).toBeGreaterThanOrEqual(0.95);
    expect(r1.docs).toHaveLength(1);
    expect(r1.docs[0]!.getMeta().fingerprint).toBe(r2.docs[0]!.getMeta().fingerprint);
    expect(r1.docs[0]!.getMeta().title).toBe('Synthetic DSH v4 Session');
    expect(r1.docs[0]!.validate()).toEqual([]);

    const view = r1.docs[0]!.toViewModel();
    // assistant/chunk skipped; spliced + user + assistant + compaction preserved
    expect(view.nodes).toHaveLength(4);
    expect(view.nodes.some((n) => n.kind === 'system_note' && n.is_synthetic)).toBe(true);
    expect(view.nodes.some((n) => n.kind === 'compaction' && n.is_synthetic)).toBe(true);
    expect(new AdapterRegistry().list().length).toBeGreaterThanOrEqual(6);
  });
});
