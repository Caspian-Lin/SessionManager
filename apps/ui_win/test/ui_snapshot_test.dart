import 'dart:convert';
import 'dart:ffi' as ffi;
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqlite3/open.dart' as sq_open;
import 'package:sqlite3/sqlite3.dart' as sq;

import 'package:ui_win/data/archive_direct_store.dart';
import 'package:ui_win/data/sm_cli_runner.dart';
import 'package:ui_win/l10n/app_strings.dart';
import 'package:ui_win/main.dart';

/// Renders review snapshots of the shell to `docs/ui/` using a seeded temp SQLite DB.
void main() {
  if (Platform.isWindows) {
    sq_open.open.overrideFor(
      sq_open.OperatingSystem.windows,
      _openWindowsSqlite,
    );
  }

  late Directory snapshotArchiveDir;
  late ArchiveDirectStore sharedStore;
  late SmCliRunner sharedRunner;

  setUpAll(() async {
    await _loadSystemFonts();
    snapshotArchiveDir = _seedSnapshotArchive();
    sharedStore = ArchiveDirectStore(archiveDir: snapshotArchiveDir.path);
    sharedRunner = SmCliRunner(store: sharedStore);
  });

  tearDownAll(() {
    sharedRunner.dispose();
    sharedStore.dispose();
    if (snapshotArchiveDir.existsSync()) {
      snapshotArchiveDir.deleteSync(recursive: true);
    }
  });

  testWidgets('writes shell snapshots', (tester) async {
    final cases = <String, _SnapshotCase>{
      'shell-light-wide': const _SnapshotCase(
        size: Size(1440, 920),
        mode: ThemeMode.light,
      ),
      'shell-dark-wide': const _SnapshotCase(
        size: Size(1440, 920),
        mode: ThemeMode.dark,
      ),
      'shell-light-narrow': const _SnapshotCase(
        size: Size(1180, 820),
        mode: ThemeMode.light,
      ),
      'shell-import': const _SnapshotCase(
        size: Size(1440, 920),
        mode: ThemeMode.light,
        tabIndex: 1,
      ),
    };

    for (final entry in cases.entries) {
      final key = GlobalKey();
      await _pumpApp(tester, key, entry.value, sharedStore, sharedRunner);
      await _writeSnapshot(tester, key, entry.key);
    }

    final readerKey = GlobalKey();
    await _pumpApp(
      tester,
      readerKey,
      const _SnapshotCase(size: Size(1440, 920), mode: ThemeMode.light),
      sharedStore,
      sharedRunner,
    );
    await tester.tap(find.text('Codex rollout session refactoring'));
    await tester.pumpAndSettle(const Duration(milliseconds: 200));
    await _writeSnapshot(tester, readerKey, 'shell-reader');
  });
}

ffi.DynamicLibrary _openWindowsSqlite() {
  const candidates = [
    'sqlite3.dll',
    r'C:\Program Files\Krita (x64)\python\sqlite3.dll',
    r'C:\Program Files\LibreOffice\program\sqlite3.dll',
    r'C:\Windows\System32\winsqlite3.dll',
  ];
  for (final path in candidates) {
    if (path == 'sqlite3.dll' || File(path).existsSync()) {
      try {
        final lib = ffi.DynamicLibrary.open(path);
        lib.lookup('sqlite3_initialize');
        return lib;
      } catch (_) {}
    }
  }
  return ffi.DynamicLibrary.process();
}

Directory _seedSnapshotArchive() {
  final dir = Directory.systemTemp.createTempSync('sm-ui-snapshot-');
  final db = sq.sqlite3.open(p.join(dir.path, 'archive.db'));
  try {
    db.execute('''
CREATE TABLE project (id INTEGER PRIMARY KEY, name TEXT NOT NULL, provider TEXT, external_id TEXT, root_path TEXT);
CREATE TABLE import_batch (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, adapter_id TEXT NOT NULL, adapter_version TEXT NOT NULL, account_id INTEGER, kind TEXT NOT NULL, source_path TEXT, source_sha256 TEXT NOT NULL, exported_at INTEGER, imported_at INTEGER NOT NULL, status TEXT NOT NULL, stats_json TEXT, report_json TEXT);
CREATE TABLE conversation (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, account_id INTEGER, external_id TEXT, title TEXT, title_source TEXT, summary TEXT, created_at INTEGER, updated_at INTEGER, exported_at INTEGER, default_model TEXT, cwd TEXT, project_id INTEGER, item_count INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0, blob_count INTEGER NOT NULL DEFAULT 0, head_hash TEXT, content_hash TEXT, fingerprint TEXT, raw_format TEXT, raw_blob_sha256 TEXT, revision_count INTEGER NOT NULL DEFAULT 1, first_batch_id INTEGER, last_batch_id INTEGER, starred INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, flags_json TEXT);
CREATE TABLE conversation_revision (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, batch_id INTEGER NOT NULL, revision_no INTEGER NOT NULL, content_hash TEXT NOT NULL, head_hash TEXT, item_count INTEGER, char_count INTEGER, raw_blob_sha256 TEXT, created_at INTEGER NOT NULL);
CREATE TABLE blob (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT, ext TEXT, rel_path TEXT NOT NULL, origin_kind TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE item (id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, parent_id INTEGER, external_id TEXT, ordinal INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER, model TEXT, tool_name TEXT, tool_call_id TEXT, status TEXT, text TEXT, text_len INTEGER NOT NULL DEFAULT 0, payload_ref TEXT, blocks_json TEXT, content_hash TEXT NOT NULL, is_active_branch INTEGER NOT NULL DEFAULT 1, is_hidden INTEGER NOT NULL DEFAULT 0, is_synthetic INTEGER NOT NULL DEFAULT 0, flags_json TEXT);
CREATE TABLE tag (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT);
CREATE TABLE conversation_tag (conversation_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (conversation_id, tag_id));
CREATE TABLE dedupe_candidate (id INTEGER PRIMARY KEY, a_id INTEGER NOT NULL, b_id INTEGER NOT NULL, similarity REAL NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
''');
    final now = DateTime.now().millisecondsSinceEpoch;
    db.execute(
      "INSERT INTO project (id, name, provider, root_path) VALUES (1, 'SessionManager', 'codex-local', 'C:/Projects/SessionManager');",
    );
    db.execute(
      "INSERT INTO import_batch (id, provider, adapter_id, adapter_version, kind, source_path, source_sha256, imported_at, status) VALUES (1, 'codex-local', 'codex-local', '1.0.0', 'local_dir', 'C:/Users/user/.codex', 'sha-snap', ?, 'ok');",
      [now],
    );
    db.execute(
      '''
      INSERT INTO conversation (id, provider, external_id, title, summary, cwd, project_id, item_count, char_count, head_hash, content_hash, revision_count, starred, updated_at, first_batch_id, last_batch_id, default_model)
      VALUES (1, 'codex-local', 'snap-conv-1', 'Codex rollout session refactoring', 'Clean Gemini-style reading canvas & attachment pills', 'C:/Projects/SessionManager', 1, 2, 320, 'head-snap-1', 'content-snap-1', 1, 1, ?, 1, 1, 'gpt-5')
      ''',
      [now - 60000],
    );
    final blocksJson = jsonEncode([
      {'idx': 0, 'type': 'text', 'text': '### Core Design\n\n1. **Direct SQLite WAL**: instant reads.\n2. **Shareable PNG**: auto-split long sessions.'},
      {'idx': 1, 'type': 'file', 'text': 'Lecture01.pdf'},
    ]);
    db.execute(
      '''
      INSERT INTO item (id, conversation_id, parent_id, external_id, ordinal, depth, role, kind, created_at, model, text, text_len, blocks_json, content_hash, is_active_branch, is_synthetic)
      VALUES
        (1, 1, NULL, 'u1', 0, 0, 'user', 'message', ?, NULL, 'rtl是什么的缩写', 10, NULL, 'hu1', 1, 0),
        (2, 1, 1, 'a1', 1, 1, 'assistant', 'message', ?, 'gpt-5', 'RTL is Register-Transfer Level.', 32, ?, 'ha1', 1, 0)
      ''',
      [now - 50000, now - 40000, blocksJson],
    );
  } finally {
    db.dispose();
  }
  return dir;
}

class _SnapshotCase {
  const _SnapshotCase({
    required this.size,
    required this.mode,
    this.tabIndex = 0,
  });

  final Size size;
  final ThemeMode mode;
  final int tabIndex;
}

Future<void> _pumpApp(
  WidgetTester tester,
  GlobalKey key,
  _SnapshotCase testCase,
  ArchiveDirectStore store,
  SmCliRunner runner,
) async {
  tester.view.physicalSize = testCase.size;
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    RepaintBoundary(
      key: key,
      child: SessionManagerApp(
        storeOverride: store,
        cliRunnerOverride: runner,
        initialLocale: AppLocale.en,
        initialThemeMode: testCase.mode,
        initialTabIndex: testCase.tabIndex,
      ),
    ),
  );
  await tester.pumpAndSettle(const Duration(milliseconds: 120));
}

Future<void> _writeSnapshot(
  WidgetTester tester,
  GlobalKey key,
  String name,
) async {
  final boundary =
      key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  // Image encoding needs the real event loop; without runAsync the test's fake
  // async zone never completes it.
  final bytes = await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 1.0);
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    return data!.buffer.asUint8List();
  });

  // Snapshots land next to the design note so reviewers find them.
  final dir = Directory('../../docs/ui');
  if (!dir.existsSync()) dir.createSync(recursive: true);
  final file = File('${dir.path}/$name.png');
  file.writeAsBytesSync(bytes!);
  // ignore: avoid_print
  print('snapshot $name -> ${file.absolute.path}');
}

Future<void> _loadSystemFonts() async {
  const candidates = <String, List<String>>{
    'Segoe UI': <String>[
      r'C:\Windows\Fonts\segoeui.ttf',
      r'C:\Windows\Fonts\segoeuib.ttf',
      r'C:\Windows\Fonts\seguisb.ttf',
    ],
    'Segoe UI Variable Text': <String>[r'C:\Windows\Fonts\segoeui.ttf'],
    'Microsoft YaHei UI': <String>[r'C:\Windows\Fonts\msyh.ttc'],
    'Cascadia Mono': <String>[
      r'C:\Windows\Fonts\CascadiaMono.ttf',
      r'C:\Windows\Fonts\CascadiaCode.ttf',
    ],
    'Consolas': <String>[r'C:\Windows\Fonts\consola.ttf'],
    'MaterialIcons': <String>[
      r'C:\Program_Files\flutter\bin\cache\artifacts\material_fonts\MaterialIcons-Regular.otf',
    ],
  };

  for (final entry in candidates.entries) {
    final loader = FontLoader(entry.key);
    var any = false;
    for (final path in entry.value) {
      final file = File(path);
      if (!file.existsSync()) continue;
      final bytes = file.readAsBytesSync();
      loader.addFont(Future<ByteData>.value(ByteData.sublistView(bytes)));
      any = true;
    }
    if (!any) continue;
    try {
      await loader.load();
    } catch (_) {
      // A missing face is not fatal for a review snapshot.
    }
  }
}
