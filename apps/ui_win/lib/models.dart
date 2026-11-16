import 'dart:convert';

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
  final String? parentExternalId;
  final int? parentConversationId;
  final bool isSubagent;
  final String? subagentName;
  final List<ConversationSummary> subagents;
  final String title;
  final String? summary;
  final String? cwd;
  final String? defaultModel;
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
    this.parentExternalId,
    this.parentConversationId,
    this.isSubagent = false,
    this.subagentName,
    this.subagents = const [],
    required this.title,
    this.summary,
    this.cwd,
    this.defaultModel,
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

  ConversationSummary copyWith({
    String? parentExternalId,
    int? parentConversationId,
    bool? isSubagent,
    String? subagentName,
    List<ConversationSummary>? subagents,
  }) {
    return ConversationSummary(
      id: id,
      provider: provider,
      externalId: externalId,
      parentExternalId: parentExternalId ?? this.parentExternalId,
      parentConversationId: parentConversationId ?? this.parentConversationId,
      isSubagent: isSubagent ?? this.isSubagent,
      subagentName: subagentName ?? this.subagentName,
      subagents: subagents ?? this.subagents,
      title: title,
      summary: summary,
      cwd: cwd,
      defaultModel: defaultModel,
      projectId: projectId,
      projectName: projectName,
      itemCount: itemCount,
      charCount: charCount,
      blobCount: blobCount,
      revisionCount: revisionCount,
      starred: starred,
      updatedAt: updatedAt,
      headHash: headHash,
      supersededBy: supersededBy,
      isShrunk: isShrunk,
    );
  }
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

  bool get isAttachment =>
      type == 'file' || type == 'link' || type == 'audio' || type == 'video';

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
  final String? rawBlocksJson;
  List<ViewBlock>? _blocks;
  final String? payloadRef;
  final int? createdAt;
  final bool isActiveBranch;
  final bool isHidden;
  final bool isSynthetic;
  final String? status;
  final String? supersededBy;

  MessageItem({
    required this.id,
    this.parentId,
    this.ordinal = 0,
    this.depth = 0,
    required this.role,
    this.kind = 'message',
    this.model,
    this.toolName,
    required this.text,
    List<ViewBlock>? blocks,
    this.rawBlocksJson,
    this.payloadRef,
    this.createdAt,
    required this.isActiveBranch,
    this.isHidden = false,
    required this.isSynthetic,
    this.status,
    this.supersededBy,
  }) : _blocks = blocks;

  List<ViewBlock> get blocks => _blocks ??= _decodeBlocks(rawBlocksJson);

  static List<ViewBlock> _decodeBlocks(String? rawBlocks) {
    if (rawBlocks == null || rawBlocks.isEmpty) return const [];
    try {
      final parsed = jsonDecode(rawBlocks);
      if (parsed is List) {
        var idx = 0;
        return parsed
            .whereType<Map<String, dynamic>>()
            .map((m) => ViewBlock.fromJson(m, fallbackIdx: idx++))
            .toList(growable: false);
      }
    } catch (_) {}
    return const [];
  }
}

class ConversationDetail {
  final int id;
  final String provider;
  final String? externalId;
  final String? parentExternalId;
  final int? parentConversationId;
  final bool isSubagent;
  final String? subagentName;
  final List<ConversationSummary> subagents;
  final String title;
  final String? headHash;
  final String? defaultModel;
  final String? cwd;
  final bool starred;
  final List<String> tags;
  final int revisionCount;
  final String? supersededBy;
  final List<ConversationRevisionInfo> revisions;
  final List<MessageItem> items;
  final Map<int?, List<MessageItem>> childrenByParent;

  ConversationDetail({
    required this.id,
    required this.provider,
    this.externalId,
    this.parentExternalId,
    this.parentConversationId,
    this.isSubagent = false,
    this.subagentName,
    this.subagents = const [],
    required this.title,
    this.headHash,
    this.defaultModel,
    this.cwd,
    this.starred = false,
    this.tags = const [],
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

class ImportProgressUpdate {
  final String stage;
  final String? adapterId;
  final int completed;
  final int total;
  final int skipped;
  final int bytesProcessed;
  final int totalBytes;
  final String? currentEntry;
  final Duration elapsed;

  const ImportProgressUpdate({
    required this.stage,
    this.adapterId,
    required this.completed,
    required this.total,
    required this.skipped,
    required this.bytesProcessed,
    required this.totalBytes,
    this.currentEntry,
    required this.elapsed,
  });

  factory ImportProgressUpdate.fromJson(
    Map<String, dynamic> json, {
    required Duration elapsed,
  }) {
    return ImportProgressUpdate(
      stage: json['stage']?.toString() ?? 'parse',
      adapterId: json['adapterId']?.toString(),
      completed: (json['completed'] as num?)?.toInt() ?? 0,
      total: (json['total'] as num?)?.toInt() ?? 0,
      skipped: (json['skipped'] as num?)?.toInt() ?? 0,
      bytesProcessed: (json['bytesProcessed'] as num?)?.toInt() ?? 0,
      totalBytes: (json['totalBytes'] as num?)?.toInt() ?? 0,
      currentEntry: json['currentEntry']?.toString(),
      elapsed: elapsed,
    );
  }

  double? get fraction {
    if (stage == 'done') return 1.0;
    if (stage == 'probe' || stage == 'plan') return null;
    if (total <= 0) {
      if (totalBytes > 0) {
        return (bytesProcessed / totalBytes).clamp(0.0, 1.0);
      }
      return null;
    }
    return (completed / total).clamp(0.0, 1.0);
  }

  double get elapsedSeconds => elapsed.inMilliseconds / 1000.0;

  double get itemsPerSec {
    final sec = elapsedSeconds;
    if (sec < 0.05 || completed <= 0) return 0;
    return completed / sec;
  }

  double get bytesPerSec {
    final sec = elapsedSeconds;
    if (sec < 0.05 || bytesProcessed <= 0) return 0;
    return bytesProcessed / sec;
  }

  Duration? get eta {
    if (stage == 'done') return Duration.zero;
    if (stage != 'parse' || total <= 0 || completed <= 0 || completed >= total) {
      return null;
    }
    final sec = elapsedSeconds;
    if (sec < 0.1) return null;
    final remainingItems = total - completed;
    final estRemSeconds = remainingItems / (completed / sec);
    if (!estRemSeconds.isFinite || estRemSeconds < 0) return null;
    return Duration(milliseconds: (estRemSeconds * 1000).round());
  }

  String get formattedBytesSpeed {
    final bps = bytesPerSec;
    if (bps <= 0) return '--';
    if (bps < 1024) return '${bps.toStringAsFixed(0)} B/s';
    if (bps < 1024 * 1024) return '${(bps / 1024).toStringAsFixed(1)} KB/s';
    return '${(bps / (1024 * 1024)).toStringAsFixed(1)} MB/s';
  }

  static String formatDuration(Duration d) {
    final totalSec = d.inSeconds;
    if (totalSec < 60) return '${totalSec}s';
    final min = totalSec ~/ 60;
    final rem = totalSec % 60;
    return '${min}m ${rem.toString().padLeft(2, '0')}s';
  }
}

class ArchiveDiskStats {
  final String dbPath;
  final String archiveRoot;
  final bool dbExists;
  final int dbBytes;
  final int cacheBytes;
  final int conversationCount;
  final int batchCount;

  const ArchiveDiskStats({
    required this.dbPath,
    required this.archiveRoot,
    required this.dbExists,
    required this.dbBytes,
    required this.cacheBytes,
    required this.conversationCount,
    required this.batchCount,
  });

  int get totalBytes => dbBytes + cacheBytes;
  bool get hasAnyData => dbExists || dbBytes > 0 || cacheBytes > 0;
}

class ArchiveResetResult {
  final bool ok;
  final int deletedFiles;
  final int deletedDirs;
  final int freedBytes;
  final String? errorMessage;

  const ArchiveResetResult({
    required this.ok,
    required this.deletedFiles,
    required this.deletedDirs,
    required this.freedBytes,
    this.errorMessage,
  });
}
