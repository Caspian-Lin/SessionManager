import fs from 'node:fs';
import path from 'node:path';
import {
  createZipBuffer,
  type BlobAsset,
  type BlobOriginKind,
  type ConversationViewModel,
  type ProviderId,
} from '@sm/shared';
import type { BlobRow, BlobStore, ConversationRow } from '@sm/store';
import type { ArchiveService } from './archive-service.js';
import { exportNativeManifest } from './exporter.js';
import { rowToViewModel } from './pipeline.js';

export interface ProviderRawExportEntry {
  relPath: string;
  content: Buffer | string;
}

export interface ProviderRawExportContext {
  conversation: ConversationRow;
  view: ConversationViewModel;
  nativeJson: string | null;
  blobStore: BlobStore;
  getBlobRow(sha256: string): BlobRow | null;
}

export interface ProviderRawExportReportItem {
  conversationId: number;
  provider: string;
  externalId: string | null;
  title: string | null;
  status: 'exported' | 'degraded' | 'skipped';
  reason?: string;
  files: string[];
}

export interface ProviderRawGroupResult {
  files: ProviderRawExportEntry[];
  items: ProviderRawExportReportItem[];
  fallbackContexts?: ProviderRawExportContext[];
}

export interface ProviderRawExporter {
  readonly provider: ProviderId | string;
  exportGroup(contexts: readonly ProviderRawExportContext[]): Promise<ProviderRawGroupResult>;
}

export type ProviderRawFallbackMode = 'skip' | 'native' | 'jsonl';

export interface ProviderRawExportOptions {
  provider?: string;
  conversationIds?: readonly number[];
  zip?: boolean;
  fallback?: ProviderRawFallbackMode;
  registry?: ProviderRawExporterRegistry;
}

export interface ProviderRawExportReport {
  ok: true;
  outPath: string;
  zip: boolean;
  fallback: ProviderRawFallbackMode;
  total: number;
  exported: number;
  degraded: number;
  skipped: number;
  filesWritten: number;
  items: ProviderRawExportReportItem[];
}

function sanitizeFilenameSegment(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'session';
}

function openAiAssetStem(ref: string): string {
  const cleaned = ref.replace(/^(file-service|sediment):\/\//i, '').trim();
  return path.posix.basename(cleaned.replace(/\\/g, '/')).replace(/\.[^.]+$/, '');
}

function extractOpenAiPointerKeys(nativeConv: Record<string, unknown>): Map<string, string> {
  // Maps asset pointer stem / normalized key -> original pointer stem filename
  const stems = new Map<string, string>();
  const mapping = nativeConv['mapping'] as Record<string, Record<string, unknown>> | undefined;
  if (!mapping || typeof mapping !== 'object') return stems;

  const registerRef = (rawRef: string) => {
    const cleaned = rawRef.replace(/^(file-service|sediment):\/\//i, '').trim();
    if (!cleaned) return;
    const base = path.posix.basename(cleaned);
    stems.set(base.toLowerCase(), openAiAssetStem(rawRef));
  };

  for (const node of Object.values(mapping)) {
    const msg = node?.['message'] as Record<string, unknown> | undefined;
    if (!msg) continue;
    const content = msg['content'] as Record<string, unknown> | undefined;
    const parts = Array.isArray(content?.['parts']) ? (content['parts'] as unknown[]) : [];
    for (const part of parts) {
      if (part && typeof part === 'object') {
        const pObj = part as Record<string, unknown>;
        if (typeof pObj['asset_pointer'] === 'string') registerRef(pObj['asset_pointer']);
      }
    }
    const metadata = msg['metadata'] as Record<string, unknown> | undefined;
    const attachments = Array.isArray(metadata?.['attachments']) ? (metadata['attachments'] as unknown[]) : [];
    for (const att of attachments) {
      if (att && typeof att === 'object') {
        const aObj = att as Record<string, unknown>;
        for (const k of ['url', 'id', 'file_id', 'file_token', 'name']) {
          if (typeof aObj[k] === 'string') registerRef(aObj[k] as string);
        }
      }
    }
  }
  return stems;
}

export class OpenAiRawExporter implements ProviderRawExporter {
  readonly provider = 'openai-web';

  async exportGroup(contexts: readonly ProviderRawExportContext[]): Promise<ProviderRawGroupResult> {
    const files: ProviderRawExportEntry[] = [];
    const items: ProviderRawExportReportItem[] = [];
    const fallbackContexts: ProviderRawExportContext[] = [];
    const conversationsJson: unknown[] = [];
    const emittedAssetPaths = new Set<string>();

    for (const ctx of contexts) {
      if (!ctx.nativeJson) {
        fallbackContexts.push(ctx);
        items.push({
          conversationId: ctx.conversation.id,
          provider: ctx.conversation.provider,
          externalId: ctx.conversation.external_id,
          title: ctx.conversation.title,
          status: 'skipped',
          reason: 'missing raw_blob_sha256 native_session slice',
          files: [],
        });
        continue;
      }

      let nativeObj: Record<string, unknown>;
      try {
        nativeObj = JSON.parse(ctx.nativeJson) as Record<string, unknown>;
      } catch {
        fallbackContexts.push(ctx);
        items.push({
          conversationId: ctx.conversation.id,
          provider: ctx.conversation.provider,
          externalId: ctx.conversation.external_id,
          title: ctx.conversation.title,
          status: 'skipped',
          reason: 'corrupt native_session JSON payload',
          files: [],
        });
        continue;
      }

      conversationsJson.push(nativeObj);
      const itemFiles = ['openai-web/conversations.json'];
      const pointerStems = extractOpenAiPointerKeys(nativeObj);

      // Export referenced binary attachments so OpenAiWebAdapter can resolve them on re-import
      const mediaBlobs = ctx.view.blobs.filter(
        (b) => b.origin_kind !== 'native_session' && b.origin_kind !== 'oversized_payload'
      );
      let missingAsset = false;

      const stemsBySha = new Map<string, Set<string>>();
      for (const node of ctx.view.nodes) {
        for (const block of node.blocks) {
          if (!block.blob_sha256) continue;
          const ref = ['asset_pointer', 'attachment_id', 'url', 'name']
            .map((key) => block.meta?.[key])
            .find((value): value is string => typeof value === 'string' && value.trim() !== '');
          if (!ref) continue;
          const stem = openAiAssetStem(ref);
          if (!stem) continue;
          const stems = stemsBySha.get(block.blob_sha256) ?? new Set<string>();
          stems.add(stem);
          stemsBySha.set(block.blob_sha256, stems);
        }
      }

      for (const blob of mediaBlobs) {
        const blobRow = ctx.getBlobRow(blob.sha256);
        const absPath = ctx.blobStore.getBlobAbsPath(blobRow?.rel_path ?? blob.rel_path);
        if (!fs.existsSync(absPath)) {
          missingAsset = true;
          continue;
        }
        const ext = blob.ext ?? blobRow?.ext ?? '.bin';
        const stems = stemsBySha.get(blob.sha256) ?? [pointerStems.values().next().value ?? blob.sha256];
        const bytes = fs.readFileSync(absPath);
        for (const stem of stems) {
          const filename = stem.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
          const assetRel = `openai-web/${filename}${ext}`;
          if (!emittedAssetPaths.has(assetRel)) {
            emittedAssetPaths.add(assetRel);
            files.push({ relPath: assetRel, content: bytes });
          }
          itemFiles.push(assetRel);
        }
      }

      items.push({
        conversationId: ctx.conversation.id,
        provider: ctx.conversation.provider,
        externalId: ctx.conversation.external_id,
        title: ctx.conversation.title,
        status: missingAsset ? 'degraded' : 'exported',
        ...(missingAsset ? { reason: 'one or more media blobs missing on disk' } : {}),
        files: itemFiles,
      });
    }

    if (conversationsJson.length > 0) {
      files.unshift({
        relPath: 'openai-web/conversations.json',
        content: JSON.stringify(conversationsJson, null, 2),
      });
    }

    return { files, items, fallbackContexts };
  }
}

export class CodexRawExporter implements ProviderRawExporter {
  readonly provider = 'codex-local';

  async exportGroup(contexts: readonly ProviderRawExportContext[]): Promise<ProviderRawGroupResult> {
    const files: ProviderRawExportEntry[] = [];
    const items: ProviderRawExportReportItem[] = [];
    const fallbackContexts: ProviderRawExportContext[] = [];

    for (const ctx of contexts) {
      const safeId = sanitizeFilenameSegment(
        ctx.conversation.external_id ?? `conv-${ctx.conversation.id}`
      );
      const relPath = `codex-local/sessions/rollout-${safeId}.jsonl`;

      if (!ctx.nativeJson) {
        fallbackContexts.push(ctx);
        items.push({
          conversationId: ctx.conversation.id,
          provider: ctx.conversation.provider,
          externalId: ctx.conversation.external_id,
          title: ctx.conversation.title,
          status: 'skipped',
          reason: 'missing raw_blob_sha256 native_session slice',
          files: [],
        });
        continue;
      }

      let nativeSession: {
        session_id?: string;
        title?: string | null;
        cwd?: string | null;
        originator?: string | null;
        cli_version?: string | null;
        model_provider?: string | null;
        records?: Array<{ timestamp?: string; ordinal?: number; type?: string; payload?: Record<string, unknown> }>;
      };
      try {
        nativeSession = JSON.parse(ctx.nativeJson) as typeof nativeSession;
      } catch {
        fallbackContexts.push(ctx);
        items.push({
          conversationId: ctx.conversation.id,
          provider: ctx.conversation.provider,
          externalId: ctx.conversation.external_id,
          title: ctx.conversation.title,
          status: 'skipped',
          reason: 'corrupt Codex native_session JSON payload',
          files: [],
        });
        continue;
      }

      const records = Array.isArray(nativeSession.records) ? nativeSession.records : [];
      const lines: string[] = [];
      let hasMeta = false;

      for (const r of records) {
        if (r?.type === 'session_meta') hasMeta = true;
        lines.push(JSON.stringify(r));
      }

      let degraded = false;
      if (!hasMeta) {
        const metaLine = JSON.stringify({
          timestamp: ctx.conversation.created_at
            ? new Date(ctx.conversation.created_at).toISOString()
            : new Date().toISOString(),
          ordinal: 0,
          type: 'session_meta',
          payload: {
            id: nativeSession.session_id ?? ctx.conversation.external_id ?? safeId,
            cwd: nativeSession.cwd ?? ctx.conversation.cwd ?? undefined,
            title: nativeSession.title ?? ctx.conversation.title ?? undefined,
            originator: nativeSession.originator ?? 'codex_cli_rs',
            cli_version: nativeSession.cli_version ?? undefined,
            model_provider: nativeSession.model_provider ?? undefined,
          },
        });
        lines.unshift(metaLine);
      }

      // If sqlite-only session had no rollout records, reconstruct response_item lines from view nodes
      if (records.length === 0 && ctx.view.nodes.length > 0) {
        degraded = true;
        let ord = 1;
        for (const node of ctx.view.nodes) {
          if (node.kind === 'turn_context') continue;
          const iso = node.created_at ? new Date(node.created_at).toISOString() : undefined;
          lines.push(
            JSON.stringify({
              timestamp: iso,
              ordinal: ord++,
              type: 'response_item',
              payload: {
                id: node.external_id,
                type: 'message',
                role: node.role === 'tool' ? 'assistant' : node.role,
                content: [{ type: node.role === 'user' ? 'input_text' : 'output_text', text: node.text }],
              },
            })
          );
        }
      }

      files.push({
        relPath,
        content: lines.length > 0 ? lines.join('\n') + '\n' : '',
      });

      items.push({
        conversationId: ctx.conversation.id,
        provider: ctx.conversation.provider,
        externalId: ctx.conversation.external_id,
        title: ctx.conversation.title,
        status: degraded ? 'degraded' : 'exported',
        ...(degraded ? { reason: 'sqlite-only thread reconstructed into rollout JSONL' } : {}),
        files: [relPath],
      });
    }

    return { files, items, fallbackContexts };
  }
}

export class DeepSeekRawExporter implements ProviderRawExporter {
  readonly provider = 'deepseek-web';

  async exportGroup(contexts: readonly ProviderRawExportContext[]): Promise<ProviderRawGroupResult> {
    const files: ProviderRawExportEntry[] = [];
    const items: ProviderRawExportReportItem[] = [];
    const fallbackContexts: ProviderRawExportContext[] = [];
    const convs: unknown[] = [];

    for (const ctx of contexts) {
      if (!ctx.nativeJson) {
        fallbackContexts.push(ctx);
        items.push({
          conversationId: ctx.conversation.id,
          provider: ctx.conversation.provider,
          externalId: ctx.conversation.external_id,
          title: ctx.conversation.title,
          status: 'skipped',
          reason: 'missing raw_blob_sha256 native_session slice',
          files: [],
        });
        continue;
      }
      convs.push(JSON.parse(ctx.nativeJson));
      items.push({
        conversationId: ctx.conversation.id,
        provider: ctx.conversation.provider,
        externalId: ctx.conversation.external_id,
        title: ctx.conversation.title,
        status: 'exported',
        files: ['deepseek-web/conversations.json'],
      });
    }

    if (convs.length > 0) {
      files.push({
        relPath: 'deepseek-web/conversations.json',
        content: JSON.stringify(convs, null, 2),
      });
    }
    return { files, items, fallbackContexts };
  }
}

export class ClaudeCodeRawExporter implements ProviderRawExporter {
  readonly provider = 'claude-code-local';

  async exportGroup(contexts: readonly ProviderRawExportContext[]): Promise<ProviderRawGroupResult> {
    const files: ProviderRawExportEntry[] = [];
    const items: ProviderRawExportReportItem[] = [];
    const fallbackContexts: ProviderRawExportContext[] = [];

    for (const ctx of contexts) {
      if (!ctx.nativeJson) {
        fallbackContexts.push(ctx);
        items.push({
          conversationId: ctx.conversation.id,
          provider: ctx.conversation.provider,
          externalId: ctx.conversation.external_id,
          title: ctx.conversation.title,
          status: 'skipped',
          reason: 'missing raw_blob_sha256 native_session slice',
          files: [],
        });
        continue;
      }
      const parsed = JSON.parse(ctx.nativeJson) as { records?: unknown[]; session_id?: string };
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      const safeId = sanitizeFilenameSegment(
        parsed.session_id ?? ctx.conversation.external_id ?? `cc-${ctx.conversation.id}`
      );
      const relPath = `claude-code-local/${safeId}.jsonl`;
      files.push({
        relPath,
        content: records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''),
      });
      items.push({
        conversationId: ctx.conversation.id,
        provider: ctx.conversation.provider,
        externalId: ctx.conversation.external_id,
        title: ctx.conversation.title,
        status: 'exported',
        files: [relPath],
      });
    }

    return { files, items, fallbackContexts };
  }
}

export class ProviderRawExporterRegistry {
  private readonly exporters = new Map<string, ProviderRawExporter>();

  constructor(registerDefaults = true) {
    if (registerDefaults) {
      this.register(new OpenAiRawExporter());
      this.register(new CodexRawExporter());
      this.register(new DeepSeekRawExporter());
      this.register(new ClaudeCodeRawExporter());
    }
  }

  register(exporter: ProviderRawExporter): void {
    this.exporters.set(exporter.provider, exporter);
  }

  get(provider: string): ProviderRawExporter | undefined {
    return this.exporters.get(provider);
  }
}

export const defaultProviderRawExporterRegistry = new ProviderRawExporterRegistry();

export async function exportProviderRawArchive(
  service: ArchiveService,
  outTarget: string,
  options: ProviderRawExportOptions = {}
): Promise<ProviderRawExportReport> {
  const registry = options.registry ?? defaultProviderRawExporterRegistry;
  const fallback: ProviderRawFallbackMode = options.fallback ?? 'skip';
  const asZip = Boolean(options.zip || outTarget.toLowerCase().endsWith('.zip'));

  const conversations = options.conversationIds?.length
    ? options.conversationIds
        .map((id) => service.repository.getConversationById(id))
        .filter((c): c is ConversationRow => Boolean(c))
    : service.listConversations({ provider: options.provider, limit: 100000 });

  const grouped = new Map<string, ProviderRawExportContext[]>();
  for (const conv of conversations) {
    const dbItems = service.repository.getConversationItems(conv.id, false);
    const blobsBySha = new Map<string, BlobRow>();
    const allBlobRows = service.db
      .prepare(
        `SELECT * FROM blob WHERE sha256 IN (
           SELECT raw_blob_sha256 FROM conversation WHERE id = ? AND raw_blob_sha256 IS NOT NULL
           UNION
           SELECT payload_ref FROM item WHERE conversation_id = ? AND payload_ref IS NOT NULL
         )`
      )
      .all(conv.id, conv.id) as unknown as BlobRow[];
    for (const br of allBlobRows) blobsBySha.set(br.sha256, br);

    for (const it of dbItems) {
      if (!it.blocks_json) continue;
      try {
        const blocks = JSON.parse(it.blocks_json) as Array<{ blob_sha256?: string | null }>;
        for (const b of blocks) {
          if (b?.blob_sha256 && !blobsBySha.has(b.blob_sha256)) {
            const br = service.repository.getBlobBySha256(b.blob_sha256);
            if (br) blobsBySha.set(br.sha256, br);
          }
        }
      } catch {
        // ignore
      }
    }

    const baseView = rowToViewModel(service.repository, conv);
    const viewBlobs: BlobAsset[] = [...blobsBySha.values()].map((br) => ({
      sha256: br.sha256,
      mime: br.mime,
      bytes: br.bytes,
      ext: br.ext,
      width: br.width,
      height: br.height,
      duration_ms: br.duration_ms,
      rel_path: br.rel_path,
      origin_kind: br.origin_kind as BlobOriginKind,
      created_at: br.created_at,
    }));
    const view: ConversationViewModel = { ...baseView, blobs: viewBlobs };
    let nativeJson: string | null = null;
    if (conv.raw_blob_sha256) {
      const nativeRow = blobsBySha.get(conv.raw_blob_sha256) ?? service.repository.getBlobBySha256(conv.raw_blob_sha256);
      if (nativeRow) {
        const abs = service.blobStore.getBlobAbsPath(nativeRow.rel_path);
        if (fs.existsSync(abs)) {
          nativeJson = fs.readFileSync(abs, 'utf8');
        }
      }
    }

    const list = grouped.get(conv.provider) ?? [];
    list.push({
      conversation: conv,
      view,
      nativeJson,
      blobStore: service.blobStore,
      getBlobRow: (sha) => blobsBySha.get(sha) ?? service.repository.getBlobBySha256(sha),
    });
    grouped.set(conv.provider, list);
  }

  const allFiles: ProviderRawExportEntry[] = [];
  const reportItems: ProviderRawExportReportItem[] = [];
  const fallbackPool: ProviderRawExportContext[] = [];

  for (const [provider, contexts] of grouped.entries()) {
    const exporter = registry.get(provider);
    if (!exporter) {
      for (const ctx of contexts) {
        fallbackPool.push(ctx);
        reportItems.push({
          conversationId: ctx.conversation.id,
          provider: ctx.conversation.provider,
          externalId: ctx.conversation.external_id,
          title: ctx.conversation.title,
          status: 'skipped',
          reason: `no ProviderRawExporter registered for provider "${provider}"`,
          files: [],
        });
      }
      continue;
    }

    const groupResult = await exporter.exportGroup(contexts);
    allFiles.push(...groupResult.files);
    reportItems.push(...groupResult.items);
    if (groupResult.fallbackContexts) {
      fallbackPool.push(...groupResult.fallbackContexts);
    }
  }

  if (fallbackPool.length > 0 && fallback !== 'skip') {
    const fbIds = new Set(fallbackPool.map((c) => c.conversation.id));
    if (fallback === 'jsonl') {
      const fbRel = '_fallback/conversations.jsonl';
      allFiles.push({
        relPath: fbRel,
        content: fallbackPool.map((c) => JSON.stringify(c.view)).join('\n') + '\n',
      });
      for (const item of reportItems) {
        if (fbIds.has(item.conversationId) && item.status === 'skipped') {
          item.status = 'degraded';
          item.reason = `${item.reason ?? 'unsupported'}; exported via jsonl fallback`;
          item.files.push(fbRel);
        }
      }
    } else if (fallback === 'native') {
      const fbBlobs = fallbackPool.flatMap((c) => c.view.blobs);
      const fbManifest = exportNativeManifest(
        fallbackPool.map((c) => c.view),
        fbBlobs,
        { generator: 'sm-provider-raw-fallback' }
      );
      allFiles.push({
        relPath: '_fallback/native-manifest.json',
        content: JSON.stringify(fbManifest, null, 2),
      });
      allFiles.push({
        relPath: '_fallback/sessions.json',
        content: JSON.stringify(fallbackPool.map((c) => c.view), null, 2),
      });
      for (const item of reportItems) {
        if (fbIds.has(item.conversationId) && item.status === 'skipped') {
          item.status = 'degraded';
          item.reason = `${item.reason ?? 'unsupported'}; exported via native fallback`;
          item.files.push('_fallback/native-manifest.json', '_fallback/sessions.json');
        }
      }
    }
  }

  const exportedCount = reportItems.filter((i) => i.status === 'exported').length;
  const degradedCount = reportItems.filter((i) => i.status === 'degraded').length;
  const skippedCount = reportItems.filter((i) => i.status === 'skipped').length;

  const summaryObj = {
    schema_version: '1.0.0',
    format: 'provider-raw',
    generated_at: Date.now(),
    fallback,
    total: reportItems.length,
    exported: exportedCount,
    degraded: degradedCount,
    skipped: skippedCount,
    items: reportItems,
  };
  allFiles.push({
    relPath: 'provider-raw-manifest.json',
    content: JSON.stringify(summaryObj, null, 2),
  });

  const resolvedOut = path.resolve(outTarget);
  if (asZip) {
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    const zipBuf = createZipBuffer(
      allFiles.map((f) => ({ name: f.relPath, data: f.content }))
    );
    fs.writeFileSync(resolvedOut, zipBuf);
  } else {
    fs.mkdirSync(resolvedOut, { recursive: true });
    for (const file of allFiles) {
      const dest = path.join(resolvedOut, file.relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.content);
    }
  }

  return {
    ok: true,
    outPath: resolvedOut,
    zip: asZip,
    fallback,
    total: reportItems.length,
    exported: exportedCount,
    degraded: degradedCount,
    skipped: skippedCount,
    filesWritten: allFiles.length,
    items: reportItems,
  };
}
