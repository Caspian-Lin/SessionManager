import 'dart:convert';
import 'dart:ffi' as ffi;
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqlite3/open.dart' as sq_open;
import 'package:sqlite3/sqlite3.dart' as sq;

import 'package:ui_win/data/archive_direct_store.dart';
import 'package:ui_win/data/sm_cli_runner.dart';
import 'package:ui_win/main.dart';
import 'package:ui_win/theme.dart';
import 'package:ui_win/views/branch_reader_view.dart';
import 'package:ui_win/views/integrity_view.dart';

ffi.DynamicLibrary _openWindowsSqliteForTest() {
  final candidates = [
    'sqlite3.dll',
    r'C:\Program Files\Krita (x64)\python\sqlite3.dll',
    r'C:\Program Files\LibreOffice\program\sqlite3.dll',
    r'C:\Program Files\MySQL\MySQL Workbench 8.0\sqlite3.dll',
    r'C:\Windows\System32\winsqlite3.dll',
  ];
  for (final path in candidates) {
    if (path == 'sqlite3.dll' || File(path).existsSync()) {
      try {
        final lib = ffi.DynamicLibrary.open(path);
        // Verify sqlite3_initialize symbol exists
        lib.lookup('sqlite3_initialize');
        return lib;
      } catch (_) {}
    }
  }
  return ffi.DynamicLibrary.process();
}

const String _testSchemaSql = r'''
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE project (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  provider    TEXT,
  external_id TEXT,
  root_path   TEXT
);

CREATE TABLE import_batch (
  id              INTEGER PRIMARY KEY,
  provider        TEXT NOT NULL,
  adapter_id      TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  account_id      INTEGER,
  kind            TEXT NOT NULL,
  source_path     TEXT,
  source_sha256   TEXT NOT NULL,
  exported_at     INTEGER,
  imported_at     INTEGER NOT NULL,
  status          TEXT NOT NULL,
  stats_json      TEXT,
  report_json     TEXT
);

CREATE TABLE conversation (
  id             INTEGER PRIMARY KEY,
  provider       TEXT NOT NULL,
  account_id     INTEGER,
  external_id    TEXT,
  title          TEXT,
  title_source   TEXT,
  summary        TEXT,
  created_at     INTEGER,
  updated_at     INTEGER,
  exported_at    INTEGER,
  default_model  TEXT,
  cwd            TEXT,
  project_id     INTEGER REFERENCES project(id),
  item_count     INTEGER NOT NULL DEFAULT 0,
  char_count     INTEGER NOT NULL DEFAULT 0,
  blob_count     INTEGER NOT NULL DEFAULT 0,
  head_hash      TEXT,
  content_hash   TEXT,
  fingerprint    TEXT,
  raw_format     TEXT,
  raw_blob_sha256 TEXT,
  revision_count INTEGER NOT NULL DEFAULT 1,
  first_batch_id INTEGER,
  last_batch_id  INTEGER,
  starred        INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  deleted_at     INTEGER,
  flags_json     TEXT
);

CREATE TABLE conversation_revision (
  id              INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  batch_id        INTEGER,
  revision_no     INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  item_count      INTEGER,
  char_count      INTEGER,
  diff_json       TEXT,
  created_at      INTEGER NOT NULL
);

CREATE TABLE item (
  id               INTEGER PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  parent_id        INTEGER REFERENCES item(id) ON DELETE CASCADE,
  external_id      TEXT,
  ordinal          INTEGER NOT NULL,
  depth            INTEGER NOT NULL DEFAULT 0,
  role             TEXT NOT NULL,
  kind             TEXT NOT NULL,
  created_at       INTEGER,
  model            TEXT,
  tool_name        TEXT,
  text             TEXT,
  text_len         INTEGER NOT NULL DEFAULT 0,
  blocks_json      TEXT,
  content_hash     TEXT NOT NULL,
  is_active_branch INTEGER NOT NULL DEFAULT 1,
  is_hidden        INTEGER NOT NULL DEFAULT 0,
  is_synthetic     INTEGER NOT NULL DEFAULT 0,
  status           TEXT,
  payload_ref      TEXT,
  flags_json       TEXT
);

CREATE TABLE blob (
  id          INTEGER PRIMARY KEY,
  sha256      TEXT NOT NULL UNIQUE,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  ext         TEXT,
  width       INTEGER,
  height      INTEGER,
  duration_ms INTEGER,
  rel_path    TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE dedupe_candidate (
  id         INTEGER PRIMARY KEY,
  a_id       INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  b_id       INTEGER NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  similarity REAL NOT NULL,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  decided_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE item_fts_uni USING fts5(
  text, tool_name, content='item', content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE item_fts_tri USING fts5(
  text, content='item', content_rowid='id', tokenize='trigram'
);

CREATE VIRTUAL TABLE conv_fts_tri USING fts5(
  title, content='conversation', content_rowid='id', tokenize='trigram'
);
''';

/// Creates a real temporary SQLite archive matching `@sm/store` schema + blobs.
Directory _createTempArchiveFixture() {
  final dir = Directory.systemTemp.createTempSync('sm_ui_win_test_');
  final dbPath = p.join(dir.path, 'archive.db');
  final db = sq.sqlite3.open(dbPath);
  try {
    db.execute(_testSchemaSql);

    // Create a spilled payload blob on disk
    const spillSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    final spillRel = p.join('blobs', 'aa', '$spillSha.json');
    final spillFile = File(p.join(dir.path, spillRel));
    spillFile.parent.createSync(recursive: true);
    spillFile.writeAsStringSync('{"stdout":"spilled payload ok","exit":0}');

    final now = DateTime.now().millisecondsSinceEpoch;
    db.execute("INSERT INTO project (id, name, provider, root_path) VALUES (1, 'SessionManager', 'codex-local', 'C:/Lab/SessionManager')");

    db.execute(
      '''
      INSERT INTO import_batch (id, provider, adapter_id, adapter_version, kind, source_path, source_sha256, imported_at, status, report_json)
      VALUES (1, 'openai-web', 'openai-web', '1.0.0', 'zip', 'export.zip', 'batchsha1', ?, 'completed', ?)
      ''',
      [
        now,
        jsonEncode({
          'diff': {
            'added_conversations': 1,
            'grown_conversations': 0,
            'shrunk_conversations': 1,
            'identical_conversations': 0,
            'shrunk_conversation_ids': ['ext-conv-1'],
          }
        }),
      ],
    );

    db.execute(
      '''
      INSERT INTO conversation (id, provider, external_id, title, summary, created_at, updated_at, default_model, cwd, project_id, item_count, char_count, revision_count, starred, head_hash, flags_json)
      VALUES
        (1, 'openai-web', 'ext-conv-1', '会话归档与分支测试', 'Branching &中文检索测试', ?, ?, 'gpt-5', 'C:/Lab/SessionManager', 1, 5, 320, 2, 1, 'headhash12345678', '{"superseded_by":"ext-conv-2"}'),
        (2, 'openai-web', 'ext-conv-2', 'Archive Duplicate Candidate', 'Similar archive discussion', ?, ?, 'gpt-5', 'C:/Lab/SessionManager', 1, 2, 120, 1, 0, 'headhash99990000', NULL)
      ''',
      [now - 5000, now, now - 10000, now - 4000],
    );

    db.execute(
      '''
      INSERT INTO conversation_revision (id, conversation_id, batch_id, revision_no, content_hash, item_count, char_count, created_at)
      VALUES
        (1, 1, 1, 1, 'rev1hash', 6, 400, ?),
        (2, 1, 1, 2, 'rev2hash', 5, 320, ?)
      ''',
      [now - 5000, now],
    );

    db.execute(
      '''
      INSERT INTO blob (id, sha256, mime, bytes, ext, rel_path, origin_kind, created_at)
      VALUES (1, ?, 'application/json', 38, '.json', ?, 'oversized_payload', ?)
      ''',
      [spillSha, 'blobs/aa/$spillSha.json', now],
    );

    final blocksJson = jsonEncode([
      {'idx': 0, 'type': 'thinking', 'text': 'Checking WAL concurrency'},
      {'idx': 1, 'type': 'code', 'lang': 'dart', 'text': 'print("branch 1");'},
    ]);

    db.execute(
      '''
      INSERT INTO item (id, conversation_id, parent_id, external_id, ordinal, depth, role, kind, created_at, model, tool_name, text, text_len, blocks_json, content_hash, is_active_branch, is_synthetic, payload_ref)
      VALUES
        (1, 1, NULL, 'n1', 0, 0, 'system', 'system_note', ?, NULL, NULL, 'synthetic turn context', 22, NULL, 'h1', 1, 1, NULL),
        (2, 1, 1, 'n2', 1, 1, 'user', 'message', ?, NULL, NULL, 'Explain sqlite WAL and 架构设计', 29, NULL, 'h2', 1, 0, NULL),
        (3, 1, 2, 'n3', 2, 2, 'assistant', 'message', ?, 'gpt-5', NULL, 'Primary active branch response', 30, ?, 'h3', 1, 0, NULL),
        (4, 1, 2, 'n4', 3, 2, 'assistant', 'message', ?, 'gpt-5', NULL, 'Regenerated sibling branch response', 35, NULL, 'h4', 0, 0, NULL),
        (5, 1, 3, 'n5', 4, 3, 'tool', 'tool_call', ?, NULL, 'exec_command', 'ran tool command', 16, NULL, 'h5', 1, 0, ?),
        (6, 2, NULL, 'm1', 0, 0, 'user', 'message', ?, NULL, NULL, 'Duplicate candidate turn one', 28, NULL, 'h6', 1, 0, NULL)
      ''',
      [now - 4000, now - 3000, now - 2000, blocksJson, now - 1500, now - 1000, spillSha, now - 4000],
    );

    db.execute(
      '''
      INSERT INTO dedupe_candidate (id, a_id, b_id, similarity, reason, status, created_at)
      VALUES (1, 1, 2, 0.86, 'minhash_jaccard_0.86', 'open', ?)
      ''',
      [now],
    );

    db.execute("INSERT INTO item_fts_uni(item_fts_uni) VALUES('rebuild');");
    db.execute("INSERT INTO item_fts_tri(item_fts_tri) VALUES('rebuild');");
    db.execute("INSERT INTO conv_fts_tri(conv_fts_tri) VALUES('rebuild');");
  } finally {
    db.dispose();
  }
  return dir;
}

void main() {
  if (Platform.isWindows) {
    sq_open.open.overrideFor(sq_open.OperatingSystem.windows, _openWindowsSqliteForTest);
  }
  test('ArchiveDirectStore reads real SQLite schema, FTS5 dual-index, revisions, dedupe, and spilled blobs', () async {
    final dir = _createTempArchiveFixture();
    final store = ArchiveDirectStore(archiveDir: dir.path);
    try {
      expect(store.isConnectedNotifier.value, isTrue);

      final projects = await store.getProjects();
      expect(projects.length, 1);
      expect(projects.first.name, 'SessionManager');

      final allConvs = await store.getConversations();
      expect(allConvs.length, 2);

      final shrunkOnly = await store.getConversations(shrunkOnly: true);
      expect(shrunkOnly.length, 1);
      expect(shrunkOnly.first.id, 1);
      expect(shrunkOnly.first.isShrunk, isTrue);

      final detail = await store.getConversationDetail(1);
      expect(detail, isNotNull);
      expect(detail!.revisions.length, 2);
      expect(detail.supersededBy, 'ext-conv-2');
      expect(detail.items.length, 5);
      expect(detail.childrenByParent[2]?.length, 2);
      expect(detail.items[2].blocks.length, 2);
      expect(detail.items[2].blocks[0].type, 'thinking');
      expect(detail.items[2].blocks[1].type, 'code');

      // Dual-index search: English (uni), 3-char CJK (tri), 2-char CJK (like)
      final enHits = await store.search('Primary');
      expect(enHits.any((h) => h.conversationId == 1 && h.strategy == 'uni'), isTrue);

      final cjk3Hits = await store.search('分支测');
      expect(cjk3Hits.any((h) => h.conversationId == 1 && h.strategy == 'tri'), isTrue);

      final cjk2Hits = await store.search('架构');
      expect(cjk2Hits.any((h) => h.conversationId == 1 && h.strategy == 'like'), isTrue);

      // Spilled blob resolution & lazy read (both bare <sha256> and blob:<sha256>)
      final payloadRef = detail.items.last.payloadRef!;
      final payloadBare = await store.readSpilledPayload(payloadRef);
      expect(payloadBare, contains('spilled payload ok'));
      final payloadPrefixed = await store.readSpilledPayload('blob:$payloadRef');
      expect(payloadPrefixed, contains('spilled payload ok'));

      final batches = await store.getBatches();
      expect(batches.length, 1);
      expect(batches.first.shrunkConversations, 1);
      expect(batches.first.shrunkConversationIds, ['ext-conv-1']);

      final candidates = await store.getDedupeCandidates();
      expect(candidates.length, 1);
      expect(candidates.first.similarity, closeTo(0.86, 0.001));
    } finally {
      store.dispose();
      dir.deleteSync(recursive: true);
    }
  });

  test('WinAdaptiveTheme builds Material 3 light & dark themes with Windows typography', () {
    final light = WinAdaptiveTheme.light();
    final dark = WinAdaptiveTheme.dark();
    expect(light.useMaterial3, isTrue);
    expect(dark.useMaterial3, isTrue);
    expect(light.visualDensity, VisualDensity.compact);
    expect(light.colorScheme.primary, WinAdaptiveTheme.winLightAccent);
    expect(dark.colorScheme.primary, WinAdaptiveTheme.winDarkAccent);
  });

  testWidgets('BranchTreeReaderView switches branches (< Branch 1 / 2 >), folds synthetic, and loads spilled blob',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    final dir = _createTempArchiveFixture();
    final store = ArchiveDirectStore(archiveDir: dir.path);
    addTearDown(() {
      store.dispose();
      try {
        dir.deleteSync(recursive: true);
      } catch (_) {}
    });

    await tester.pumpWidget(
      MaterialApp(
        theme: WinAdaptiveTheme.dark(),
        home: Scaffold(
          body: BranchTreeReaderView(
            store: store,
            refreshTick: ValueNotifier<int>(0),
            conversationId: 1,
            onSelectOtherSession: (_) {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Synthetic item collapsed by default
    expect(find.textContaining('1 synthetic orchestration item(s) collapsed'), findsOneWidget);
    expect(find.text('synthetic turn context'), findsNothing);

    // Branch selector pill shown on fork (Branch 1 / 2)
    expect(find.text('Branch 1 / 2'), findsOneWidget);
    expect(find.text('Reasoning / Thinking'), findsOneWidget);
    expect(find.text('print("branch 1");'), findsOneWidget);

    // Switch to sibling regenerate branch (Branch 2 / 2)
    await tester.tap(find.byIcon(Icons.chevron_right));
    await tester.pumpAndSettle();
    expect(find.text('Branch 2 / 2'), findsOneWidget);
    expect(find.text('Regenerated sibling branch response'), findsOneWidget);

    // Switch back to Branch 1 / 2 and expand synthetic banner + spilled payload
    await tester.tap(find.byIcon(Icons.chevron_left));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('1 synthetic orchestration item(s) collapsed'));
    await tester.pumpAndSettle();
    expect(find.text('synthetic turn context'), findsOneWidget);

    final loadBlobBtn = find.textContaining('Load full payload from blob');
    expect(loadBlobBtn, findsOneWidget);
    await tester.ensureVisible(loadBlobBtn);
    await tester.tap(loadBlobBtn);
    await tester.pumpAndSettle();
    expect(find.textContaining('spilled payload ok'), findsOneWidget);
  });

  testWidgets('IntegrityReportView renders shrunk alert, clickable ID, and side-by-side dedupe comparison',
      (WidgetTester tester) async {
    final dir = _createTempArchiveFixture();
    final store = ArchiveDirectStore(archiveDir: dir.path);
    final cliRunner = SmCliRunner(store: store);
    int? openedId;
    addTearDown(() {
      cliRunner.dispose();
      store.dispose();
      dir.deleteSync(recursive: true);
    });

    await tester.pumpWidget(
      MaterialApp(
        theme: WinAdaptiveTheme.light(),
        home: Scaffold(
          body: IntegrityReportView(
            store: store,
            cliRunner: cliRunner,
            refreshTick: ValueNotifier<int>(0),
            onDataChanged: () {},
            onOpenConversation: (id) => openedId = id,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('SHRINK ALERT: 1 Conversation(s) Lost Items Upstream'), findsOneWidget);
    expect(find.text('86.0% Similarity'), findsOneWidget);
    expect(find.text('Conversation A (#1)'), findsOneWidget);
    expect(find.text('Conversation B (#2)'), findsOneWidget);

    await tester.tap(find.text('ext-conv-1'));
    await tester.pumpAndSettle();
    expect(openedId, 1);
  });

  testWidgets('SessionManagerApp renders wide desktop shell with SQLite WAL Read-Only badge',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1400, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    final dir = _createTempArchiveFixture();
    final store = ArchiveDirectStore(archiveDir: dir.path);
    final cliRunner = SmCliRunner(store: store);
    addTearDown(() {
      cliRunner.dispose();
      store.dispose();
      dir.deleteSync(recursive: true);
    });

    await tester.pumpWidget(SessionManagerApp(storeOverride: store, cliRunnerOverride: cliRunner));
    await tester.pumpAndSettle();

    expect(find.text('SQLite WAL Read-Only'), findsOneWidget);
    expect(find.text('Archived Sessions'), findsOneWidget);
    expect(find.text('会话归档与分支测试'), findsOneWidget);
  });
}
