/**
 * @sm/shared — Core DTOs, Polymorphic Session Contracts & UI View Projections
 */

/** Spill threshold: payloads or inline media larger than 32 KB must be externalized to BlobAsset */
export const SPILL_THRESHOLD_BYTES = 32 * 1024;

/** Maximum length of plain-text projection stored inline on search index items (64 KB) */
export const TEXT_PREVIEW_MAX_CHARS = 64 * 1024;

export type ProviderId =
  | 'openai-web'
  | 'anthropic-web'
  | 'deepseek-web'
  | 'codex-local'
  | 'claude-code-local'
  | 'dsh-local'
  | 'zcode-local'
  | 'opencode-local'
  | 'generic-json'
  | 'generic-md'
  | 'sm-native';

export type SessionRole = 'user' | 'assistant' | 'system' | 'tool' | 'developer';

export type TurnKind =
  | 'message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'file_change'
  | 'web_search'
  | 'image'
  | 'notice'
  | 'turn_context'
  | 'compaction'
  | 'todo'
  | 'system_note';

export type ViewBlockType =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'code'
  | 'citation'
  | 'image'
  | 'audio'
  | 'video'
  | 'file'
  | 'canvas';

export type ItemStatus = 'ok' | 'error' | 'pending' | 'interrupted';

export type AssetAvailability = 'full' | 'extracted_only' | 'missing_ref';

export type BlobOriginKind =
  | 'export_dat'
  | 'attachment'
  | 'inline_base64'
  | 'generated'
  | 'thumbnail'
  | 'oversized_payload'
  | 'native_session';

export type TitleSource = 'provider' | 'generated' | 'first_user' | 'filename';

export interface BlobAsset {
  sha256: string;
  mime: string;
  bytes: number;
  ext?: string | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  rel_path: string;
  origin_kind: BlobOriginKind;
  created_at: number;
}

export interface ViewBlock {
  idx: number;
  type: ViewBlockType;
  text?: string | null;
  lang?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  /** Inline JSON string when <= 32KB; otherwise spilled to blob_sha256 */
  tool_input?: string | null;
  status?: ItemStatus | null;
  blob_sha256?: string | null;
  availability?: AssetAvailability;
  meta?: Record<string, unknown> | null;
}

export interface SearchChunk {
  external_id: string;
  parent_external_id: string | null;
  ordinal: number;
  depth: number;
  role: SessionRole;
  kind: TurnKind;
  created_at: number | null;
  model: string | null;
  text: string;
  text_len: number;
  tool_name: string | null;
  content_hash: string;
  is_active_branch: boolean;
  is_hidden: boolean;
  is_synthetic: boolean;
  status: ItemStatus | null;
  payload_ref: string | null;
  blocks: ViewBlock[];
}

export interface ViewNode {
  external_id: string;
  parent_external_id: string | null;
  ordinal: number;
  depth: number;
  role: SessionRole;
  kind: TurnKind;
  created_at: number | null;
  model: string | null;
  text: string;
  text_len: number;
  content_hash: string;
  is_active_branch: boolean;
  is_hidden: boolean;
  is_synthetic: boolean;
  status: ItemStatus | null;
  payload_ref: string | null;
  blocks: ViewBlock[];
}

export interface SessionMeta {
  provider: ProviderId;
  external_id: string | null;
  parent_external_id?: string | null;
  is_subagent?: boolean;
  subagent_name?: string | null;
  title: string | null;
  title_source: TitleSource | null;
  summary: string | null;
  created_at: number | null;
  updated_at: number | null;
  exported_at: number | null;
  default_model: string | null;
  cwd: string | null;
  message_count: number;
  char_count: number;
  blob_count: number;
  head_hash: string | null;
  content_hash: string;
  fingerprint: string;
  raw_format: string;
}

export interface ConversationViewModel {
  meta: SessionMeta;
  nodes: ViewNode[];
  blobs: BlobAsset[];
}

export type SessionDiffStatus =
  | 'identical'
  | 'superset_append'
  | 'shrunk'
  | 'branched'
  | 'modified';

export interface SessionDiffResult {
  status: SessionDiffStatus;
  added_hashes: string[];
  removed_hashes: string[];
  common_count: number;
  similarity: number;
  summary: string;
}

export type IssueSeverity = 'info' | 'warn' | 'error';

export type IssueCode =
  | 'parse_error'
  | 'orphan_node'
  | 'cycle_detected'
  | 'duplicate_external_id'
  | 'orphan_blob_ref'
  | 'unreferenced_blob'
  | 'time_anomaly'
  | 'truncated_stream'
  | 'encoding_replacement'
  | 'manifest_count_mismatch'
  | 'attachment_extracted_only'
  | 'oversized_inline_payload'
  | 'text_content_mismatch'
  | 'unrecognized_fields_spike';

export interface IntegrityIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  conversation_external_id?: string | null;
  item_external_id?: string | null;
  details?: Record<string, unknown>;
}

export interface BatchDiffStats {
  previous_batch_id?: number | null;
  added_conversations: number;
  grown_conversations: number;
  /** Critical indicator: messages or branches were deleted upstream */
  shrunk_conversations: number;
  shrunk_conversation_ids: string[];
  disappeared_conversations: number;
  identical_conversations: number;
  ambiguous_candidates: number;
}

export interface IntegrityReport {
  schema_version: 'v1';
  provider: ProviderId;
  adapter_id: string;
  adapter_version: string;
  generated_at: number;
  issues: IntegrityIssue[];
  unrecognized_field_counts: Record<string, number>;
  diff?: BatchDiffStats;
}

export interface NativeArchiveManifest {
  archive_version: '1.0.0';
  format: 'native-slice';
  exported_at: number;
  generator: string;
  conversation_count: number;
  item_count: number;
  blob_count: number;
  conversations_file: string;
  blobs_dir: string;
}
