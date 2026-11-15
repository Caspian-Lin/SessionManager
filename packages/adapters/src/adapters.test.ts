import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  genericJsonAdapter,
  genericMdAdapter,
  openaiWebAdapter,
  opencodeLocalAdapter,
  zcodeLocalAdapter,
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

  it('Issue #10: deepseek-web mapping tree + fragments ZIP export and generic-json / generic-md spill fallback', async () => {
    const dir = makeTempDir();
    const deepseekMappingExport = [
      {
        id: 'ds-map-001',
        title: 'DeepSeek Mapping + Fragments Export',
        inserted_at: '2026-06-20T09:00:00.000Z',
        updated_at: '2026-06-20T09:05:00.000Z',
        current_node: 'n3',
        mapping: {
          root: { id: 'root', parent: null, children: ['n1'], message: null },
          n1: {
            id: 'n1',
            parent: 'root',
            children: ['n2', 'n2-alt'],
            message: {
              inserted_at: '2026-06-20T09:00:10.000Z',
              model: 'deepseek-reasoner',
              fragments: [{ id: 1, type: 'REQUEST', content: 'Explain RTL synthesis.' }],
            },
          },
          n2: {
            id: 'n2',
            parent: 'n1',
            children: ['n3'],
            message: {
              inserted_at: '2026-06-20T09:01:00.000Z',
              model: 'deepseek-reasoner',
              fragments: [
                { id: 1, type: 'THINK', content: 'Consider IEEE Verilog behavioral blocks.' },
                { id: 2, type: 'RESPONSE', content: 'RTL stands for Register-Transfer Level.' },
              ],
            },
          },
          'n2-alt': {
            id: 'n2-alt',
            parent: 'n1',
            children: [],
            message: {
              inserted_at: '2026-06-20T09:00:45.000Z',
              model: 'deepseek-chat',
              fragments: [{ id: 1, type: 'RESPONSE', content: 'Alternate regenerated answer.' }],
            },
          },
          n3: {
            id: 'n3',
            parent: 'n2',
            children: [],
            message: {
              inserted_at: '2026-06-20T09:02:00.000Z',
              fragments: [{ id: 1, type: 'REQUEST', content: 'Follow-up prompt' }],
            },
          },
        },
      },
    ];

    const zipPath = path.join(dir, 'deepseek-archive.zip');
    fs.writeFileSync(
      zipPath,
      createZipBuffer([{ name: 'conversations.json', data: JSON.stringify(deepseekMappingExport) }])
    );

    const dsMock = createMockParseCtx();
    const dsRes = await runAdapterLifecycle(deepseekWebAdapter, { kind: 'file', path: zipPath }, dsMock.ctx);
    expect(dsRes.probe.confidence).toBeGreaterThanOrEqual(0.95);
    expect(dsRes.docs).toHaveLength(1);
    const dsView = dsRes.docs[0]!.toViewModel();
    expect(dsView.nodes).toHaveLength(4);
    expect(dsView.nodes.find((n) => n.external_id === 'n2')?.blocks.some((b) => b.type === 'thinking')).toBe(true);
    expect(dsView.nodes.find((n) => n.external_id === 'n2')?.is_active_branch).toBe(true);
    expect(dsView.nodes.find((n) => n.external_id === 'n2-alt')?.is_active_branch).toBe(false);

    // Generic JSON fallback on opaque non-standard object triggers raw byte spill
    const opaquePath = path.join(dir, 'opaque-export.json');
    fs.writeFileSync(opaquePath, JSON.stringify({ role: 'custom', opaque: { payload: 'x'.repeat(256) } }), 'utf8');
    const gjMock = createMockParseCtx();
    const gjRes = await runAdapterLifecycle(genericJsonAdapter, { kind: 'file', path: opaquePath }, gjMock.ctx);
    expect(gjRes.docs).toHaveLength(1);
    expect(gjMock.spilled.length).toBeGreaterThanOrEqual(1);
    expect(gjRes.docs[0]!.validate().some((i) => i.code === 'parse_error' && i.message.includes('heuristic_raw_fallback'))).toBe(true);

    // Generic MD extended turn headers + >32KB raw spill
    const mdPath = path.join(dir, 'transcript.md');
    const longMd = `### User\nHow to package MSIX?\n\n**Assistant**:\n${'Detail '.repeat(6000)}\n`;
    fs.writeFileSync(mdPath, longMd, 'utf8');
    const gmMock = createMockParseCtx();
    const gmRes = await runAdapterLifecycle(genericMdAdapter, { kind: 'file', path: mdPath }, gmMock.ctx);
    expect(gmRes.docs).toHaveLength(1);
    expect(gmRes.docs[0]!.toViewModel().nodes).toHaveLength(2);
    expect(gmMock.spilled.length).toBe(1);
  });

  it('Issue #13: claude-code-local merges cross-file resumed sessionId records chronologically and deduplicates uuids', async () => {
    const dir = makeTempDir();
    const projDir = path.join(dir, '.claude', 'projects', 'c--lab-sm');
    fs.mkdirSync(projDir, { recursive: true });

    const sharedLines = [
      JSON.stringify({
        type: 'user',
        uuid: 'u-1',
        parentUuid: null,
        sessionId: 'cc-resume-999',
        cwd: 'C:\\Lab\\SessionManager',
        gitBranch: 'main',
        timestamp: '2026-06-21T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Part 1 prompt' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-1',
        parentUuid: 'u-1',
        sessionId: 'cc-resume-999',
        gitBranch: 'main',
        timestamp: '2026-06-21T10:00:10.000Z',
        message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'Part 1 answer' }] },
      }),
    ];
    const resumedLines = [
      sharedLines[1]!, // duplicate uuid carried over in resume file
      JSON.stringify({
        type: 'user',
        uuid: 'u-2',
        parentUuid: 'a-1',
        sessionId: 'cc-resume-999',
        isSidechain: true,
        gitBranch: 'main',
        timestamp: '2026-06-21T10:05:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
        },
      }),
      '{"type":"assistant","uuid":"broken-tail', // bad tail line
    ];

    fs.writeFileSync(path.join(projDir, 'cc-resume-999.jsonl'), sharedLines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(projDir, 'cc-resume-999-resumed.jsonl'), resumedLines.join('\n') + '\n', 'utf8');

    const { ctx } = createMockParseCtx();
    const res = await runAdapterLifecycle(claudeCodeLocalAdapter, { kind: 'dir', path: path.join(dir, '.claude') }, ctx);
    expect(res.docs).toHaveLength(1);
    const view = res.docs[0]!.toViewModel();
    expect(view.nodes).toHaveLength(3);
    expect(view.nodes.map((n) => n.external_id)).toEqual(['u-1', 'a-1', 'u-2']);
    expect(view.nodes[2]!.role).toBe('tool');
    expect(view.nodes[2]!.is_synthetic).toBe(true);
    expect(res.docs[0]!.validate().some((i) => i.code === 'truncated_stream')).toBe(true);
  });

  it('Issue #14: dsh-local aggregates unfinalized streaming chunks, marks command/run synthetic, and associates attachments', async () => {
    const dir = makeTempDir();
    const dshRoot = path.join(dir, '.dsh');
    const sessDir = path.join(dshRoot, 'sessions', 'proj-b', 'dsh-stream-002');
    const attDir = path.join(dshRoot, 'attachments', 'dsh-stream-002');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.mkdirSync(attDir, { recursive: true });

    fs.writeFileSync(path.join(attDir, 'diagram.png'), SYNTHETIC_PNG_BYTES);

    const events = [
      { type: 'session', seq: 1, time: 1750000000, data: { id: 'dsh-stream-002', cwd: 'C:\\Lab\\proj-b' } },
      { type: 'session/title', seq: 2, time: 1750000001, data: 'DSH Chunk & Attachment Test' },
      {
        type: 'user/message',
        seq: 3,
        time: 1750000002,
        data: { text: 'Inspect diagram', attachments: ['diagram.png'] },
      },
      { type: 'command/run', seq: 4, time: 1750000003, data: { cmd: 'pnpm test', exit: 0 } },
      { type: 'reasoning-chunks', seq: 5, time: 1750000004, data: { delta: 'Think step 1. ' } },
      { type: 'reasoning-chunks', seq: 6, time: 1750000005, data: { delta: 'Think step 2.' } },
      { type: 'assistant/chunk', seq: 7, time: 1750000006, data: { delta: 'Streamed ' } },
      { type: 'assistant/chunk', seq: 8, time: 1750000007, data: { delta: 'reply!' } },
    ];

    const zstdPath = path.join(sessDir, 'session.v4.jsonl.zstd');
    const rawJsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(zstdPath, zlib.zstdCompressSync(Buffer.from(rawJsonl, 'utf8')));

    const mock = createMockParseCtx();
    const res = await runAdapterLifecycle(dshLocalAdapter, { kind: 'dir', path: dshRoot }, mock.ctx);
    expect(res.docs).toHaveLength(1);
    const view = res.docs[0]!.toViewModel();

    expect(view.nodes.some((n) => n.kind === 'system_note' && n.is_synthetic && n.text.includes('pnpm test'))).toBe(true);
    expect(view.nodes.some((n) => n.kind === 'reasoning' && n.text === 'Think step 1. Think step 2.')).toBe(true);
    expect(view.nodes.some((n) => n.role === 'assistant' && n.text === 'Streamed reply!')).toBe(true);
    expect(view.blobs.some((b) => b.origin_kind === 'attachment' && b.mime === 'image/png')).toBe(true);
    expect(view.nodes[0]!.blocks.some((b) => b.type === 'image' && b.meta?.['file_name'] === 'diagram.png')).toBe(true);
  });

  it('dsh-local handles real DSH v4 top-level session id, multi-frame zstd, content[] messages, and deduplicated tool calls', async () => {
    const dir = makeTempDir();
    const dshRoot = path.join(dir, '.dsh');
    const sessA = path.join(dshRoot, 'sessions', 'proj-v4', 'uuid-aaa');
    const sessB = path.join(dshRoot, 'sessions', 'proj-v4', 'uuid-bbb');
    fs.mkdirSync(sessA, { recursive: true });
    fs.mkdirSync(sessB, { recursive: true });

    const linesA = [
      { type: 'session', version: 4, id: 'uuid-aaa', createdAt: 1794722670919, cwd: 'C:\\Lab\\V4' },
      { type: 'request/header', seq: 1, time: 1794722671000, data: { header: { config: { model: 'deepseek-v4.1-flash' } } } },
      { type: 'session/title', seq: 2, time: 1794722671100, data: { title: 'Clean V4 Title' } },
      { type: 'user/message', seq: 3, time: 1794722672000, data: { content: [{ type: 'text', text: 'Read protocol' }] } },
      {
        type: 'assistant/message',
        seq: 4,
        time: 1794722673000,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Let me read it carefully.' },
              { type: 'text', text: 'Reading now.' },
              { type: 'tool-call', id: 'call-v4-1', name: 'read', arguments: '{"file_path":"PROTOCOL.md"}' },
            ],
          },
          source: { model: 'deepseek-v4.1-flash' },
        },
      },
      // Duplicate standalone tool/call for same callId should be suppressed
      {
        type: 'tool/call',
        seq: 5,
        time: 1794722673005,
        data: { turn: 1, step: 1, callId: 'call-v4-1', name: 'read', arguments: '{"file_path":"PROTOCOL.md"}' },
      },
      {
        type: 'tool/result',
        seq: 6,
        time: 1794722673100,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'tool', toolCallId: 'call-v4-1', content: [{ type: 'text', text: '# Protocol Body' }] },
        },
      },
    ];
    // Multi-frame zstd (concatenated zstd frames, as written by DSH daemon)
    const multiFrameBuf = Buffer.concat(
      linesA.map((l) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(l) + '\n', 'utf8')))
    );
    fs.writeFileSync(path.join(sessA, 'session.v4.jsonl.zstd'), multiFrameBuf);

    const linesB = [
      { type: 'session', version: 4, id: 'uuid-bbb', createdAt: 1794722680000, cwd: 'C:\\Lab\\V4' },
      { type: 'user/message', seq: 1, time: 1794722681000, data: { content: [{ type: 'text', text: 'Second session' }] } },
    ];
    fs.writeFileSync(
      path.join(sessB, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(linesB.map((l) => JSON.stringify(l) + '\n').join(''), 'utf8'))
    );

    const mock = createMockParseCtx();
    const res = await runAdapterLifecycle(dshLocalAdapter, { kind: 'dir', path: dshRoot }, mock.ctx);
    expect(res.docs).toHaveLength(2);
    const byExt = new Map(res.docs.map((d) => [d.getMeta().external_id, d]));
    expect(byExt.has('uuid-aaa')).toBe(true);
    expect(byExt.has('uuid-bbb')).toBe(true);
    const docA = byExt.get('uuid-aaa')!;
    expect(docA.getMeta().title).toBe('Clean V4 Title');
    expect(docA.getMeta().default_model).toBe('deepseek-v4.1-flash');
    const viewA = docA.toViewModel();
    expect(viewA.nodes.some((n) => n.role === 'user' && n.text === 'Read protocol')).toBe(true);
    expect(viewA.nodes.some((n) => n.kind === 'reasoning' && n.text === 'Let me read it carefully.')).toBe(true);
    expect(viewA.nodes.some((n) => n.role === 'assistant' && n.text === 'Reading now.')).toBe(true);
    expect(viewA.nodes.filter((n) => n.kind === 'tool_call')).toHaveLength(1);
    expect(viewA.nodes.some((n) => n.kind === 'tool_result' && n.text === '# Protocol Body')).toBe(true);
  });

  it('dsh-local classifies inbox, user-approval, subagent replies, and system time/permission hints as system synthetic', async () => {
    const dir = makeTempDir();
    const dshRoot = path.join(dir, '.dsh');
    const sessDir = path.join(dshRoot, 'sessions', 'synth-session');
    fs.mkdirSync(sessDir, { recursive: true });

    const lines = [
      { type: 'session/meta', seq: 0, time: 1700000000, data: { id: 'synth-session', title: 'Synthetic Check' } },
      { type: 'user/message', seq: 1, time: 1700000001, data: { text: 'Actual user prompt' } },
      { type: 'user/message', seq: 2, time: 1700000002, data: { text: 'Subagent finished task X', source: { kind: 'inbox' } } },
      { type: 'user/message', seq: 3, time: 1700000003, data: { text: 'Approved tool execution', source: { kind: 'user-approval' } } },
      { type: 'user/message', seq: 4, time: 1700000004, data: { text: '<system-reminder>Current time: 2026-11-15</system-reminder>' } },
      { type: 'user/message', seq: 5, time: 1700000005, data: { text: 'Permission hint: auto-approve enabled' } },
      { type: 'assistant/message', seq: 6, time: 1700000006, data: { text: 'Done!' } },
    ];
    fs.writeFileSync(
      path.join(sessDir, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(lines.map((l) => JSON.stringify(l) + '\n').join(''), 'utf8'))
    );

    const mock = createMockParseCtx();
    const res = await runAdapterLifecycle(dshLocalAdapter, { kind: 'dir', path: dshRoot }, mock.ctx);
    expect(res.docs).toHaveLength(1);
    const view = res.docs[0]!.toViewModel();

    const realUsers = view.nodes.filter((n) => n.role === 'user');
    expect(realUsers).toHaveLength(1);
    expect(realUsers[0]!.text).toBe('Actual user prompt');
    expect(realUsers[0]!.is_synthetic).toBe(false);

    const sysNodes = view.nodes.filter((n) => n.role === 'system' && n.is_synthetic);
    expect(sysNodes).toHaveLength(4);
    expect(sysNodes.every((n) => n.kind === 'system_note')).toBe(true);
  });

  it('zcode-local adapter imports ZCode cli/db/db.sqlite sessions, parts, tool calls, and tasks-index links', async () => {
    const dir = makeTempDir();
    const zcodeRoot = path.join(dir, '.zcode');
    const cliDbDir = path.join(zcodeRoot, 'cli', 'db');
    const v2Dir = path.join(zcodeRoot, 'v2');
    fs.mkdirSync(cliDbDir, { recursive: true });
    fs.mkdirSync(v2Dir, { recursive: true });

    const tasksDb = new DatabaseSync(path.join(v2Dir, 'tasks-index.sqlite'));
    tasksDb.exec(`
      CREATE TABLE tasks (task_id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO tasks (task_id, title) VALUES ('task-42', 'ZCode Task Title');
    `);
    tasksDb.close();

    const db = new DatabaseSync(path.join(cliDbDir, 'db.sqlite'));
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        parent_id TEXT,
        title TEXT,
        version TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        directory TEXT
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        sequence INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        sequence INTEGER,
        data TEXT
      );
      CREATE TABLE session_task_link (
        session_id TEXT PRIMARY KEY,
        task_id TEXT,
        task_type TEXT
      );
    `);
    db.prepare(`INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'zc-sess-1',
      'proj-1',
      null,
      'Inspect ZCode schema',
      '1.0.0',
      1750001000000,
      1750001050000,
      'C:\\Lab\\SessionManager'
    );
    db.prepare(`INSERT INTO session_task_link VALUES (?, ?, ?)`).run('zc-sess-1', 'task-42', 'feature');

    db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)`).run(
      'msg-u1',
      'zc-sess-1',
      1750001001000,
      1750001001000,
      1,
      JSON.stringify({ role: 'user' })
    );
    db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'p-u1',
      'msg-u1',
      'zc-sess-1',
      1750001001000,
      1750001001000,
      1,
      JSON.stringify({ type: 'text', text: 'Check ZCode adapter' })
    );

    db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?, ?, ?)`).run(
      'msg-a1',
      'zc-sess-1',
      1750001002000,
      1750001010000,
      2,
      JSON.stringify({ role: 'assistant', modelID: 'glm-4.7' })
    );
    db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'p-r1',
      'msg-a1',
      'zc-sess-1',
      1750001002100,
      1750001002100,
      1,
      JSON.stringify({ type: 'reasoning', text: 'Inspecting tables' })
    );
    db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'p-t1',
      'msg-a1',
      'zc-sess-1',
      1750001002200,
      1750001002500,
      2,
      JSON.stringify({
        type: 'tool',
        callID: 'call-zc-1',
        tool: 'read_file',
        state: {
          status: 'completed',
          input: { path: 'README.md' },
          output: 'SessionManager README',
          time: { start: 1750001002200, end: 1750001002500 },
        },
      })
    );
    db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'p-a1',
      'msg-a1',
      'zc-sess-1',
      1750001003000,
      1750001003000,
      3,
      JSON.stringify({ type: 'text', text: 'ZCode adapter works!' })
    );
    db.close();

    const probe = await defaultAdapterRegistry.probeSource({ kind: 'dir', path: zcodeRoot });
    expect(probe[0]?.adapterId).toBe('zcode-local');

    const mock = createMockParseCtx();
    const res = await runAdapterLifecycle(zcodeLocalAdapter, { kind: 'dir', path: zcodeRoot }, mock.ctx);
    expect(res.docs).toHaveLength(1);
    const meta = res.docs[0]!.getMeta();
    expect(meta.provider).toBe('zcode-local');
    expect(meta.external_id).toBe('zc-sess-1');
    expect(meta.title).toBe('Inspect ZCode schema');
    expect(meta.cwd).toBe('C:\\Lab\\SessionManager');
    const view = res.docs[0]!.toViewModel();
    expect(view.nodes.some((n) => n.kind === 'reasoning' && n.text === 'Inspecting tables')).toBe(true);
    expect(view.nodes.some((n) => n.kind === 'tool_call' && n.blocks[0]?.tool_name === 'read_file')).toBe(true);
    expect(view.nodes.some((n) => n.kind === 'tool_result' && n.text === 'SessionManager README')).toBe(true);
    expect(view.nodes.some((n) => n.role === 'assistant' && n.text === 'ZCode adapter works!')).toBe(true);
  });

  it('opencode-local adapter imports opencode.db with session_v2 + v1 sessions without duplicates', async () => {
    const dir = makeTempDir();
    const ocRoot = path.join(dir, 'opencode');
    fs.mkdirSync(ocRoot, { recursive: true });
    const db = new DatabaseSync(path.join(ocRoot, 'opencode.db'));
    db.exec(`
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        title TEXT,
        title_source TEXT,
        parent_id TEXT,
        model TEXT,
        path TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        position INTEGER,
        type TEXT,
        data TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        parent_id TEXT,
        directory TEXT,
        title TEXT,
        version TEXT,
        time_created INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `);

    db.prepare(`INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'oc-v2-1',
      'OpenCode V2 Session',
      'manual',
      null,
      'gpt-5',
      '/repo/oc',
      1750002000000,
      1750002010000
    );
    db.prepare(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'm-v2-1',
      'oc-v2-1',
      1,
      'user',
      JSON.stringify({ content: 'Hello v2' }),
      1750002001000,
      1750002001000
    );
    db.prepare(`INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'm-v2-2',
      'oc-v2-1',
      2,
      'assistant',
      JSON.stringify({
        content: [
          { type: 'reasoning', text: 'Thinking v2' },
          {
            type: 'tool',
            callID: 'tc-v2',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'echo ok' }, output: 'ok' },
          },
          { type: 'text', text: 'Done v2' },
        ],
      }),
      1750002002000,
      1750002005000
    );
    // Duplicate id in v1 + unique id in v1
    db.prepare(`INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'oc-v2-1',
      'p1',
      null,
      '/repo/oc',
      'Duplicate V1',
      '1',
      1750002000000,
      1750002000000
    );
    db.prepare(`INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'oc-v1-only',
      'p1',
      null,
      '/repo/oc-v1',
      'OpenCode V1 Session',
      '1',
      1750000000000,
      1750000005000
    );
    db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?, ?)`).run(
      'm-v1-1',
      'oc-v1-only',
      1750000001000,
      1750000001000,
      JSON.stringify({ role: 'user' })
    );
    db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)`).run(
      'p-v1-1',
      'm-v1-1',
      'oc-v1-only',
      1750000001000,
      1750000001000,
      JSON.stringify({ type: 'text', text: 'Legacy v1 prompt' })
    );
    db.close();

    const probe = await defaultAdapterRegistry.probeSource({ kind: 'dir', path: ocRoot });
    expect(probe[0]?.adapterId).toBe('opencode-local');

    const mock = createMockParseCtx();
    const res = await runAdapterLifecycle(opencodeLocalAdapter, { kind: 'dir', path: ocRoot }, mock.ctx);
    expect(res.docs).toHaveLength(2);
    expect(res.docs.map((d) => d.getMeta().external_id).sort()).toEqual(['oc-v1-only', 'oc-v2-1']);
    const v2 = res.docs.find((d) => d.getMeta().external_id === 'oc-v2-1')!;
    expect(v2.toViewModel().nodes.some((n) => n.kind === 'tool_call' && n.blocks[0]?.tool_name === 'bash')).toBe(true);
    expect(v2.toViewModel().nodes.some((n) => n.role === 'assistant' && n.text === 'Done v2')).toBe(true);
  });

  it('extracts parent_external_id and is_subagent for DSH, OpenCode/ZCode, Codex, and Claude Code subagents', async () => {
    // 1. DSH subagent
    const dshDir = makeTempDir();
    const dshChildDir = path.join(dshDir, '.dsh', 'sessions', 'proj-sub', 'dsh-child-01');
    fs.mkdirSync(dshChildDir, { recursive: true });
    fs.writeFileSync(
      path.join(dshChildDir, 'session.v4.jsonl'),
      [
        JSON.stringify({
          type: 'session',
          id: 'dsh-child-01',
          cwd: 'C:\\Lab\\SessionManager',
          parentSession: 'dsh-parent-00',
          origin: 'subagent',
          agentPreset: 'researcher',
          delegationDepth: 1,
        }),
        JSON.stringify({
          type: 'user/message',
          seq: 1,
          time: 1750000100,
          data: { text: 'Explore repo' },
        }),
      ].join('\n'),
      'utf8'
    );
    const dshRes = await runAdapterLifecycle(dshLocalAdapter, { kind: 'dir', path: path.join(dshDir, '.dsh') }, createMockParseCtx().ctx);
    expect(dshRes.docs).toHaveLength(1);
    expect(dshRes.docs[0]!.getMeta().parent_external_id).toBe('dsh-parent-00');
    expect(dshRes.docs[0]!.getMeta().is_subagent).toBe(true);
    expect(dshRes.docs[0]!.getMeta().subagent_name).toBe('researcher');

    // 2. Claude Code subagents/agent-*.jsonl separate from parent
    const ccDir = makeTempDir();
    const ccProjDir = path.join(ccDir, '.claude', 'projects', 'proj-c');
    const ccSubDir = path.join(ccProjDir, 'main-sess-1', 'subagents');
    fs.mkdirSync(ccSubDir, { recursive: true });
    fs.writeFileSync(
      path.join(ccProjDir, 'main-sess-1.jsonl'),
      JSON.stringify({
        type: 'user',
        uuid: 'm-1',
        parentUuid: null,
        sessionId: 'main-sess-1',
        cwd: 'C:\\Lab\\SessionManager',
        timestamp: '2026-06-21T10:00:00.000Z',
        message: { role: 'user', content: 'Main question' },
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ccSubDir, 'agent-a123.jsonl'),
      JSON.stringify({
        type: 'user',
        uuid: 's-1',
        parentUuid: null,
        sessionId: 'main-sess-1',
        isSidechain: true,
        agentId: 'a123',
        cwd: 'C:\\Lab\\SessionManager',
        timestamp: '2026-06-21T10:01:00.000Z',
        message: { role: 'user', content: 'Subagent task' },
      }) + '\n',
      'utf8'
    );
    const ccRes = await runAdapterLifecycle(claudeCodeLocalAdapter, { kind: 'dir', path: path.join(ccDir, '.claude') }, createMockParseCtx().ctx);
    expect(ccRes.docs).toHaveLength(2);
    const mainDoc = ccRes.docs.find((d) => d.getMeta().external_id === 'main-sess-1')!;
    const subDoc = ccRes.docs.find((d) => d.getMeta().is_subagent === true)!;
    expect(mainDoc.getMeta().is_subagent).toBe(false);
    expect(subDoc.getMeta().parent_external_id).toBe('main-sess-1');
    expect(subDoc.getMeta().subagent_name).toBe('a123');
  });
});
