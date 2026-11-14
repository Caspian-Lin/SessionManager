import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  AnthropicSessionDocument,
  OpenAiSessionDocument,
  type Adapter,
  type ImportTask,
  type ParseCtx,
  type ProbeResult,
  type SessionDocument,
  type SourceRef,
} from '@sm/adapters';
import { SPILL_THRESHOLD_BYTES, createZipBuffer, sha256Hex } from '@sm/shared';
import { ArchiveDatabase, ArchiveRepository, BlobStore, RawStore } from '@sm/store';
import { ArchiveService } from './archive-service.js';
import { decideConversationMerge } from './deduper.js';
import { buildBatchDiffStats, formatIntegrityReportMarkdown } from './diff-reporter.js';
import { formatConversationMarkdown } from './exporter.js';
import { ImportPipeline } from './pipeline.js';
import { buildSearchSqlPlan, executeArchiveSearch } from './search-router.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'sm-core-test-'): string {
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

function makeOpenAiConv(
  id: string,
  title: string,
  turns: { id: string; role: 'user' | 'assistant'; text: string; createTime?: number }[],
  createTime = 1700000000,
  updateTime = 1700000100
) {
  const mapping: Record<string, unknown> = {};
  let prevId: string | null = null;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    mapping[t.id] = {
      id: t.id,
      parent: prevId,
      children: i + 1 < turns.length ? [turns[i + 1]!.id] : [],
      message: {
        id: t.id,
        author: { role: t.role },
        create_time: t.createTime ?? createTime + i * 10,
        content: { content_type: 'text', parts: [t.text] },
      },
    };
    prevId = t.id;
  }
  return {
    id,
    conversation_id: id,
    title,
    create_time: createTime,
    update_time: updateTime,
    current_node: prevId ?? undefined,
    mapping,
  };
}

describe('@sm/core polymorphic SessionDocument pipeline', () => {
  it('validates OpenAI native mapping tree, repairs orphan nodes, and extracts ViewModel', () => {
    const doc = new OpenAiSessionDocument({
      conversation_id: 'conv-1',
      current_node: 'item-1',
      mapping: {
        'item-1': {
          id: 'item-1',
          parent: 'missing-parent',
          message: {
            id: 'item-1',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['First prompt for title'] },
          },
        },
        'item-a': {
          id: 'item-a',
          parent: 'item-b',
          message: {
            id: 'item-a',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['Cycle A'] },
          },
        },
        'item-b': {
          id: 'item-b',
          parent: 'item-a',
          message: {
            id: 'item-b',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['Cycle B'] },
          },
        },
      },
    });

    const meta = doc.getMeta();
    const issues = doc.validate();
    const chunks = doc.extractSearchChunks();
    const view = doc.toViewModel();

    expect(meta.title).toBe('First prompt for title');
    expect(meta.title_source).toBe('first_user');
    expect(meta.raw_format).toBe('openai-web/v2');
    expect(issues.some((i) => i.code === 'orphan_node')).toBe(true);
    expect(issues.some((i) => i.code === 'cycle_detected')).toBe(true);
    expect(chunks).toHaveLength(3);
    expect(view.nodes).toHaveLength(3);
    expect(formatConversationMarkdown(doc)).toContain('raw_format: openai-web/v2');
  });

  it('detects Anthropic text vs content[] mismatch and extracted_only attachment', () => {
    const doc = new AnthropicSessionDocument({
      uuid: 'anth-1',
      name: 'Claude Session',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          text: 'Outdated fallback text',
          content: [{ type: 'text', text: 'Real content block text' }],
          attachments: [{ file_name: 'notes.pdf', extracted_content: 'PDF body' }],
        },
      ],
    });

    const issues = doc.validate();
    expect(issues.some((i) => i.code === 'text_content_mismatch')).toBe(true);
    expect(issues.some((i) => i.code === 'attachment_extracted_only')).toBe(true);
  });

  it('performs same-provider diffing and detects shrunk sessions', () => {
    const older = new OpenAiSessionDocument({
      conversation_id: 'conv-diff-1',
      title: 'Session',
      mapping: {
        m1: { id: 'm1', parent: null, message: { id: 'm1', author: { role: 'user' }, content: { parts: ['Hello'] } } },
        m2: { id: 'm2', parent: 'm1', message: { id: 'm2', author: { role: 'assistant' }, content: { parts: ['Hi'] } } },
      },
    });

    const shrunkNewer = new OpenAiSessionDocument({
      conversation_id: 'conv-diff-1',
      title: 'Session',
      mapping: {
        m1: { id: 'm1', parent: null, message: { id: 'm1', author: { role: 'user' }, content: { parts: ['Hello'] } } },
      },
    });

    const diff = shrunkNewer.diffWith(older);
    expect(diff.status).toBe('shrunk');

    const batchDiff = buildBatchDiffStats([older], [shrunkNewer], 1);
    expect(batchDiff.shrunk_conversations).toBe(1);
    expect(batchDiff.shrunk_conversation_ids).toEqual(['conv-diff-1']);

    expect(decideConversationMerge(older, older)).toBe('identical');
  });
});

describe('@sm/core persistent ImportPipeline & ArchiveService (Issues #16, #17, #18)', () => {
  it('enforces L0 SHA-256 batch idempotency for both files and directory manifests', async () => {
    const dir = makeTempDir();
    const archiveDir = path.join(dir, 'archive');
    const dbPath = path.join(archiveDir, 'archive.db');
    const service = ArchiveService.open(dbPath, { archiveRoot: archiveDir });

    try {
      const exportFile = path.join(dir, 'conversations.json');
      const conv = makeOpenAiConv('oa-l0-1', 'L0 Test Chat', [
        { id: 'm1', role: 'user', text: 'First question' },
        { id: 'm2', role: 'assistant', text: 'First answer' },
      ]);
      fs.writeFileSync(exportFile, JSON.stringify([conv]), 'utf8');

      const firstRun = await service.importSource({ kind: 'file', path: exportFile });
      expect(firstRun.skipped_identical_batch).toBe(false);
      expect(firstRun.sessions).toHaveLength(1);
      expect(firstRun.decisions[0]!.decision).toBe('new');
      expect(service.listConversations()).toHaveLength(1);

      // Re-importing exact same file skips immediately with 0 new conversations
      const secondRun = await service.importSource({ kind: 'file', path: exportFile });
      expect(secondRun.skipped_identical_batch).toBe(true);
      expect(secondRun.batchId).toBe(firstRun.batchId);
      expect(secondRun.sessions).toHaveLength(0);
      expect(service.listBatches()).toHaveLength(1);
      expect(service.listConversations()).toHaveLength(1);

      // Directory manifest L0 idempotency using codex-local directory
      const codexDir = path.join(dir, 'codex-home');
      const sessionsSubdir = path.join(codexDir, 'sessions', '2026', '01', '01');
      fs.mkdirSync(sessionsSubdir, { recursive: true });
      const rolloutPath = path.join(sessionsSubdir, 'rollout-1.jsonl');
      fs.writeFileSync(
        rolloutPath,
        [
          JSON.stringify({
            timestamp: '2026-01-01T10:00:00Z',
            type: 'session_meta',
            payload: { id: 'codex-thread-1', cwd: '/repo', model_provider: 'openai' },
          }),
          JSON.stringify({
            timestamp: '2026-01-01T10:00:01Z',
            type: 'response_item',
            payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix bug' }] },
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      const dirRun1 = await service.importSource({ kind: 'dir', path: codexDir });
      expect(dirRun1.skipped_identical_batch).toBe(false);
      expect(dirRun1.adapterId).toBe('codex-local');
      expect(dirRun1.sessions).toHaveLength(1);

      const dirRun2 = await service.importSource({ kind: 'dir', path: codexDir });
      expect(dirRun2.skipped_identical_batch).toBe(true);
      expect(dirRun2.batchId).toBe(dirRun1.batchId);

      // Modifying the directory content changes sourceSha256 and triggers a new batch
      fs.appendFileSync(
        rolloutPath,
        JSON.stringify({
          timestamp: '2026-01-01T10:00:02Z',
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Bug fixed' }] },
        }) + '\n',
        'utf8'
      );
      const dirRun3 = await service.importSource({ kind: 'dir', path: codexDir });
      expect(dirRun3.skipped_identical_batch).toBe(false);
      expect(dirRun3.sourceSha256).not.toBe(dirRun1.sourceSha256);
      expect(dirRun3.decisions[0]!.decision).toBe('superset_append');
    } finally {
      service.close();
    }
  });

  it('wires real ParseCtx (RawStore + import_file, BlobStore.spillPayload + blob table, streamTopLevelJsonArray) and stores native_session blobs', async () => {
    const dir = makeTempDir();
    const archiveDir = path.join(dir, 'archive');
    const db = ArchiveDatabase.openArchiveDb(path.join(archiveDir, 'archive.db'));
    db.migrate();
    const repo = new ArchiveRepository(db);
    const rawStore = new RawStore(archiveDir);
    const blobStore = new BlobStore(archiveDir);

    try {
      // 1. OpenAI ZIP export with an embedded PNG asset -> exercises ctx.persistRaw + native_session blob
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03]);
      const zipPath = path.join(dir, 'openai-export.zip');
      const convWithAsset = {
        id: 'oa-asset-conv',
        conversation_id: 'oa-asset-conv',
        title: 'Asset Chat',
        create_time: 1700000000,
        update_time: 1700000050,
        current_node: 'm1',
        mapping: {
          m1: {
            id: 'm1',
            parent: null,
            children: [],
            message: {
              id: 'm1',
              author: { role: 'user' },
              create_time: 1700000000,
              content: {
                content_type: 'multimodal_text',
                parts: [
                  'Look at this diagram',
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-png-1', width: 320, height: 240 },
                ],
              },
            },
          },
        },
      };

      const zipBuf = createZipBuffer([
        { name: 'conversations.json', data: Buffer.from(JSON.stringify([convWithAsset]), 'utf8') },
        { name: 'file-png-1.png', data: pngBytes },
      ]);
      fs.writeFileSync(zipPath, zipBuf);

      const pipeline = new ImportPipeline();
      const res = await pipeline.run(
        { kind: 'file', path: zipPath },
        { storage: { db, repository: repo, rawStore, blobStore, archiveRoot: archiveDir } }
      );

      expect(res.batchId).toBeGreaterThan(0);
      const importFiles = repo.getImportFilesByBatch(res.batchId!);
      expect(importFiles.some((f) => f.rel_path === 'file-png-1.png' && f.sha256 === sha256Hex(pngBytes))).toBe(true);
      expect(rawStore.hasRaw(`raw/openai-web/${sha256Hex(pngBytes).slice(0, 2)}/file-png-1.png`)).toBe(true);

      const storedConv = repo.getConversationByExternalId('openai-web', 'oa-asset-conv')!;
      expect(storedConv.raw_format).toBe('openai-web/v2');
      expect(storedConv.raw_blob_sha256).toBeTruthy();

      const nativeBlobRow = repo.getBlobBySha256(storedConv.raw_blob_sha256!)!;
      expect(nativeBlobRow).toBeTruthy();
      expect(nativeBlobRow.origin_kind).toBe('native_session');
      expect(nativeBlobRow.mime).toBe('application/json');
      expect(blobStore.hasBlob(nativeBlobRow.rel_path)).toBe(true);
      const nativeJson = JSON.parse(blobStore.readBlobSync(nativeBlobRow.rel_path).toString('utf8'));
      expect(nativeJson.conversation_id).toBe('oa-asset-conv');

      // 2. Codex rollout with >32KB tool output -> exercises ctx.spill + blob table
      const codexDir = path.join(dir, 'codex-spill');
      const rolloutDir = path.join(codexDir, 'sessions', '2026', '01', '02');
      fs.mkdirSync(rolloutDir, { recursive: true });
      const oversizedOutput = 'Z'.repeat(SPILL_THRESHOLD_BYTES + 2048);
      fs.writeFileSync(
        path.join(rolloutDir, 'rollout-spill.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-01-02T10:00:00Z',
            type: 'session_meta',
            payload: { id: 'codex-spill-1', cwd: '/proj' },
          }),
          JSON.stringify({
            timestamp: '2026-01-02T10:00:01Z',
            type: 'response_item',
            payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"cat big.log"}', call_id: 'call-1' },
          }),
          JSON.stringify({
            timestamp: '2026-01-02T10:00:02Z',
            type: 'response_item',
            payload: { type: 'function_call_output', call_id: 'call-1', output: oversizedOutput },
          }),
        ].join('\n') + '\n',
        'utf8'
      );

      const codexRes = await pipeline.run(
        { kind: 'dir', path: codexDir },
        { storage: { db, repository: repo, rawStore, blobStore, archiveRoot: archiveDir } }
      );
      expect(codexRes.sessions).toHaveLength(1);
      const spilledSha = sha256Hex(oversizedOutput);
      const spilledBlob = repo.getBlobBySha256(spilledSha);
      expect(spilledBlob).toBeTruthy();
      expect(blobStore.hasBlob(spilledBlob!.rel_path)).toBe(true);

      // 3. Verify ctx.streamArray uses streamTopLevelJsonArray
      const customRegistry = new AdapterRegistry();
      let streamedCount = 0;
      const streamAdapter: Adapter = {
        id: 'openai-web',
        async probe(src: SourceRef): Promise<ProbeResult | null> {
          if (src.kind === 'file' && src.path.endsWith('.stream.json')) {
            return { adapterId: 'openai-web', version: '1.0.0', confidence: 1, evidence: [], entries: [], warnings: [] };
          }
          return null;
        },
        async *plan(src: SourceRef): AsyncIterable<ImportTask> {
          yield { id: 'stream-1', src, estimatedBytes: 100 };
        },
        async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument[]> {
          const readable = Readable.from([fs.readFileSync(task.src.path)]);
          const docs: SessionDocument[] = [];
          for await (const raw of ctx.streamArray<Record<string, unknown>>(readable)) {
            streamedCount++;
            docs.push(new OpenAiSessionDocument(raw as never));
          }
          return docs;
        },
      };
      customRegistry.register(streamAdapter);

      const streamFile = path.join(dir, 'array.stream.json');
      fs.writeFileSync(
        streamFile,
        JSON.stringify([
          makeOpenAiConv('oa-stream-1', 'Streamed 1', [{ id: 's1', role: 'user', text: 'Stream test 1' }]),
          makeOpenAiConv('oa-stream-2', 'Streamed 2', [{ id: 's2', role: 'user', text: 'Stream test 2' }]),
        ]),
        'utf8'
      );

      const streamRes = await pipeline.run(
        { kind: 'file', path: streamFile },
        {
          registry: customRegistry,
          storage: { db, repository: repo, rawStore, blobStore, archiveRoot: archiveDir },
        }
      );
      expect(streamedCount).toBe(2);
      expect(streamRes.sessions).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('persists L1-L4 dedupe decisions (identical, superset_append, branch_revision with superseded_by, auto_merge_fingerprint, candidate_review) and cross-batch shrunk diff reports', async () => {
    const dir = makeTempDir();
    const archiveDir = path.join(dir, 'archive');
    const service = ArchiveService.open(path.join(archiveDir, 'archive.db'), { archiveRoot: archiveDir });

    try {
      // Build 25 turns for MinHash similarity tests (candidate_review ~0.80 vs auto_merge >=0.90)
      const shared25 = Array.from({ length: 25 }, (_, idx) => ({
        id: `t-${idx}`,
        role: (idx % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        text: `Shared conversation turn number ${idx} discussing architecture`,
      }));

      // Batch 1: conv-ident, conv-grow, conv-branch, conv-shrunk, conv-vanish, conv-minhash-base
      const batch1File = path.join(dir, 'batch1.json');
      const batch1Convs = [
        makeOpenAiConv('conv-ident', 'Identical Chat', [
          { id: 'i1', role: 'user', text: 'What is WAL mode?' },
          { id: 'i2', role: 'assistant', text: 'Write-Ahead Logging.' },
        ]),
        makeOpenAiConv('conv-grow', 'Growing Chat', [
          { id: 'g1', role: 'user', text: 'Step 1' },
          { id: 'g2', role: 'assistant', text: 'Done 1' },
        ]),
        makeOpenAiConv('conv-branch', 'Branched Chat', [
          { id: 'b1', role: 'user', text: 'Draft prompt' },
          { id: 'b2', role: 'assistant', text: 'Original response v1' },
          { id: 'b3', role: 'user', text: 'Old follow-up' },
        ]),
        makeOpenAiConv('conv-shrunk', 'Shrunk Chat', [
          { id: 'sh1', role: 'user', text: 'Keep this message' },
          { id: 'sh2', role: 'assistant', text: 'Delete this message upstream' },
          { id: 'sh3', role: 'user', text: 'Delete this too' },
        ]),
        makeOpenAiConv('conv-vanish', 'Vanished Chat', [
          { id: 'v1', role: 'user', text: 'Will disappear in batch 2' },
        ]),
        makeOpenAiConv('conv-minhash-base', 'MinHash Base', shared25),
      ];
      fs.writeFileSync(batch1File, JSON.stringify(batch1Convs), 'utf8');

      const res1 = await service.importSource({ kind: 'file', path: batch1File });
      expect(res1.decisions.every((d) => d.decision === 'new')).toBe(true);
      expect(service.listConversations({ limit: 50 })).toHaveLength(6);

      // Batch 2:
      // - conv-ident: identical (updated exported_at via update_time)
      // - conv-grow: superset_append (+1 turn g3)
      // - conv-branch: branch_revision (b2 edited, b3 removed)
      // - conv-shrunk: shrunk (only sh1 remains)
      // - conv-vanish: omitted (disappeared)
      // - conv-added: brand new
      // - conv-auto-merge (no external_id): 24 of 25 turns identical + 1 modified -> >=0.90 auto_merge_fingerprint
      // - conv-cand-review (different external_id): 22 of 25 turns identical + 3 modified -> 0.75-0.90 candidate_review
      const batch2File = path.join(dir, 'batch2.json');
      const autoMergeTurns = [
        ...shared25.slice(0, 24),
        { id: 'am-24', role: 'assistant' as const, text: 'Slightly revised final turn 24' },
      ];
      const candReviewTurns = [
        ...shared25.slice(0, 22),
        { id: 'cr-22', role: 'user' as const, text: 'Diverged question 22' },
        { id: 'cr-23', role: 'assistant' as const, text: 'Diverged answer 23' },
        { id: 'cr-24', role: 'user' as const, text: 'Diverged question 24' },
      ];

      const batch2Convs = [
        makeOpenAiConv(
          'conv-ident',
          'Identical Chat',
          [
            { id: 'i1', role: 'user', text: 'What is WAL mode?' },
            { id: 'i2', role: 'assistant', text: 'Write-Ahead Logging.' },
          ],
          1700000000,
          1700009999
        ),
        makeOpenAiConv('conv-grow', 'Growing Chat', [
          { id: 'g1', role: 'user', text: 'Step 1' },
          { id: 'g2', role: 'assistant', text: 'Done 1' },
          { id: 'g3', role: 'user', text: 'Step 2' },
        ]),
        makeOpenAiConv('conv-branch', 'Branched Chat', [
          { id: 'b1', role: 'user', text: 'Draft prompt' },
          { id: 'b2', role: 'assistant', text: 'Edited response v2' },
        ]),
        makeOpenAiConv('conv-shrunk', 'Shrunk Chat', [
          { id: 'sh1', role: 'user', text: 'Keep this message' },
        ]),
        makeOpenAiConv('conv-added', 'Added Chat', [
          { id: 'a1', role: 'user', text: 'Brand new session' },
        ]),
        // No external_id -> tests Tier 3/4 auto_merge_fingerprint against conv-minhash-base
        {
          title: 'Auto Merge No ID',
          create_time: 1700000000,
          update_time: 1700000200,
          mapping: makeOpenAiConv('tmp-am', 'Auto Merge No ID', autoMergeTurns).mapping,
        },
        makeOpenAiConv('conv-cand-review', 'Candidate Review Chat', candReviewTurns),
      ];
      fs.writeFileSync(batch2File, JSON.stringify(batch2Convs), 'utf8');

      const res2 = await service.importSource({ kind: 'file', path: batch2File });
      const byExt = new Map(res2.decisions.map((d) => [d.externalId, d]));

      expect(byExt.get('conv-ident')?.decision).toBe('identical');
      expect(byExt.get('conv-grow')?.decision).toBe('superset_append');
      expect(byExt.get('conv-branch')?.decision).toBe('branch_revision');
      expect(byExt.get('conv-shrunk')?.decision).toBe('branch_revision');
      expect(byExt.get('conv-added')?.decision).toBe('new');
      expect(byExt.get(null)?.decision).toBe('auto_merge_fingerprint');
      expect(byExt.get('conv-cand-review')?.decision).toBe('candidate_review');

      // Check SQLite persistence for superset_append
      const growRow = service.repository.getConversationByExternalId('openai-web', 'conv-grow')!;
      expect(growRow.revision_count).toBe(2);
      expect(growRow.item_count).toBe(3);
      expect(service.repository.getConversationRevisions(growRow.id)).toHaveLength(2);

      // Check SQLite persistence for branch_revision (superseded_by flags + diff_json)
      const branchRow = service.repository.getConversationByExternalId('openai-web', 'conv-branch')!;
      expect(branchRow.revision_count).toBe(2);
      const activeBranchItems = service.repository.getConversationItems(branchRow.id, true);
      expect(activeBranchItems.map((i) => i.text)).toEqual(['Draft prompt', 'Edited response v2']);

      const allBranchItems = service.repository.getConversationItems(branchRow.id, false);
      const supersededItems = allBranchItems.filter((i) => i.is_active_branch === 0);
      expect(supersededItems).toHaveLength(2); // b2 (v1) + b3 (pruned)
      for (const oldItem of supersededItems) {
        const flags = JSON.parse(oldItem.flags_json!);
        expect(flags.superseded_by).toBeTruthy();
      }
      const branchRevs = service.repository.getConversationRevisions(branchRow.id);
      expect(branchRevs).toHaveLength(2);
      expect(JSON.parse(branchRevs[1]!.diff_json!).status).toBe('branch_revision');

      // Check dedupe_candidate table for candidate_review
      const candidates = service.listDedupeCandidates('open');
      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(candidates[0]!.similarity).toBeGreaterThanOrEqual(0.75);
      expect(candidates[0]!.similarity).toBeLessThan(0.9);

      // Check Issue #18: cross-batch diff persisted in import_batch.report_json
      const batch2Row = service.repository.getBatch(res2.batchId!)!;
      const persistedReport = JSON.parse(batch2Row.report_json!);
      expect(persistedReport.diff.previous_batch_id).toBe(res1.batchId);
      expect(persistedReport.diff.identical_conversations).toBe(1);
      expect(persistedReport.diff.grown_conversations).toBe(1);
      expect(persistedReport.diff.shrunk_conversations).toBe(2); // conv-branch (3->2) & conv-shrunk (3->1)
      expect(persistedReport.diff.shrunk_conversation_ids).toContain('conv-branch');
      expect(persistedReport.diff.shrunk_conversation_ids).toContain('conv-shrunk');
      expect(persistedReport.diff.disappeared_conversations).toBe(1); // conv-vanish

      // Check formatIntegrityReportMarkdown & verify()
      const verification = service.verify(res2.batchId);
      expect(verification.markdown).toContain('# Integrity Verification Report');
      expect(verification.markdown).toContain('## Cross-Batch Diff Summary');
      expect(verification.markdown).toContain('Shrunk Conversations');
      expect(verification.markdown).toContain('conv-shrunk');
      expect(formatIntegrityReportMarkdown(res2.report)).toBe(verification.markdown);
    } finally {
      service.close();
    }
  });
});

describe('@sm/core FTS5 dual-index search router & weighted BM25 ranking (Issue #20)', () => {
  function seedSearchDb() {
    const db = ArchiveDatabase.openArchiveDb(':memory:');
    db.migrate();
    const repo = new ArchiveRepository(db);
    const now = 1_750_000_000_000;
    const oldTs = now - 120 * 86_400_000; // 120 days ago

    const batchId = repo.createBatch({
      provider: 'codex-local',
      adapter_id: 'codex-local',
      adapter_version: '1.0.0',
      kind: 'local_dir',
      source_sha256: sha256Hex('search-seed'),
      status: 'ok',
    });

    // Conv 1: Latin text, tool_name, user role boost, recency, synthetic downweighting
    repo.insertConversation({
      provider: 'codex-local',
      external_id: 's-latin',
      title: 'SQLite Performance Tuning',
      created_at: oldTs,
      updated_at: now,
      batch_id: batchId,
      items: [
        {
          external_id: 'l-synth',
          ordinal: 0,
          role: 'user',
          kind: 'system_note',
          created_at: now,
          text: 'Synthetic benchmark harness for TypeScript parser',
          content_hash: 'h-l-synth',
          is_synthetic: true,
        },
        {
          external_id: 'l-asst-old',
          ordinal: 1,
          role: 'assistant',
          kind: 'message',
          created_at: oldTs,
          text: 'TypeScript parser optimization benchmark completed',
          content_hash: 'h-l-asst-old',
          is_synthetic: false,
        },
        {
          external_id: 'l-asst-new',
          ordinal: 2,
          role: 'assistant',
          kind: 'message',
          created_at: now - 1000,
          text: 'TypeScript parser optimization benchmark completed',
          content_hash: 'h-l-asst-new',
          is_synthetic: false,
        },
        {
          external_id: 'l-user-new',
          ordinal: 3,
          role: 'user',
          kind: 'message',
          created_at: now - 1000,
          text: 'TypeScript parser optimization benchmark completed',
          content_hash: 'h-l-user-new',
          is_synthetic: false,
        },
        {
          external_id: 'l-tool',
          ordinal: 4,
          role: 'assistant',
          kind: 'tool_call',
          created_at: now,
          tool_name: 'run_vitest_runner',
          text: 'Executing test suite',
          content_hash: 'h-l-tool',
          blocks: [{ idx: 0, type: 'tool_use', tool_name: 'run_vitest_runner', tool_input: '{}' }],
        },
      ],
    });

    // Conv 2: CJK content + CJK title (conv_fts_tri)
    repo.insertConversation({
      provider: 'openai-web',
      external_id: 's-cjk',
      title: '分布式系统架构设计指南',
      created_at: now,
      updated_at: now,
      batch_id: batchId,
      items: [
        {
          external_id: 'c-1',
          ordinal: 0,
          role: 'user',
          kind: 'message',
          created_at: now,
          text: '请介绍全文检索与倒排索引的实现细节',
          content_hash: 'h-c-1',
        },
        {
          external_id: 'c-2',
          ordinal: 1,
          role: 'assistant',
          kind: 'message',
          created_at: now,
          text: '本文讨论检索性能与缓存一致性',
          content_hash: 'h-c-2',
        },
      ],
    });

    // Conv 3: Mixed Latin + CJK
    repo.insertConversation({
      provider: 'openai-web',
      external_id: 's-mixed',
      title: 'Mixed Search Session',
      created_at: now,
      updated_at: now,
      batch_id: batchId,
      items: [
        {
          external_id: 'm-1',
          ordinal: 0,
          role: 'user',
          kind: 'message',
          created_at: now,
          text: 'Using SQLite trigram for 全文检索 and 缓存 optimization',
          content_hash: 'h-m-1',
        },
      ],
    });

    return { db, now };
  }

  it('routes Latin queries to item_fts_uni (text + tool_name) and applies role_boost, recency_decay, and synthetic downweighting', () => {
    const { db, now } = seedSearchDb();
    try {
      const plan = buildSearchSqlPlan('TypeScript benchmark');
      expect(plan.strategy).toBe('uni');
      expect(plan.targetTables).toEqual(['item_fts_uni']);

      const result = executeArchiveSearch(db, 'TypeScript benchmark', { nowMs: now });
      expect(result.strategy).toBe('uni');
      expect(result.hits).toHaveLength(4);

      // Rank order:
      // 1. user + recent (non-synthetic)
      // 2. assistant + recent (non-synthetic)
      // 3. assistant + 120d old (non-synthetic)
      // 4. synthetic user + recent (downweighted by default)
      expect(result.hits[0]!.role).toBe('user');
      expect(result.hits[0]!.is_synthetic).toBe(false);
      expect(result.hits[1]!.role).toBe('assistant');
      expect(result.hits[1]!.created_at).toBe(now - 1000);
      expect(result.hits[2]!.role).toBe('assistant');
      expect(result.hits[2]!.created_at).toBeLessThan(now - 1000);
      expect(result.hits[3]!.is_synthetic).toBe(true);

      // Tool name matching via item_fts_uni
      const toolHits = executeArchiveSearch(db, 'run_vitest_runner', { nowMs: now });
      expect(toolHits.strategy).toBe('uni');
      expect(toolHits.hits).toHaveLength(1);
      expect(toolHits.hits[0]!.tool_name).toBe('run_vitest_runner');
    } finally {
      db.close();
    }
  });

  it('routes >=3 char CJK to item_fts_tri + conv_fts_tri title hits, and 1-2 char CJK to bounded LIKE without false positives', () => {
    const { db, now } = seedSearchDb();
    try {
      // >=3 char CJK item match
      const triPlan = buildSearchSqlPlan('全文检索');
      expect(triPlan.strategy).toBe('tri');
      expect(triPlan.targetTables).toContain('item_fts_tri');
      expect(triPlan.targetTables).toContain('conv_fts_tri');

      const triRes = executeArchiveSearch(db, '全文检索', { nowMs: now });
      expect(triRes.strategy).toBe('tri');
      expect(triRes.hits.length).toBeGreaterThanOrEqual(2);
      expect(triRes.hits.every((h) => h.text?.includes('全文检索'))).toBe(true);

      // >=3 char CJK conversation title hit (not present in item text)
      const titleRes = executeArchiveSearch(db, '系统架构设计', { nowMs: now });
      expect(titleRes.strategy).toBe('tri');
      expect(titleRes.hits).toHaveLength(1);
      expect(titleRes.hits[0]!.match_source).toBe('conv_fts_tri');
      expect(titleRes.hits[0]!.conversation_title).toBe('分布式系统架构设计指南');

      // 2-char CJK -> bounded LIKE
      const shortPlan = buildSearchSqlPlan('缓存');
      expect(shortPlan.strategy).toBe('like');
      expect(shortPlan.targetTables).toEqual(['item']);

      const shortRes = executeArchiveSearch(db, '缓存', { nowMs: now });
      expect(shortRes.strategy).toBe('like');
      expect(shortRes.hits).toHaveLength(2);
      expect(shortRes.hits.every((h) => h.text?.includes('缓存'))).toBe(true);

      // Non-matching 2-char CJK returns 0 hits
      const missShort = executeArchiveSearch(db, '量子', { nowMs: now });
      expect(missShort.hits).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('routes mixed Latin + CJK queries through union fusion without trigram short-token false positives', () => {
    const { db, now } = seedSearchDb();
    try {
      // Mixed: Latin + >=3-char CJK
      const mixedTri = executeArchiveSearch(db, 'SQLite 全文检索', { nowMs: now });
      expect(mixedTri.strategy).toBe('mixed');
      expect(mixedTri.hits.length).toBeGreaterThanOrEqual(1);
      // Item matching BOTH SQLite (item_fts_uni) and 全文检索 (item_fts_tri) ranks #1 via fusion boost
      expect(mixedTri.hits[0]!.text).toContain('SQLite trigram for 全文检索');
      expect(mixedTri.hits[0]!.match_source).toBe('mixed');

      // Mixed: Latin + 2-char CJK (never sends 2-char CJK to item_fts_tri)
      const mixedShort = executeArchiveSearch(db, 'SQLite 缓存', { nowMs: now });
      expect(mixedShort.strategy).toBe('mixed');
      expect(mixedShort.hits[0]!.text).toContain('SQLite');
      expect(mixedShort.hits[0]!.text).toContain('缓存');

      // Non-matching short CJK + non-matching Latin returns 0 hits (no trigram match-all leak)
      const mixedMiss = executeArchiveSearch(db, 'Go 量子', { nowMs: now });
      expect(mixedMiss.hits).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
