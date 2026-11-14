import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SPILL_THRESHOLD_BYTES, sha256Hex, type BlobAsset } from '@sm/shared';
import {
  ArchiveDatabase,
  ArchiveRepository,
  BlobStore,
  RawStore,
  openArchiveDb,
  openExternalSqliteReadOnly,
  sniffMimeAndExt,
} from './index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'sm-store-test-'): string {
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

describe('@sm/store ArchiveDatabase', () => {
  it('migrates :memory: database, manages meta, rebuilds FTS5, and rolls back failed transactions', () => {
    const db = openArchiveDb(':memory:');
    try {
      db.migrate();
      expect(db.getMeta('schema_version')).toBe('1');
      expect(db.getMeta('created_at')).toBeTruthy();

      db.setMeta('custom_key', 'hello');
      expect(db.getMeta('custom_key')).toBe('hello');
      expect(db.getMeta('missing_key')).toBeUndefined();

      expect(() =>
        db.transaction(() => {
          db.setMeta('tx_key', 'rolled_back');
          throw new Error('forced failure');
        })
      ).toThrow('forced failure');
      expect(db.getMeta('tx_key')).toBeUndefined();

      db.rebuildFts();
      expect(db.getMeta('last_reindex_at')).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('creates parent directories for file-backed DB and opens external sqlite read-only', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'nested', 'archive.db');
    const db = ArchiveDatabase.openArchiveDb(dbPath);
    db.migrate();
    db.setMeta('marker', 'disk-ok');
    db.close();

    const ro = openExternalSqliteReadOnly(dbPath);
    try {
      const row = ro.prepare('SELECT value FROM meta WHERE key = ?').get('marker') as {
        value: string;
      };
      expect(row.value).toBe('disk-ok');
      expect(() => ro.exec("INSERT INTO meta (key, value) VALUES ('x', 'y')")).toThrow();
    } finally {
      ro.close();
    }

    expect(() => openExternalSqliteReadOnly(path.join(dir, 'nonexistent.db'))).toThrow();
  });
});

describe('@sm/store RawStore', () => {
  it('persists immutable raw bytes asynchronously and synchronously with filename sanitization', async () => {
    const dir = makeTempDir();
    const rawStore = new RawStore(dir);
    const payload = Buffer.from('{"conversation":"test"}', 'utf8');

    const res1 = await rawStore.persistRaw('openai-web', '../../evil:name?.json', payload);
    expect(res1.sha256).toBe(sha256Hex(payload));
    expect(res1.relPath).toBe(`raw/openai-web/${res1.sha256.slice(0, 2)}/evil_name_.json`);
    expect(rawStore.hasRaw(res1.relPath)).toBe(true);
    expect((await rawStore.readRaw(res1.relPath)).equals(payload)).toBe(true);

    // Idempotent second write
    const res2 = rawStore.persistRawSync('openai-web', '../../evil:name?.json', payload);
    expect(res2.sha256).toBe(res1.sha256);
    expect(rawStore.readRawSync(res2.absPath).equals(payload)).toBe(true);
  });
});

describe('@sm/store BlobStore & Magic Number Sniffing', () => {
  it('sniffs MIME types and extensions accurately from magic bytes', () => {
    expect(sniffMimeAndExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({
      mime: 'image/png',
      ext: '.png',
    });
    expect(sniffMimeAndExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      mime: 'image/jpeg',
      ext: '.jpg',
    });
    expect(
      sniffMimeAndExt(Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'latin1'))
    ).toEqual({
      mime: 'image/webp',
      ext: '.webp',
    });
    expect(sniffMimeAndExt(Buffer.from('GIF89a'))).toEqual({
      mime: 'image/gif',
      ext: '.gif',
    });
    expect(sniffMimeAndExt(Buffer.from('%PDF-1.7'))).toEqual({
      mime: 'application/pdf',
      ext: '.pdf',
    });
    expect(
      sniffMimeAndExt(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]))
    ).toEqual({
      mime: 'video/mp4',
      ext: '.mp4',
    });
    expect(sniffMimeAndExt(Buffer.from('\uFEFF  {"ok": true}', 'utf8'))).toEqual({
      mime: 'application/json',
      ext: '.json',
    });
    expect(sniffMimeAndExt(Buffer.from([0x01, 0x02, 0x03]))).toEqual({
      mime: 'application/octet-stream',
      ext: '.bin',
    });
  });

  it('stores deduplicated blobs and spills > 32KB payloads to content-addressed files', async () => {
    const dir = makeTempDir();
    const blobStore = new BlobStore(dir);

    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const asset1 = await blobStore.putBlob(pngBytes, 'export_dat');
    const asset2 = blobStore.putBlobSync(pngBytes, 'export_dat');

    expect(asset1.sha256).toBe(asset2.sha256);
    expect(asset1.mime).toBe('image/png');
    expect(asset1.ext).toBe('.png');
    expect(asset1.rel_path).toBe(`blobs/${asset1.sha256.slice(0, 2)}/${asset1.sha256}.png`);
    expect(blobStore.hasBlob(asset1.rel_path)).toBe(true);
    expect((await blobStore.readBlob(asset1.rel_path)).equals(pngBytes)).toBe(true);

    // > 32KB spill (object & string)
    const oversizedText = 'X'.repeat(SPILL_THRESHOLD_BYTES + 1024);
    const spilledObj = await blobStore.spillPayload({ output: oversizedText });
    expect(spilledObj.origin_kind).toBe('oversized_payload');
    expect(spilledObj.mime).toBe('application/json');
    expect(spilledObj.ext).toBe('.json');
    expect(spilledObj.bytes).toBeGreaterThan(SPILL_THRESHOLD_BYTES);
    expect(blobStore.readBlobSync(spilledObj.rel_path).toString('utf8')).toContain(oversizedText);

    const spilledStr = blobStore.spillPayloadSync(oversizedText);
    expect(spilledStr.mime).toBe('text/plain');
    expect(spilledStr.ext).toBe('.txt');
    expect(spilledStr.bytes).toBe(Buffer.byteLength(oversizedText, 'utf8'));
  });
});

describe('@sm/store ArchiveRepository', () => {
  function setupRepo(): { db: ArchiveDatabase; repo: ArchiveRepository } {
    const db = openArchiveDb(':memory:');
    db.migrate();
    return { db, repo: new ArchiveRepository(db) };
  }

  it('handles batch lifecycle, L0 source sha idempotency, import_file, and latest completed batch', () => {
    const { db, repo } = setupRepo();
    try {
      const sha1 = sha256Hex('export-zip-1');
      expect(repo.findBatchBySourceSha('openai-web', 'export_zip', sha1)).toBeNull();

      const batch1Id = repo.createBatch({
        provider: 'openai-web',
        adapter_id: 'openai-web',
        adapter_version: '1.0.0',
        kind: 'export_zip',
        source_path: '/tmp/export1.zip',
        source_sha256: sha1,
        imported_at: 1000,
      });

      const found = repo.findBatchBySourceSha('openai-web', 'export_zip', sha1);
      expect(found?.id).toBe(batch1Id);
      expect(found?.status).toBe('running');

      const fileId = repo.insertImportFile({
        batch_id: batch1Id,
        rel_path: 'conversations.json',
        sha256: sha256Hex('conversations-json'),
        size: 1234,
        role: 'conversations',
        parsed_ok: true,
      });
      expect(fileId).toBeGreaterThan(0);
      expect(repo.getImportFilesByBatch(batch1Id)).toHaveLength(1);

      repo.updateBatchStatus(
        batch1Id,
        'ok',
        { conversations: 1, items: 2 },
        {
          schema_version: 'v1',
          provider: 'openai-web',
          adapter_id: 'openai-web',
          adapter_version: '1.0.0',
          generated_at: 1050,
          issues: [],
          unrecognized_field_counts: {},
        }
      );

      const batch1 = repo.getBatch(batch1Id);
      expect(batch1?.status).toBe('ok');
      expect(JSON.parse(batch1!.stats_json!)).toEqual({ conversations: 1, items: 2 });

      const batch2Id = repo.createBatch({
        provider: 'openai-web',
        adapter_id: 'openai-web',
        adapter_version: '1.0.0',
        kind: 'export_zip',
        source_sha256: sha256Hex('export-zip-2'),
        imported_at: 2000,
        status: 'running',
      });

      expect(repo.listBatches(10).map((b) => b.id)).toEqual([batch2Id, batch1Id]);
      expect(repo.getLatestCompletedBatch('openai-web')?.id).toBe(batch1Id);
      expect(repo.getLatestCompletedBatch('openai-web', batch1Id)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('inserts conversations with parent_external_id resolution, queries items, and upserts blobs', () => {
    const { db, repo } = setupRepo();
    try {
      const batchId = repo.createBatch({
        provider: 'codex-local',
        adapter_id: 'codex-local',
        adapter_version: '1.0.0',
        kind: 'local_dir',
        source_sha256: sha256Hex('codex-dir'),
      });

      const blob: BlobAsset = {
        sha256: sha256Hex('img-bytes'),
        mime: 'image/png',
        bytes: 9,
        ext: '.png',
        rel_path: `blobs/aa/${sha256Hex('img-bytes')}.png`,
        origin_kind: 'export_dat',
        created_at: 1000,
      };
      repo.upsertBlob(blob);
      // Conflict upsert enriches optional metadata
      repo.upsertBlob({ ...blob, width: 640, height: 480 });
      const storedBlob = repo.getBlobBySha256(blob.sha256);
      expect(storedBlob?.width).toBe(640);
      expect(storedBlob?.height).toBe(480);

      // Insert with child appearing before parent to verify two-pass parent_id resolution
      const convId = repo.insertConversation({
        provider: 'codex-local',
        external_id: 'thread-1',
        title: 'Refactor Store',
        title_source: 'provider',
        created_at: 1000,
        updated_at: 2000,
        content_hash: 'conv-hash-1',
        fingerprint: 'fp-1',
        raw_format: 'codex-local/v1',
        batch_id: batchId,
        starred: true,
        items: [
          {
            external_id: 'turn-2',
            parent_external_id: 'turn-1',
            ordinal: 1,
            depth: 1,
            role: 'assistant',
            kind: 'tool_call',
            text: 'Running vitest',
            content_hash: 'h2',
            is_active_branch: true,
            blocks: [
              {
                idx: 0,
                type: 'tool_use',
                tool_name: 'commandExecution',
                tool_input: '{"cmd":"npx vitest run"}',
              },
            ],
            flags_json: { source: 'rollout' },
          },
          {
            external_id: 'turn-1',
            parent_external_id: null,
            ordinal: 0,
            depth: 0,
            role: 'user',
            kind: 'message',
            text: 'Run tests',
            content_hash: 'h1',
            is_active_branch: true,
            blocks: [{ idx: 0, type: 'text', text: 'Run tests' }],
          },
        ],
      });

      expect(repo.getConversationById(convId)?.title).toBe('Refactor Store');
      expect(repo.getConversationByExternalId('codex-local', 'thread-1')?.id).toBe(convId);
      expect(repo.getConversationsByProvider('codex-local')).toHaveLength(1);
      expect(repo.listConversations({ provider: 'codex-local', starred: true })).toHaveLength(1);
      expect(repo.listConversations({ provider: 'codex-local', starred: false })).toHaveLength(0);

      const items = repo.getConversationItems(convId);
      expect(items).toHaveLength(2);
      expect(items[0]!.external_id).toBe('turn-1');
      expect(items[0]!.parent_id).toBeNull();
      expect(items[1]!.external_id).toBe('turn-2');
      expect(items[1]!.parent_id).toBe(items[0]!.id);
      expect(items[1]!.tool_name).toBe('commandExecution');
      expect(JSON.parse(items[1]!.blocks_json!)[0].tool_name).toBe('commandExecution');
      expect(JSON.parse(items[1]!.flags_json!)).toEqual({ source: 'rollout' });
      expect(repo.getConversationRevisions(convId)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('supports identical updates, superset appends, branch revisions with superseded_by, and dedupe candidates', () => {
    const { db, repo } = setupRepo();
    try {
      const b1 = repo.createBatch({
        provider: 'openai-web',
        adapter_id: 'openai-web',
        adapter_version: '1.0.0',
        kind: 'export_zip',
        source_sha256: sha256Hex('b1'),
      });
      const b2 = repo.createBatch({
        provider: 'openai-web',
        adapter_id: 'openai-web',
        adapter_version: '1.0.0',
        kind: 'export_zip',
        source_sha256: sha256Hex('b2'),
      });
      const b3 = repo.createBatch({
        provider: 'openai-web',
        adapter_id: 'openai-web',
        adapter_version: '1.0.0',
        kind: 'export_zip',
        source_sha256: sha256Hex('b3'),
      });
      const b4 = repo.createBatch({
        provider: 'openai-web',
        adapter_id: 'openai-web',
        adapter_version: '1.0.0',
        kind: 'export_zip',
        source_sha256: sha256Hex('b4'),
      });

      const convId = repo.insertConversation({
        provider: 'openai-web',
        external_id: 'oa-1',
        title: 'Chat',
        content_hash: 'root-v1',
        batch_id: b1,
        exported_at: 1000,
        items: [
          {
            external_id: 'm1',
            parent_external_id: null,
            ordinal: 0,
            role: 'user',
            kind: 'message',
            text: 'Hello',
            content_hash: 'h-m1',
            blocks: [{ idx: 0, type: 'text', text: 'Hello' }],
          },
          {
            external_id: 'm2',
            parent_external_id: 'm1',
            ordinal: 1,
            role: 'assistant',
            kind: 'message',
            text: 'Draft answer',
            content_hash: 'h-m2-v1',
            blocks: [{ idx: 0, type: 'text', text: 'Draft answer' }],
          },
        ],
      });

      // 1. Identical batch update
      repo.updateConversationIdentical(convId, b2, 2000);
      const afterIdentical = repo.getConversationById(convId)!;
      expect(afterIdentical.last_batch_id).toBe(b2);
      expect(afterIdentical.exported_at).toBe(2000);
      expect(afterIdentical.revision_count).toBe(1);

      // 2. Superset append
      const rev2 = repo.appendConversationItems(
        convId,
        b3,
        [
          {
            external_id: 'm3',
            parent_external_id: 'm2',
            ordinal: 2,
            role: 'user',
            kind: 'message',
            text: 'Follow up',
            content_hash: 'h-m3',
            blocks: [{ idx: 0, type: 'text', text: 'Follow up' }],
          },
        ],
        {
          content_hash: 'root-v2',
          updated_at: 3000,
          exported_at: 3000,
        }
      );
      expect(rev2).toBe(2);
      const afterAppend = repo.getConversationById(convId)!;
      expect(afterAppend.revision_count).toBe(2);
      expect(afterAppend.item_count).toBe(3);
      expect(repo.getConversationItems(convId)).toHaveLength(3);

      // 3. Branch revision: m1 kept, m2 edited (same external_id, new content_hash), m3 pruned
      const rev3 = repo.saveBranchRevision(
        convId,
        b4,
        [
          {
            external_id: 'm1',
            parent_external_id: null,
            ordinal: 0,
            role: 'user',
            kind: 'message',
            text: 'Hello',
            content_hash: 'h-m1',
            blocks: [{ idx: 0, type: 'text', text: 'Hello' }],
          },
          {
            external_id: 'm2',
            parent_external_id: 'm1',
            ordinal: 1,
            role: 'assistant',
            kind: 'message',
            text: 'Edited answer',
            content_hash: 'h-m2-v2',
            blocks: [{ idx: 0, type: 'text', text: 'Edited answer' }],
          },
        ],
        { status: 'branched', edited: ['m2'], removed: ['m3'] },
        {
          content_hash: 'root-v3',
          updated_at: 4000,
        }
      );
      expect(rev3).toBe(3);

      const activeItems = repo.getConversationItems(convId, true);
      expect(activeItems).toHaveLength(2);
      expect(activeItems.map((i) => i.external_id)).toEqual(['m1', 'm2']);
      expect(activeItems[1]!.text).toBe('Edited answer');
      expect(activeItems[1]!.parent_id).toBe(activeItems[0]!.id);

      const allItems = repo.getConversationItems(convId, false);
      expect(allItems).toHaveLength(4);
      const superseded = allItems.filter((i) => i.is_active_branch === 0);
      expect(superseded).toHaveLength(2);
      for (const oldRow of superseded) {
        const flags = JSON.parse(oldRow.flags_json!);
        expect(flags.superseded_by).toBeTruthy();
        expect(flags.superseded_batch_id).toBe(b4);
      }

      const revisions = repo.getConversationRevisions(convId);
      expect(revisions).toHaveLength(3);
      expect(JSON.parse(revisions[2]!.diff_json!)).toEqual({
        status: 'branched',
        edited: ['m2'],
        removed: ['m3'],
      });

      // 4. Dedupe candidates
      const conv2Id = repo.insertConversation({
        provider: 'openai-web',
        external_id: 'oa-2',
        title: 'Duplicate Chat',
        content_hash: 'root-dup',
        batch_id: b4,
      });

      const candId = repo.insertDedupeCandidate(conv2Id, convId, 0.86, 'minhash_lsh');
      expect(candId).toBeGreaterThan(0);
      const openCandidates = repo.listDedupeCandidates('open');
      expect(openCandidates).toHaveLength(1);
      expect(openCandidates[0]!.a_id).toBe(Math.min(convId, conv2Id));
      expect(openCandidates[0]!.b_id).toBe(Math.max(convId, conv2Id));
      expect(openCandidates[0]!.similarity).toBeCloseTo(0.86);
      expect(repo.listDedupeCandidates('merged')).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
