import 'dart:convert';
import 'dart:ffi' as ffi;
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqlite3/open.dart' as sq_open;
import 'package:sqlite3/sqlite3.dart' as sq;

import 'package:ui_win/data/app_settings.dart';
import 'package:ui_win/data/archive_direct_store.dart';
import 'package:ui_win/data/local_agent_discovery.dart';
import 'package:ui_win/data/perf_logger.dart';
import 'package:ui_win/data/sm_cli_runner.dart';
import 'package:ui_win/l10n/app_strings.dart';
import 'package:ui_win/main.dart';
import 'package:ui_win/models.dart';
import 'package:ui_win/theme.dart';
import 'package:ui_win/views/branch_reader_view.dart';
import 'package:ui_win/views/import_view.dart';
import 'package:ui_win/views/integrity_view.dart';
import 'package:ui_win/views/session_list_view.dart';
import 'package:ui_win/views/settings_view.dart';
import 'package:ui_win/widgets/markdown_prose.dart';
import 'package:ui_win/widgets/share_image_sheet.dart';

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

      final writableDb = sq.sqlite3.open(store.dbPath);
      try {
        writableDb.execute(
          "UPDATE blob SET rel_path = 'raw/moved.dat', ext = '.dat' WHERE sha256 = ?",
          [payloadRef],
        );
      } finally {
        writableDb.dispose();
      }
      expect(await store.readSpilledPayload(payloadRef), payloadBare);

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

  test('GoogleMaterialTheme builds Material 3 light & dark flat themes with Google Blue seed', () {
    final light = GoogleMaterialTheme.light();
    final dark = GoogleMaterialTheme.dark();
    expect(light.useMaterial3, isTrue);
    expect(dark.useMaterial3, isTrue);
    expect(light.brightness, Brightness.light);
    expect(dark.brightness, Brightness.dark);
    expect(light.navigationRailTheme.indicatorShape, const StadiumBorder());
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
      AppStringsScope(
        notifier: ValueNotifier<AppLocale>(AppLocale.en),
        child: MaterialApp(
          theme: GoogleMaterialTheme.dark(),
          home: Scaffold(
            body: BranchTreeReaderView(
              store: store,
              refreshTick: ValueNotifier<int>(0),
              conversationId: 1,
              onSelectOtherSession: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Process & synthetic steps collapsed by default into 1-line bars
    expect(find.textContaining('Thinking & tool process (1 sys)'), findsOneWidget);
    expect(find.textContaining('Thinking & tool process (1 thinking)'), findsOneWidget);
    expect(find.textContaining('Thinking & tool process (1 tool call(s))'), findsOneWidget);
    expect(find.text('synthetic turn context'), findsNothing);
    expect(find.text('Checking WAL concurrency'), findsNothing);

    // Branch selector pill shown on fork (Branch 1 / 2), action icons only under final reply
    expect(find.text('Branch 1 / 2'), findsOneWidget);
    expect(find.text('print("branch 1");'), findsOneWidget);
    expect(find.byTooltip('Copy'), findsOneWidget);

    // Switch to sibling regenerate branch (Branch 2 / 2)
    await tester.tap(find.byIcon(Icons.chevron_right).last);
    await tester.pumpAndSettle();
    expect(find.text('Branch 2 / 2'), findsOneWidget);
    expect(find.text('Regenerated sibling branch response'), findsOneWidget);

    // Open dedicated Branch View (分支视图) and switch back to Branch 1 / 2
    await tester.tap(find.textContaining('Branches (1)'));
    await tester.pumpAndSettle();
    expect(find.text('Branch & Revision Topology'), findsOneWidget);
    await tester.tap(find.text('Read This Branch').first);
    await tester.pumpAndSettle();
    expect(find.text('Branch 1 / 2'), findsOneWidget);

    // Expand collapsed 1-line process bars to reveal synthetic, thinking, and spilled blob
    await tester.tap(find.textContaining('Thinking & tool process (1 sys)'));
    await tester.pumpAndSettle();
    expect(find.text('synthetic turn context'), findsOneWidget);

    await tester.tap(find.textContaining('Thinking & tool process (1 thinking)'));
    await tester.pumpAndSettle();
    expect(find.text('Checking WAL concurrency'), findsOneWidget);

    final toolBar = find.textContaining('Thinking & tool process (1 tool call(s))');
    await tester.ensureVisible(toolBar);
    await tester.tap(toolBar);
    await tester.pumpAndSettle();

    // Second-level collapse: tap the 1-line tool call item to expand its body & blob button
    final toolStepRow = find.textContaining('tool_call');
    await tester.ensureVisible(toolStepRow.first);
    await tester.tap(toolStepRow.first);
    await tester.pumpAndSettle();

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
      AppStringsScope(
        notifier: ValueNotifier<AppLocale>(AppLocale.en),
        child: MaterialApp(
          theme: GoogleMaterialTheme.light(),
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
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('Alert: 1 Conversation(s) Shrunk Upstream'), findsOneWidget);
    expect(find.text('86.0% Similarity'), findsOneWidget);
    expect(find.text('Conversation A (#1)'), findsOneWidget);
    expect(find.text('Conversation B (#2)'), findsOneWidget);

    await tester.tap(find.text('ext-conv-1'));
    await tester.pumpAndSettle();
    expect(openedId, 1);
  });

  testWidgets('SessionManagerApp supports Google M3 flat shell, 中文/EN switch, and Import Hub discovery',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    final dir = _createTempArchiveFixture();
    final store = ArchiveDirectStore(archiveDir: dir.path);
    final cliRunner = SmCliRunner(store: store);
    final mockInstances = [
      const LocalAgentInstance(
        provider: 'codex-local',
        displayName: 'Codex CLI',
        installMethod: 'User Home (~/.codex)',
        path: r'C:\Users\demo\.codex\sessions',
        supportedForImport: true,
        sessionFileCount: 18,
        hasSqliteDb: true,
        totalBytes: 204800,
      ),
      const LocalAgentInstance(
        provider: 'opencode-local',
        displayName: 'OpenCode',
        installMethod: 'XDG Data',
        path: r'C:\Users\demo\.local\share\opencode',
        supportedForImport: false,
        sessionFileCount: 4,
        hasSqliteDb: false,
        totalBytes: 4096,
      ),
    ];
    addTearDown(() {
      cliRunner.dispose();
      store.dispose();
      dir.deleteSync(recursive: true);
    });

    await tester.pumpWidget(
      SessionManagerApp(
        storeOverride: store,
        cliRunnerOverride: cliRunner,
        discoveryOverride: _FakeDiscoveryService(mockInstances),
      ),
    );
    await tester.pumpAndSettle();

    // Default Chinese UI
    expect(find.text('SQLite WAL 直连'), findsNothing);
    expect(find.text('归档会话'), findsOneWidget);
    expect(find.text('会话归档与分支测试'), findsOneWidget);

    // Switch language to EN via Settings view (titlebar switcher removed)
    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();
    expect(find.text('SQLite WAL Direct'), findsNothing);
    expect(find.text('Settings & Diagnostics'), findsOneWidget);

    await tester.tap(find.text('Sessions'));
    await tester.pumpAndSettle();
    expect(find.text('Archived Sessions'), findsOneWidget);

    // Navigate to Import Hub tab
    await tester.tap(find.text('Import'));
    await tester.pumpAndSettle();
    expect(find.text('Import & Local Sync Hub'), findsOneWidget);
    expect(find.text('Codex CLI'), findsOneWidget);
    expect(find.text('OpenCode'), findsOneWidget);
    expect(find.text('One-Click Import / Sync'), findsOneWidget);
    expect(find.text('Probe'), findsOneWidget);

    // Switch guided source to Claude Web
    await tester.tap(find.text('Claude Web'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Claude.ai'), findsOneWidget);
  });

  test('ArchiveDirectStore does not emit demo fallback when DB does not exist', () async {
    final emptyDir = Directory.systemTemp.createTempSync('sm-empty-real-');
    final store = ArchiveDirectStore(archiveDir: emptyDir.path);
    try {
      expect(store.isConnectedNotifier.value, isFalse);
      expect(await store.getConversations(), isEmpty);
      expect(await store.getConversationDetail(1), isNull);
      expect(await store.getBatches(), isEmpty);
      expect(await store.getDedupeCandidates(), isEmpty);
    } finally {
      store.dispose();
      emptyDir.deleteSync(recursive: true);
    }
  });

  test('Share long image helpers filter tool details, single turn vs full, and auto-split tall sessions (Issue #35)', () {
    final items = <MessageItem>[
      MessageItem(id: 1, ordinal: 0, role: 'user', kind: 'message', text: 'First question', isActiveBranch: true, isSynthetic: false),
      MessageItem(
        id: 2,
        ordinal: 1,
        role: 'assistant',
        kind: 'message',
        text: 'First reply',
        isActiveBranch: true,
        isSynthetic: false,
        blocks: [
          ViewBlock(idx: 0, type: 'thinking', text: 'Internal chain of thought'),
          ViewBlock(idx: 1, type: 'text', text: 'First reply body'),
        ],
      ),
      MessageItem(
        id: 3,
        ordinal: 2,
        role: 'tool',
        kind: 'tool_call',
        toolName: 'exec_command',
        text: 'echo ok',
        isActiveBranch: true,
        isSynthetic: false,
      ),
      MessageItem(id: 4, ordinal: 3, role: 'user', kind: 'message', text: 'Second question', isActiveBranch: true, isSynthetic: false),
      MessageItem(
        id: 5,
        ordinal: 4,
        role: 'assistant',
        kind: 'message',
        text: 'Second reply',
        isActiveBranch: true,
        isSynthetic: false,
      ),
    ];

    // Full conversation without tool details hides tool item & thinking block
    final cleanFull = filterShareMessages(
      items,
      scope: ShareScopeMode.fullConversation,
      includeToolDetails: false,
    );
    expect(cleanFull.map((e) => e.id).toList(), [1, 2, 4, 5]);
    expect(cleanFull[1].blocks.any((b) => b.type == 'thinking'), isFalse);

    // Single turn with tool details includes preceding prompt + assistant + follow-up tool item
    final singleWithTools = filterShareMessages(
      items,
      scope: ShareScopeMode.singleTurn,
      targetAssistantId: 2,
      includeToolDetails: true,
    );
    expect(singleWithTools.map((e) => e.id).toList(), [1, 2, 3]);
    expect(singleWithTools[1].blocks.any((b) => b.type == 'thinking'), isTrue);

    // Long multi-turn session splits into multiple slices when exceeding maxBodyHeight
    final longItems = [
      for (var i = 0; i < 12; i++)
        MessageItem(
          id: 100 + i,
          ordinal: i,
          role: i.isEven ? 'user' : 'assistant',
          kind: 'message',
          isActiveBranch: true,
          isSynthetic: false,
          text: List.filled(25, 'Line $i: Detailed analysis of digital RTL design and verification.').join('\n'),
        ),
    ];
    final slices = buildShareSlices(longItems, maxBodyHeight: 1600.0);
    expect(slices.length, greaterThan(1));
    expect(slices.first.total, slices.length);
  });

  testWidgets('BranchTreeReaderView opens Share Long Image dialog with scope & tool toggle (Issue #35)',
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
      AppStringsScope(
        notifier: ValueNotifier<AppLocale>(AppLocale.en),
        child: MaterialApp(
          theme: GoogleMaterialTheme.dark(),
          home: Scaffold(
            body: BranchTreeReaderView(
              store: store,
              refreshTick: ValueNotifier<int>(0),
              conversationId: 1,
              onSelectOtherSession: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byTooltip('Share Long Image').first);
    await tester.pumpAndSettle();

    expect(find.text('Export Shareable Long Image (PNG)'), findsOneWidget);
    expect(find.text('Full Conversation'), findsOneWidget);
    expect(find.text('Single Agent Reply'), findsOneWidget);
    expect(find.text('Include Thinking & Tool Call Details'), findsOneWidget);

    await tester.tap(find.text('Single Agent Reply'));
    await tester.pumpAndSettle();
    expect(find.text('Select Agent Reply Turn'), findsOneWidget);
  });

  test('LocalAgentDiscoveryService detects multiple simultaneous install methods and skips noisy sandbox subdirs (CC Switch pattern)', () async {
    final sandboxHome = Directory.systemTemp.createTempSync('sm-discovery-test-');
    try {
      final homeDir = Directory(p.join(sandboxHome.path, 'home'))..createSync();
      final appDataDir = Directory(p.join(sandboxHome.path, 'appdata'))..createSync();
      final localAppDataDir = Directory(p.join(sandboxHome.path, 'localappdata'))..createSync();
      final npmDir = Directory(p.join(appDataDir.path, 'npm'))..createSync(recursive: true);
      final localBinDir = Directory(p.join(homeDir.path, '.local', 'bin'))..createSync(recursive: true);

      // Simulate simultaneous npm .cmd AND native binary for Codex, plus noisy .sandbox & real rollout session
      File(p.join(npmDir.path, 'codex.cmd')).writeAsStringSync('@echo off\r\n');
      File(p.join(localBinDir.path, 'codex.exe')).writeAsBytesSync(const [0]);
      final codexSessionDir = Directory(p.join(homeDir.path, '.codex', 'sessions', '2026', '11'))
        ..createSync(recursive: true);
      Directory(p.join(homeDir.path, '.codex', '.sandbox-bin')).createSync(recursive: true);
      File(p.join(codexSessionDir.path, 'rollout-001.jsonl')).writeAsStringSync('{}\n');

      // Simulate DSH with dsh-runtimes embedded binary + session.v4.jsonl.zstd
      Directory(p.join(homeDir.path, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime')).createSync(recursive: true);
      final dshSessDir = Directory(p.join(homeDir.path, '.dsh', 'sessions', 'proj-a', 's1'))
        ..createSync(recursive: true);
      File(p.join(dshSessDir.path, 'session.v4.jsonl.zstd')).writeAsBytesSync(const [1, 2, 3]);

      // Simulate Claude Code with both settings + session jsonl
      final claudeProjDir = Directory(p.join(homeDir.path, '.claude', 'projects', 'repo-x'))
        ..createSync(recursive: true);
      File(p.join(claudeProjDir.path, 'conv-1.jsonl')).writeAsStringSync('{}\n');

      // Simulate OpenCode XDG Data + ZCode CLI/v2
      final opencodeDir = Directory(p.join(homeDir.path, '.local', 'share', 'opencode'))
        ..createSync(recursive: true);
      File(p.join(opencodeDir.path, 'opencode.db')).writeAsBytesSync(const [1, 2, 3, 4]);
      final zcodeCliDbDir = Directory(p.join(homeDir.path, '.zcode', 'cli', 'db'))
        ..createSync(recursive: true);
      final zcodeV2Dir = Directory(p.join(homeDir.path, '.zcode', 'v2'))
        ..createSync(recursive: true);
      File(p.join(zcodeCliDbDir.path, 'db.sqlite')).writeAsBytesSync(const [1, 2, 3]);
      File(p.join(zcodeV2Dir.path, 'tasks-index.sqlite')).writeAsBytesSync(const [1, 2]);

      const svc = LocalAgentDiscoveryService();
      final found = await svc.scanLocalInstances(
        includeWsl: false,
        envOverride: {
          'USERPROFILE': homeDir.path,
          'APPDATA': appDataDir.path,
          'LOCALAPPDATA': localAppDataDir.path,
          'PATH': '${npmDir.path};${localBinDir.path}',
        },
      );

      final codex = found.firstWhere((e) => e.provider == 'codex-local');
      expect(codex.supportedForImport, isTrue);
      expect(codex.sessionFileCount, 1);
      expect(
        codex.installations.map((i) => i.method),
        containsAll(['npm (.cmd)', 'Native Binary']),
      );

      final dsh = found.firstWhere((e) => e.provider == 'dsh-local');
      expect(dsh.supportedForImport, isTrue);
      expect(dsh.sessionFileCount, 1);
      expect(dsh.installations.map((i) => i.method), contains('Embedded Runtime'));

      final claude = found.firstWhere((e) => e.provider == 'claude-code-local');
      expect(claude.supportedForImport, isTrue);
      expect(claude.sessionFileCount, 1);

      final opencode = found.firstWhere((e) => e.provider == 'opencode-local');
      expect(opencode.supportedForImport, isTrue);
      expect(opencode.hasSqliteDb, isTrue);

      final zcode = found.firstWhere((e) => e.provider == 'zcode-local');
      expect(zcode.supportedForImport, isTrue);
      expect(zcode.hasSqliteDb, isTrue);
      expect(zcode.sessionFileCount, 2);
      expect(
        zcode.installations.map((i) => i.method),
        containsAll(['ZCode CLI', 'ZCode Desktop v2']),
      );
    } finally {
      sandboxHome.deleteSync(recursive: true);
    }
  });

  test('ImportProgressUpdate calculates fraction, throughput speed, and ETA accurately', () {
    final prog = ImportProgressUpdate.fromJson(
      const {
        'type': 'progress',
        'stage': 'parse',
        'adapterId': 'zcode-local',
        'completed': 50,
        'total': 200,
        'skipped': 0,
        'bytesProcessed': 10 * 1024 * 1024,
        'totalBytes': 40 * 1024 * 1024,
      },
      elapsed: const Duration(seconds: 5),
    );
    expect(prog.fraction, closeTo(0.25, 0.0001));
    expect(prog.itemsPerSec, closeTo(10.0, 0.01));
    expect(prog.formattedBytesSpeed, '2.0 MB/s');
    expect(prog.eta, const Duration(seconds: 15));
    expect(ImportProgressUpdate.formatDuration(prog.eta!), '15s');
  });

  test('ArchiveDirectStore inspectArchiveStats & resetArchiveData clears DB and cache dirs while preserving shares', () async {
    final sandboxArchive = Directory.systemTemp.createTempSync('sm_reset_test_');
    try {
      final dbFile = File(p.join(sandboxArchive.path, 'archive.db'))..writeAsBytesSync(List<int>.filled(256, 7));
      final walFile = File(p.join(sandboxArchive.path, 'archive.db-wal'))..writeAsBytesSync(const [1, 2, 3, 4]);
      final shmFile = File(p.join(sandboxArchive.path, 'archive.db-shm'))..writeAsBytesSync(const [5, 6]);
      final blobsDir = Directory(p.join(sandboxArchive.path, 'blobs', 'aa'))..createSync(recursive: true);
      File(p.join(blobsDir.path, 'blob.bin')).writeAsBytesSync(const [1, 2, 3]);
      final rawDir = Directory(p.join(sandboxArchive.path, 'raw', 'dsh-local'))..createSync(recursive: true);
      File(p.join(rawDir.path, 'orig.jsonl')).writeAsStringSync('{}\n');
      final sharesDir = Directory(p.join(sandboxArchive.path, 'shares'))..createSync(recursive: true);
      final shareImg = File(p.join(sharesDir.path, 'long_share.png'))..writeAsBytesSync(const [9, 9]);

      final store = ArchiveDirectStore(archiveDir: sandboxArchive.path);
      expect(store.isConnectedNotifier.value, isTrue);

      final stats = await store.inspectArchiveStats();
      expect(stats.dbExists, isTrue);
      expect(stats.dbBytes, 262);
      expect(stats.cacheBytes, 6);

      final res = await store.resetArchiveData(includeBlobsAndRaw: true);
      expect(res.ok, isTrue);
      expect(res.deletedFiles, 3);
      expect(res.deletedDirs, 2);
      expect(dbFile.existsSync(), isFalse);
      expect(walFile.existsSync(), isFalse);
      expect(shmFile.existsSync(), isFalse);
      expect(Directory(p.join(sandboxArchive.path, 'blobs')).existsSync(), isFalse);
      expect(Directory(p.join(sandboxArchive.path, 'raw')).existsSync(), isFalse);
      expect(shareImg.existsSync(), isTrue);
      expect(store.isConnectedNotifier.value, isFalse);
      store.dispose();
    } finally {
      sandboxArchive.deleteSync(recursive: true);
    }
  });

  testWidgets('Delete archive DB entry in ImportView opens dialog and deletes archive files', (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    final sandboxArchive = Directory.systemTemp.createTempSync('sm_ui_reset_');
    try {
      final dbFile = File(p.join(sandboxArchive.path, 'archive.db'))..writeAsBytesSync(const [1, 2, 3, 4]);
      final blobsDir = Directory(p.join(sandboxArchive.path, 'blobs'))..createSync(recursive: true);
      File(p.join(blobsDir.path, 'item.bin')).writeAsBytesSync(const [8, 9]);

      final store = ArchiveDirectStore(archiveDir: sandboxArchive.path);
      final cliRunner = SmCliRunner(store: store);
      addTearDown(() {
        cliRunner.dispose();
        store.dispose();
      });

      await tester.pumpWidget(
        AppStringsScope(
          notifier: ValueNotifier<AppLocale>(AppLocale.zh),
          child: MaterialApp(
            theme: GoogleMaterialTheme.light(),
            home: Scaffold(
              body: ImportView(
                store: store,
                cliRunner: cliRunner,
                discoveryService: const _FakeDiscoveryService([]),
                onDataChanged: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final resetBtn = find.text('删除旧库记录');
      expect(resetBtn, findsOneWidget);
      await tester.ensureVisible(resetBtn);
      await tester.tap(resetBtn);
      await tester.pumpAndSettle();

      expect(find.text('确认删除当前归档库记录？'), findsOneWidget);
      final confirmBtn = find.text('确认删除归档库');
      expect(confirmBtn, findsOneWidget);
      await tester.tap(confirmBtn);
      await tester.pumpAndSettle();

      expect(dbFile.existsSync(), isFalse);
      expect(blobsDir.existsSync(), isFalse);
      expect(store.isConnectedNotifier.value, isFalse);
    } finally {
      sandboxArchive.deleteSync(recursive: true);
    }
  });

  testWidgets(
      'Tree session list, subagent attachment, 1-line multi-round folding, Share customization, SettingsView & PerfLogger',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(1440, 920);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    final dir = Directory.systemTemp.createTempSync('sm_ui_full_features_');
    final db = sq.sqlite3.open(p.join(dir.path, 'archive.db'));
    try {
      db.execute(_testSchemaSql);
      final now = DateTime.now().millisecondsSinceEpoch;
      db.execute(
        "INSERT INTO project (id, name, provider, root_path) VALUES (1, 'SessionManager', 'codex-local', 'C:/Lab/SessionManager');",
      );
      db.execute(
        '''
        INSERT INTO conversation (id, provider, external_id, title, summary, created_at, updated_at, default_model, cwd, project_id, item_count, char_count, revision_count, starred, flags_json)
        VALUES
          (1, 'codex-local', 'main-1', 'Multi-round Refactor Task', 'Parent session summary', ?, ?, 'gpt-5', 'C:/Lab/SessionManager', 1, 7, 500, 1, 1, NULL),
          (2, 'codex-local', 'sub-1', 'Inspect subagent worker', 'Subagent helper output', ?, ?, 'gpt-5-mini', 'C:/Lab/SessionManager', 1, 2, 120, 1, 0, '{"parent_external_id":"main-1","is_subagent":true,"subagent_name":"explore"}')
        ''',
        [now - 5000, now, now - 4000, now - 1000],
      );
      db.execute(
        '''
        INSERT INTO item (id, conversation_id, parent_id, external_id, ordinal, depth, role, kind, created_at, model, tool_name, text, text_len, blocks_json, content_hash, is_active_branch, is_synthetic)
        VALUES
          (1, 1, NULL, 'u1', 0, 0, 'user', 'message', ?, NULL, NULL, 'Inspect topic context and summarize', 35, NULL, 'h1', 1, 0),
          (2, 1, 1, 't1', 1, 1, 'assistant', 'thinking', ?, 'gpt-5', NULL, 'Planning step 1', 15, NULL, 'h2', 1, 0),
          (3, 1, 2, 'tc1', 2, 2, 'tool', 'tool_call', ?, NULL, 'execute', 'find tools', 10, NULL, 'h3', 1, 0),
          (4, 1, 3, 'a_mid', 3, 3, 'assistant', 'message', ?, 'gpt-5', NULL, 'Found two tools, running step 1...', 34, NULL, 'h4', 1, 0),
          (5, 1, 4, 't2', 4, 4, 'assistant', 'thinking', ?, 'gpt-5', NULL, 'Synthesizing final answer', 25, NULL, 'h5', 1, 0),
          (6, 1, 5, 'tc2', 5, 5, 'tool', 'tool_call', ?, NULL, 'execute', 'append entry', 12, NULL, 'h6', 1, 0),
          (7, 1, 6, 'a_final', 6, 6, 'assistant', 'message', ?, 'gpt-5', NULL, 'Final complete summary response.', 32, NULL, 'h7', 1, 0),
          (8, 2, NULL, 'su1', 0, 0, 'user', 'message', ?, NULL, NULL, 'Subagent prompt', 15, NULL, 'h8', 1, 0),
          (9, 2, 8, 'sa1', 1, 1, 'assistant', 'message', ?, 'gpt-5-mini', NULL, 'Subagent final result', 21, NULL, 'h9', 1, 0)
        ''',
        [
          now - 4900,
          now - 4800,
          now - 4700,
          now - 4600,
          now - 4500,
          now - 4400,
          now - 4300,
          now - 3900,
          now - 3800,
        ],
      );
    } finally {
      db.dispose();
    }

    PerfLogger.instance.clear();
    final store = ArchiveDirectStore(archiveDir: dir.path);
    final settings = AppSettingsController(
      settingsDir: dir.path,
      locale: AppLocale.en,
      authorName: 'TestUser',
    );
    addTearDown(() {
      settings.dispose();
      store.dispose();
      try {
        dir.deleteSync(recursive: true);
      } catch (_) {}
    });

    // 1. Subagent attached cleanly under parent conversation in store
    final list = await store.getConversations();
    expect(list.length, 1);
    expect(list.first.id, 1);
    expect(list.first.subagents.length, 1);
    expect(list.first.subagents.first.subagentName, 'explore');

    final detail = await store.getConversationDetail(1);
    expect(detail, isNotNull);
    expect(detail!.subagents.length, 1);

    // 2. Render full SessionManagerApp and verify 2-level tree, reader folding, share preview, and settings
    await tester.pumpWidget(
      SessionManagerApp(
        storeOverride: store,
        settingsOverride: settings,
        discoveryOverride: const _FakeDiscoveryService([]),
        initialLocale: AppLocale.en,
      ),
    );
    await tester.pumpAndSettle();

    // 2-level tree: Provider -> Project -> Main Session + Subagent row
    expect(find.text('codex-local'), findsOneWidget);
    expect(find.text('SessionManager'), findsOneWidget);
    expect(find.text('Multi-round Refactor Task'), findsOneWidget);
    expect(find.text('1 sub'), findsOneWidget);
    await tester.tap(find.text('1 sub'));
    await tester.pumpAndSettle();
    expect(find.text('explore'), findsOneWidget);
    expect(find.text('Inspect subagent worker'), findsOneWidget);

    // Open main session
    await tester.tap(find.text('Multi-round Refactor Task'));
    await tester.pumpAndSettle();

    // Verify all 5 intermediate rounds folded into ONE line and final reply has the only Copy button
    expect(
      find.textContaining('Thinking & tool process (2 thinking · 2 tool call(s) · 1 step(s))'),
      findsOneWidget,
    );
    expect(find.text('Found two tools, running step 1...'), findsNothing);
    expect(find.text('Final complete summary response.'), findsOneWidget);
    expect(find.byTooltip('Copy'), findsOneWidget);
    expect(find.text('Subagent Sessions (1)'), findsOneWidget);

    // PerfLogger recorded open_conversation
    expect(
      PerfLogger.instance.entriesNotifier.value.any((e) => e.operation == 'open_conversation'),
      isTrue,
    );

    // Open Share dialog from final reply and check live preview & customization controls
    await tester.tap(find.byTooltip('Share Long Image').last);
    await tester.pumpAndSettle();
    expect(find.text('Live Image Preview'), findsOneWidget);
    expect(find.text('Color Style'), findsOneWidget);
    expect(find.text('Show Signature'), findsOneWidget);
    expect(find.text('Add Watermark Overlay'), findsOneWidget);
    expect(find.text('由 SessionManager 分享'), findsWidgets);
    await tester.tap(find.byIcon(Icons.close));
    await tester.pumpAndSettle();

    // Navigate to Settings tab and verify version, GitHub URL, and Share defaults
    await tester.tap(find.text('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Settings & Diagnostics'), findsOneWidget);
    expect(find.text('SessionManager ${AppSettingsController.appVersion}'), findsOneWidget);
    expect(find.text(AppSettingsController.githubUrl), findsOneWidget);
    expect(find.textContaining('open_conversation'), findsWidgets);
  });

  testWidgets('MarkdownProse renders GFM pipe tables and AppSettingsController persists pins & global project stars',
      (WidgetTester tester) async {
    final dir = Directory.systemTemp.createTempSync('sm_table_pin_');
    final settings = AppSettingsController(settingsDir: dir.path);
    addTearDown(() {
      settings.dispose();
      try {
        dir.deleteSync(recursive: true);
      } catch (_) {}
    });

    settings.togglePinProject('codex-local::1');
    settings.togglePinSession(42);
    settings.toggleStarProject('c:/lab/sessionmanager');
    settings.setSessionListWidth(400);

    final reloaded = AppSettingsController(settingsDir: dir.path);
    addTearDown(reloaded.dispose);
    expect(reloaded.isProjectPinned('codex-local::1'), isTrue);
    expect(reloaded.isSessionPinned(42), isTrue);
    expect(reloaded.isProjectStarred('c:/lab/sessionmanager'), isTrue);
    expect(reloaded.sessionListWidth, 400.0);

    await tester.pumpWidget(
      AppStringsScope(
        notifier: ValueNotifier<AppLocale>(AppLocale.en),
        child: MaterialApp(
          theme: GoogleMaterialTheme.light(),
          home: const Scaffold(
            body: Padding(
              padding: EdgeInsets.all(16),
              child: MarkdownProse(
                text: 'Summary:\n\n| Name | Score |\n| :--- | ---: |\n| **Alpha** | `99` |\n',
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byType(Table), findsOneWidget);
    expect(find.text('Name'), findsOneWidget);
    expect(find.text('Score'), findsOneWidget);
    expect(find.textContaining('Alpha'), findsOneWidget);
    expect(find.textContaining('99'), findsOneWidget);
  });

  testWidgets('BranchTreeReaderView collapses >3 subagents by default and folds synthetic user items',
      (tester) async {
    tester.view.physicalSize = const Size(1280, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);

    final dir = _createTempArchiveFixture();
    final detail = ConversationDetail(
      id: 77,
      provider: 'dsh-local',
      externalId: 'dsh-main',
      title: 'Main Session',
      subagents: [
        for (var i = 1; i <= 4; i++)
          ConversationSummary(
            id: 100 + i,
            provider: 'dsh-local',
            externalId: 'sub-$i',
            title: 'Subagent $i',
            isSubagent: true,
            subagentName: 'worker-$i',
            itemCount: 10 + i,
            updatedAt: 1700000100000,
          ),
      ],
      items: [
        MessageItem(
          id: 1,
          ordinal: 0,
          role: 'user',
          kind: 'message',
          createdAt: 1700000001000,
          text: 'Real user prompt',
          isActiveBranch: true,
          isSynthetic: false,
        ),
        MessageItem(
          id: 2,
          parentId: 1,
          ordinal: 1,
          role: 'user',
          kind: 'message',
          createdAt: 1700000002000,
          text: 'Subagent inbox reply',
          isActiveBranch: true,
          isSynthetic: true,
        ),
        MessageItem(
          id: 3,
          parentId: 2,
          ordinal: 2,
          role: 'assistant',
          kind: 'message',
          createdAt: 1700000003000,
          text: 'Final assistant answer',
          isActiveBranch: true,
          isSynthetic: false,
        ),
      ],
    );

    final store = _FakeReaderStore(dir.path, detail);
    addTearDown(() {
      store.dispose();
      try {
        dir.deleteSync(recursive: true);
      } catch (_) {}
    });

    await tester.pumpWidget(
      AppStringsScope(
        notifier: ValueNotifier<AppLocale>(AppLocale.en),
        child: MaterialApp(
          theme: GoogleMaterialTheme.light(),
          home: Scaffold(
            body: BranchTreeReaderView(
              store: store,
              refreshTick: ValueNotifier<int>(0),
              conversationId: 77,
              onSelectOtherSession: (_) {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // >3 subagents collapsed by default
    expect(find.text('Show all (4)'), findsOneWidget);
    expect(find.text('worker-1 · 11'), findsNothing);

    // Expanding reveals all 4 subagent chips
    await tester.tap(find.text('Show all (4)'));
    await tester.pumpAndSettle();
    expect(find.text('worker-1 · 11'), findsOneWidget);
    expect(find.text('worker-4 · 14'), findsOneWidget);
    expect(find.text('Collapse'), findsOneWidget);

    // Synthetic user item was folded into process bar, not rendered as a user bubble
    expect(find.text('Real user prompt'), findsOneWidget);
    expect(find.text('Final assistant answer'), findsOneWidget);
    expect(find.text('Subagent inbox reply'), findsNothing);
  });
}

class _FakeReaderStore extends ArchiveDirectStore {
  final ConversationDetail _detail;
  _FakeReaderStore(String archiveDir, this._detail)
      : super(archiveDir: archiveDir);

  @override
  Future<ConversationDetail?> getConversationDetail(int id) async => _detail;
}

class _FakeDiscoveryService extends LocalAgentDiscoveryService {
  final List<LocalAgentInstance> instances;
  const _FakeDiscoveryService(this.instances);

  @override
  Future<List<LocalAgentInstance>> scanLocalInstances({
    Map<String, String>? envOverride,
    bool includeWsl = true,
  }) async =>
      instances;
}
