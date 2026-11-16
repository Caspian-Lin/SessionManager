import fs from 'node:fs';
import path from 'node:path';
import {
  ZipArchive,
  iterJsonLines,
  sha256Hex,
  type BlobAsset,
  type ConversationViewModel,
  type IntegrityIssue,
  type NativeArchiveManifest,
  type ProviderId,
  type SessionMeta,
  type ViewNode,
} from '@sm/shared';
import {
  BaseSessionDocument,
  type Adapter,
  type ImportTask,
  type ParseCtx,
  type ProbeResult,
  type RawTurnProjection,
  type SessionDocument,
  type SourceRef,
} from '../contract.js';

export interface NativeSessionExportRecord {
  id?: number;
  provider?: ProviderId;
  external_id?: string | null;
  raw_format?: string | null;
  raw_blob_sha256?: string | null;
  raw_blob_rel_path?: string | null;
  revision_count?: number;
  meta: SessionMeta;
  nodes: ViewNode[];
  blobs?: BlobAsset[];
}

export interface SmNativeDocumentPayload {
  manifest: NativeArchiveManifest;
  session: NativeSessionExportRecord;
  rawSliceJson?: string | null;
}

export class SmNativeSessionDocument extends BaseSessionDocument<SmNativeDocumentPayload> {
  constructor(
    nativeData: SmNativeDocumentPayload,
    restoredBlobs: BlobAsset[],
    parseIssues: IntegrityIssue[] = []
  ) {
    const meta = nativeData.session.meta;
    super({
      provider: meta.provider,
      rawFormat: nativeData.session.raw_format ?? meta.raw_format ?? 'sm-native/v1',
      nativeData,
      external_id: nativeData.session.external_id ?? meta.external_id ?? null,
      title: meta.title ?? null,
      title_source: meta.title_source ?? null,
      summary: meta.summary ?? null,
      created_at: meta.created_at ?? null,
      updated_at: meta.updated_at ?? null,
      exported_at: meta.exported_at ?? nativeData.manifest.exported_at ?? null,
      default_model: meta.default_model ?? null,
      cwd: meta.cwd ?? null,
      blobs: restoredBlobs,
      parseIssues,
    });
  }

  override toNativeJson(): string {
    if (this.nativeData.rawSliceJson) {
      return this.nativeData.rawSliceJson;
    }
    return JSON.stringify(this.nativeData.session);
  }

  protected projectTurns(): RawTurnProjection[] {
    const nodes = [...(this.nativeData.session.nodes ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    return nodes.map((n) => ({
      external_id: n.external_id,
      parent_external_id: n.parent_external_id,
      ordinal: n.ordinal,
      role: n.role,
      kind: n.kind,
      created_at: n.created_at,
      model: n.model,
      text: n.text,
      is_active_branch: n.is_active_branch,
      is_hidden: n.is_hidden,
      is_synthetic: n.is_synthetic,
      status: n.status,
      payload_ref: n.payload_ref,
      blocks: n.blocks ?? [],
    }));
  }
}

function findBlobBytesInDir(rootDir: string, blob: BlobAsset | undefined, relPathHint: string | null): Buffer | null {
  const candidates: string[] = [];
  if (relPathHint) candidates.push(relPathHint);
  if (blob?.rel_path) candidates.push(blob.rel_path);
  if (blob?.sha256) {
    const prefix = blob.sha256.slice(0, 2);
    if (blob.ext) candidates.push(path.posix.join('blobs', prefix, `${blob.sha256}${blob.ext}`));
    candidates.push(path.posix.join('blobs', prefix, blob.sha256));
  }

  for (const rel of candidates) {
    const abs = path.resolve(rootDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return fs.readFileSync(abs);
    }
  }

  // Scan blobs/<prefix2>/ for matching sha256 prefix
  const sha = blob?.sha256;
  if (sha) {
    const bucketDir = path.join(rootDir, 'blobs', sha.slice(0, 2));
    if (fs.existsSync(bucketDir)) {
      for (const fname of fs.readdirSync(bucketDir)) {
        if (fname.startsWith(sha)) {
          return fs.readFileSync(path.join(bucketDir, fname));
        }
      }
    }
  }
  return null;
}

function findBlobBytesInZip(
  archive: ZipArchive,
  basePrefix: string,
  blob: BlobAsset | undefined,
  relPathHint: string | null
): Buffer | null {
  const joinZip = (pRel: string) =>
    basePrefix ? `${basePrefix.replace(/\/+$/, '')}/${pRel.replace(/^\/+/, '')}` : pRel.replace(/^\/+/, '');

  const candidates: string[] = [];
  if (relPathHint) candidates.push(joinZip(relPathHint));
  if (blob?.rel_path) candidates.push(joinZip(blob.rel_path));
  if (blob?.sha256 && blob.ext) {
    candidates.push(joinZip(`blobs/${blob.sha256.slice(0, 2)}/${blob.sha256}${blob.ext}`));
  }

  for (const cand of candidates) {
    if (archive.getEntry(cand)) {
      return archive.readEntry(cand);
    }
  }

  if (blob?.sha256) {
    const needle = `blobs/${blob.sha256.slice(0, 2)}/${blob.sha256}`;
    for (const ent of archive.listEntries()) {
      if (!ent.isDirectory && ent.name.includes(needle)) {
        return archive.readEntry(ent.name);
      }
    }
  }
  return null;
}

export class SmNativeAdapter implements Adapter<SmNativeDocumentPayload> {
  readonly id: ProviderId = 'sm-native';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    if (src.kind === 'dir') {
      const manifestPath = path.join(src.path, 'native-manifest.json');
      if (!fs.existsSync(manifestPath)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Partial<NativeArchiveManifest>;
        if (parsed.format === 'native-slice') {
          return {
            adapterId: this.id,
            version: parsed.archive_version ?? '1.0.0',
            confidence: 0.99,
            evidence: [`Found SessionManager native-slice manifest (${parsed.conversation_count ?? '?'} conversation(s))`],
            entries: [manifestPath],
            warnings: [],
          };
        }
      } catch {
        return null;
      }
    } else if (src.kind === 'file') {
      const base = path.basename(src.path).toLowerCase();
      if (base === 'native-manifest.json') {
        try {
          const parsed = JSON.parse(fs.readFileSync(src.path, 'utf8')) as Partial<NativeArchiveManifest>;
          if (parsed.format === 'native-slice') {
            return {
              adapterId: this.id,
              version: parsed.archive_version ?? '1.0.0',
              confidence: 0.99,
              evidence: ['Matched native-manifest.json with native-slice format'],
              entries: [src.path],
              warnings: [],
            };
          }
        } catch {
          return null;
        }
      } else if (base.endsWith('.zip')) {
        let archive: ZipArchive | null = null;
        try {
          archive = ZipArchive.open(src.path);
          const manifestEntry = archive
            .listEntries()
            .find((e) => !e.isDirectory && path.posix.basename(e.name) === 'native-manifest.json');
          if (!manifestEntry) return null;
          const parsed = JSON.parse(archive.readEntryText(manifestEntry.name)) as Partial<NativeArchiveManifest>;
          if (parsed.format === 'native-slice') {
            return {
              adapterId: this.id,
              version: parsed.archive_version ?? '1.0.0',
              confidence: 0.99,
              evidence: [`Found SessionManager native-slice manifest inside ZIP (${manifestEntry.name})`],
              entries: [`${src.path}::zip::${manifestEntry.name}`],
              warnings: [],
            };
          }
        } catch {
          return null;
        } finally {
          archive?.close();
        }
      }
    }

    return null;
  }

  async *plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask> {
    for (const entry of probe.entries) {
      let size = 0;
      const diskPath = entry.includes('::zip::') ? entry.split('::zip::')[0]! : entry;
      try {
        size = fs.statSync(diskPath).size;
      } catch {
        // ignore
      }
      yield {
        id: sha256Hex(`${src.path}#${entry}#0`),
        src,
        entry,
        estimatedBytes: size,
      };
    }
  }

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<SmNativeDocumentPayload>[]> {
    const entry = task.entry ?? task.src.path;
    const isZip = entry.includes('::zip::');

    let archive: ZipArchive | null = null;
    try {
      let manifest: NativeArchiveManifest;
      let sessions: NativeSessionExportRecord[] = [];
      let rootDir = '';
      let zipPrefix = '';

      if (isZip) {
        const [zipPath, manifestEntryName] = entry.split('::zip::') as [string, string];
        archive = ZipArchive.open(zipPath);
        zipPrefix = path.posix.dirname(manifestEntryName);
        if (zipPrefix === '.') zipPrefix = '';

        manifest = JSON.parse(archive.readEntryText(manifestEntryName)) as NativeArchiveManifest;
        const sessionsEntry = zipPrefix ? `${zipPrefix}/sessions.json` : 'sessions.json';
        const convJsonlEntry = zipPrefix
          ? `${zipPrefix}/${manifest.conversations_file || 'conversations.jsonl'}`
          : manifest.conversations_file || 'conversations.jsonl';

        if (archive.getEntry(sessionsEntry)) {
          sessions = JSON.parse(archive.readEntryText(sessionsEntry)) as NativeSessionExportRecord[];
        } else if (archive.getEntry(convJsonlEntry)) {
          for (const line of iterJsonLines(archive.readEntry(convJsonlEntry))) {
            sessions.push(JSON.parse(line) as ConversationViewModel);
          }
        }
      } else {
        rootDir = path.dirname(entry);
        manifest = JSON.parse(fs.readFileSync(entry, 'utf8')) as NativeArchiveManifest;
        const sessionsPath = path.join(rootDir, 'sessions.json');
        const convJsonlPath = path.join(rootDir, manifest.conversations_file || 'conversations.jsonl');

        if (fs.existsSync(sessionsPath)) {
          sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8')) as NativeSessionExportRecord[];
        } else if (fs.existsSync(convJsonlPath)) {
          for (const line of iterJsonLines(fs.readFileSync(convJsonlPath))) {
            sessions.push(JSON.parse(line) as ConversationViewModel);
          }
        }
      }

      const docs: SessionDocument<SmNativeDocumentPayload>[] = [];

      for (const rec of sessions) {
        const parseIssues: IntegrityIssue[] = [];
        const restoredBlobs: BlobAsset[] = [];

        // Restore raw native_session slice JSON if present
        let rawSliceJson: string | null = null;
        const rawHint =
          rec.raw_blob_rel_path ??
          (rec.raw_blob_sha256
            ? `blobs/${rec.raw_blob_sha256.slice(0, 2)}/${rec.raw_blob_sha256}.json`
            : null);

        const rawBuf = archive
          ? findBlobBytesInZip(archive, zipPrefix, undefined, rawHint)
          : findBlobBytesInDir(rootDir, undefined, rawHint);
        if (rawBuf) {
          rawSliceJson = rawBuf.toString('utf8');
        }

        // Re-ingest non-native_session blobs via ctx.spill() -> BlobStore
        for (const asset of rec.blobs ?? []) {
          if (asset.origin_kind === 'native_session') continue;
          const bytes = archive
            ? findBlobBytesInZip(archive, zipPrefix, asset, asset.rel_path)
            : findBlobBytesInDir(rootDir, asset, asset.rel_path);

          if (!bytes) {
            parseIssues.push({
              code: 'orphan_blob_ref',
              severity: 'warn',
              message: `Missing blob in native package: ${asset.rel_path} (${asset.sha256})`,
              conversation_external_id: rec.meta.external_id ?? null,
            });
            continue;
          }

          const sourceExt = asset.ext ?? path.posix.extname(asset.rel_path);
          const ext = /^\.[a-z0-9_-]+$/i.test(sourceExt) ? sourceExt : '.bin';
          const spilledSha = await ctx.spill(bytes, {
            mime: asset.mime,
            ext,
            originKind: asset.origin_kind,
          });
          restoredBlobs.push({
            ...asset,
            sha256: spilledSha,
            ext,
            rel_path: `blobs/${spilledSha.slice(0, 2)}/${spilledSha}${ext}`,
          });
        }

        docs.push(
          new SmNativeSessionDocument(
            { manifest, session: rec, rawSliceJson },
            restoredBlobs,
            parseIssues
          )
        );
      }

      return docs;
    } finally {
      archive?.close();
    }
  }
}

export const smNativeAdapter = new SmNativeAdapter();
