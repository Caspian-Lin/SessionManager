enum SmSortBy {
  updatedDesc('Latest Updated'),
  itemsDesc('Most Items'),
  titleAsc('Title A–Z');

  final String label;
  const SmSortBy(this.label);
}

class ProjectInfo {
  final int id;
  final String name;
  final String? provider;
  final String? rootPath;

  const ProjectInfo({
    required this.id,
    required this.name,
    this.provider,
    this.rootPath,
  });
}

class ConversationSummary {
  final int id;
  final String provider;
  final String? externalId;
  final String title;
  final String? summary;
  final String? cwd;
  final int? projectId;
  final String? projectName;
  final int itemCount;
  final int charCount;
  final int blobCount;
  final int revisionCount;
  final bool starred;
  final int? updatedAt;
  final String? headHash;
  final String? supersededBy;
  final bool isShrunk;

  const ConversationSummary({
    required this.id,
    required this.provider,
    this.externalId,
    required this.title,
    this.summary,
    this.cwd,
    this.projectId,
    this.projectName,
    required this.itemCount,
    this.charCount = 0,
    this.blobCount = 0,
    this.revisionCount = 1,
    this.starred = false,
    this.updatedAt,
    this.headHash,
    this.supersededBy,
    this.isShrunk = false,
  });
}

class ConversationRevisionInfo {
  final int id;
  final int revisionNo;
  final int? batchId;
  final String contentHash;
  final int? itemCount;
  final int? charCount;
  final int createdAt;

  const ConversationRevisionInfo({
    required this.id,
    required this.revisionNo,
    this.batchId,
    required this.contentHash,
    this.itemCount,
    this.charCount,
    required this.createdAt,
  });
}

class ViewBlock {
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

  const ViewBlock({
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

  factory ViewBlock.fromJson(Map<String, dynamic> m, {int fallbackIdx = 0}) {
    return ViewBlock(
      idx: (m['idx'] as int?) ?? fallbackIdx,
      type: (m['type'] as String?) ?? 'text',
      text: m['text'] as String?,
      lang: m['lang'] as String?,
      toolName: m['tool_name'] as String?,
      toolCallId: m['tool_call_id'] as String?,
      toolInput: m['tool_input'] as String?,
      status: m['status'] as String?,
      blobSha256: m['blob_sha256'] as String?,
      availability: m['availability'] as String?,
      meta: m['meta'] is Map<String, dynamic> ? m['meta'] as Map<String, dynamic> : null,
    );
  }
}

class MessageItem {
  final int id;
  final int? parentId;
  final int ordinal;
  final int depth;
  final String role;
  final String kind;
  final String? model;
  final String? toolName;
  final String text;
  final List<ViewBlock> blocks;
  final String? payloadRef;
  final int? createdAt;
  final bool isActiveBranch;
  final bool isHidden;
  final bool isSynthetic;
  final String? status;
  final String? supersededBy;

  const MessageItem({
    required this.id,
    this.parentId,
    this.ordinal = 0,
    this.depth = 0,
    required this.role,
    this.kind = 'message',
    this.model,
    this.toolName,
    required this.text,
    this.blocks = const [],
    this.payloadRef,
    this.createdAt,
    required this.isActiveBranch,
    this.isHidden = false,
    required this.isSynthetic,
    this.status,
    this.supersededBy,
  });
}

class ConversationDetail {
  final int id;
  final String provider;
  final String? externalId;
  final String title;
  final String? headHash;
  final String? defaultModel;
  final String? cwd;
  final int revisionCount;
  final String? supersededBy;
  final List<ConversationRevisionInfo> revisions;
  final List<MessageItem> items;
  final Map<int?, List<MessageItem>> childrenByParent;

  ConversationDetail({
    required this.id,
    required this.provider,
    this.externalId,
    required this.title,
    this.headHash,
    this.defaultModel,
    this.cwd,
    this.revisionCount = 1,
    this.supersededBy,
    this.revisions = const [],
    required this.items,
  }) : childrenByParent = _buildTree(items);

  static Map<int?, List<MessageItem>> _buildTree(List<MessageItem> items) {
    final map = <int?, List<MessageItem>>{};
    final ids = items.map((e) => e.id).toSet();
    for (final item in items) {
      final parentKey = (item.parentId != null && ids.contains(item.parentId)) ? item.parentId : null;
      map.putIfAbsent(parentKey, () => []).add(item);
    }
    return map;
  }
}

class SearchHit {
  final int itemId;
  final int conversationId;
  final String provider;
  final String title;
  final String role;
  final String snippet;
  final String strategy;
  final double score;
  final bool isSynthetic;

  const SearchHit({
    this.itemId = 0,
    required this.conversationId,
    required this.provider,
    required this.title,
    required this.role,
    required this.snippet,
    this.strategy = 'uni',
    this.score = 0,
    this.isSynthetic = false,
  });
}

class BatchReport {
  final int id;
  final String provider;
  final String kind;
  final String? sourcePath;
  final int importedAt;
  final String status;
  final int addedConversations;
  final int grownConversations;
  final int shrunkConversations;
  final int identicalConversations;
  final List<String> shrunkConversationIds;

  const BatchReport({
    required this.id,
    required this.provider,
    this.kind = 'zip',
    this.sourcePath,
    required this.importedAt,
    this.status = 'completed',
    required this.addedConversations,
    required this.grownConversations,
    required this.shrunkConversations,
    required this.identicalConversations,
    this.shrunkConversationIds = const [],
  });
}

class DedupeCandidatePair {
  final int id;
  final int aId;
  final int bId;
  final double similarity;
  final String reason;
  final String status;
  final String aTitle;
  final String aProvider;
  final String? aHeadHash;
  final int aItemCount;
  final List<String> aPreviewTurns;
  final String bTitle;
  final String bProvider;
  final String? bHeadHash;
  final int bItemCount;
  final List<String> bPreviewTurns;

  const DedupeCandidatePair({
    required this.id,
    required this.aId,
    required this.bId,
    required this.similarity,
    required this.reason,
    required this.status,
    required this.aTitle,
    required this.aProvider,
    this.aHeadHash,
    required this.aItemCount,
    this.aPreviewTurns = const [],
    required this.bTitle,
    required this.bProvider,
    this.bHeadHash,
    required this.bItemCount,
    this.bPreviewTurns = const [],
  });
}

class SmCliResult {
  final bool ok;
  final int exitCode;
  final String command;
  final Map<String, dynamic>? data;
  final String stdoutText;
  final String stderrText;
  final DateTime timestamp;

  SmCliResult({
    required this.ok,
    required this.exitCode,
    required this.command,
    this.data,
    required this.stdoutText,
    required this.stderrText,
    DateTime? timestamp,
  }) : timestamp = timestamp ?? DateTime.now();

  String get errorMessage {
    if (stderrText.trim().isNotEmpty) return stderrText.trim();
    if (stdoutText.trim().isNotEmpty) return stdoutText.trim();
    return 'exitCode=$exitCode';
  }

  String get summary {
    if (data == null) return 'exitCode=$exitCode';
    if (data!.containsKey('conversationCount')) {
      return '${data!['conversationCount']} conversations';
    }
    if (data!.containsKey('batchId')) {
      return 'batch #${data!['batchId']}';
    }
    if (data!.containsKey('status')) {
      return 'status=${data!['status']}';
    }
    if (data!.containsKey('ok')) {
      return data!['ok'] == true ? 'ok' : 'failed';
    }
    return 'ok';
  }
}
