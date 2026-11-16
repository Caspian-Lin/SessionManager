import {
  SPILL_THRESHOLD_BYTES,
  TEXT_PREVIEW_MAX_CHARS,
  computeMinHash128,
  computeSessionHeadHash,
  computeSessionMerkleRoot,
  computeTurnSemanticHash,
  estimateMinHashSimilarity,
  projectBlocksText,
  type BlobAsset,
  type BlobOriginKind,
  type ConversationViewModel,
  type IntegrityIssue,
  type ItemStatus,
  type ProviderId,
  type SearchChunk,
  type SessionDiffResult,
  type SessionDiffStatus,
  type SessionMeta,
  type SessionRole,
  type TitleSource,
  type TurnKind,
  type ViewBlock,
  type ViewNode,
} from '@sm/shared';

export type SourceRef =
  | { kind: 'file'; path: string }
  | { kind: 'dir'; path: string }
  | { kind: 'sqlite'; path: string };

export interface ProbeResult {
  adapterId: string;
  version: string;
  confidence: number;
  evidence: string[];
  entries: string[];
  warnings: string[];
}

export interface ImportTask {
  id: string;
  src: SourceRef;
  entry?: string;
  range?: [number, number];
  estimatedBytes: number;
  payload?: unknown;
}

export interface ParseCtx {
  persistRaw(entry: string, bytes: Buffer | NodeJS.ReadableStream): Promise<{ sha256: string; path: string }>;
  streamArray<T>(src: NodeJS.ReadableStream): AsyncIterable<T>;
  spill(payload: unknown, binary?: { mime: string; ext: string; originKind: BlobOriginKind }): Promise<string>;
  log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void;
  recordUnrecognizedField?(key: string): void;
  skipIfUnchanged?(filePath: string): boolean;
  recordSourceFile?(filePath: string): void;
}

/**
 * Polymorphic Session Interface implemented by every provider's native session class.
 * Keeps native data intact while exposing uniform methods for metadata extraction,
 * provider-specific validation, same-provider diffing, FTS indexing, and UI projection.
 */
export interface SessionDocument<TRaw = unknown> {
  readonly provider: ProviderId;
  readonly rawFormat: string;
  readonly nativeData: TRaw;

  getMeta(): SessionMeta;
  validate(): IntegrityIssue[];
  diffWith(older: SessionDocument<TRaw>): SessionDiffResult;
  extractSearchChunks(): SearchChunk[];
  toViewModel(): ConversationViewModel;
  toNativeJson(): string;
}

export interface Adapter<TRaw = unknown> {
  readonly id: ProviderId;
  probe(src: SourceRef): Promise<ProbeResult | null>;
  plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask>;
  parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<TRaw>[]>;
}

/**
 * Internal turn draft used by BaseSessionDocument subclasses to project
 * search chunks, compute hashes, repair tree edges, and build ViewModels
 * without introducing a global intermediate archive JSON format.
 */
export interface RawTurnProjection {
  external_id: string;
  parent_external_id?: string | null;
  ordinal: number;
  role: SessionRole;
  kind: TurnKind;
  created_at?: number | null;
  model?: string | null;
  text?: string | null;
  is_active_branch?: boolean;
  is_hidden?: boolean;
  is_synthetic?: boolean;
  status?: ItemStatus | null;
  payload_ref?: string | null;
  blocks: ViewBlock[];
}

export interface BaseSessionInit<TRaw> {
  provider: ProviderId;
  rawFormat: string;
  nativeData: TRaw;
  external_id: string | null;
  parent_external_id?: string | null;
  is_subagent?: boolean;
  subagent_name?: string | null;
  title?: string | null;
  title_source?: TitleSource | null;
  summary?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  exported_at?: number | null;
  default_model?: string | null;
  cwd?: string | null;
  blobs?: BlobAsset[];
  parseIssues?: IntegrityIssue[];
}

/**
 * Shared base implementation for polymorphic SessionDocument classes.
 * Handles deterministic tree topology repair, 5-tier hashing, same-provider diffing,
 * FTS chunk extraction, and ViewModel projection, while allowing each provider
 * subclass to keep its typed nativeData and extend validate() / diffWith().
 */
export abstract class BaseSessionDocument<TRaw> implements SessionDocument<TRaw> {
  readonly provider: ProviderId;
  readonly rawFormat: string;
  readonly nativeData: TRaw;

  protected readonly init: BaseSessionInit<TRaw>;
  private cachedMeta?: SessionMeta;
  private cachedNodes?: ViewNode[];
  private cachedIssues?: IntegrityIssue[];

  constructor(init: BaseSessionInit<TRaw>) {
    this.provider = init.provider;
    this.rawFormat = init.rawFormat;
    this.nativeData = init.nativeData;
    this.init = init;
  }

  protected abstract projectTurns(): RawTurnProjection[];

  protected validateProviderSpecific(): IntegrityIssue[] {
    return [];
  }

  private ensureComputed(): { meta: SessionMeta; nodes: ViewNode[]; issues: IntegrityIssue[] } {
    if (this.cachedMeta && this.cachedNodes && this.cachedIssues) {
      return { meta: this.cachedMeta, nodes: this.cachedNodes, issues: this.cachedIssues };
    }

    const issues: IntegrityIssue[] = [...(this.init.parseIssues ?? [])];
    const convExtId = this.init.external_id ?? null;
    const rawTurns = this.projectTurns();

    const byId = new Map<string, ViewNode>();
    for (const rawItem of rawTurns) {
      const projected = projectBlocksText(rawItem.blocks, rawItem.text);
      const truncatedText =
        projected.length > TEXT_PREVIEW_MAX_CHARS ? projected.slice(0, TEXT_PREVIEW_MAX_CHARS) : projected;

      for (const block of rawItem.blocks) {
        if (
          block.tool_input &&
          Buffer.byteLength(block.tool_input, 'utf8') > SPILL_THRESHOLD_BYTES &&
          !block.blob_sha256
        ) {
          issues.push({
            code: 'oversized_inline_payload',
            severity: 'warn',
            message: `Block idx=${block.idx} has tool_input > 32KB without blob_sha256 spill`,
            conversation_external_id: convExtId,
            item_external_id: rawItem.external_id,
          });
        }
      }

      const contentHash = computeTurnSemanticHash({
        role: rawItem.role,
        kind: rawItem.kind,
        text: rawItem.text,
        blocks: rawItem.blocks,
      });

      const node: ViewNode = {
        external_id: rawItem.external_id,
        parent_external_id: rawItem.parent_external_id ?? null,
        ordinal: rawItem.ordinal,
        depth: 0,
        role: rawItem.role,
        kind: rawItem.kind,
        created_at: rawItem.created_at ?? null,
        model: rawItem.model ?? null,
        text: truncatedText,
        text_len: projected.length,
        content_hash: contentHash,
        is_active_branch: rawItem.is_active_branch ?? true,
        is_hidden: rawItem.is_hidden ?? false,
        is_synthetic: rawItem.is_synthetic ?? false,
        status: rawItem.status ?? null,
        payload_ref: rawItem.payload_ref ?? null,
        blocks: rawItem.blocks,
      };

      if (byId.has(rawItem.external_id)) {
        issues.push({
          code: 'duplicate_external_id',
          severity: 'warn',
          message: `Duplicate item external_id "${rawItem.external_id}" merged`,
          conversation_external_id: convExtId,
          item_external_id: rawItem.external_id,
        });
      }
      byId.set(rawItem.external_id, node);
    }

    // Repair orphan parent pointers
    for (const node of byId.values()) {
      if (node.parent_external_id && !byId.has(node.parent_external_id)) {
        issues.push({
          code: 'orphan_node',
          severity: 'warn',
          message: `Item "${node.external_id}" references missing parent "${node.parent_external_id}"; re-attached to root`,
          conversation_external_id: convExtId,
          item_external_id: node.external_id,
        });
        node.parent_external_id = null;
      }
    }

    // Detect cycles & compute depth
    const visitState = new Map<string, 0 | 1 | 2>();
    const computeDepth = (id: string): number => {
      const state = visitState.get(id) ?? 0;
      const node = byId.get(id)!;
      if (state === 1) {
        issues.push({
          code: 'cycle_detected',
          severity: 'error',
          message: `Cycle detected at item "${id}"; parent edge broken`,
          conversation_external_id: convExtId,
          item_external_id: id,
        });
        node.parent_external_id = null;
        visitState.set(id, 2);
        node.depth = 0;
        return 0;
      }
      if (state === 2) {
        return node.depth;
      }
      visitState.set(id, 1);
      const d = node.parent_external_id ? computeDepth(node.parent_external_id) + 1 : 0;
      node.depth = d;
      visitState.set(id, 2);
      return d;
    };

    for (const id of byId.keys()) {
      computeDepth(id);
    }

    if (
      this.init.created_at != null &&
      this.init.updated_at != null &&
      this.init.updated_at < this.init.created_at
    ) {
      issues.push({
        code: 'time_anomaly',
        severity: 'warn',
        message: `Session updated_at (${this.init.updated_at}) < created_at (${this.init.created_at})`,
        conversation_external_id: convExtId,
      });
    }

    issues.push(...this.validateProviderSpecific());

    const nodes = [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
    const substantiveHashes = nodes
      .filter((n) => !n.is_synthetic && !n.is_hidden)
      .map((n) => n.content_hash);
    const allHashes = nodes.map((n) => n.content_hash);

    const headHash = computeSessionHeadHash(nodes);
    const contentHash = computeSessionMerkleRoot(allHashes);
    const fingerprint = computeMinHash128(substantiveHashes.length > 0 ? substantiveHashes : allHashes);

    let title = this.init.title ?? null;
    let titleSource = this.init.title_source ?? (title ? 'provider' : null);
    if (!title) {
      const firstUser = nodes.find((n) => n.role === 'user' && !n.is_synthetic && n.text.trim().length > 0);
      if (firstUser) {
        title = firstUser.text.trim().replace(/\s+/g, ' ').slice(0, 40);
        titleSource = 'first_user';
      }
    }

    const totalChars = nodes.reduce((acc, n) => acc + n.text_len, 0);
    const summary =
      this.init.summary ??
      nodes.find((n) => !n.is_synthetic && !n.is_hidden && n.text.trim().length > 0)?.text.slice(0, 120) ??
      null;

    this.cachedMeta = {
      provider: this.provider,
      external_id: convExtId,
      parent_external_id: this.init.parent_external_id ?? null,
      is_subagent: Boolean(this.init.is_subagent || this.init.parent_external_id),
      subagent_name: this.init.subagent_name ?? null,
      title,
      title_source: titleSource,
      summary,
      created_at: this.init.created_at ?? null,
      updated_at: this.init.updated_at ?? null,
      exported_at: this.init.exported_at ?? null,
      default_model: this.init.default_model ?? null,
      cwd: this.init.cwd ?? null,
      message_count: nodes.length,
      char_count: totalChars,
      blob_count: this.init.blobs?.length ?? 0,
      head_hash: headHash,
      content_hash: contentHash,
      fingerprint,
      raw_format: this.rawFormat,
    };
    this.cachedNodes = nodes;
    this.cachedIssues = issues;

    return { meta: this.cachedMeta, nodes, issues };
  }

  getMeta(): SessionMeta {
    return this.ensureComputed().meta;
  }

  validate(): IntegrityIssue[] {
    return this.ensureComputed().issues;
  }

  diffWith(older: SessionDocument<TRaw>): SessionDiffResult {
    const olderMeta = older.getMeta();
    const newerMeta = this.getMeta();
    const olderNodes = older.toViewModel().nodes;
    const newerNodes = this.toViewModel().nodes;

    const olderSet = new Set(olderNodes.map((n) => n.content_hash));
    const newerSet = new Set(newerNodes.map((n) => n.content_hash));

    const addedHashes = [...newerSet].filter((h) => !olderSet.has(h));
    const removedHashes = [...olderSet].filter((h) => !newerSet.has(h));
    const commonCount = [...newerSet].filter((h) => olderSet.has(h)).length;

    const similarity =
      olderMeta.fingerprint === newerMeta.fingerprint
        ? 1.0
        : estimateMinHashSimilarity(olderMeta.fingerprint, newerMeta.fingerprint);

    let status: SessionDiffStatus;
    let summary: string;

    if (olderMeta.content_hash === newerMeta.content_hash) {
      status = 'identical';
      summary = 'Exact content match';
    } else if (removedHashes.length === 0 && addedHashes.length > 0) {
      status = 'superset_append';
      summary = `Grown by ${addedHashes.length} turn(s)`;
    } else if (addedHashes.length === 0 && removedHashes.length > 0) {
      status = 'shrunk';
      summary = `Shrunk by ${removedHashes.length} turn(s) upstream`;
    } else if (newerNodes.length < olderNodes.length) {
      status = 'shrunk';
      summary = `Net shrunk (${olderNodes.length} -> ${newerNodes.length} turns; +${addedHashes.length}/-${removedHashes.length})`;
    } else if (olderMeta.external_id && olderMeta.external_id === newerMeta.external_id) {
      status = 'branched';
      summary = `Same session diverged (+${addedHashes.length}/-${removedHashes.length})`;
    } else {
      status = 'modified';
      summary = `Modified (+${addedHashes.length}/-${removedHashes.length})`;
    }

    return {
      status,
      added_hashes: addedHashes,
      removed_hashes: removedHashes,
      common_count: commonCount,
      similarity,
      summary,
    };
  }

  extractSearchChunks(): SearchChunk[] {
    const { nodes } = this.ensureComputed();
    return nodes.map((n) => {
      const toolName = n.blocks.find((b) => Boolean(b.tool_name))?.tool_name ?? null;
      return {
        external_id: n.external_id,
        parent_external_id: n.parent_external_id,
        ordinal: n.ordinal,
        depth: n.depth,
        role: n.role,
        kind: n.kind,
        created_at: n.created_at,
        model: n.model,
        text: n.text,
        text_len: n.text_len,
        tool_name: toolName,
        content_hash: n.content_hash,
        is_active_branch: n.is_active_branch,
        is_hidden: n.is_hidden,
        is_synthetic: n.is_synthetic,
        status: n.status,
        payload_ref: n.payload_ref,
        blocks: n.blocks,
      };
    });
  }

  toViewModel(): ConversationViewModel {
    const { meta, nodes } = this.ensureComputed();
    return {
      meta,
      nodes,
      blobs: this.init.blobs ?? [],
    };
  }

  toNativeJson(): string {
    return JSON.stringify(this.nativeData);
  }
}

/**
 * Extracts unrecognized fields from a raw object for schema drift spike monitoring
 * without losing native fields on nativeData.
 */
export function partitionVendorFields<T extends Record<string, unknown>>(
  raw: T,
  knownKeys: readonly string[],
  ctx?: ParseCtx
): Record<string, unknown> | undefined {
  const knownSet = new Set(knownKeys);
  const unmapped: Record<string, unknown> = {};
  let hasUnmapped = false;

  for (const [key, value] of Object.entries(raw)) {
    if (!knownSet.has(key) && value !== undefined) {
      unmapped[key] = value;
      hasUnmapped = true;
      ctx?.recordUnrecognizedField?.(key);
    }
  }

  return hasUnmapped ? unmapped : undefined;
}
