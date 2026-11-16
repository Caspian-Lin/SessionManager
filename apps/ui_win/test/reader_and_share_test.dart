import 'dart:convert';
import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:ui_win/l10n/app_strings.dart';
import 'package:ui_win/models.dart';
import 'package:ui_win/theme.dart';
import 'package:ui_win/data/archive_direct_store.dart';
import 'package:ui_win/views/branch_reader_view.dart';
import 'package:ui_win/views/session_list_view.dart';
import 'package:ui_win/widgets/app_title_bar.dart';
import 'package:ui_win/widgets/gm3_surface.dart';
import 'package:ui_win/widgets/markdown_prose.dart';
import 'package:ui_win/widgets/share_image_sheet.dart';

class _FakeReaderStore extends ArchiveDirectStore {
  final ConversationDetail _detail;
  final List<ConversationSummary> _summaries;
  final List<ProjectInfo> _projects;
  _FakeReaderStore(
    String archiveDir,
    this._detail, {
    List<ConversationSummary> summaries = const [],
    List<ProjectInfo> projects = const [],
  })  : _summaries = summaries,
        _projects = projects,
        super(archiveDir: archiveDir);

  @override
  Future<ConversationDetail?> getConversationDetail(int id) async => _detail;

  @override
  Future<List<ConversationSummary>> getConversations({
    String? provider,
    int? projectId,
    bool starredOnly = false,
    bool shrunkOnly = false,
    String? searchFilter,
    SmSortBy sortBy = SmSortBy.updatedDesc,
    int limit = 2000,
    int offset = 0,
  }) async =>
      _summaries;

  @override
  Future<List<ProjectInfo>> getProjects() async => _projects;
}

void main() {
  testWidgets('Reader and share render blob and linked images and open attachments',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final dir = Directory.systemTemp.createTempSync('sm-media-');
    final workspace = Directory(p.join(dir.path, 'workspace'))..createSync();
    final sha = List.filled(64, 'a').join();
    final blob = File(p.join(dir.path, 'blobs', 'aa', '$sha.png'))
      ..createSync(recursive: true);
    final png = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    );
    blob.writeAsBytesSync(png);
    addTearDown(() => dir.deleteSync(recursive: true));
    File(p.join(workspace.path, '截图 example.png')).writeAsBytesSync(png);
    final audio = File(p.join(workspace.path, 'clip example.wav'))..writeAsBytesSync([0]);
    final notes = File(p.join(workspace.path, 'notes.csv'))..writeAsStringSync('one,two');

    final detail = ConversationDetail(
      id: 1,
      provider: 'codex-local',
      title: 'Media session',
      cwd: workspace.path,
      items: [
        MessageItem(
          id: 1, ordinal: 0, role: 'user', kind: 'message', text: '',
          isActiveBranch: true, isSynthetic: false,
          blocks: [
            ViewBlock(idx: 0, type: 'image', blobSha256: sha, text: 'Archived image'),
            const ViewBlock(idx: 1, type: 'image', meta: {'url': '截图%20example.png', 'name': 'Linked image'}),
            ViewBlock(idx: 2, type: 'audio', meta: {'url': audio.uri.toString(), 'name': 'Audio clip'}),
          ],
        ),
        MessageItem(
          id: 2, parentId: 1, ordinal: 1, role: 'assistant', kind: 'message',
          text: '![Markdown image](<截图 example.png>)\n[打开 CSV](notes.csv)',
          isActiveBranch: true, isSynthetic: false,
        ),
      ],
    );
    final store = _FakeReaderStore(dir.path, detail);
    addTearDown(store.dispose);
    expect(store.resolveBlobFile(sha).path, blob.path);
    expect(store.resolveLocalFile('截图%20example.png', cwd: workspace.path)?.path,
        p.join(workspace.path, '截图 example.png'));
    expect(store.resolveLocalFile('https://example.com/notes.csv', cwd: workspace.path), isNull);

    final openCalls = <MethodCall>[];
    const channel = MethodChannel('session_manager/window');
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (call) async {
      openCalls.add(call);
      return true;
    });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

    Future<void> show(Widget body) async {
      await tester.pumpWidget(AppStringsScope(
        notifier: ValueNotifier<AppLocale>(AppLocale.zh),
        child: MaterialApp(theme: GoogleMaterialTheme.light(), home: Scaffold(body: body)),
      ));
      await tester.pumpAndSettle();
    }

    Finder imageWithLabel(String label) => find.byWidgetPredicate(
      (widget) => widget is Image && widget.semanticLabel == label,
    );

    await show(BranchTreeReaderView(
      store: store,
      refreshTick: ValueNotifier(0),
      conversationId: detail.id,
      onSelectOtherSession: (_) {},
    ));
    expect(imageWithLabel('Archived image'), findsOneWidget);
    expect(imageWithLabel('Linked image'), findsOneWidget);
    expect(imageWithLabel('Markdown image'), findsOneWidget);
    await tester.tap(find.text('打开 CSV'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Audio clip'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('打开本地文件'));
    await tester.pumpAndSettle();
    expect(openCalls.where((call) => call.method == 'openLocalFile').map((call) => call.arguments),
        [notes.path, audio.path]);

    await show(ShareImageDialog(
      detail: detail,
      activeItems: detail.items,
      store: store,
      initialOutputDir: dir.path,
    ));
    expect(imageWithLabel('Archived image'), findsOneWidget);
    expect(imageWithLabel('Linked image'), findsOneWidget);
    expect(imageWithLabel('Markdown image'), findsOneWidget);
  });

  group('filterShareMessages', () {
    final items = <MessageItem>[
      MessageItem(
        id: 1,
        ordinal: 0,
        role: 'user',
        kind: 'message',
        createdAt: 1700000001000,
        text: 'Explain how auth works',
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
        text: '<goal_round>\nRound: 1/4\n</goal_round>',
        isActiveBranch: true,
        isSynthetic: false,
      ),
      MessageItem(
        id: 3,
        parentId: 2,
        ordinal: 2,
        role: 'assistant',
        kind: 'reasoning',
        createdAt: 1700000003000,
        text: 'Internal chain of thought about auth',
        isActiveBranch: true,
        isSynthetic: false,
      ),
      MessageItem(
        id: 4,
        parentId: 3,
        ordinal: 3,
        role: 'assistant',
        kind: 'message',
        createdAt: 1700000004000,
        text: 'Let me check auth.dart first.',
        blocks: const [
          ViewBlock(idx: 0, type: 'text', text: 'Let me check auth.dart first.'),
          ViewBlock(
            idx: 1,
            type: 'tool_use',
            toolName: 'read_file',
            toolCallId: 'call_1',
            toolInput: '{"path":"lib/auth.dart"}',
          ),
        ],
        isActiveBranch: true,
        isSynthetic: false,
      ),
      MessageItem(
        id: 5,
        parentId: 4,
        ordinal: 4,
        role: 'tool',
        kind: 'tool_result',
        createdAt: 1700000005000,
        toolName: 'read_file',
        text: 'void verify() {}',
        blocks: const [
          ViewBlock(
            idx: 0,
            type: 'tool_result',
            toolName: 'read_file',
            toolCallId: 'call_1',
            text: 'void verify() {}',
          ),
        ],
        isActiveBranch: true,
        isSynthetic: false,
      ),
      MessageItem(
        id: 6,
        parentId: 5,
        ordinal: 5,
        role: 'assistant',
        kind: 'message',
        createdAt: 1700000006000,
        text: '<think>secret middle thought</think>\nMiddle summary reply.',
        isActiveBranch: true,
        isSynthetic: false,
      ),
      MessageItem(
        id: 7,
        parentId: 6,
        ordinal: 6,
        role: 'user',
        kind: 'message',
        createdAt: 1700000007000,
        text: '[model changed: deepseek-v4]',
        isActiveBranch: true,
        isSynthetic: false,
      ),
      MessageItem(
        id: 8,
        parentId: 7,
        ordinal: 7,
        role: 'assistant',
        kind: 'message',
        createdAt: 1700000008000,
        text: 'Hidden raw think\nFinal answer here.',
        blocks: const [
          ViewBlock(idx: 0, type: 'thinking', text: 'Hidden raw think'),
          ViewBlock(idx: 1, type: 'text', text: 'Final answer here.'),
        ],
        isActiveBranch: true,
        isSynthetic: false,
      ),
      MessageItem(
        id: 9,
        parentId: 8,
        ordinal: 8,
        role: 'user',
        kind: 'message',
        createdAt: 1700000009000,
        text: 'Second turn prompt',
        isActiveBranch: true,
        isSynthetic: false,
      ),
      MessageItem(
        id: 10,
        parentId: 9,
        ordinal: 9,
        role: 'assistant',
        kind: 'message',
        createdAt: 1700000010000,
        text: '<think>only internal thinking</think>',
        isActiveBranch: true,
        isSynthetic: false,
      ),
    ];

    test('singleTurn always includes real user prompt when selecting a middle reply', () {
      final result = filterShareMessages(
        items,
        scope: ShareScopeMode.singleTurn,
        targetAssistantId: 6,
        includeToolDetails: false,
      );

      expect(result.map((e) => e.id).toList(), [1, 6]);
      expect(result.first.text, 'Explain how auth works');
      expect(result.last.text, 'Middle summary reply.');
    });

    test('singleTurn includes user prompt even with includeToolDetails true on intermediate reply', () {
      final result = filterShareMessages(
        items,
        scope: ShareScopeMode.singleTurn,
        targetAssistantId: 6,
        includeToolDetails: true,
      );

      expect(result.first.id, 1);
      expect(result.last.id, 6);
      expect(result.any((e) => e.id == 3), isTrue);
      expect(result.any((e) => e.id == 8), isFalse);
    });

    test('fullConversation with includeToolDetails false excludes reasoning, think blocks/tags, pre-tool commentary, and synthetic DSH inputs', () {
      final result = filterShareMessages(
        items,
        scope: ShareScopeMode.fullConversation,
        includeToolDetails: false,
      );

      expect(result.map((e) => e.id).toList(), [1, 8, 9]);
      expect(result[1].text, 'Final answer here.');
      expect(result[1].blocks.every((b) => b.type != 'thinking'), isTrue);
    });
  });

  group('CodeSyntaxHighlighter & MarkdownProse padding', () {
    test('CodeSyntaxHighlighter highlights code tokens and falls back cleanly', () {
      const base = TextStyle(fontSize: 13, color: Colors.white);
      final jsonSpan = CodeSyntaxHighlighter.buildSpan(
        '{"enabled": true, "count": 42, "path": "/tmp/app.dart"}',
        base,
        isDark: true,
        language: 'json',
      );
      expect(jsonSpan.children, isNotNull);
      expect(jsonSpan.children!.length, greaterThan(3));

      final plainSpan = CodeSyntaxHighlighter.buildSpan(
        'plain unstructured words without symbols',
        base,
        isDark: false,
      );
      expect(plainSpan.toPlainText(), 'plain unstructured words without symbols');
    });

    testWidgets('MarkdownProse adds no extra trailing bottom padding on final paragraph',
        (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: GoogleMaterialTheme.light(),
          home: const Scaffold(
            body: Center(
              child: DecoratedBox(
                decoration: BoxDecoration(color: Colors.grey),
                child: Padding(
                  padding: EdgeInsets.symmetric(vertical: 12, horizontal: 18),
                  child: MarkdownProse(text: 'Single prompt line'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final box = tester.renderObject<RenderBox>(find.byType(MarkdownProse));
      final paddedBox = tester.renderObject<RenderBox>(
        find.ancestor(
          of: find.byType(MarkdownProse),
          matching: find.byType(DecoratedBox),
        ).first,
      );
      // Top 12 + Bottom 12 = 24px total vertical padding difference
      expect(paddedBox.size.height - box.size.height, closeTo(24.0, 0.5));
    });
  });

  group('BranchTreeReaderView DSH synthetic folding, hover time & tool linking', () {
    testWidgets('folds DSH goal/model/job messages, shows hover timestamp, and links tool_result to tool_call',
        (tester) async {
      tester.view.physicalSize = const Size(1280, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);

      final dir = Directory.systemTemp.createTempSync('sm_reader_test_');
      final detail = ConversationDetail(
        id: 88,
        provider: 'dsh-local',
        externalId: 'dsh-conv-88',
        title: 'DSH Session Test',
        items: [
          MessageItem(
            id: 1,
            ordinal: 0,
            role: 'user',
            kind: 'message',
            createdAt: 1700000001000,
            text: 'Check workspace config',
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
            text: '<goal_round>\nRound: 1/6\n</goal_round>',
            isActiveBranch: true,
            isSynthetic: false,
          ),
          MessageItem(
            id: 3,
            parentId: 2,
            ordinal: 2,
            role: 'user',
            kind: 'message',
            createdAt: 1700000003000,
            text: '[model changed: deepseek-v4.1-flash]',
            isActiveBranch: true,
            isSynthetic: false,
          ),
          MessageItem(
            id: 4,
            parentId: 3,
            ordinal: 3,
            role: 'assistant',
            kind: 'tool_call',
            createdAt: 1700000004000,
            toolName: 'read_file',
            text: '{"path":"pubspec.yaml"}',
            blocks: const [
              ViewBlock(
                idx: 0,
                type: 'tool_use',
                toolName: 'read_file',
                toolCallId: 'tc_99',
                toolInput: '{"path":"pubspec.yaml"}',
              ),
            ],
            isActiveBranch: true,
            isSynthetic: false,
          ),
          MessageItem(
            id: 5,
            parentId: 4,
            ordinal: 4,
            role: 'tool',
            kind: 'tool_result',
            createdAt: 1700000005000,
            text: 'name: ui_win',
            blocks: const [
              ViewBlock(
                idx: 0,
                type: 'tool_result',
                toolCallId: 'tc_99',
                text: 'name: ui_win',
              ),
            ],
            isActiveBranch: true,
            isSynthetic: false,
          ),
          MessageItem(
            id: 6,
            parentId: 5,
            ordinal: 5,
            role: 'assistant',
            kind: 'message',
            createdAt: 1700000006000,
            text: 'Workspace config uses Flutter package ui_win.',
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
          notifier: ValueNotifier<AppLocale>(AppLocale.zh),
          child: MaterialApp(
            theme: GoogleMaterialTheme.dark(),
            home: Scaffold(
              body: BranchTreeReaderView(
                store: store,
                refreshTick: ValueNotifier<int>(0),
                conversationId: 88,
                onSelectOtherSession: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Synthetic <goal_round> and [model changed:] are folded, not rendered as user bubbles
      expect(find.text('Check workspace config'), findsOneWidget);
      expect(find.textContaining('<goal_round>'), findsNothing);
      expect(find.textContaining('[model changed:'), findsNothing);
      expect(find.text('Workspace config uses Flutter package ui_win.'), findsOneWidget);

      // Hover over user prompt bubble -> single invocation timestamp badge shows in blank space (no overlapping Tooltip)
      final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await gesture.addPointer(location: Offset.zero);
      addTearDown(gesture.removePointer);
      await gesture.moveTo(tester.getCenter(find.text('Check workspace config')));
      await tester.pump(const Duration(milliseconds: 500));
      final timeBadge = find.textContaining('调用时间:');
      expect(timeBadge, findsNothing);
      await tester.pump(const Duration(milliseconds: 1100));
      await tester.pumpAndSettle();
      expect(timeBadge, findsOneWidget);
      final userBubble = find.ancestor(
        of: find.text('Check workspace config'),
        matching: find.byWidgetPredicate(
          (w) =>
              w is Container &&
              w.decoration is BoxDecoration &&
              (w.decoration as BoxDecoration).borderRadius ==
                  BorderRadius.circular(22),
        ),
      );
      expect(
        tester.getRect(timeBadge).right,
        lessThanOrEqualTo(tester.getRect(userBubble.first).left),
      );
      await gesture.moveTo(Offset.zero);
      await tester.pumpAndSettle();

      // Expand the process group -> expand tool_result -> linked tool_call banner appears
      await tester.tap(find.textContaining('思考与调用过程'));
      await tester.pumpAndSettle();

      // Step badge on tool_result inherits linked toolName 'read_file'
      expect(find.text('tool_result: read_file'), findsOneWidget);
      await tester.tap(find.text('tool_result: read_file'));
      await tester.pumpAndSettle();

      expect(find.text('关联调用'), findsOneWidget);
      expect(find.text('#3'), findsOneWidget);

      // Conversation detail header displays character count, estimated tokens, In/Out ratio, and category share
      expect(find.textContaining('字数'), findsWidgets);
      expect(find.textContaining('估计 Token'), findsWidgets);
      expect(find.textContaining('输入/输出'), findsWidgets);
      await tester.tap(find.textContaining('估计 Token'));
      await tester.pumpAndSettle();
      expect(find.textContaining('tok ('), findsWidgets);
    });
  });

  group('Follow-up UX enhancements', () {
    testWidgets('middle-mouse-button press and drag fast-scrolls Scrollables',
        (tester) async {
      final scrollCtrl = ScrollController();
      addTearDown(scrollCtrl.dispose);

      await tester.pumpWidget(
        MaterialApp(
          scrollBehavior: const SmScrollBehavior(),
          theme: GoogleMaterialTheme.dark(),
          home: Scaffold(
            body: SizedBox(
              width: 400,
              height: 300,
              child: ListView.builder(
                controller: scrollCtrl,
                itemCount: 40,
                itemExtent: 60,
                itemBuilder: (_, idx) => Text('Row $idx'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(scrollCtrl.offset, 0);

      final middleDrag = await tester.startGesture(
        const Offset(200, 150),
        kind: PointerDeviceKind.mouse,
        buttons: kMiddleMouseButton,
      );
      await middleDrag.moveBy(const Offset(0, 90));
      await tester.pump(const Duration(milliseconds: 60));
      expect(scrollCtrl.offset, greaterThan(100));

      await middleDrag.up();
      await tester.pumpAndSettle();
    });

    testWidgets(
        'MarkdownProse renders --- divider, unifies SelectionArea across blocks, and toggles raw source on right click',
        (tester) async {
      const md = '''Paragraph one with `inlineCode()` inside.

---

- Bullet item A
- Bullet item B

| ColA | ColB |
| --- | --- |
| v1 | v2 |''';

      await tester.pumpWidget(
        AppStringsScope(
          notifier: ValueNotifier<AppLocale>(AppLocale.zh),
          child: MaterialApp(
            theme: GoogleMaterialTheme.dark(),
            home: const Scaffold(
              body: SingleChildScrollView(
                padding: EdgeInsets.all(16),
                child: MarkdownProse(text: md),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // --- renders as Divider
      expect(find.byType(Divider), findsOneWidget);
      // Unified SelectionArea instead of isolated SelectableText per paragraph/cell
      expect(find.byType(SelectionArea), findsOneWidget);
      expect(find.byType(SelectableText), findsNothing);

      // Right-click opens context menu with raw Markdown toggle
      final rClick = await tester.startGesture(
        tester.getCenter(find.textContaining('inlineCode()')),
        kind: PointerDeviceKind.mouse,
        buttons: kSecondaryMouseButton,
      );
      await rClick.up();
      await tester.pumpAndSettle();

      expect(find.text('显示源码 (纯文本)'), findsOneWidget);
      await tester.tap(find.text('显示源码 (纯文本)'));
      await tester.pumpAndSettle();

      expect(find.text('markdown · raw'), findsOneWidget);
      expect(find.text('显示渲染视图'), findsOneWidget);
      expect(find.byType(Divider), findsNothing);

      // Switch back to rendered Markdown view
      await tester.tap(find.text('显示渲染视图'));
      await tester.pumpAndSettle();
      expect(find.byType(Divider), findsOneWidget);
    });

    testWidgets(
        'Codex turn jump rail up/down overflow arrows align horizontally with tick bars',
        (tester) async {
      final dir = Directory.systemTemp.createTempSync('sm_rail_align_');
      final items = <MessageItem>[];
      var parentId = 0;
      for (var i = 0; i < 36; i++) {
        final uId = i * 2 + 1;
        final aId = i * 2 + 2;
        items.add(
          MessageItem(
            id: uId,
            parentId: i == 0 ? null : parentId,
            ordinal: i * 2,
            role: 'user',
            kind: 'message',
            createdAt: 1700000000000 + i * 2000,
            text: 'Turn $i prompt',
            isActiveBranch: true,
            isSynthetic: false,
          ),
        );
        items.add(
          MessageItem(
            id: aId,
            parentId: uId,
            ordinal: i * 2 + 1,
            role: 'assistant',
            kind: 'message',
            createdAt: 1700000001000 + i * 2000,
            text: 'Turn $i reply',
            isActiveBranch: true,
            isSynthetic: false,
          ),
        );
        parentId = aId;
      }

      final detail = ConversationDetail(
        id: 99,
        provider: 'codex-local',
        title: 'Many turns',
        items: items,
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
          notifier: ValueNotifier<AppLocale>(AppLocale.zh),
          child: MaterialApp(
            theme: GoogleMaterialTheme.dark(),
            home: Scaffold(
              body: BranchTreeReaderView(
                store: store,
                refreshTick: ValueNotifier<int>(0),
                conversationId: 99,
                onSelectOtherSession: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final downArrow = find.byIcon(Icons.keyboard_arrow_down_rounded);
      expect(downArrow, findsOneWidget);
      final arrowCenterX = tester.getCenter(downArrow).dx;

      // Normal inactive tick bars are 14px wide, left-aligned in the rail
      final normalTickFinder = find.byWidgetPredicate(
        (w) =>
            w is AnimatedContainer &&
            w.constraints?.minWidth == 14 &&
            w.constraints?.maxWidth == 14,
      );
      expect(normalTickFinder, findsWidgets);
      final tickCenterX = tester.getCenter(normalTickFinder.first).dx;
      expect((arrowCenterX - tickCenterX).abs(), lessThan(1.5));
    });

    testWidgets(
        'SessionListView header collapse-all button stays right-aligned when pane is wide',
        (tester) async {
      final dir = Directory.systemTemp.createTempSync('sm_wide_list_');
      const summary = ConversationSummary(
        id: 1,
        provider: 'dsh-local',
        title: 'Wide pane test session',
        projectName: 'SessionManager',
        itemCount: 4,
      );
      final detail = ConversationDetail(
        id: 1,
        provider: 'dsh-local',
        title: 'Wide pane test session',
        items: const [],
      );
      final store = _FakeReaderStore(
        dir.path,
        detail,
        summaries: const [summary],
        projects: const [ProjectInfo(id: 1, name: 'SessionManager')],
      );
      addTearDown(() {
        store.dispose();
        try {
          dir.deleteSync(recursive: true);
        } catch (_) {}
      });

      await tester.pumpWidget(
        AppStringsScope(
          notifier: ValueNotifier<AppLocale>(AppLocale.zh),
          child: MaterialApp(
            theme: GoogleMaterialTheme.dark(),
            home: Scaffold(
              body: SizedBox(
                width: 800,
                height: 600,
                child: SessionListView(
                  store: store,
                  refreshTick: ValueNotifier<int>(0),
                  onSelectSession: (_) {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final collapseBtn = find.ancestor(
        of: find.byIcon(Icons.unfold_less_rounded),
        matching: find.byType(IconButton),
      );
      expect(collapseBtn, findsOneWidget);
      final btnRect = tester.getRect(collapseBtn);
      // Header padding right is 16px, so button right edge sits near 784px (certainly > 740px)
      expect(btnRect.right, greaterThan(740));
    });

    test('computeConversationContextStats aggregates chars, categories & tokens',
        () {
      final stats = computeConversationContextStats([
        MessageItem(
          id: 1,
          ordinal: 0,
          role: 'user',
          kind: 'message',
          text: '<goal_round>System injected round</goal_round>',
          isActiveBranch: true,
          isSynthetic: true,
        ),
        MessageItem(
          id: 2,
          ordinal: 1,
          role: 'user',
          kind: 'message',
          text: '请分析这个问题',
          isActiveBranch: true,
          isSynthetic: false,
        ),
        MessageItem(
          id: 3,
          ordinal: 2,
          role: 'assistant',
          kind: 'message',
          text: '好的，我来看看。',
          blocks: const [
            ViewBlock(idx: 0, type: 'thinking', text: 'Let me inspect code.'),
            ViewBlock(
              idx: 1,
              type: 'tool_use',
              toolName: 'read_file',
              text: '{"path":"a.dart"}',
            ),
          ],
          isActiveBranch: true,
          isSynthetic: false,
        ),
        MessageItem(
          id: 4,
          ordinal: 3,
          role: 'tool',
          kind: 'tool_result',
          text: 'void main() {}',
          isActiveBranch: true,
          isSynthetic: false,
        ),
        MessageItem(
          id: 5,
          ordinal: 4,
          role: 'assistant',
          kind: 'message',
          text: '已完成检查并确认正常。',
          isActiveBranch: true,
          isSynthetic: false,
        ),
      ]);

      expect(stats.totalChars, greaterThan(0));
      expect(stats.totalTokens, greaterThan(0));
      expect(stats.inputTokens, greaterThan(0));
      expect(stats.outputTokens, greaterThan(0));
      expect(stats.user.tokens, greaterThan(0));
      expect(stats.assistant.tokens, greaterThan(0));
      expect(stats.thinking.tokens, greaterThan(0));
      expect(stats.tool.tokens, greaterThan(0));
      expect(stats.system.tokens, greaterThan(0));
      expect(
        stats.user.tokens +
            stats.assistant.tokens +
            stats.thinking.tokens +
            stats.tool.tokens +
            stats.system.tokens,
        equals(stats.totalTokens),
      );
    });
  });

  group('KaTeX formula rendering & narrow AppTitleBar', () {
    testWidgets('MarkdownProse renders \\[...\\] display math and \\(...\\)/\$...\$ inline math with Math.tex',
        (tester) async {
      final localeNotifier = ValueNotifier<AppLocale>(AppLocale.zh);
      addTearDown(localeNotifier.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: GoogleMaterialTheme.dark(),
          home: AppStringsScope(
            notifier: localeNotifier,
            child: const Scaffold(
              body: SingleChildScrollView(
                child: Padding(
                  padding: EdgeInsets.all(16),
                  child: MarkdownProse(
                    text: '给定矩阵：\n'
                        '\\[\n'
                        'A = \\begin{pmatrix}\n'
                        'a & b \\\\\n'
                        'c & d\n'
                        '\\end{pmatrix}\n'
                        '\\]\n'
                        '它的行列式（记作 \\(\\det(A)\\) 或 \$|A|\$）计算公式为：\n'
                        '\\[\n'
                        '\\det(A) = ad - bc\n'
                        '\\]',
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(Math), findsNWidgets(4));
      expect(find.textContaining(r'\['), findsNothing);
      expect(find.textContaining(r'\begin{pmatrix}'), findsNothing);
    });

    testWidgets('AppTitleBar omits SQLite WAL badge and ellipsizes long CLI badge without overflowing caption buttons',
        (tester) async {
      await tester.binding.setSurfaceSize(const Size(520, 200));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final localeNotifier = ValueNotifier<AppLocale>(AppLocale.zh);
      final themeModeNotifier = ValueNotifier<ThemeMode>(ThemeMode.dark);
      addTearDown(localeNotifier.dispose);
      addTearDown(themeModeNotifier.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: GoogleMaterialTheme.dark(),
          home: AppStringsScope(
            notifier: localeNotifier,
            child: Scaffold(
              body: AppTitleBar(
                appTitle: 'Session Manager',
                statusLabel: 'SQLite WAL 直连',
                statusConnected: true,
                dbPath: r'C:\Users\28491\.sm\archive.sqlite',
                localeNotifier: localeNotifier,
                themeModeNotifier: themeModeNotifier,
                onReload: () {},
                onCycleTheme: () {},
                trailingBadge: const HeaderBadge(
                  label: r'sm import C:\Users\28491\Downloads\deepseek_data-2026-11-16.zip --kind deepseek-web: exitCode=0',
                  emphasized: false,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('SQLite WAL 直连'), findsNothing);
      expect(tester.takeException(), isNull);

      final closeBtn = find.byTooltip('关闭');
      expect(closeBtn, findsOneWidget);
      expect(tester.getRect(closeBtn).right, lessThanOrEqualTo(520.0));
      expect(tester.getRect(closeBtn).right, greaterThanOrEqualTo(500.0));
    });

    testWidgets('AppTitleBar pins caption buttons to the far right on wide windows when trailingBadge is null',
        (tester) async {
      await tester.binding.setSurfaceSize(const Size(1200, 200));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final localeNotifier = ValueNotifier<AppLocale>(AppLocale.zh);
      final themeModeNotifier = ValueNotifier<ThemeMode>(ThemeMode.dark);
      addTearDown(localeNotifier.dispose);
      addTearDown(themeModeNotifier.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: GoogleMaterialTheme.dark(),
          home: AppStringsScope(
            notifier: localeNotifier,
            child: Scaffold(
              body: AppTitleBar(
                appTitle: 'Session Manager',
                statusLabel: 'SQLite WAL 直连',
                statusConnected: true,
                dbPath: r'C:\Users\28491\.sm\archive.sqlite',
                localeNotifier: localeNotifier,
                themeModeNotifier: themeModeNotifier,
                onReload: () {},
                onCycleTheme: () {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final closeBtn = find.byTooltip('关闭');
      expect(closeBtn, findsOneWidget);
      expect(tester.getRect(closeBtn).right, greaterThanOrEqualTo(1180.0));
      expect(tester.getRect(closeBtn).right, lessThanOrEqualTo(1200.0));
    });

    testWidgets('MarkdownProse renders formulas in light card DefaultTextStyle under dark Theme and buildShareSlices keeps reply start on page 1',
        (tester) async {
      final userMsg = MessageItem(
        id: 1,
        ordinal: 0,
        role: 'user',
        kind: 'message',
        text: '如何理解傅里叶变换？',
        isActiveBranch: true,
        isSynthetic: false,
      );
      final bodyText = List.generate(30, (i) => '第 $i 段详细推导与物理意义说明。').join('\n\n');
      final longMathReply = MessageItem(
        id: 2,
        ordinal: 1,
        role: 'assistant',
        kind: 'message',
        text: '数学表达：\n'
            '\\[\n'
            'F(\\omega) = \\int_{-\\infty}^{\\infty} f(t)e^{-j\\omega t}dt\n'
            '\\]\n'
            '其中 \$f(t)\$ 为时域信号。\n\n'
            '$bodyText',
        isActiveBranch: true,
        isSynthetic: false,
      );

      final slices = buildShareSlices([userMsg, longMathReply], maxBodyHeight: 800.0);
      expect(slices.length, greaterThan(1));
      expect(slices.first.segments.length, greaterThanOrEqualTo(2));
      expect(slices.first.segments.first.role, 'user');
      expect(slices.first.segments[1].role, 'assistant');

      final localeNotifier = ValueNotifier<AppLocale>(AppLocale.zh);
      addTearDown(localeNotifier.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: GoogleMaterialTheme.dark(),
          home: AppStringsScope(
            notifier: localeNotifier,
            child: Scaffold(
              body: Container(
                color: const Color(0xFFFFFFFF),
                child: DefaultTextStyle(
                  style: const TextStyle(color: Color(0xFF1F1F1F)),
                  child: SingleChildScrollView(
                    child: MarkdownProse(
                      text: slices.first.segments[1].text,
                      selectable: false,
                      showCopyButtons: false,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      final mathWidgets = tester.widgetList<Math>(find.byType(Math)).toList();
      expect(mathWidgets.length, 2);
      expect(mathWidgets.first.textStyle?.color, const Color(0xFF1F1F1F));
    });
  });
}
