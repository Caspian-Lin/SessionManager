// GENERATED CODE - DO NOT MODIFY BY HAND
// Source: packages/oca/schemas/v1/oca.schema.json (https://oca-spec.org/schemas/v1/oca.schema.json)

enum OcaProviderId {
  openaiWeb('openai-web'),
  anthropicWeb('anthropic-web'),
  deepseekWeb('deepseek-web'),
  codexLocal('codex-local'),
  claudeCodeLocal('claude-code-local'),
  dshLocal('dsh-local'),
  genericJson('generic-json'),
  genericMd('generic-md');

  final String value;
  const OcaProviderId(this.value);
}

class OcaBlock {
  final int idx;
  final String type;
  final String? text;
  final String? lang;
  final String? toolName;
  final String? toolCallId;
  final String? toolInput;
  final String? status;
  final String? blobSha256;
  final String? availability;
  final Map<String, dynamic>? meta;

  const OcaBlock({
    required this.idx,
    required this.type,
    this.text,
    this.lang,
    this.toolName,
    this.toolCallId,
    this.toolInput,
    this.status,
    this.blobSha256,
    this.availability,
    this.meta,
  });

  factory OcaBlock.fromJson(Map<String, dynamic> json) => OcaBlock(
        idx: json['idx'] as int,
        type: json['type'] as String,
        text: json['text'] as String?,
        lang: json['lang'] as String?,
        toolName: json['tool_name'] as String?,
        toolCallId: json['tool_call_id'] as String?,
        toolInput: json['tool_input'] as String?,
        status: json['status'] as String?,
        blobSha256: json['blob_sha256'] as String?,
        availability: json['availability'] as String?,
        meta: json['meta'] as Map<String, dynamic>?,
      );
}

class OcaItem {
  final String externalId;
  final String? parentExternalId;
  final int ordinal;
  final int depth;
  final String role;
  final String kind;
  final int? createdAt;
  final String? model;
  final String text;
  final int textLen;
  final String contentHash;
  final bool isActiveBranch;
  final bool isHidden;
  final bool isSynthetic;
  final String? status;
  final String? payloadRef;
  final List<OcaBlock> blocks;
  final Map<String, dynamic>? ext;

  const OcaItem({
    required this.externalId,
    this.parentExternalId,
    required this.ordinal,
    this.depth = 0,
    required this.role,
    required this.kind,
    this.createdAt,
    this.model,
    this.text = '',
    this.textLen = 0,
    required this.contentHash,
    this.isActiveBranch = true,
    this.isHidden = false,
    this.isSynthetic = false,
    this.status,
    this.payloadRef,
    required this.blocks,
    this.ext,
  });

  factory OcaItem.fromJson(Map<String, dynamic> json) => OcaItem(
        externalId: json['external_id'] as String,
        parentExternalId: json['parent_external_id'] as String?,
        ordinal: json['ordinal'] as int,
        depth: (json['depth'] as int?) ?? 0,
        role: json['role'] as String,
        kind: json['kind'] as String,
        createdAt: json['created_at'] as int?,
        model: json['model'] as String?,
        text: (json['text'] as String?) ?? '',
        textLen: (json['text_len'] as int?) ?? 0,
        contentHash: json['content_hash'] as String,
        isActiveBranch: (json['is_active_branch'] as bool?) ?? true,
        isHidden: (json['is_hidden'] as bool?) ?? false,
        isSynthetic: (json['is_synthetic'] as bool?) ?? false,
        status: json['status'] as String?,
        payloadRef: json['payload_ref'] as String?,
        blocks: ((json['blocks'] as List<dynamic>?) ?? const [])
            .map((e) => OcaBlock.fromJson(e as Map<String, dynamic>))
            .toList(),
        ext: json['ext'] as Map<String, dynamic>?,
      );
}
