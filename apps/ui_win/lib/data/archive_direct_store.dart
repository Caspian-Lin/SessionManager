import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:sqlite3/sqlite3.dart' as sq;

import '../models.dart';
import 'perf_logger.dart';

class _SubagentMeta {
  final String? parentExternalId;
  final bool isSubagent;
  final String? subagentName;

  const _SubagentMeta({
    this.parentExternalId,
    this.isSubagent = false,
    this.subagentName,
  });
}

/// CQRS Read Path: Direct SQLite WAL read-only access (`OpenMode.readOnly`)
/// plus zero-copy local `blobs/` file resolution.
class ArchiveDirectStore {
  static const String _envDefineDir = String.fromEnvironment('SM_ARCHIVE_DIR');

  late String _dbPath;
  late String _archiveRoot;
  sq.Database? _cachedReadDb;
  String? _cachedReadDbPath;
  Set<String>? _cachedShrunkIds;
  final Map<int, _SubagentMeta> _subagentBackfillCache = <int, _SubagentMeta>{};
  final ValueNotifier<bool> isConnectedNotifier = ValueNotifier<bool>(false);
  final ValueNotifier<String> dbPathNotifier = ValueNotifier<String>('');

  String get dbPath => _dbPath;
  String get archiveRoot => _archiveRoot;

  ArchiveDirectStore({String? archiveDir}) {
    final resolved = _resolveDbPath(
      archiveDir ?? (_envDefineDir.trim().isNotEmpty ? _envDefineDir : Platform.environment['SM_ARCHIVE_DIR'] ?? ''),
    );
    _applyPath(resolved);
  }

  void _applyPath(String resolvedDbPath) {
    _closeReadDb();
    _cachedShrunkIds = null;
    _subagentBackfillCache.clear();
    _dbPath = resolvedDbPath;
    _archiveRoot = p.dirname(resolvedDbPath);
    PerfLogger.instance.archiveRoot = _archiveRoot;
    dbPathNotifier.value = resolvedDbPath;
    isConnectedNotifier.value = File(resolvedDbPath).existsSync();
  }

  void setArchiveLocation(String pathOrDir) {
    final resolved = _resolveDbPath(pathOrDir);
    _applyPath(resolved);
  }

  static String _resolveDbPath(String configured) {
    if (configured.trim().isNotEmpty) {
      final norm = p.normalize(configured.trim());
      if (norm.endsWith('.db')) return norm;
      return p.join(norm, 'archive.db');
    }
    final cwd = Directory.current.path;
    final cwdLower = cwd.toLowerCase();
    final isSystemDir = cwdLower.contains(r'\windows\system32') ||
        cwdLower.contains(r'\windowsapps\') ||
        cwdLower.contains(r'\program files');
    if (!isSystemDir) {
      final candidates = [
        p.join(cwd, 'archive', 'archive.db'),
        p.join(cwd, 'archive.db'),
      ];
      for (final c in candidates) {
        if (File(c).existsSync()) return c;
      }
    }
    final localAppData = (Platform.environment['LOCALAPPDATA'] ?? '').trim();
    if (localAppData.isNotEmpty) {
      return p.join(localAppData, 'SessionManager', 'archive', 'archive.db');
    }
    final home = (Platform.environment['USERPROFILE'] ??
            Platform.environment['HOME'] ??
            '')
        .trim();
    if (home.isNotEmpty) {
      return p.join(home, '.session-manager', 'archive', 'archive.db');
    }
    return p.join(cwd, 'archive', 'archive.db');
  }

  void _closeReadDb() {
    try {
      _cachedReadDb?.dispose();
    } catch (_) {}
    _cachedReadDb = null;
    _cachedReadDbPath = null;
  }

  void dispose() {
    _closeReadDb();
    isConnectedNotifier.dispose();
    dbPathNotifier.dispose();
  }

  /// Persistent read-only SQLite connection reused across fast UI queries.
  /// Do NOT dispose inside individual read methods; closed on path switch,
  /// archive reset, or store dispose.
  sq.Database? _getReadDb() {
    if (!File(_dbPath).existsSync()) {
      _closeReadDb();
      isConnectedNotifier.value = false;
      return null;
    }
    if (_cachedReadDb != null && _cachedReadDbPath == _dbPath) {
      return _cachedReadDb;
    }
    _closeReadDb();
    sq.Database? opened;
    try {
      opened = sq.sqlite3.open(_dbPath, mode: sq.OpenMode.readOnly);
      opened.execute('PRAGMA busy_timeout = 3000;');
      opened.execute('PRAGMA query_only = ON;');
      opened.execute('PRAGMA cache_size = -16000;');
      opened.execute('PRAGMA temp_store = MEMORY;');
      _cachedReadDb = opened;
      _cachedReadDbPath = _dbPath;
      isConnectedNotifier.value = true;
      return opened;
    } catch (_) {
      try {
        opened?.dispose();
      } catch (_) {}
      isConnectedNotifier.value = false;
      return null;
    }
  }

  bool checkConnection() {
    _closeReadDb();
    _cachedShrunkIds = null;
    _subagentBackfillCache.clear();
    return _getReadDb() != null;
  }

  Set<String> _loadShrunkIdSet(sq.Database db, {bool forceRefresh = false}) {
    if (!forceRefresh && _cachedShrunkIds != null) {
      return _cachedShrunkIds!;
    }
    final shrunkIds = <String>{};
    try {
      final rows = db.select('SELECT report_json FROM import_batch WHERE report_json IS NOT NULL');
      for (final r in rows) {
        final raw = r['report_json'] as String?;
        if (raw == null || raw.isEmpty) continue;
        final decoded = jsonDecode(raw);
        if (decoded is Map<String, dynamic>) {
          final diff = decoded['diff'];
          if (diff is Map<String, dynamic>) {
            final ids = diff['shrunk_conversation_ids'];
            if (ids is List) {
              for (final id in ids) {
                shrunkIds.add(id.toString());
              }
            }
          }
        }
      }
    } catch (_) {}
    _cachedShrunkIds = shrunkIds;
    return shrunkIds;
  }

  /// Resolves `<archiveRoot>/blobs/<2-char>/<sha256><ext>` for zero-copy
  /// local media rendering (`Image.file(store.resolveBlobFile(...))`).
  File resolveBlobFile(String sha256, {String? ext, String? relPath}) {
    if (relPath != null && relPath.isNotEmpty) {
      final direct = File(p.join(_archiveRoot, relPath));
      if (direct.existsSync()) return direct;
      final underBlobs = File(p.join(_archiveRoot, 'blobs', relPath));
      if (underBlobs.existsSync()) return underBlobs;
      return direct;
    }

    String resolvedExt = ext ?? '';
    if (resolvedExt.isEmpty) {
      final db = _getReadDb();
      if (db != null) {
        try {
          final rows = db.select(
            'SELECT ext, rel_path FROM blob WHERE sha256 = ? LIMIT 1',
            [sha256],
          );
          if (rows.isNotEmpty) {
            final rowRel = rows.first['rel_path'] as String?;
            if (rowRel != null && rowRel.isNotEmpty) {
              return File(p.join(_archiveRoot, rowRel));
            }
            resolvedExt = (rows.first['ext'] as String?) ?? '';
          }
        } catch (_) {}
      }
    }

    if (resolvedExt.isNotEmpty && !resolvedExt.startsWith('.')) {
      resolvedExt = '.$resolvedExt';
    }
    final prefix = sha256.length >= 2 ? sha256.substring(0, 2) : '00';
    final candidate = File(p.join(_archiveRoot, 'blobs', prefix, '$sha256$resolvedExt'));
    if (candidate.existsSync() || resolvedExt.isNotEmpty) {
      return candidate;
    }

    final bucketDir = Directory(p.join(_archiveRoot, 'blobs', prefix));
    if (bucketDir.existsSync()) {
      for (final entity in bucketDir.listSync()) {
        if (entity is File && p.basename(entity.path).startsWith(sha256)) {
          return entity;
        }
      }
    }
    return candidate;
  }

  static final RegExp _sha256Re = RegExp(r'^[0-9a-fA-F]{64}$');

  /// Extracts a 64-hex SHA256 digest from either a bare `<sha256>` (persisted
  /// by `@sm/store` / `codex-local`) or a `blob:<sha256>` reference.
  static String? extractPayloadSha256(String? payloadRef) {
    if (payloadRef == null) return null;
    final trimmed = payloadRef.trim();
    if (trimmed.isEmpty) return null;
    final candidate = trimmed.startsWith('blob:') ? trimmed.substring('blob:'.length).trim() : trimmed;
    if (_sha256Re.hasMatch(candidate)) return candidate;
    return null;
  }

  /// Lazy-reads spilled `<sha256>` or `blob:<sha256>` payload directly from disk.
  Future<String?> readSpilledPayload(String payloadRef, {int maxChars = 65536}) async {
    final sha = extractPayloadSha256(payloadRef);
    if (sha == null) return null;
    final file = resolveBlobFile(sha);
    if (!file.existsSync()) return null;
    try {
      final totalBytes = file.lengthSync();
      final raf = file.openSync(mode: FileMode.read);
      try {
        final readCap = totalBytes > maxChars * 4 ? maxChars * 4 : totalBytes;
        final bytes = raf.readSync(readCap);
        final decoded = utf8.decode(bytes, allowMalformed: true);
        if (decoded.length > maxChars || totalBytes > readCap) {
          final slice = decoded.length > maxChars ? decoded.substring(0, maxChars) : decoded;
          return '$slice\n\n... [truncated ($totalBytes bytes total); file: ${file.path}]';
        }
        return decoded;
      } finally {
        raf.closeSync();
      }
    } catch (_) {
      return null;
    }
  }

  Future<List<ProjectInfo>> getProjects() async {
    final db = _getReadDb();
    if (db != null) {
      try {
        final rows = db.select(
          '''
          SELECT id, name, provider, root_path
          FROM project
          ORDER BY name COLLATE NOCASE ASC
          ''',
        );
        if (rows.isNotEmpty) {
          return rows
              .map((r) => ProjectInfo(
                    id: r['id'] as int,
                    name: r['name'] as String,
                    provider: r['provider'] as String?,
                    rootPath: r['root_path'] as String?,
                  ))
              .toList();
        }
      } catch (_) {}
    }
    return const [];
  }

  static final RegExp _subagentTitleRe = RegExp(
    r'\(@([^\s)]+)\s+subagent\)',
    caseSensitive: false,
  );
  static final RegExp _jsonParentSessRe = RegExp(
    r'"parent_session(?:_id)?"\s*:\s*"([^"]+)"',
  );
  static final RegExp _jsonParentThreadRe = RegExp(
    r'"parent_thread_id"\s*:\s*"([^"]+)"',
  );
  static final RegExp _jsonTaskTypeSubRe = RegExp(
    r'"task_type"\s*:\s*"subagent"|"origin"\s*:\s*"subagent"',
  );
  static final RegExp _jsonAgentPresetRe = RegExp(
    r'"(?:agent_preset|agent_role|agent_nickname)"\s*:\s*"([^"]+)"',
  );

  _SubagentMeta _resolveSubagentMeta({
    required int convId,
    required String provider,
    required String title,
    required Map<String, dynamic>? flagsMap,
    required String? rawBlobSha256,
  }) {
    final flagParent = flagsMap?['parent_external_id']?.toString();
    final flagIsSub = flagsMap?['is_subagent'] == true;
    final flagName = flagsMap?['subagent_name']?.toString();
    if (flagParent != null || flagIsSub || flagName != null) {
      return _SubagentMeta(
        parentExternalId: flagParent,
        isSubagent: flagIsSub || (flagParent != null && flagParent.isNotEmpty),
        subagentName: flagName,
      );
    }

    final cached = _subagentBackfillCache[convId];
    if (cached != null) return cached;

    var parentExt = flagParent;
    var isSub = flagIsSub;
    var subName = flagName;

    final titleMatch = _subagentTitleRe.firstMatch(title);
    if (titleMatch != null) {
      isSub = true;
      subName ??= titleMatch.group(1);
    }

    // Best-effort lightweight header inspect (< 1.5 KB) for legacy archives without flags_json linkage
    if (!isSub &&
        rawBlobSha256 != null &&
        rawBlobSha256.length >= 2 &&
        (provider == 'dsh-local' ||
            provider == 'opencode-local' ||
            provider == 'zcode-local' ||
            provider == 'codex-local' ||
            provider == 'claude-code-local')) {
      try {
        final prefix = rawBlobSha256.substring(0, 2);
        final blobFile = File(p.join(_archiveRoot, 'blobs', prefix, '$rawBlobSha256.json'));
        if (blobFile.existsSync()) {
          final raf = blobFile.openSync(mode: FileMode.read);
          try {
            final head = utf8.decode(raf.readSync(1536), allowMalformed: true);
            final pSess = _jsonParentSessRe.firstMatch(head)?.group(1) ??
                _jsonParentThreadRe.firstMatch(head)?.group(1);
            if (pSess != null && pSess.isNotEmpty) {
              parentExt = pSess;
              isSub = true;
            }
            if (_jsonTaskTypeSubRe.hasMatch(head)) {
              isSub = true;
            }
            subName ??= _jsonAgentPresetRe.firstMatch(head)?.group(1);
            if (provider == 'claude-code-local' &&
                (head.contains('subagents/') || head.contains('subagents\\\\') || head.contains('/agent-'))) {
              isSub = true;
            }
          } finally {
            raf.closeSync();
          }
        }
      } catch (_) {}
    }

    final resolved = _SubagentMeta(
      parentExternalId: parentExt,
      isSubagent: isSub,
      subagentName: subName,
    );
    _subagentBackfillCache[convId] = resolved;
    return resolved;
  }

  Future<List<ConversationSummary>> getConversations({
    String? provider,
    int? projectId,
    bool starredOnly = false,
    bool shrunkOnly = false,
    String? searchFilter,
    SmSortBy sortBy = SmSortBy.updatedDesc,
    int limit = 2000,
    int offset = 0,
  }) async {
    final trace = PerfLogger.instance.startTrace('get_conversations');
    final db = _getReadDb();
    if (db != null) {
      try {
        final shrunkIds = _loadShrunkIdSet(db);
        trace.markPhase('shrunk_cache');
        final where = <String>['c.deleted_at IS NULL'];
        final params = <Object?>[];

        if (provider != null && provider.isNotEmpty && provider != 'all') {
          where.add('c.provider = ?');
          params.add(provider);
        }
        if (projectId != null) {
          where.add('c.project_id = ?');
          params.add(projectId);
        }
        if (starredOnly) {
          where.add('c.starred = 1');
        }
        if (searchFilter != null && searchFilter.trim().isNotEmpty) {
          where.add('(LOWER(COALESCE(c.title, \'\')) LIKE ? OR LOWER(COALESCE(c.summary, \'\')) LIKE ?)');
          final pat = '%${searchFilter.trim().toLowerCase()}%';
          params.add(pat);
          params.add(pat);
        }

        final orderClause = switch (sortBy) {
          SmSortBy.updatedDesc => 'COALESCE(c.updated_at, c.created_at, 0) DESC, c.id DESC',
          SmSortBy.itemsDesc => 'c.item_count DESC, c.id DESC',
          SmSortBy.titleAsc => 'LOWER(COALESCE(c.title, \'Untitled\')) ASC, c.id DESC',
        };

        final sql = '''
          SELECT c.id, c.provider, c.external_id, c.title, c.summary, c.cwd,
                 c.default_model, c.project_id, p.name AS project_name,
                 c.item_count, c.char_count, c.blob_count, c.revision_count,
                 c.starred, c.updated_at, c.head_hash, c.raw_blob_sha256, c.flags_json
          FROM conversation c
          LEFT JOIN project p ON c.project_id = p.id
          WHERE ${where.join(' AND ')}
          ORDER BY $orderClause
          LIMIT ? OFFSET ?
        ''';
        params.add(limit);
        params.add(offset);

        final rows = db.select(sql, params);
        trace.markPhase('sql_query');

        final rawList = rows.map((r) {
          final id = r['id'] as int;
          final prov = r['provider'] as String;
          final extId = r['external_id'] as String?;
          final title = (r['title'] as String?) ?? 'Untitled';
          String? supersededBy;
          Map<String, dynamic>? flagsMap;
          final flagsRaw = r['flags_json'] as String?;
          if (flagsRaw != null && flagsRaw.isNotEmpty) {
            try {
              final decoded = jsonDecode(flagsRaw);
              if (decoded is Map<String, dynamic>) {
                flagsMap = decoded;
                supersededBy = decoded['superseded_by']?.toString();
              }
            } catch (_) {}
          }
          final subMeta = _resolveSubagentMeta(
            convId: id,
            provider: prov,
            title: title,
            flagsMap: flagsMap,
            rawBlobSha256: r['raw_blob_sha256'] as String?,
          );
          final isShrunk = shrunkIds.contains(id.toString()) || (extId != null && shrunkIds.contains(extId));
          return ConversationSummary(
            id: id,
            provider: prov,
            externalId: extId,
            parentExternalId: subMeta.parentExternalId,
            isSubagent: subMeta.isSubagent,
            subagentName: subMeta.subagentName,
            title: title,
            summary: r['summary'] as String?,
            cwd: r['cwd'] as String?,
            defaultModel: r['default_model'] as String?,
            projectId: r['project_id'] as int?,
            projectName: r['project_name'] as String?,
            itemCount: (r['item_count'] as int?) ?? 0,
            charCount: (r['char_count'] as int?) ?? 0,
            blobCount: (r['blob_count'] as int?) ?? 0,
            revisionCount: (r['revision_count'] as int?) ?? 1,
            starred: ((r['starred'] as int?) ?? 0) == 1,
            updatedAt: r['updated_at'] as int?,
            headHash: r['head_hash'] as String?,
            supersededBy: supersededBy,
            isShrunk: isShrunk,
          );
        }).toList();

        // Build parent -> children map using provider + externalId
        final byProvExt = <String, int>{};
        for (var i = 0; i < rawList.length; i++) {
          final c = rawList[i];
          if (c.externalId != null && c.externalId!.isNotEmpty) {
            byProvExt['${c.provider}::${c.externalId}'] = i;
          }
        }

        final childrenByParentIdx = <int, List<ConversationSummary>>{};
        final attachedChildIndices = <int>{};
        for (var i = 0; i < rawList.length; i++) {
          final c = rawList[i];
          if (!c.isSubagent) continue;
          int? parentIdx;
          if (c.parentExternalId != null && c.parentExternalId!.isNotEmpty) {
            parentIdx = byProvExt['${c.provider}::${c.parentExternalId}'];
          }
          // Fallback: if marked isSubagent without parentExternalId in DB, attach to
          // nearest non-subagent session with same provider + cwd/project if unique/close.
          if (parentIdx == null && c.cwd != null && c.cwd!.isNotEmpty) {
            final cNormCwd = c.cwd!.toLowerCase();
            int? bestIdx;
            int bestDist = 1 << 60;
            for (var j = 0; j < rawList.length; j++) {
              if (i == j) continue;
              final cand = rawList[j];
              if (cand.isSubagent || cand.provider != c.provider) continue;
              if ((cand.cwd ?? '').toLowerCase() != cNormCwd) continue;
              final dist = ((cand.updatedAt ?? 0) - (c.updatedAt ?? 0)).abs();
              if (dist < bestDist) {
                bestDist = dist;
                bestIdx = j;
              }
            }
            // Only heuristic-attach within 6 hours in same cwd
            if (bestIdx != null && bestDist <= 6 * 3600 * 1000) {
              parentIdx = bestIdx;
            }
          }

          if (parentIdx != null && parentIdx != i) {
            final parent = rawList[parentIdx];
            attachedChildIndices.add(i);
            childrenByParentIdx.putIfAbsent(parentIdx, () => []).add(
                  c.copyWith(parentConversationId: parent.id),
                );
          }
        }

        final hierarchical = <ConversationSummary>[];
        for (var i = 0; i < rawList.length; i++) {
          if (attachedChildIndices.contains(i)) continue;
          final c = rawList[i];
          final kids = childrenByParentIdx[i];
          if (kids != null && kids.isNotEmpty) {
            hierarchical.add(c.copyWith(subagents: kids));
          } else {
            hierarchical.add(c);
          }
        }

        final result = shrunkOnly
            ? hierarchical.where((c) => c.isShrunk).toList()
            : hierarchical;
        trace.markPhase('hierarchy_link');
        trace.finish(extraMeta: {
          'rows': rawList.length,
          'top_level': result.length,
          'attached_subagents': attachedChildIndices.length,
        });
        return result;
      } catch (_) {
        _closeReadDb();
        trace.finish();
      }
    } else {
      trace.finish();
    }

    return const [];
  }

  Future<int?> resolveConversationId(String idOrExternalId) async {
    final db = _getReadDb();
    if (db != null) {
      try {
        final rows = db.select(
          '''
          SELECT id FROM conversation
          WHERE deleted_at IS NULL AND (external_id = ? OR CAST(id AS TEXT) = ?)
          LIMIT 1
          ''',
          [idOrExternalId, idOrExternalId],
        );
        if (rows.isNotEmpty) return rows.first['id'] as int;
      } catch (_) {}
    }
    return null;
  }

  Future<ConversationDetail?> getConversationDetail(int id) async {
    final trace = PerfLogger.instance.startTrace('open_conversation', targetId: '$id');
    final db = _getReadDb();
    if (db != null) {
      try {
        final convRows = db.select(
          '''
          SELECT id, provider, external_id, title, head_hash, default_model, cwd,
                 starred, revision_count, raw_blob_sha256, flags_json
          FROM conversation
          WHERE id = ? AND deleted_at IS NULL
          LIMIT 1
          ''',
          [id],
        );
        if (convRows.isEmpty) {
          trace.finish(extraMeta: {'found': false});
          return null;
        }
        final conv = convRows.first;
        final convProvider = conv['provider'] as String;
        final convExtId = conv['external_id'] as String?;
        final convTitle = (conv['title'] as String?) ?? 'Untitled';

        String? convSupersededBy;
        Map<String, dynamic>? convFlagsMap;
        final convFlags = conv['flags_json'] as String?;
        if (convFlags != null && convFlags.isNotEmpty) {
          try {
            final decoded = jsonDecode(convFlags);
            if (decoded is Map<String, dynamic>) {
              convFlagsMap = decoded;
              convSupersededBy = decoded['superseded_by']?.toString();
            }
          } catch (_) {}
        }

        final subMeta = _resolveSubagentMeta(
          convId: id,
          provider: convProvider,
          title: convTitle,
          flagsMap: convFlagsMap,
          rawBlobSha256: conv['raw_blob_sha256'] as String?,
        );

        int? parentConversationId;
        if (subMeta.parentExternalId != null && subMeta.parentExternalId!.isNotEmpty) {
          final pRows = db.select(
            '''
            SELECT id FROM conversation
            WHERE deleted_at IS NULL AND provider = ? AND external_id = ?
            LIMIT 1
            ''',
            [convProvider, subMeta.parentExternalId],
          );
          if (pRows.isNotEmpty) {
            parentConversationId = pRows.first['id'] as int;
          }
        }

        var tags = <String>[];
        try {
          final tagRows = db.select(
            '''
            SELECT t.name
            FROM tag t
            JOIN conversation_tag ct ON ct.tag_id = t.id
            WHERE ct.conversation_id = ?
            ORDER BY t.name ASC
            ''',
            [id],
          );
          tags = tagRows.map((r) => r['name'] as String).toList();
        } catch (_) {
          // Optional tag tables may be absent in minimal test or legacy schemas
        }

        // Find child subagents matching externalId directly via SQLite LIKE/json check
        final childSubagents = <ConversationSummary>[];
        if (convExtId != null && convExtId.isNotEmpty) {
          final subRows = db.select(
            '''
            SELECT id, provider, external_id, title, summary, cwd, default_model,
                   project_id, item_count, char_count, blob_count, revision_count,
                   starred, updated_at, head_hash, flags_json
            FROM conversation
            WHERE deleted_at IS NULL AND provider = ? AND flags_json LIKE ?
            ORDER BY COALESCE(updated_at, created_at, 0) ASC, id ASC
            ''',
            [convProvider, '%$convExtId%'],
          );
          for (final sr in subRows) {
            final srId = sr['id'] as int;
            if (srId == id) continue;
            final sFlagsRaw = sr['flags_json'] as String?;
            Map<String, dynamic>? sFlags;
            if (sFlagsRaw != null && sFlagsRaw.isNotEmpty) {
              try {
                final d = jsonDecode(sFlagsRaw);
                if (d is Map<String, dynamic>) sFlags = d;
              } catch (_) {}
            }
            if (sFlags?['parent_external_id']?.toString() == convExtId) {
              childSubagents.add(ConversationSummary(
                id: srId,
                provider: sr['provider'] as String,
                externalId: sr['external_id'] as String?,
                parentExternalId: convExtId,
                parentConversationId: id,
                isSubagent: true,
                subagentName: sFlags?['subagent_name']?.toString(),
                title: (sr['title'] as String?) ?? 'Subagent',
                summary: sr['summary'] as String?,
                cwd: sr['cwd'] as String?,
                defaultModel: sr['default_model'] as String?,
                projectId: sr['project_id'] as int?,
                itemCount: (sr['item_count'] as int?) ?? 0,
                charCount: (sr['char_count'] as int?) ?? 0,
                blobCount: (sr['blob_count'] as int?) ?? 0,
                revisionCount: (sr['revision_count'] as int?) ?? 1,
                starred: ((sr['starred'] as int?) ?? 0) == 1,
                updatedAt: sr['updated_at'] as int?,
                headHash: sr['head_hash'] as String?,
              ));
            }
          }
        }
        trace.markPhase('meta_tags_subagents');

        final revRows = db.select(
          '''
          SELECT id, batch_id, revision_no, content_hash, item_count, char_count, created_at
          FROM conversation_revision
          WHERE conversation_id = ?
          ORDER BY revision_no DESC
          ''',
          [id],
        );
        final revisions = revRows
            .map((r) => ConversationRevisionInfo(
                  id: r['id'] as int,
                  batchId: r['batch_id'] as int?,
                  revisionNo: r['revision_no'] as int,
                  contentHash: r['content_hash'] as String,
                  itemCount: r['item_count'] as int?,
                  charCount: r['char_count'] as int?,
                  createdAt: r['created_at'] as int,
                ))
            .toList();

        final itemRows = db.select(
          '''
          SELECT id, conversation_id, parent_id, ordinal, depth, role, kind, model, tool_name,
                 text, blocks_json, payload_ref, created_at, is_active_branch, is_hidden, is_synthetic,
                 status, flags_json
          FROM item
          WHERE conversation_id = ?
          ORDER BY ordinal ASC, id ASC
          ''',
          [id],
        );
        trace.markPhase('sql_items');

        final items = itemRows.map((r) {
          String? itemSupersededBy;
          final rawItemFlags = r['flags_json'] as String?;
          if (rawItemFlags != null && rawItemFlags.isNotEmpty) {
            if (rawItemFlags.contains('superseded_by')) {
              try {
                final decoded = jsonDecode(rawItemFlags);
                if (decoded is Map<String, dynamic>) {
                  itemSupersededBy = decoded['superseded_by']?.toString();
                }
              } catch (_) {}
            }
          }

          return MessageItem(
            id: r['id'] as int,
            parentId: r['parent_id'] as int?,
            ordinal: (r['ordinal'] as int?) ?? 0,
            depth: (r['depth'] as int?) ?? 0,
            role: (r['role'] as String?) ?? 'user',
            kind: (r['kind'] as String?) ?? 'message',
            model: r['model'] as String?,
            toolName: r['tool_name'] as String?,
            text: (r['text'] as String?) ?? '',
            rawBlocksJson: r['blocks_json'] as String?,
            payloadRef: r['payload_ref'] as String?,
            createdAt: r['created_at'] as int?,
            isActiveBranch: ((r['is_active_branch'] as int?) ?? 1) == 1,
            isHidden: ((r['is_hidden'] as int?) ?? 0) == 1,
            isSynthetic: ((r['is_synthetic'] as int?) ?? 0) == 1,
            status: r['status'] as String?,
            supersededBy: itemSupersededBy,
          );
        }).toList();
        trace.markPhase('row_mapping');
        trace.finish(extraMeta: {'item_count': items.length});

        return ConversationDetail(
          id: conv['id'] as int,
          provider: convProvider,
          externalId: convExtId,
          parentExternalId: subMeta.parentExternalId,
          parentConversationId: parentConversationId,
          isSubagent: subMeta.isSubagent,
          subagentName: subMeta.subagentName,
          subagents: childSubagents,
          title: convTitle,
          headHash: conv['head_hash'] as String?,
          defaultModel: conv['default_model'] as String?,
          cwd: conv['cwd'] as String?,
          starred: ((conv['starred'] as int?) ?? 0) == 1,
          tags: tags,
          revisionCount: (conv['revision_count'] as int?) ?? 1,
          supersededBy: convSupersededBy,
          revisions: revisions,
          items: items,
        );
      } catch (_) {
        _closeReadDb();
        trace.finish();
      }
    } else {
      trace.finish();
    }

    return null;
  }

  static final RegExp _cjkRunRe = RegExp(
    r'[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+',
  );
  static final RegExp _asciiTokenRe = RegExp(r'[a-zA-Z0-9_.-]+');

  String _quoteFtsPhrase(String term) => '"${term.replaceAll('"', '""')}"';

  String _escapeLike(String term) =>
      term.replaceAll(r'\', r'\\').replaceAll('%', r'\%').replaceAll('_', r'\_');

  String _makeSnippet(String text, String query) {
    final cleaned = text.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (cleaned.length <= 160) return cleaned;
    final idx = cleaned.toLowerCase().indexOf(query.toLowerCase());
    if (idx < 0) return '${cleaned.substring(0, 157)}...';
    final start = idx > 50 ? idx - 50 : 0;
    final end = (start + 160) < cleaned.length ? start + 160 : cleaned.length;
    return '${start > 0 ? '...' : ''}${cleaned.substring(start, end)}${end < cleaned.length ? '...' : ''}';
  }

  double _rankScore(double bm25Val, String role, int? createdAt, bool isSynthetic) {
    final base = -bm25Val;
    final roleBoost = role == 'user' ? 0.15 : 0.0;
    var recencyDecay = 0.0;
    if (createdAt != null && createdAt > 0) {
      final ageDays = (DateTime.now().millisecondsSinceEpoch - createdAt) / 86400000.0;
      recencyDecay = 0.1 * (1.0 / (1.0 + (ageDays < 0 ? 0.0 : ageDays / 30.0)));
    }
    final synthPenalty = isSynthetic ? -0.25 : 0.0;
    return base + roleBoost + recencyDecay + synthPenalty;
  }

  Future<List<SearchHit>> search(
    String q, {
    String? provider,
    String? role,
    bool includeSynthetic = false,
  }) async {
    final trimmed = q.trim();
    if (trimmed.isEmpty) return [];

    final db = _getReadDb();
    if (db != null) {
      try {
        final cjkTokens = _cjkRunRe.allMatches(trimmed).map((m) => m.group(0)!).toList();
        final asciiTokens = _asciiTokenRe.allMatches(trimmed).map((m) => m.group(0)!).toList();
        final hitsByKey = <String, SearchHit>{};

        final filters = <String>['c.deleted_at IS NULL'];
        final filterParams = <Object?>[];
        if (provider != null && provider.isNotEmpty && provider != 'all') {
          filters.add('c.provider = ?');
          filterParams.add(provider);
        }
        if (role != null && role.isNotEmpty && role != 'all') {
          filters.add('i.role = ?');
          filterParams.add(role);
        }
        if (!includeSynthetic) {
          filters.add('i.is_synthetic = 0');
        }
        final filterSql = filters.join(' AND ');

        if (asciiTokens.isNotEmpty) {
          final ftsQuery = asciiTokens.map(_quoteFtsPhrase).join(' ');
          final rows = db.select(
            '''
            SELECT i.id AS item_id, i.conversation_id, i.role, i.text, i.created_at, i.is_synthetic,
                   c.provider, COALESCE(c.title, 'Untitled') AS title,
                   bm25(item_fts_uni, 1.0, 2.0) AS rank_score
            FROM item_fts_uni
            JOIN item i ON i.id = item_fts_uni.rowid
            JOIN conversation c ON c.id = i.conversation_id
            WHERE item_fts_uni MATCH ? AND $filterSql
            ORDER BY rank_score
            LIMIT 50
            ''',
            [ftsQuery, ...filterParams],
          );
          for (final r in rows) {
            final itemId = r['item_id'] as int;
            final convId = r['conversation_id'] as int;
            final itemRole = r['role'] as String;
            final synth = ((r['is_synthetic'] as int?) ?? 0) == 1;
            final score = _rankScore(
              (r['rank_score'] as num?)?.toDouble() ?? 0.0,
              itemRole,
              r['created_at'] as int?,
              synth,
            );
            hitsByKey['$convId:$itemId'] = SearchHit(
              itemId: itemId,
              conversationId: convId,
              provider: r['provider'] as String,
              title: r['title'] as String,
              role: itemRole,
              snippet: _makeSnippet((r['text'] as String?) ?? '', trimmed),
              strategy: cjkTokens.isNotEmpty ? 'mixed' : 'uni',
              score: score,
              isSynthetic: synth,
            );
          }
        }

        for (final token in cjkTokens) {
          if (token.runes.length >= 3) {
            final ftsQuery = _quoteFtsPhrase(token);
            final itemRows = db.select(
              '''
              SELECT i.id AS item_id, i.conversation_id, i.role, i.text, i.created_at, i.is_synthetic,
                     c.provider, COALESCE(c.title, 'Untitled') AS title,
                     bm25(item_fts_tri) AS rank_score
              FROM item_fts_tri
              JOIN item i ON i.id = item_fts_tri.rowid
              JOIN conversation c ON c.id = i.conversation_id
              WHERE item_fts_tri MATCH ? AND $filterSql
              ORDER BY rank_score
              LIMIT 50
              ''',
              [ftsQuery, ...filterParams],
            );
            for (final r in itemRows) {
              final itemId = r['item_id'] as int;
              final convId = r['conversation_id'] as int;
              final itemRole = r['role'] as String;
              final synth = ((r['is_synthetic'] as int?) ?? 0) == 1;
              final score = _rankScore(
                (r['rank_score'] as num?)?.toDouble() ?? 0.0,
                itemRole,
                r['created_at'] as int?,
                synth,
              );
              hitsByKey.putIfAbsent(
                '$convId:$itemId',
                () => SearchHit(
                  itemId: itemId,
                  conversationId: convId,
                  provider: r['provider'] as String,
                  title: r['title'] as String,
                  role: itemRole,
                  snippet: _makeSnippet((r['text'] as String?) ?? '', token),
                  strategy: asciiTokens.isNotEmpty ? 'mixed' : 'tri',
                  score: score,
                  isSynthetic: synth,
                ),
              );
            }

            if (role == null || role == 'all') {
              final titleRows = db.select(
                '''
                SELECT c.id AS conversation_id, c.provider, COALESCE(c.title, 'Untitled') AS title,
                       c.updated_at, bm25(conv_fts_tri) AS rank_score
                FROM conv_fts_tri
                JOIN conversation c ON c.id = conv_fts_tri.rowid
                WHERE conv_fts_tri MATCH ? AND c.deleted_at IS NULL
                ${provider != null && provider != 'all' ? 'AND c.provider = ?' : ''}
                ORDER BY rank_score
                LIMIT 20
                ''',
                [ftsQuery, if (provider != null && provider != 'all') provider],
              );
              for (final r in titleRows) {
                final convId = r['conversation_id'] as int;
                hitsByKey.putIfAbsent(
                  '$convId:title',
                  () => SearchHit(
                    conversationId: convId,
                    provider: r['provider'] as String,
                    title: r['title'] as String,
                    role: 'title',
                    snippet: r['title'] as String,
                    strategy: asciiTokens.isNotEmpty ? 'mixed' : 'tri',
                    score: _rankScore(
                      (r['rank_score'] as num?)?.toDouble() ?? 0.0,
                      'user',
                      r['updated_at'] as int?,
                      false,
                    ),
                  ),
                );
              }
            }
          } else {
            final likePattern = '%${_escapeLike(token)}%';
            final likeRows = db.select(
              '''
              SELECT i.id AS item_id, i.conversation_id, i.role, i.text, i.created_at, i.is_synthetic,
                     c.provider, COALESCE(c.title, 'Untitled') AS title
              FROM item i
              JOIN conversation c ON c.id = i.conversation_id
              WHERE $filterSql AND i.text LIKE ? ESCAPE '\\'
              LIMIT 50
              ''',
              [...filterParams, likePattern],
            );
            for (final r in likeRows) {
              final itemId = r['item_id'] as int;
              final convId = r['conversation_id'] as int;
              final itemRole = r['role'] as String;
              final synth = ((r['is_synthetic'] as int?) ?? 0) == 1;
              hitsByKey.putIfAbsent(
                '$convId:$itemId',
                () => SearchHit(
                  itemId: itemId,
                  conversationId: convId,
                  provider: r['provider'] as String,
                  title: r['title'] as String,
                  role: itemRole,
                  snippet: _makeSnippet((r['text'] as String?) ?? '', token),
                  strategy: asciiTokens.isNotEmpty ? 'mixed' : 'like',
                  score: _rankScore(-1.0, itemRole, r['created_at'] as int?, synth),
                  isSynthetic: synth,
                ),
              );
            }
          }
        }

        final sorted = hitsByKey.values.toList()..sort((a, b) => b.score.compareTo(a.score));
        return sorted.take(50).toList();
      } catch (_) {}
    }

    return const [];
  }

  Future<List<BatchReport>> getBatches() async {
    final db = _getReadDb();
    if (db != null) {
      try {
        final rows = db.select(
          '''
          SELECT id, provider, kind, source_path, imported_at, status, stats_json, report_json
          FROM import_batch
          ORDER BY imported_at DESC, id DESC
          LIMIT 100
          ''',
        );
        return rows.map((r) {
          Map<String, dynamic>? report;
          final rawReport = r['report_json'] as String?;
          if (rawReport != null && rawReport.isNotEmpty) {
            try {
              final decoded = jsonDecode(rawReport);
              if (decoded is Map<String, dynamic>) report = decoded;
            } catch (_) {}
          }
          final diff = report?['diff'] as Map<String, dynamic>?;
          final rawShrunkIds = (diff?['shrunk_conversation_ids'] as List<dynamic>?) ?? const [];
          return BatchReport(
            id: r['id'] as int,
            provider: r['provider'] as String,
            kind: (r['kind'] as String?) ?? 'zip',
            sourcePath: r['source_path'] as String?,
            importedAt: r['imported_at'] as int,
            status: (r['status'] as String?) ?? 'completed',
            addedConversations: (diff?['added_conversations'] as int?) ?? 0,
            grownConversations: (diff?['grown_conversations'] as int?) ?? 0,
            shrunkConversations: (diff?['shrunk_conversations'] as int?) ?? 0,
            identicalConversations: (diff?['identical_conversations'] as int?) ?? 0,
            shrunkConversationIds: rawShrunkIds.map((e) => e.toString()).toList(),
          );
        }).toList();
      } catch (_) {}
    }

    return const [];
  }

  Future<List<DedupeCandidatePair>> getDedupeCandidates() async {
    final db = _getReadDb();
    if (db != null) {
      try {
        final rows = db.select(
          '''
          SELECT dc.id, dc.a_id, dc.b_id, dc.similarity, dc.reason, dc.status,
                 COALESCE(a.title, 'Untitled') AS a_title, a.provider AS a_provider,
                 a.head_hash AS a_head_hash, a.item_count AS a_item_count,
                 COALESCE(b.title, 'Untitled') AS b_title, b.provider AS b_provider,
                 b.head_hash AS b_head_hash, b.item_count AS b_item_count
          FROM dedupe_candidate dc
          JOIN conversation a ON dc.a_id = a.id
          JOIN conversation b ON dc.b_id = b.id
          WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
          ORDER BY dc.similarity DESC, dc.id DESC
          LIMIT 100
          ''',
        );

        List<String> loadPreview(int convId) {
          final itemRows = db.select(
            '''
            SELECT role, text FROM item
            WHERE conversation_id = ? AND is_active_branch = 1 AND is_synthetic = 0
            ORDER BY ordinal ASC
            LIMIT 4
            ''',
            [convId],
          );
          return itemRows
              .map((ir) => '${ir['role']}: ${((ir['text'] as String?) ?? '').replaceAll(RegExp(r'\s+'), ' ').trim()}')
              .toList();
        }

        return rows.map((r) {
          final aId = r['a_id'] as int;
          final bId = r['b_id'] as int;
          return DedupeCandidatePair(
            id: r['id'] as int,
            aId: aId,
            bId: bId,
            similarity: (r['similarity'] as num).toDouble(),
            reason: r['reason'] as String,
            status: r['status'] as String,
            aTitle: r['a_title'] as String,
            aProvider: r['a_provider'] as String,
            aHeadHash: r['a_head_hash'] as String?,
            aItemCount: (r['a_item_count'] as int?) ?? 0,
            aPreviewTurns: loadPreview(aId),
            bTitle: r['b_title'] as String,
            bProvider: r['b_provider'] as String,
            bHeadHash: r['b_head_hash'] as String?,
            bItemCount: (r['b_item_count'] as int?) ?? 0,
            bPreviewTurns: loadPreview(bId),
          );
        }).toList();
      } catch (_) {}
    }

    return const [];
  }

  Future<List<String>> getConversationTags(int conversationId) async {
    final db = _getReadDb();
    if (db == null) return const [];
    try {
      final rows = db.select(
        '''
        SELECT t.name
        FROM tag t
        JOIN conversation_tag ct ON ct.tag_id = t.id
        WHERE ct.conversation_id = ?
        ORDER BY t.name ASC
        ''',
        [conversationId],
      );
      return rows.map((r) => r['name'] as String).toList();
    } catch (_) {
      return const [];
    }
  }

  static int _dirSizeBytes(Directory dir) {
    if (!dir.existsSync()) return 0;
    var total = 0;
    try {
      for (final entity in dir.listSync(recursive: true, followLinks: false)) {
        if (entity is File) {
          try {
            total += entity.lengthSync();
          } catch (_) {}
        }
      }
    } catch (_) {}
    return total;
  }

  List<String> _sqliteSidecarPaths() => <String>[
        _dbPath,
        '$_dbPath-wal',
        '$_dbPath-shm',
        '$_dbPath-journal',
      ];

  List<String> _archiveCacheDirs() => <String>[
        p.join(_archiveRoot, 'blobs'),
        p.join(_archiveRoot, 'raw'),
        p.join(_archiveRoot, 'reports'),
      ];

  Future<ArchiveDiskStats> inspectArchiveStats() async {
    final dbExists = File(_dbPath).existsSync();
    var dbBytes = 0;
    for (final path in _sqliteSidecarPaths()) {
      final f = File(path);
      if (f.existsSync()) {
        try {
          dbBytes += f.lengthSync();
        } catch (_) {}
      }
    }
    var cacheBytes = 0;
    for (final dirPath in _archiveCacheDirs()) {
      cacheBytes += _dirSizeBytes(Directory(dirPath));
    }

    var conversationCount = 0;
    var batchCount = 0;
    final db = _getReadDb();
    if (db != null) {
      try {
        conversationCount = (db
                .select('SELECT COUNT(*) AS n FROM conversation WHERE deleted_at IS NULL')
                .first['n'] as num)
            .toInt();
        batchCount = (db.select('SELECT COUNT(*) AS n FROM import_batch').first['n'] as num).toInt();
      } catch (_) {
        // DB might not be migrated yet or schema differs
      }
    }

    return ArchiveDiskStats(
      dbPath: _dbPath,
      archiveRoot: _archiveRoot,
      dbExists: dbExists,
      dbBytes: dbBytes,
      cacheBytes: cacheBytes,
      conversationCount: conversationCount,
      batchCount: batchCount,
    );
  }

  /// Deletes the current archive SQLite database (plus WAL/SHM/journal sidecars)
  /// and optionally clears `blobs/`, `raw/`, and `reports/` in the same archive folder.
  /// Preserves user-exported share images (`shares/`) and original local agent files.
  Future<ArchiveResetResult> resetArchiveData({bool includeBlobsAndRaw = true}) async {
    _closeReadDb();
    _cachedShrunkIds = null;
    _subagentBackfillCache.clear();
    var deletedFiles = 0;
    var deletedDirs = 0;
    var freedBytes = 0;
    final errors = <String>[];

    for (final filePath in _sqliteSidecarPaths()) {
      final f = File(filePath);
      if (!f.existsSync()) continue;
      try {
        freedBytes += f.lengthSync();
        f.deleteSync();
        deletedFiles++;
      } catch (e) {
        errors.add('$filePath: $e');
      }
    }

    if (includeBlobsAndRaw) {
      for (final dirPath in _archiveCacheDirs()) {
        final d = Directory(dirPath);
        if (!d.existsSync()) continue;
        try {
          freedBytes += _dirSizeBytes(d);
          d.deleteSync(recursive: true);
          deletedDirs++;
        } catch (e) {
          errors.add('$dirPath: $e');
        }
      }
    }

    checkConnection();
    dbPathNotifier.value = _dbPath;

    return ArchiveResetResult(
      ok: errors.isEmpty,
      deletedFiles: deletedFiles,
      deletedDirs: deletedDirs,
      freedBytes: freedBytes,
      errorMessage: errors.isEmpty ? null : errors.join('\n'),
    );
  }
}
