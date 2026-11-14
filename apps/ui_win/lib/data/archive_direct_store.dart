import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:sqlite3/sqlite3.dart' as sq;

import '../models.dart';

/// CQRS Read Path: Direct SQLite WAL read-only access (`OpenMode.readOnly`)
/// plus zero-copy local `blobs/` file resolution.
class ArchiveDirectStore {
  static const String _envDefineDir = String.fromEnvironment('SM_ARCHIVE_DIR');

  late String _dbPath;
  late String _archiveRoot;
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
    _dbPath = resolvedDbPath;
    _archiveRoot = p.dirname(resolvedDbPath);
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
    final candidates = [
      p.join(Directory.current.path, 'archive', 'archive.db'),
      p.join(Directory.current.path, 'archive.db'),
    ];
    for (final c in candidates) {
      if (File(c).existsSync()) return c;
    }
    return candidates.last;
  }

  void dispose() {
    isConnectedNotifier.dispose();
    dbPathNotifier.dispose();
  }

  sq.Database? _openReadOnlyDb() {
    if (!File(_dbPath).existsSync()) {
      isConnectedNotifier.value = false;
      return null;
    }
    try {
      final db = sq.sqlite3.open(_dbPath, mode: sq.OpenMode.readOnly);
      db.execute('PRAGMA busy_timeout = 3000;');
      db.execute('PRAGMA query_only = ON;');
      isConnectedNotifier.value = true;
      return db;
    } catch (_) {
      isConnectedNotifier.value = false;
      return null;
    }
  }

  bool checkConnection() {
    final db = _openReadOnlyDb();
    if (db == null) return false;
    db.dispose();
    return true;
  }

  Set<String> _loadShrunkIdSet(sq.Database db) {
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
      final db = _openReadOnlyDb();
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
        } finally {
          db.dispose();
        }
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
    final db = _openReadOnlyDb();
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
      } finally {
        db.dispose();
      }
    }
    return const [];
  }

  Future<List<ConversationSummary>> getConversations({
    String? provider,
    int? projectId,
    bool starredOnly = false,
    bool shrunkOnly = false,
    String? searchFilter,
    SmSortBy sortBy = SmSortBy.updatedDesc,
    int limit = 200,
    int offset = 0,
  }) async {
    final db = _openReadOnlyDb();
    if (db != null) {
      try {
        final shrunkIds = _loadShrunkIdSet(db);
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
                 c.project_id, p.name AS project_name,
                 c.item_count, c.char_count, c.blob_count, c.revision_count,
                 c.starred, c.updated_at, c.head_hash, c.flags_json
          FROM conversation c
          LEFT JOIN project p ON c.project_id = p.id
          WHERE ${where.join(' AND ')}
          ORDER BY $orderClause
          LIMIT ? OFFSET ?
        ''';
        params.add(limit);
        params.add(offset);

        final rows = db.select(sql, params);
        final list = rows.map((r) {
          final id = r['id'] as int;
          final extId = r['external_id'] as String?;
          String? supersededBy;
          final flagsRaw = r['flags_json'] as String?;
          if (flagsRaw != null && flagsRaw.isNotEmpty) {
            try {
              final decoded = jsonDecode(flagsRaw);
              if (decoded is Map<String, dynamic>) {
                supersededBy = decoded['superseded_by']?.toString();
              }
            } catch (_) {}
          }
          final isShrunk = shrunkIds.contains(id.toString()) || (extId != null && shrunkIds.contains(extId));
          return ConversationSummary(
            id: id,
            provider: r['provider'] as String,
            externalId: extId,
            title: (r['title'] as String?) ?? 'Untitled',
            summary: r['summary'] as String?,
            cwd: r['cwd'] as String?,
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

        if (shrunkOnly) {
          return list.where((c) => c.isShrunk).toList();
        }
        return list;
      } finally {
        db.dispose();
      }
    }

    // Demo fallback when archive.db is not yet present on disk
    final now = DateTime.now().millisecondsSinceEpoch;
    final demos = [
      ConversationSummary(
        id: 1,
        provider: 'openai-web',
        externalId: 'demo-conv-1',
        title: 'Architecting local AI conversation archive',
        summary: 'CQRS hybrid direct SQLite read-only + on-demand CLI runner',
        cwd: 'C:/Projects/SessionManager',
        itemCount: 5,
        charCount: 1420,
        blobCount: 1,
        revisionCount: 2,
        starred: true,
        updatedAt: now - 3600000,
        headHash: 'a7f3b8912c44e901',
        isShrunk: true,
      ),
      ConversationSummary(
        id: 2,
        provider: 'codex-local',
        externalId: 'demo-conv-2',
        title: 'Codex rollout session refactoring',
        summary: 'Analyzed thread_history_1.sqlite items and >32KB payload spilling',
        cwd: 'C:/Projects/SessionManager',
        itemCount: 38,
        charCount: 18400,
        blobCount: 3,
        revisionCount: 1,
        updatedAt: now - 7200000,
        headHash: 'b829d11e90ac1204',
      ),
      ConversationSummary(
        id: 3,
        provider: 'dsh-local',
        externalId: 'demo-conv-3',
        title: 'Streaming chunk aggregation pipeline',
        summary: 'Handling multi-frame zstd with fzstd decompressor',
        itemCount: 8,
        charCount: 4120,
        updatedAt: now - 18000000,
        headHash: 'c310a77f29b40091',
      ),
    ];

    return demos.where((c) {
      if (provider != null && provider.isNotEmpty && provider != 'all' && c.provider != provider) return false;
      if (starredOnly && !c.starred) return false;
      if (shrunkOnly && !c.isShrunk) return false;
      if (searchFilter != null && searchFilter.trim().isNotEmpty) {
        final q = searchFilter.trim().toLowerCase();
        if (!c.title.toLowerCase().contains(q) && !(c.summary?.toLowerCase().contains(q) ?? false)) {
          return false;
        }
      }
      return true;
    }).toList();
  }

  Future<int?> resolveConversationId(String idOrExternalId) async {
    final db = _openReadOnlyDb();
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
      } finally {
        db.dispose();
      }
      return null;
    }
    return int.tryParse(idOrExternalId) ?? 1;
  }

  Future<ConversationDetail?> getConversationDetail(int id) async {
    final db = _openReadOnlyDb();
    if (db != null) {
      try {
        final convRows = db.select(
          '''
          SELECT id, provider, external_id, title, head_hash, default_model, cwd, revision_count, flags_json
          FROM conversation
          WHERE id = ? AND deleted_at IS NULL
          LIMIT 1
          ''',
          [id],
        );
        if (convRows.isEmpty) return null;
        final conv = convRows.first;

        String? convSupersededBy;
        final convFlags = conv['flags_json'] as String?;
        if (convFlags != null && convFlags.isNotEmpty) {
          try {
            final decoded = jsonDecode(convFlags);
            if (decoded is Map<String, dynamic>) {
              convSupersededBy = decoded['superseded_by']?.toString();
            }
          } catch (_) {}
        }

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

        final items = itemRows.map((r) {
          final rawBlocks = r['blocks_json'] as String?;
          List<ViewBlock> decodedBlocks = const [];
          if (rawBlocks != null && rawBlocks.isNotEmpty) {
            try {
              final parsed = jsonDecode(rawBlocks);
              if (parsed is List) {
                var idx = 0;
                decodedBlocks = parsed
                    .whereType<Map<String, dynamic>>()
                    .map((m) => ViewBlock.fromJson(m, fallbackIdx: idx++))
                    .toList();
              }
            } catch (_) {}
          }

          String? itemSupersededBy;
          final rawItemFlags = r['flags_json'] as String?;
          if (rawItemFlags != null && rawItemFlags.isNotEmpty) {
            try {
              final decoded = jsonDecode(rawItemFlags);
              if (decoded is Map<String, dynamic>) {
                itemSupersededBy = decoded['superseded_by']?.toString();
              }
            } catch (_) {}
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
            blocks: decodedBlocks,
            payloadRef: r['payload_ref'] as String?,
            createdAt: r['created_at'] as int?,
            isActiveBranch: ((r['is_active_branch'] as int?) ?? 1) == 1,
            isHidden: ((r['is_hidden'] as int?) ?? 0) == 1,
            isSynthetic: ((r['is_synthetic'] as int?) ?? 0) == 1,
            status: r['status'] as String?,
            supersededBy: itemSupersededBy,
          );
        }).toList();

        return ConversationDetail(
          id: conv['id'] as int,
          provider: conv['provider'] as String,
          externalId: conv['external_id'] as String?,
          title: (conv['title'] as String?) ?? 'Untitled',
          headHash: conv['head_hash'] as String?,
          defaultModel: conv['default_model'] as String?,
          cwd: conv['cwd'] as String?,
          revisionCount: (conv['revision_count'] as int?) ?? 1,
          supersededBy: convSupersededBy,
          revisions: revisions,
          items: items,
        );
      } finally {
        db.dispose();
      }
    }

    // Demo fallback with branch tree + synthetic run + rich blocks
    final now = DateTime.now().millisecondsSinceEpoch;
    return ConversationDetail(
      id: id,
      provider: 'openai-web',
      externalId: 'demo-conv-$id',
      title: 'Architecting local AI conversation archive',
      headHash: 'a7f3b8912c44e901',
      defaultModel: 'gpt-5',
      cwd: 'C:/Projects/SessionManager',
      revisionCount: 2,
      revisions: [
        ConversationRevisionInfo(
          id: 2,
          revisionNo: 2,
          batchId: 2,
          contentHash: 'a7f3b8912c44e901',
          itemCount: 5,
          charCount: 1420,
          createdAt: now - 3600000,
        ),
        ConversationRevisionInfo(
          id: 1,
          revisionNo: 1,
          batchId: 1,
          contentHash: '91ab0023ff110022',
          itemCount: 6,
          charCount: 1680,
          createdAt: now - 86400000,
        ),
      ],
      items: [
        const MessageItem(
          id: 10,
          parentId: null,
          ordinal: 0,
          depth: 0,
          role: 'system',
          kind: 'system_note',
          text: '<turn_context cwd="C:/Projects/SessionManager" git_branch="main"/>',
          isActiveBranch: true,
          isSynthetic: true,
        ),
        const MessageItem(
          id: 11,
          parentId: 10,
          ordinal: 1,
          depth: 1,
          role: 'user',
          kind: 'message',
          text: r'How should we architect SessionManager and compute $$H(m) = \text{sha256}(text)$$ without a resident daemon?',
          isActiveBranch: true,
          isSynthetic: false,
        ),
        const MessageItem(
          id: 12,
          parentId: 11,
          ordinal: 2,
          depth: 2,
          role: 'assistant',
          kind: 'message',
          model: 'gpt-5',
          text: 'We use CQRS Hybrid Direct-Connection: Dart sqlite3 FFI read-only queries + on-demand sm CLI.',
          blocks: [
            ViewBlock(
              idx: 0,
              type: 'thinking',
              text: 'Comparing local HTTP server overhead vs WAL read-only direct SQLite access on Windows.',
            ),
            ViewBlock(
              idx: 1,
              type: 'text',
              text: 'Adopt **CQRS Hybrid Direct-Connection**: read `archive.db` directly via `sqlite3.open(..., mode: OpenMode.readOnly)` and invoke `sm --json` only for writes.',
            ),
            ViewBlock(
              idx: 2,
              type: 'code',
              lang: 'dart',
              text: "final db = sqlite3.open(dbPath, mode: OpenMode.readOnly);\ndb.execute('PRAGMA busy_timeout = 3000;');",
            ),
          ],
          isActiveBranch: true,
          isSynthetic: false,
        ),
        const MessageItem(
          id: 13,
          parentId: 11,
          ordinal: 3,
          depth: 2,
          role: 'assistant',
          kind: 'message',
          model: 'gpt-5',
          text: '[Alternative regenerate branch]: Using a local daemon adds firewall prompts and token plumbing.',
          isActiveBranch: false,
          isSynthetic: false,
          supersededBy: 'item:12',
        ),
        const MessageItem(
          id: 14,
          parentId: 12,
          ordinal: 4,
          depth: 3,
          role: 'tool',
          kind: 'tool_call',
          toolName: 'exec_command',
          text: 'npx vitest run',
          blocks: [
            ViewBlock(
              idx: 0,
              type: 'tool_use',
              toolName: 'exec_command',
              toolInput: '{"cmd":"npx vitest run"}',
              status: 'ok',
            ),
          ],
          isActiveBranch: true,
          isSynthetic: false,
        ),
      ],
    );
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

    final db = _openReadOnlyDb();
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
      } finally {
        db.dispose();
      }
    }

    return const [
      SearchHit(
        itemId: 11,
        conversationId: 1,
        provider: 'openai-web',
        title: 'Architecting local AI conversation archive',
        role: 'user',
        snippet: '...architect SessionManager and compute sha256 without a resident daemon...',
        strategy: 'uni',
        score: 1.42,
      ),
    ];
  }

  Future<List<BatchReport>> getBatches() async {
    final db = _openReadOnlyDb();
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
      } finally {
        db.dispose();
      }
    }

    return [
      BatchReport(
        id: 1,
        provider: 'openai-web',
        kind: 'zip',
        sourcePath: 'demo-export-2026-11.zip',
        importedAt: DateTime.now().millisecondsSinceEpoch - 86400000,
        status: 'completed',
        addedConversations: 120,
        grownConversations: 15,
        shrunkConversations: 1,
        identicalConversations: 430,
        shrunkConversationIds: const ['demo-conv-1'],
      ),
    ];
  }

  Future<List<DedupeCandidatePair>> getDedupeCandidates() async {
    final db = _openReadOnlyDb();
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
      } finally {
        db.dispose();
      }
    }

    return const [
      DedupeCandidatePair(
        id: 1,
        aId: 1,
        bId: 2,
        similarity: 0.84,
        reason: 'minhash_jaccard_0.84',
        status: 'open',
        aTitle: 'Architecting local AI conversation archive (March Export)',
        aProvider: 'openai-web',
        aHeadHash: 'a7f3b8912c44e901',
        aItemCount: 14,
        aPreviewTurns: [
          'user: How do we prevent SQLite bloat on 3MB inline tool results?',
          'assistant: Spill payloads > 32KB into content-addressed blobs/.',
        ],
        bTitle: 'Architecting local AI conversation archive (Nov Export)',
        bProvider: 'openai-web',
        bHeadHash: '91ab0023ff110022',
        bItemCount: 16,
        bPreviewTurns: [
          'user: How do we prevent SQLite bloat on 3MB inline tool results?',
          'assistant: Spill payloads > 32KB into blobs/ and keep payload_ref.',
        ],
      ),
    ];
  }
}
