/**
 * Open Conversation Archive (OCA) v1 — Core TypeScript Definitions
 *
 * Dual-licensed:
 * - Specification & Schemas: CC0-1.0
 * - Reference Implementation: MIT
 */

/** Spill threshold: payloads or inline media larger than 32 KB must be externalized to OcaBlob */
export const OCA_SPILL_THRESHOLD_BYTES = 32 * 1024;

/** Maximum length of plain-text projection stored inline on OcaItem.text (64 KB) */
export const OCA_TEXT_PREVIEW_MAX_CHARS = 64 * 1024;

export type OcaProviderId =
  | 'openai-web'
  | 'anthropic-web'
  | 'deepseek-web'
  | 'codex-local'
  | 'claude-code-local'
  | 'dsh-local'
  | 'generic-json'
  | 'generic-md';

export type OcaRole = 'user' | 'assistant' | 'system' | 'tool' | 'developer';

export type OcaItemKind =
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

export type OcaBlockType =
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

export type OcaItemStatus = 'ok' | 'error' | 'pending' | 'interrupted';

export type OcaAssetAvailability = 'full' | 'extracted_only' | 'missing_ref';

export type OcaBlobOriginKind =
  | 'export_dat'
  | 'attachment'
  | 'inline_base64'
  | 'generated'
  | 'thumbnail'
  | 'oversized_payload';

export type OcaTitleSource = 'provider' | 'generated' | 'first_user' | 'filename';

/**
 * Three-Tier Vendor Extension Reservoir (Level 2 & Level 3):
 * Preserves provider-specific metadata without polluting Level-1 core columns,
 * and captures unrecognized fields in `_unmapped` for zero-loss schema drift recovery.
 */
export interface OcaVendorExtensions {
  openai?: {
    gizmo_id?: string | null;
    default_model_slug?: string | null;
    feedback?: 'thumbs_up' | 'thumbs_down' | string | null;
    shared?: boolean;
    recipient?: string | null;
    content_type?: string | null;
    about_user_message?: string | null;
    about_model_message?: string | null;
  };
  anthropic?: {
    account_uuid?: string | null;
    project_uuid?: string | null;
    text_content_mismatch?: boolean;
  };
  deepseek?: {
    inferred_schema_version?: string | null;
    reasoning_content_present?: boolean;
  };
  codex?: {
    originator?: string | null;
    cli_version?: string | null;
    model_provider?: string | null;
    collaboration_mode_kind?: string | null;
    base_instructions_sha256?: string | null;
    turn_id?: string | null;
    rollout_ordinal?: number | null;
  };
  claude_code?: {
    git_branch?: string | null;
    user_type?: string | null;
    version?: string | null;
    sidechain?: boolean;
    leaf_uuid?: string | null;
  };
  dsh?: {
    agent_preset?: string | null;
    delegation_depth?: number | null;
    permission_preset?: string | null;
    sandbox_mode?: string | null;
    seq?: number | null;
  };
  /** Level-3 fallback for unknown / newly introduced upstream fields */
  _unmapped?: Record<string, unknown>;
  [namespace: string]: unknown;
}

export interface OcaBlob {
  sha256: string;
  mime: string;
  bytes: number;
  ext?: string | null;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  rel_path: string;
  origin_kind: OcaBlobOriginKind;
  created_at: number;
}

export interface OcaBlock {
  idx: number;
  type: OcaBlockType;
  text?: string | null;
  lang?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  /** Inline JSON string when <= 32KB; otherwise spilled to blob_sha256 */
  tool_input?: string | null;
  status?: OcaItemStatus | null;
  blob_sha256?: string | null;
  availability?: OcaAssetAvailability;
  meta?: Record<string, unknown> | null;
}

export interface OcaItemDraft {
  external_id: string;
  parent_external_id?: string | null;
  ordinal: number;
  depth?: number;
  role: OcaRole;
  kind: OcaItemKind;
  created_at?: number | null;
  model?: string | null;
  text?: string | null;
  text_len?: number;
  content_hash?: string;
  is_active_branch?: boolean;
  is_hidden?: boolean;
  is_synthetic?: boolean;
  status?: OcaItemStatus | null;
  /** SHA256 blob reference when raw item payload > 32KB or contains unmapped nested payloads */
  payload_ref?: string | null;
  blocks: OcaBlock[];
  ext?: OcaVendorExtensions;
}

export interface OcaItem extends OcaItemDraft {
  depth: number;
  text: string;
  text_len: number;
  content_hash: string;
  is_active_branch: boolean;
  is_hidden: boolean;
  is_synthetic: boolean;
}

export interface OcaConversationDraft {
  provider: OcaProviderId;
  external_id?: string | null;
  title?: string | null;
  title_source?: OcaTitleSource | null;
  summary?: string | null;
  created_at?: number | null;
  updated_at?: number | null;
  exported_at?: number | null;
  default_model?: string | null;
  cwd?: string | null;
  items: OcaItemDraft[];
  blobs?: OcaBlob[];
  ext?: OcaVendorExtensions;
}

export interface OcaConversation extends Omit<OcaConversationDraft, 'items'> {
  head_hash: string | null;
  content_hash: string;
  fingerprint: string;
  items: OcaItem[];
}

export type OcaIssueSeverity = 'info' | 'warn' | 'error';

export type OcaIssueCode =
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
  | 'unrecognized_fields_spike';

export interface OcaIntegrityIssue {
  code: OcaIssueCode;
  severity: OcaIssueSeverity;
  message: string;
  conversation_external_id?: string | null;
  item_external_id?: string | null;
  details?: Record<string, unknown>;
}

export interface OcaBatchDiffStats {
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

export interface OcaIntegrityReport {
  schema_version: 'v1';
  provider: OcaProviderId;
  adapter_id: string;
  adapter_version: string;
  generated_at: number;
  issues: OcaIntegrityIssue[];
  unrecognized_field_counts: Record<string, number>;
  diff?: OcaBatchDiffStats;
}

export interface OcaArchiveManifest {
  oca_version: '1.0.0';
  exported_at: number;
  generator: string;
  conversation_count: number;
  item_count: number;
  blob_count: number;
  conversations_file: string;
  blobs_dir: string;
}
