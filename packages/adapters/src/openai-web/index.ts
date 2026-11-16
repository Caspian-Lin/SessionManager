import fs from 'node:fs';
import path from 'node:path';
import {
  ZipArchive,
  extForMime,
  sha256Hex,
  sniffMimeFromBuffer,
  streamTopLevelJsonArray,
  type BlobAsset,
  type BlobOriginKind,
  type IntegrityIssue,
  type ProviderId,
  type SessionRole,
  type TurnKind,
  type ViewBlock,
  type ViewBlockType,
} from '@sm/shared';
import {
  BaseSessionDocument,
  partitionVendorFields,
  type Adapter,
  type ImportTask,
  type ParseCtx,
  type ProbeResult,
  type RawTurnProjection,
  type SessionDocument,
  type SourceRef,
} from '../contract.js';

export interface OpenAiNativeMessage {
  id?: string;
  author?: { role?: string; name?: string | null; metadata?: Record<string, unknown> };
  create_time?: number | null;
  update_time?: number | null;
  content?: {
    content_type?: string;
    parts?: unknown[];
    text?: string;
    thoughts?: unknown[];
    result?: string;
    title?: string;
    url?: string;
    user_profile?: string;
    user_instructions?: string;
    [key: string]: unknown;
  };
  status?: string;
  end_turn?: boolean;
  weight?: number;
  metadata?: Record<string, unknown>;
  recipient?: string;
  channel?: string | null;
  [key: string]: unknown;
}

export interface OpenAiNativeMappingNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: OpenAiNativeMessage | null;
}

export interface OpenAiNativeConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  current_node?: string;
  default_model_slug?: string;
  gizmo_id?: string;
  is_archived?: boolean;
  is_starred?: boolean;
  is_shared?: boolean;
  mapping?: Record<string, OpenAiNativeMappingNode>;
  [key: string]: unknown;
}

export interface OpenAiMemoryCandidate {
  field: 'about_user_message' | 'about_model_message';
  text: string;
  item_external_id: string;
}

const KNOWN_CONV_KEYS = [
  'id',
  'conversation_id',
  'title',
  'create_time',
  'update_time',
  'mapping',
  'current_node',
  'default_model_slug',
  'gizmo_id',
  'gizmo_type',
  'is_archived',
  'is_starred',
  'is_shared',
  'is_do_not_remember',
  'memory_scope',
  'moderation_results',
  'plugin_ids',
  'safe_urls',
  'conversation_template_id',
  'async_status',
  'voice',
] as const;

const KNOWN_MSG_KEYS = [
  'id',
  'author',
  'create_time',
  'update_time',
  'content',
  'status',
  'end_turn',
  'weight',
  'metadata',
  'recipient',
  'channel',
] as const;

const CONV_SHARD_RE = /(?:^|\/)conversations(?:-(\d+))?\.json$/i;
const ASSET_EXT_RE = /\.(?:dat|png|jpe?g|webp|gif|bmp|svg|mp4|webm|mov|mp3|wav|m4a|ogg|pdf)$/i;

const RUNTIME_NOISE_LINE_RES: readonly RegExp[] = [
  /^(?:user\s+timezone(?:\s+context(?:\s+update)?)?|timezone|user\s+location)\s*[:：]\s*.+$/i,
  /^(?:current\s+(?:time|date|datetime)|today'?s?\s+date|the\s+current\s+(?:date|time)\s+is|当前时间|当前日期)\s*[:：]?\s*.+$/i,
  /^\[\d{4}[-/]\d{2}[-/]\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\]$/,
  /^(?:model\s+knowledge\s+cutoff|knowledge\s+cutoff)\s*[:：].+$/i,
];

function isRuntimeNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return RUNTIME_NOISE_LINE_RES.some((re) => re.test(trimmed));
}

/**
 * Strips pure runtime timezone/date-only noise lines and returns null when
 * nothing substantive remains.
 */
function cleanMemoryCandidateText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const meaningfulLines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !isRuntimeNoiseLine(l));
  if (meaningfulLines.length === 0) return null;
  return meaningfulLines.join('\n');
}

function compareConversationEntries(a: string, b: string): number {
  const ma = CONV_SHARD_RE.exec(a);
  const mb = CONV_SHARD_RE.exec(b);
  const na = ma?.[1] ? Number.parseInt(ma[1], 10) : -1;
  const nb = mb?.[1] ? Number.parseInt(mb[1], 10) : -1;
  if (na !== nb) return na - nb;
  return a.localeCompare(b);
}

function normalizePointerKey(raw: string): string[] {
  const keys = new Set<string>();
  const trimmed = raw.trim();
  if (!trimmed) return [];
  keys.add(trimmed);

  const strippedScheme = trimmed.replace(/^(?:file-service|sediment):\/\//i, '');
  keys.add(strippedScheme);

  // Normalize file-xxx <-> file_xxx
  keys.add(strippedScheme.replace(/^file_/, 'file-'));
  keys.add(strippedScheme.replace(/^file-/, 'file_'));

  // Base name without extension
  const base = path.posix.basename(strippedScheme.replace(/\\/g, '/'));
  keys.add(base);
  const stem = base.replace(/\.[^.]+$/, '');
  if (stem) keys.add(stem);

  return [...keys].filter(Boolean);
}

interface AssetSourceEntry {
  entryName: string;
  readBytes: () => Buffer;
}

class AssetLocator {
  private readonly allAssets: AssetSourceEntry[] = [];
  private readonly byPathLower = new Map<string, AssetSourceEntry>();
  private readonly byBasenameLower = new Map<string, AssetSourceEntry>();
  private readonly byStemLower = new Map<string, AssetSourceEntry>();

  add(entryName: string, readBytes: () => Buffer): void {
    const normalized = entryName.replace(/\\/g, '/');
    const item: AssetSourceEntry = { entryName: normalized, readBytes };
    this.allAssets.push(item);
    this.byPathLower.set(normalized.toLowerCase(), item);

    const baseLower = path.posix.basename(normalized).toLowerCase();
    if (!this.byBasenameLower.has(baseLower)) {
      this.byBasenameLower.set(baseLower, item);
    }
    const stemLower = baseLower.replace(/\.[^.]+$/, '');
    if (stemLower && !this.byStemLower.has(stemLower)) {
      this.byStemLower.set(stemLower, item);
    }
  }

  find(pointerOrName: string): AssetSourceEntry | undefined {
    const candidates = normalizePointerKey(pointerOrName);
    for (const c of candidates) {
      const exactPath = this.byPathLower.get(c.replace(/\\/g, '/').toLowerCase());
      if (exactPath) return exactPath;
    }
    for (const c of candidates) {
      const lower = c.toLowerCase();
      const exactBase = this.byBasenameLower.get(lower);
      if (exactBase) return exactBase;
      const exactStem = this.byStemLower.get(lower);
      if (exactStem) return exactStem;
    }

    // Exported asset names can include a provider file ID followed by a suffix.
    for (const c of candidates) {
      const lower = c.toLowerCase();
      if (!/^file[-_].{4}/.test(lower)) continue;
      for (const item of this.allAssets) {
        const base = path.posix.basename(item.entryName).toLowerCase();
        if (
          base.startsWith(`${lower}.`) ||
          base.startsWith(`${lower}-`) ||
          base.startsWith(`${lower}_`)
        ) {
          return item;
        }
      }
    }

    return undefined;
  }
}

function collectDirAssets(rootDir: string, locator: AssetLocator, maxDepth = 4): void {
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        walk(full, depth + 1);
      } else if (item.isFile() && !CONV_SHARD_RE.test(item.name)) {
        const rel = path.relative(rootDir, full).replace(/\\/g, '/');
        locator.add(rel, () => fs.readFileSync(full));
      }
    }
  };
  walk(rootDir, 0);
}

function collectNodeAssetRefs(
  conv: OpenAiNativeConversation
): { ref: string; width?: number | null; height?: number | null; preferredMime?: string | null }[] {
  const refs: { ref: string; width?: number | null; height?: number | null; preferredMime?: string | null }[] = [];
  const mapping = conv.mapping ?? {};
  for (const node of Object.values(mapping)) {
    const msg = node?.message;
    if (!msg || typeof msg !== 'object') continue;

    const parts = Array.isArray(msg.content?.parts) ? msg.content.parts : [];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const pObj = part as Record<string, unknown>;
      if (typeof pObj['asset_pointer'] === 'string') {
        refs.push({
          ref: pObj['asset_pointer'],
          width: typeof pObj['width'] === 'number' ? pObj['width'] : null,
          height: typeof pObj['height'] === 'number' ? pObj['height'] : null,
        });
      }
    }

    const attachments = Array.isArray(msg.metadata?.['attachments'])
      ? (msg.metadata['attachments'] as unknown[])
      : [];
    for (const att of attachments) {
      if (!att || typeof att !== 'object') continue;
      const aObj = att as Record<string, unknown>;
      const preferredMime =
        typeof aObj['mimeType'] === 'string'
          ? aObj['mimeType']
          : typeof aObj['mime_type'] === 'string'
            ? aObj['mime_type']
            : null;
      for (const key of ['url', 'id', 'file_id', 'file_token', 'name']) {
        const val = aObj[key];
        if (typeof val === 'string' && val.trim().length > 0) {
          refs.push({ ref: val.trim(), preferredMime });
        }
      }
    }
  }
  return refs;
}

export class OpenAiSessionDocument extends BaseSessionDocument<OpenAiNativeConversation> {
  private readonly assetBlobByRef: ReadonlyMap<string, BlobAsset>;
  private cachedMemoryCandidates?: OpenAiMemoryCandidate[];

  constructor(
    nativeData: OpenAiNativeConversation,
    parseIssues: IntegrityIssue[] = [],
    blobs: BlobAsset[] = [],
    assetBlobByRef: ReadonlyMap<string, BlobAsset> = new Map()
  ) {
    const extId =
      typeof nativeData.conversation_id === 'string'
        ? nativeData.conversation_id
        : typeof nativeData.id === 'string'
          ? nativeData.id
          : null;

    const createdAt = typeof nativeData.create_time === 'number' ? Math.round(nativeData.create_time * 1000) : null;
    const updatedAt = typeof nativeData.update_time === 'number' ? Math.round(nativeData.update_time * 1000) : null;
    const title = typeof nativeData.title === 'string' ? nativeData.title.trim() : null;
    const defaultModel = typeof nativeData.default_model_slug === 'string' ? nativeData.default_model_slug : null;

    super({
      provider: 'openai-web',
      rawFormat: 'openai-web/v2',
      nativeData,
      external_id: extId,
      title: title || null,
      title_source: title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      default_model: defaultModel,
      blobs,
      parseIssues,
    });
    this.assetBlobByRef = assetBlobByRef;
  }

  getMemoryCandidates(): OpenAiMemoryCandidate[] {
    if (!this.cachedMemoryCandidates) {
      this.ensureMemoryCandidatesComputed();
    }
    return [...(this.cachedMemoryCandidates ?? [])];
  }

  private ensureMemoryCandidatesComputed(): void {
    this.validate();
  }

  protected override validateProviderSpecific(): IntegrityIssue[] {
    const issues: IntegrityIssue[] = [];
    const mapping = this.nativeData.mapping ?? {};
    const currentNode = this.nativeData.current_node;
    const convId = this.init.external_id;

    if (currentNode && !mapping[currentNode]) {
      issues.push({
        code: 'orphan_node',
        severity: 'warn',
        message: `OpenAI current_node "${currentNode}" is missing from mapping graph`,
        conversation_external_id: convId,
        item_external_id: currentNode,
      });
    }
    return issues;
  }

  private resolveBlobForKeys(candidates: (string | undefined | null)[]): BlobAsset | undefined {
    for (const c of candidates) {
      if (!c) continue;
      for (const k of normalizePointerKey(c)) {
        const hit = this.assetBlobByRef.get(k);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  protected projectTurns(): RawTurnProjection[] {
    const mapping = this.nativeData.mapping ?? {};
    const currentNode = typeof this.nativeData.current_node === 'string' ? this.nativeData.current_node : null;
    const defaultModel = this.init.default_model ?? null;
    const createdAt = this.init.created_at ?? null;
    const memoryCandidates: OpenAiMemoryCandidate[] = [];

    // Trace active branch from current_node up to root
    const activeBranchNodeIds = new Set<string>();
    const visited = new Set<string>();
    let tracer: string | null = currentNode;
    while (tracer && mapping[tracer] && !visited.has(tracer)) {
      visited.add(tracer);
      activeBranchNodeIds.add(tracer);
      const parent = mapping[tracer]?.parent;
      tracer = typeof parent === 'string' ? parent : null;
    }

    const turns: RawTurnProjection[] = [];
    let ordinal = 0;

    for (const [nodeId, nodeObj] of Object.entries(mapping)) {
      if (!nodeObj || typeof nodeObj !== 'object') continue;
      const msgObj = nodeObj.message;
      if (!msgObj || typeof msgObj !== 'object') {
        continue;
      }

      // Skip structural message-less placeholder nodes when resolving parent_external_id,
      // while preserving genuinely missing parent IDs so BaseSessionDocument flags true orphans.
      let parentId: string | null = typeof nodeObj.parent === 'string' ? nodeObj.parent : null;
      const parentVisited = new Set<string>([nodeId]);
      while (parentId && mapping[parentId] && !mapping[parentId]!.message && !parentVisited.has(parentId)) {
        parentVisited.add(parentId);
        const nextParent = mapping[parentId]!.parent;
        parentId = typeof nextParent === 'string' ? nextParent : null;
      }
      const rawRole = typeof msgObj.author?.role === 'string' ? msgObj.author.role.toLowerCase() : 'user';

      let role: SessionRole = 'user';
      if (rawRole === 'assistant') role = 'assistant';
      else if (rawRole === 'system') role = 'system';
      else if (rawRole === 'tool') role = 'tool';
      else if (rawRole === 'developer') role = 'developer';
      else if (rawRole === 'critic') role = 'assistant';

      const metadata = (msgObj.metadata ?? {}) as Record<string, unknown>;
      const isHidden = Boolean(metadata['is_visually_hidden_from_conversation']);
      let isSynthetic = Boolean(metadata['is_user_system_message']);
      const model = typeof metadata['model_slug'] === 'string' ? metadata['model_slug'] : defaultModel;
      const msgCreateTime = typeof msgObj.create_time === 'number' ? Math.round(msgObj.create_time * 1000) : createdAt;
      const recipient =
        typeof msgObj.recipient === 'string' && msgObj.recipient !== 'all' ? msgObj.recipient : null;

      const contentObj = msgObj.content ?? {};
      const contentType = typeof contentObj.content_type === 'string' ? contentObj.content_type : 'text';
      const parts = Array.isArray(contentObj.parts) ? contentObj.parts : [];

      const blocks: ViewBlock[] = [];
      let blockIdx = 0;
      const emittedAssetShas = new Set<string>();
      const emittedAssetKeys = new Set<string>();

      // Handle thoughts array in reasoning/thoughts content_type
      if ((contentType === 'thoughts' || contentType === 'reasoning_recap') && Array.isArray(contentObj.thoughts)) {
        for (const t of contentObj.thoughts) {
          if (typeof t === 'string' && t.trim().length > 0) {
            blocks.push({ idx: blockIdx++, type: 'thinking', text: t });
          } else if (t && typeof t === 'object') {
            const tObj = t as Record<string, unknown>;
            const txt =
              typeof tObj['content'] === 'string'
                ? tObj['content']
                : typeof tObj['summary'] === 'string'
                  ? tObj['summary']
                  : typeof tObj['text'] === 'string'
                    ? tObj['text']
                    : null;
            if (txt) {
              blocks.push({ idx: blockIdx++, type: 'thinking', text: txt });
            }
          }
        }
      }

      // Handle user_editable_context / model_editable_context custom profile/instructions
      if (contentType === 'user_editable_context' || contentType === 'model_editable_context') {
        isSynthetic = true;
        const userProfile = cleanMemoryCandidateText(contentObj['user_profile']);
        const userInstructions = cleanMemoryCandidateText(contentObj['user_instructions']);
        if (userProfile) {
          blocks.push({
            idx: blockIdx++,
            type: 'text',
            text: userProfile,
            meta: { memory_candidate: true, memory_kind: 'about_user_message', source: contentType },
          });
          memoryCandidates.push({
            field: 'about_user_message',
            text: userProfile,
            item_external_id: nodeId,
          });
        }
        if (userInstructions) {
          blocks.push({
            idx: blockIdx++,
            type: 'text',
            text: userInstructions,
            meta: { memory_candidate: true, memory_kind: 'about_model_message', source: contentType },
          });
          memoryCandidates.push({
            field: 'about_model_message',
            text: userInstructions,
            item_external_id: nodeId,
          });
        }
      }

      for (const part of parts) {
        if (typeof part === 'string') {
          let blockType: ViewBlockType = 'text';
          if (contentType === 'thoughts' || contentType === 'reasoning_recap') {
            blockType = 'thinking';
          } else if (contentType === 'code') {
            blockType = 'code';
          } else if (contentType === 'execution_output') {
            blockType = 'tool_result';
          } else if (contentType === 'tether_browsing_display' || contentType === 'tether_quote') {
            blockType = 'citation';
          } else if (contentType === 'canvas') {
            blockType = 'canvas';
          }

          blocks.push({
            idx: blockIdx++,
            type: blockType,
            text: part,
            tool_name: blockType === 'tool_result' || blockType === 'code' ? recipient : null,
          });
        } else if (part && typeof part === 'object') {
          const partObj = part as Record<string, unknown>;
          if (partObj['content_type'] === 'image_asset_pointer' || typeof partObj['asset_pointer'] === 'string') {
            const pointer = typeof partObj['asset_pointer'] === 'string' ? partObj['asset_pointer'] : null;
            const matchedBlob = this.resolveBlobForKeys([pointer]);
            if (matchedBlob) {
              emittedAssetShas.add(matchedBlob.sha256);
            }
            if (pointer) {
              for (const k of normalizePointerKey(pointer)) emittedAssetKeys.add(k.toLowerCase());
            }

            const blockType: ViewBlockType =
              partObj['content_type'] === 'audio_asset_pointer'
                ? 'audio'
                : partObj['content_type'] === 'video_asset_pointer'
                  ? 'video'
                  : 'image';

            blocks.push({
              idx: blockIdx++,
              type: blockType,
              text: null,
              blob_sha256: matchedBlob?.sha256 ?? null,
              availability: matchedBlob ? 'full' : 'missing_ref',
              meta: {
                asset_pointer: pointer,
                mime: matchedBlob?.mime ?? null,
                width: typeof partObj['width'] === 'number' ? partObj['width'] : matchedBlob?.width ?? null,
                height: typeof partObj['height'] === 'number' ? partObj['height'] : matchedBlob?.height ?? null,
              },
            });
          } else if (typeof partObj['text'] === 'string') {
            blocks.push({
              idx: blockIdx++,
              type: 'text',
              text: partObj['text'],
            });
          }
        }
      }

      if (blocks.length === 0 && typeof contentObj.text === 'string') {
        const blockType: ViewBlockType =
          contentType === 'code'
            ? 'code'
            : contentType === 'execution_output'
              ? 'tool_result'
              : contentType === 'canvas'
                ? 'canvas'
                : 'text';
        blocks.push({
          idx: blockIdx++,
          type: blockType,
          text: contentObj.text,
          tool_name: blockType === 'tool_result' || blockType === 'code' ? recipient : null,
        });
      }

      // Handle attachments metadata (avoiding duplicates already resolved by image_asset_pointer)
      const attachments = Array.isArray(metadata['attachments']) ? (metadata['attachments'] as unknown[]) : [];
      for (const att of attachments) {
        if (!att || typeof att !== 'object') continue;
        const aObj = att as Record<string, unknown>;
        const attId = typeof aObj['id'] === 'string' ? aObj['id'] : null;
        const attUrl = typeof aObj['url'] === 'string' ? aObj['url'] : null;
        const attName = typeof aObj['name'] === 'string' ? aObj['name'] : null;
        const attFileId = typeof aObj['file_id'] === 'string' ? aObj['file_id'] : null;
        const attToken = typeof aObj['file_token'] === 'string' ? aObj['file_token'] : null;

        const keyHits = [attId, attUrl, attFileId, attToken, attName]
          .filter((v): v is string => Boolean(v))
          .flatMap((v) => normalizePointerKey(v));
        if (keyHits.some((k) => emittedAssetKeys.has(k.toLowerCase()))) {
          continue;
        }

        const matchedBlob = this.resolveBlobForKeys([attUrl, attId, attFileId, attToken, attName]);
        if (matchedBlob && emittedAssetShas.has(matchedBlob.sha256)) {
          continue;
        }
        if (matchedBlob) {
          emittedAssetShas.add(matchedBlob.sha256);
        }

        const declaredMime = aObj['mimeType'] ?? aObj['mime_type'];
        const mime = matchedBlob?.mime === 'application/octet-stream' || !matchedBlob
          ? typeof declaredMime === 'string' ? declaredMime : null
          : matchedBlob.mime;
        const type: ViewBlockType = mime?.startsWith('image/') ? 'image'
          : mime?.startsWith('audio/') ? 'audio'
          : mime?.startsWith('video/') ? 'video' : 'file';

        blocks.push({
          idx: blockIdx++,
          type,
          text: attName,
          blob_sha256: matchedBlob?.sha256 ?? null,
          availability: matchedBlob ? 'full' : 'missing_ref',
          meta: {
            attachment_id: attId ?? attFileId ?? attToken,
            url: attUrl,
            name: attName,
            mime,
          },
        });
      }

      // Handle citations metadata
      const citations = Array.isArray(metadata['citations']) ? (metadata['citations'] as unknown[]) : [];
      for (const cit of citations) {
        if (!cit || typeof cit !== 'object') continue;
        const cObj = cit as Record<string, unknown>;
        const citMeta = (cObj['metadata'] as Record<string, unknown> | undefined) ?? cObj;
        const title = typeof citMeta['title'] === 'string' ? citMeta['title'] : null;
        const url = typeof citMeta['url'] === 'string' ? citMeta['url'] : null;
        const text = typeof citMeta['text'] === 'string' ? citMeta['text'] : title ?? url ?? null;
        if (text) {
          blocks.push({
            idx: blockIdx++,
            type: 'citation',
            text,
            meta: { title, url },
          });
        }
      }

      // Extract user_context_message_data memory candidates while ignoring runtime timezone/date noise
      const ucmd = metadata['user_context_message_data'];
      if (ucmd && typeof ucmd === 'object') {
        const ucmdObj = ucmd as Record<string, unknown>;
        isSynthetic = true;
        const aboutUser = cleanMemoryCandidateText(ucmdObj['about_user_message']);
        const aboutModel = cleanMemoryCandidateText(ucmdObj['about_model_message']);

        if (aboutUser) {
          blocks.push({
            idx: blockIdx++,
            type: 'text',
            text: aboutUser,
            meta: {
              memory_candidate: true,
              memory_kind: 'about_user_message',
              source: 'user_context_message_data',
            },
          });
          memoryCandidates.push({
            field: 'about_user_message',
            text: aboutUser,
            item_external_id: nodeId,
          });
        }
        if (aboutModel) {
          blocks.push({
            idx: blockIdx++,
            type: 'text',
            text: aboutModel,
            meta: {
              memory_candidate: true,
              memory_kind: 'about_model_message',
              source: 'user_context_message_data',
            },
          });
          memoryCandidates.push({
            field: 'about_model_message',
            text: aboutModel,
            item_external_id: nodeId,
          });
        }
      }

      const isActive = activeBranchNodeIds.size > 0 ? activeBranchNodeIds.has(nodeId) : true;
      const textProjection = blocks.map((b) => b.text ?? '').filter(Boolean).join('\n');

      let kind: TurnKind = 'message';
      if (contentType === 'execution_output') {
        kind = 'tool_result';
      } else if (
        contentType === 'user_editable_context' ||
        contentType === 'model_editable_context' ||
        (ucmd && typeof ucmd === 'object')
      ) {
        kind = 'system_note';
      } else if (contentType === 'thoughts' || contentType === 'reasoning_recap') {
        kind = 'reasoning';
      }

      turns.push({
        external_id: nodeId,
        parent_external_id: parentId,
        ordinal: ordinal++,
        role,
        kind,
        created_at: msgCreateTime,
        model,
        text: textProjection,
        is_active_branch: isActive,
        is_hidden: isHidden,
        is_synthetic: isSynthetic,
        blocks,
      });
    }

    this.cachedMemoryCandidates = memoryCandidates;
    return turns;
  }
}

export class OpenAiWebAdapter implements Adapter<OpenAiNativeConversation> {
  readonly id: ProviderId = 'openai-web';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const evidence: string[] = [];
    const entries: string[] = [];
    const warnings: string[] = [];
    let confidence = 0;

    if (src.kind === 'file') {
      const base = path.basename(src.path).toLowerCase();
      if (base.endsWith('.zip')) {
        let zip: ZipArchive | null = null;
        try {
          zip = ZipArchive.open(src.path);
          const allEntries = zip.listEntries().filter((e) => !e.isDirectory);
          const convEntries = allEntries
            .map((e) => e.name)
            .filter((name) => CONV_SHARD_RE.test(name))
            .sort(compareConversationEntries);

          if (convEntries.length > 0) {
            entries.push(...convEntries);
            confidence = 0.9;
            evidence.push(`ZIP archive contains ${convEntries.length} OpenAI conversation file(s): ${convEntries.join(', ')}`);

            try {
              const firstEntryBuf = zip.readEntry(convEntries[0]!);
              const sample = firstEntryBuf.subarray(0, 16384).toString('utf8');
              if (sample.includes('"mapping"') && sample.includes('"current_node"')) {
                confidence = 0.99;
                evidence.push('Discovered mapping and current_node graph keys inside ZIP');
              }
            } catch (err) {
              warnings.push(`ZIP entry sample read warning: ${(err as Error).message}`);
            }

            const assetCount = allEntries.filter((e) => ASSET_EXT_RE.test(e.name)).length;
            if (assetCount > 0) {
              evidence.push(`ZIP contains ${assetCount} asset/media file(s)`);
            }
          } else {
            const hasOpenAiMarkers = allEntries.some((e) =>
              /(?:^|\/)(?:shared_conversations\.json|message_feedback\.json|export_manifest\.json|user\.json|chat\.html)$/i.test(
                e.name
              )
            );
            if (hasOpenAiMarkers && (base.includes('chatgpt') || base.includes('openai'))) {
              confidence = 0.7;
              evidence.push(`ZIP archive has OpenAI markers: ${base}`);
              entries.push(src.path);
            }
          }
        } catch (err) {
          warnings.push(`ZIP probe error: ${(err as Error).message}`);
        } finally {
          zip?.close();
        }
      } else if (base.endsWith('.json')) {
        entries.push(src.path);
        if (/^conversations(?:-\d+)?\.json$/i.test(base)) {
          confidence = 0.85;
          evidence.push(`Matched OpenAI conversations file signature: ${base}`);
        }
        try {
          const sample = fs.readFileSync(src.path, { encoding: 'utf8', flag: 'r' }).slice(0, 16384);
          if (sample.includes('"mapping"') && sample.includes('"current_node"')) {
            confidence = 0.99;
            evidence.push('Discovered mapping and current_node graph keys');
          }
          if (sample.includes('is_visually_hidden_from_conversation')) {
            evidence.push('Discovered hidden message metadata flag');
          }
        } catch (err) {
          warnings.push(`File read error: ${(err as Error).message}`);
        }
      }
    } else if (src.kind === 'dir') {
      try {
        const files = fs.readdirSync(src.path);
        const convFiles = files.filter((f) => /^conversations(?:-\d+)?\.json$/i.test(f)).sort(compareConversationEntries);
        if (convFiles.length > 0) {
          confidence = 0.95;
          evidence.push(`Directory contains OpenAI export files: ${convFiles.join(', ')}`);
          for (const f of convFiles) {
            entries.push(path.join(src.path, f));
          }
          try {
            const firstSample = fs.readFileSync(entries[0]!, 'utf8').slice(0, 16384);
            if (firstSample.includes('"mapping"') && firstSample.includes('"current_node"')) {
              confidence = 0.99;
              evidence.push('Discovered mapping and current_node graph keys');
            }
          } catch {
            // ignore sample error
          }
        }
      } catch (err) {
        warnings.push(`Directory read error: ${(err as Error).message}`);
      }
    }

    if (confidence <= 0) return null;

    return {
      adapterId: this.id,
      version: 'v2',
      confidence,
      evidence,
      entries,
      warnings,
    };
  }

  async *plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask> {
    if (src.kind === 'file' && src.path.toLowerCase().endsWith('.zip')) {
      let zip: ZipArchive | null = null;
      try {
        zip = ZipArchive.open(src.path);
        for (const entry of probe.entries) {
          const entryInfo = zip.getEntry(entry);
          const taskId = sha256Hex(`${src.path}#${entry}#0`);
          yield {
            id: taskId,
            src,
            entry,
            estimatedBytes: entryInfo?.uncompressedSize ?? 0,
          };
        }
      } finally {
        zip?.close();
      }
      return;
    }

    for (const entry of probe.entries) {
      let size = 0;
      try {
        size = fs.statSync(entry).size;
      } catch {
        // ignore size probe error
      }
      const taskId = sha256Hex(`${src.path}#${entry}#0`);
      yield {
        id: taskId,
        src,
        entry,
        estimatedBytes: size,
      };
    }
  }

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<OpenAiNativeConversation>[]> {
    const isZip = task.src.kind === 'file' && task.src.path.toLowerCase().endsWith('.zip');
    const targetDesc = isZip ? `${task.src.path}#${task.entry ?? 'conversations.json'}` : (task.entry ?? task.src.path);
    ctx.log('info', `OpenAiWebAdapter parsing: ${targetDesc}`);

    const assetLocator = new AssetLocator();
    const persistedAssetCache = new Map<string, BlobAsset>();
    let zip: ZipArchive | null = null;
    let rawContent: string;

    try {
      if (isZip) {
        zip = ZipArchive.open(task.src.path);
        const entryName = task.entry ?? 'conversations.json';
        if (!zip.getEntry(entryName)) {
          ctx.log('error', `ZIP entry not found: ${entryName} in ${task.src.path}`);
          return [];
        }

        // Index all asset entries in the ZIP Central Directory
        for (const entryInfo of zip.listEntries()) {
          if (!entryInfo.isDirectory && !CONV_SHARD_RE.test(entryInfo.name)) {
            const z = zip;
            assetLocator.add(entryInfo.name, () => z.readEntry(entryInfo.name));
          }
        }

        rawContent = zip.readEntryText(entryName, 'utf8');
      } else {
        const filePath = task.entry ?? task.src.path;
        rawContent = fs.readFileSync(filePath, 'utf8');
        const assetRoot = task.src.kind === 'dir' ? task.src.path : path.dirname(filePath);
        collectDirAssets(assetRoot, assetLocator);
      }

      const rawList: OpenAiNativeConversation[] = [];
      const trimmed = rawContent.trimStart();
      try {
        if (trimmed.startsWith('[')) {
          for (const item of streamTopLevelJsonArray<OpenAiNativeConversation>(rawContent)) {
            if (item && typeof item === 'object') {
              rawList.push(item);
            }
          }
        } else {
          const parsed = JSON.parse(rawContent) as unknown;
          if (Array.isArray(parsed)) {
            rawList.push(...(parsed as OpenAiNativeConversation[]));
          } else if (parsed && typeof parsed === 'object') {
            rawList.push(parsed as OpenAiNativeConversation);
          }
        }
      } catch (err) {
        ctx.log('error', `JSON parse error in ${targetDesc}: ${(err as Error).message}`);
        return [];
      }

      const docs: SessionDocument<OpenAiNativeConversation>[] = [];

      for (const rawConv of rawList) {
        partitionVendorFields(rawConv, KNOWN_CONV_KEYS, ctx);
        const mapping = rawConv.mapping ?? {};
        for (const node of Object.values(mapping)) {
          if (node?.message && typeof node.message === 'object') {
            partitionVendorFields(node.message, KNOWN_MSG_KEYS, ctx);
          }
        }

        const convCreatedAt =
          typeof rawConv.create_time === 'number' ? Math.round(rawConv.create_time * 1000) : Date.now();
        const convBlobsBySha = new Map<string, BlobAsset>();
        const assetBlobByRef = new Map<string, BlobAsset>();

        const refs = collectNodeAssetRefs(rawConv);
        for (const itemRef of refs) {
          const matchedEntry = assetLocator.find(itemRef.ref);
          if (!matchedEntry) continue;

          let blobAsset = persistedAssetCache.get(matchedEntry.entryName);
          if (!blobAsset) {
            try {
              const buf = matchedEntry.readBytes();
              const sniffed = sniffMimeFromBuffer(buf);
              const mime =
                sniffed.mime !== 'application/octet-stream'
                  ? sniffed.mime
                  : itemRef.preferredMime ?? sniffed.mime;
              const sourceExt = path.posix.extname(matchedEntry.entryName);
              const ext = /^\.[a-z0-9_-]+$/i.test(sourceExt) && sourceExt.toLowerCase() !== '.dat'
                ? sourceExt.toLowerCase()
                : (
                sniffed.mime !== 'application/octet-stream'
                  ? sniffed.ext
                  : itemRef.preferredMime
                    ? extForMime(itemRef.preferredMime)
                    : sniffed.ext
                );

              const persisted = await ctx.persistRaw(matchedEntry.entryName, buf);
              const sha256 = persisted.sha256 || sha256Hex(buf);
              const originKind: BlobOriginKind = matchedEntry.entryName.toLowerCase().endsWith('.dat')
                ? 'export_dat'
                : 'attachment';
              const relPath = `blobs/${sha256.slice(0, 2)}/${sha256}${ext}`;
              await ctx.spill(buf, { mime, ext, originKind });

              blobAsset = {
                sha256,
                mime,
                bytes: buf.length,
                ext,
                width: itemRef.width ?? null,
                height: itemRef.height ?? null,
                duration_ms: null,
                rel_path: relPath,
                origin_kind: originKind,
                created_at: convCreatedAt,
              };
              persistedAssetCache.set(matchedEntry.entryName, blobAsset);
            } catch (err) {
              ctx.log('warn', `Failed persisting OpenAI asset ${matchedEntry.entryName}: ${(err as Error).message}`);
              continue;
            }
          }

          convBlobsBySha.set(blobAsset.sha256, blobAsset);
          for (const key of normalizePointerKey(itemRef.ref)) {
            assetBlobByRef.set(key, blobAsset);
          }
        }

        docs.push(new OpenAiSessionDocument(rawConv, [], [...convBlobsBySha.values()], assetBlobByRef));
      }

      return docs;
    } catch (err) {
      ctx.log('error', `Failed to read ${targetDesc}: ${(err as Error).message}`);
      return [];
    } finally {
      zip?.close();
    }
  }
}

export const openaiWebAdapter = new OpenAiWebAdapter();
