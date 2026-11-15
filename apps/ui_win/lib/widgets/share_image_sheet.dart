import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:intl/intl.dart';
import 'package:path/path.dart' as p;

import '../data/app_settings.dart';
import '../data/archive_direct_store.dart';
import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';
import 'gm3_surface.dart';
import 'markdown_prose.dart';

enum ShareScopeMode { fullConversation, singleTurn }

class ShareSegment {
  final String role;
  final String? model;
  final String? toolName;
  final String text;
  final List<ViewBlock> blocks;
  final double estimatedHeight;

  const ShareSegment({
    required this.role,
    this.model,
    this.toolName,
    required this.text,
    this.blocks = const [],
    required this.estimatedHeight,
  });
}

class ShareSlice {
  final int index;
  final int total;
  final List<ShareSegment> segments;
  final double estimatedHeight;

  const ShareSlice({
    required this.index,
    required this.total,
    required this.segments,
    required this.estimatedHeight,
  });
}

bool _isToolLikeBlock(ViewBlock b) {
  return b.type == 'thinking' ||
      b.type == 'reasoning' ||
      b.type == 'thought' ||
      b.type == 'tool_use' ||
      b.type == 'tool_call' ||
      b.type == 'tool_result' ||
      b.type == 'file_diff';
}

final RegExp _shareSyntheticUserPrefixRe = RegExp(
  r'^(?:<(?:goal_round|goal_complete|system-reminder|system_reminder|system-notification|system_notification|system-time|time_reminder|permission_hint|permission-hint|subagent_reply|subagent-reply|agent_reply|task-notification|inbox|environment_context|permissions instructions|collaboration_mode|skills_instructions|turn_aborted|subagent_notification|local-command-[a-z-]+)\b|\[(?:model\s+changed:|system\b|system\s+time|current\s+time|time\s+hint|permission\b|user-approval|approval\b|inbox\b|subagent\b|agent\s+reply|inter-agent)|(?:system\s+time|current\s+time|permission\s+(?:hint|notice|prompt|mode)|subagent\s+(?:reply|response|report)|reply\s+from\s+(?:sub)?agent|browser\s+time\s+zone\s+for\s+this\s+request|elapsed\s+since\s+the\s+preceding\s+step\s+context)\s*[:：]|time\s+sampled\s+while\b|background\s+job\s+\S+|(?:background\s+)?subagent\s+\S+\s+(?:finished|completed|failed|stopped|canceled|cancelled)\b|background\s+subagent\b|agent\s+\S+\s+sent\s+a\s+message:|current\s+runtime\s+context\.\s+this\s+snapshot\s+supersedes|this\s+is\s+an\s+automatically\s+generated\s+checkpoint\s+condensing|the\s+(?:user\s+changed\s+the\s+)?approval\s+policy\s+(?:changed|was\s+changed)\b|the\s+working\s+directory\s+changed\s+from\b|#\s*AGENTS\.md\b|INSTRUCTIONS:|(?:系统时间|当前时间|系统权限|权限提示|子代理回复|来自子代理)\s*[:：]?)',
  caseSensitive: false,
);

final RegExp _inlineThinkTagRe = RegExp(
  r'<(?:think|thought|thinking)\b[^>]*>[\s\S]*?</(?:think|thought|thinking)>',
  caseSensitive: false,
);

bool _isRealShareUserPrompt(MessageItem item) {
  if (item.role != 'user' || item.isSynthetic) return false;
  final trimmed = item.text.trimLeft();
  if (trimmed.isNotEmpty && _shareSyntheticUserPrefixRe.hasMatch(trimmed)) {
    return false;
  }
  return true;
}

bool _isToolLikeItem(MessageItem item) {
  if (item.role == 'tool' ||
      item.role == 'system' ||
      item.role == 'developer' ||
      item.kind == 'tool_call' ||
      item.kind == 'tool_result' ||
      item.kind == 'thinking' ||
      item.kind == 'reasoning' ||
      item.kind == 'thought' ||
      item.kind == 'system_note' ||
      item.kind == 'summary' ||
      item.kind == 'compaction' ||
      item.kind == 'turn_context' ||
      item.kind == 'notice' ||
      item.kind == 'file_change' ||
      item.kind == 'web_search' ||
      item.isSynthetic) {
    return true;
  }
  if (item.role == 'user' && !_isRealShareUserPrompt(item)) {
    return true;
  }
  if (item.role == 'assistant' && item.blocks.isNotEmpty) {
    final hasNonToolBlock = item.blocks.any((b) =>
        !_isToolLikeBlock(b) &&
        (b.type == 'image' ||
            b.type == 'code' ||
            (b.text ?? '').trim().isNotEmpty));
    if (!hasNonToolBlock && item.blocks.every(_isToolLikeBlock)) {
      return true;
    }
  }
  return false;
}

MessageItem? _sanitizeShareItem(
  MessageItem item, {
  required bool includeToolDetails,
}) {
  if (item.isHidden) return null;
  if (!includeToolDetails && _isToolLikeItem(item)) return null;

  if (includeToolDetails) {
    final hasVisibleText = item.text.trim().isNotEmpty;
    if (!hasVisibleText && item.blocks.isEmpty) return null;
    return item;
  }

  final filteredBlocks = item.blocks
      .where((b) =>
          !_isToolLikeBlock(b) &&
          (b.type == 'image' ||
              b.type == 'code' ||
              b.type == 'file' ||
              b.type == 'link' ||
              (b.text ?? '').trim().isNotEmpty))
      .toList(growable: false);

  if (item.blocks.isNotEmpty) {
    if (filteredBlocks.isEmpty) return null;
    final cleanBlocks = <ViewBlock>[];
    for (final b in filteredBlocks) {
      if (b.type == 'text' && b.text != null) {
        final cleaned = b.text!.replaceAll(_inlineThinkTagRe, '').trim();
        if (cleaned.isEmpty) continue;
        cleanBlocks.add(ViewBlock(
          idx: b.idx,
          type: b.type,
          text: cleaned,
          lang: b.lang,
          toolName: b.toolName,
          toolCallId: b.toolCallId,
          toolInput: b.toolInput,
          status: b.status,
          blobSha256: b.blobSha256,
          availability: b.availability,
          meta: b.meta,
        ));
      } else {
        cleanBlocks.add(b);
      }
    }
    if (cleanBlocks.isEmpty) return null;
    final recomputedText = cleanBlocks
        .map((b) => b.type == 'code'
            ? '```${b.lang ?? ''}\n${b.text ?? ''}\n```'
            : (b.text ?? ''))
        .where((t) => t.trim().isNotEmpty)
        .join('\n\n');
    return MessageItem(
      id: item.id,
      parentId: item.parentId,
      ordinal: item.ordinal,
      depth: item.depth,
      role: item.role,
      kind: item.kind,
      model: item.model,
      toolName: item.toolName,
      createdAt: item.createdAt,
      text: recomputedText,
      payloadRef: item.payloadRef,
      blocks: cleanBlocks,
      isActiveBranch: item.isActiveBranch,
      isSynthetic: item.isSynthetic,
      supersededBy: item.supersededBy,
    );
  }

  final cleanedText = item.text.replaceAll(_inlineThinkTagRe, '').trim();
  if (cleanedText.isEmpty) return null;
  if (cleanedText == item.text) return item;
  return MessageItem(
    id: item.id,
    parentId: item.parentId,
    ordinal: item.ordinal,
    depth: item.depth,
    role: item.role,
    kind: item.kind,
    model: item.model,
    toolName: item.toolName,
    createdAt: item.createdAt,
    text: cleanedText,
    payloadRef: item.payloadRef,
    blocks: const [],
    isActiveBranch: item.isActiveBranch,
    isSynthetic: item.isSynthetic,
    supersededBy: item.supersededBy,
  );
}

/// Filters active branch items by share scope (`fullConversation` vs `singleTurn`)
/// and whether thinking/tool call details should be included.
List<MessageItem> filterShareMessages(
  List<MessageItem> activeItems, {
  required ShareScopeMode scope,
  int? targetAssistantId,
  required bool includeToolDetails,
}) {
  final visible = activeItems.where((m) => !m.isHidden).toList(growable: false);
  if (visible.isEmpty) return const [];

  // Partition into real user turns (matching BranchTreeReaderView turn slices)
  final slices = <List<MessageItem>>[];
  var current = <MessageItem>[];
  for (final item in visible) {
    if (_isRealShareUserPrompt(item)) {
      if (current.isNotEmpty) slices.add(current);
      current = [item];
    } else {
      current.add(item);
    }
  }
  if (current.isNotEmpty) slices.add(current);

  if (scope == ShareScopeMode.singleTurn && targetAssistantId != null) {
    for (final slice in slices) {
      final pos = slice.indexWhere((m) => m.id == targetAssistantId);
      if (pos < 0) continue;

      final hasLeadingUser =
          slice.isNotEmpty && _isRealShareUserPrompt(slice.first);
      if (!includeToolDetails) {
        final out = <MessageItem>[];
        if (hasLeadingUser && slice.first.id != slice[pos].id) {
          final cleanUser =
              _sanitizeShareItem(slice.first, includeToolDetails: false);
          if (cleanUser != null) out.add(cleanUser);
        }
        final cleanTarget =
            _sanitizeShareItem(slice[pos], includeToolDetails: false);
        if (cleanTarget != null) {
          out.add(cleanTarget);
        } else {
          // If the user explicitly picked a non-standard item, still preserve it
          // alongside the prompt so singleTurn isn't blank.
          out.add(slice[pos]);
        }
        return out;
      }

      // includeToolDetails == true: include prompt + turn process up through target
      // (and trailing tool/process items if target is the final assistant reply)
      final lastAsstIdx =
          slice.lastIndexWhere((m) => _sanitizeShareItem(m, includeToolDetails: false)?.role == 'assistant');
      final endIdx = (pos == lastAsstIdx || lastAsstIdx < 0)
          ? slice.length - 1
          : pos;
      final out = <MessageItem>[];
      for (var i = 0; i <= endIdx; i++) {
        final clean = _sanitizeShareItem(slice[i], includeToolDetails: true);
        if (clean != null) out.add(clean);
      }
      return out;
    }
  }

  // Full conversation
  final out = <MessageItem>[];
  for (final slice in slices) {
    if (includeToolDetails) {
      for (final m in slice) {
        final clean = _sanitizeShareItem(m, includeToolDetails: true);
        if (clean != null) out.add(clean);
      }
      continue;
    }

    // When excluding thinking & tool details, match the main reader view:
    // emit the real user prompt + ONLY the final substantive assistant reply of the turn.
    final startIdx =
        slice.isNotEmpty && _isRealShareUserPrompt(slice.first) ? 1 : 0;
    if (startIdx == 1) {
      final cleanUser =
          _sanitizeShareItem(slice.first, includeToolDetails: false);
      if (cleanUser != null) out.add(cleanUser);
    }

    MessageItem? finalReply;
    for (var i = slice.length - 1; i >= startIdx; i--) {
      final candidate = slice[i];
      if (candidate.role != 'assistant') continue;
      final clean = _sanitizeShareItem(candidate, includeToolDetails: false);
      if (clean != null) {
        finalReply = clean;
        break;
      }
    }
    if (finalReply != null) {
      out.add(finalReply);
    }
  }
  return out;
}

double _estimateTextHeight(String text,
    {double widthChars = 66, double lineHeight = 25.5}) {
  if (text.trim().isEmpty) return 0;
  var totalLines = 0;
  for (final line in text.split('\n')) {
    final weightedLen = line.runes.fold<int>(
      0,
      (acc, r) => acc + (r > 0x2E7F ? 2 : 1),
    );
    totalLines += math.max(1, (weightedLen / widthChars).ceil());
  }
  return totalLines * lineHeight + 18;
}

double _estimateBlockHeight(ViewBlock b) {
  if (b.type == 'image') return 260;
  if (b.type == 'code' || _isToolLikeBlock(b)) {
    final content = (b.toolInput ?? b.text ?? '').trim();
    return 48 + _estimateTextHeight(content, widthChars: 74, lineHeight: 21);
  }
  return _estimateTextHeight(b.text ?? '');
}

List<ShareSegment> _splitMessageIfOversized(
  MessageItem item,
  double maxBodyHeight, {
  double? firstChunkMaxHeight,
}) {
  final singleHeight = 46 +
      (item.blocks.isNotEmpty
          ? item.blocks.fold<double>(0, (s, b) => s + _estimateBlockHeight(b))
          : _estimateTextHeight(item.text));

  final firstBudget = firstChunkMaxHeight ?? maxBodyHeight;
  if (singleHeight <= firstBudget) {
    return [
      ShareSegment(
        role: item.role,
        model: item.model,
        toolName: item.toolName,
        text: item.text,
        blocks: item.blocks,
        estimatedHeight: singleHeight,
      ),
    ];
  }

  final out = <ShareSegment>[];
  if (item.blocks.length > 1) {
    var accBlocks = <ViewBlock>[];
    var accHeight = 40.0;
    for (final b in item.blocks) {
      final bh = _estimateBlockHeight(b);
      final budget = out.isEmpty ? firstBudget : maxBodyHeight;
      if (accBlocks.isNotEmpty && accHeight + bh > budget) {
        out.add(ShareSegment(
          role: item.role,
          model: item.model,
          toolName: item.toolName,
          text: '',
          blocks: accBlocks,
          estimatedHeight: accHeight,
        ));
        accBlocks = [];
        accHeight = 40.0;
      }
      accBlocks.add(b);
      accHeight += bh;
    }
    if (accBlocks.isNotEmpty) {
      out.add(ShareSegment(
        role: item.role,
        model: item.model,
        toolName: item.toolName,
        text: '',
        blocks: accBlocks,
        estimatedHeight: accHeight,
      ));
    }
    return out;
  }

  final rawText = item.blocks.length == 1
      ? (item.blocks.first.text ?? item.text)
      : item.text;
  final paragraphs = rawText.split(RegExp(r'\r?\n\r?\n'));
  var buf = <String>[];
  var accHeight = 40.0;

  void flushChunk() {
    if (buf.isEmpty) return;
    final joined = buf.join('\n\n');
    out.add(ShareSegment(
      role: item.role,
      model: item.model,
      toolName: item.toolName,
      text: joined,
      estimatedHeight: accHeight,
    ));
    buf = [];
    accHeight = 40.0;
  }

  for (final para in paragraphs) {
    final ph = _estimateTextHeight(para);
    final budget = out.isEmpty ? firstBudget : maxBodyHeight;
    if (ph > budget) {
      flushChunk();
      final lines = para.split('\n');
      for (final line in lines) {
        final lh = _estimateTextHeight(line);
        final lineBudget = out.isEmpty ? firstBudget : maxBodyHeight;
        if (buf.isNotEmpty && accHeight + lh > lineBudget) {
          flushChunk();
        }
        buf.add(line);
        accHeight += lh;
      }
      flushChunk();
      continue;
    }
    if (buf.isNotEmpty && accHeight + ph > budget) {
      flushChunk();
    }
    buf.add(para);
    accHeight += ph;
  }
  flushChunk();

  if (out.isEmpty) {
    out.add(ShareSegment(
      role: item.role,
      model: item.model,
      toolName: item.toolName,
      text: rawText,
      blocks: item.blocks,
      estimatedHeight: singleHeight,
    ));
  }
  return out;
}

/// Splits [messages] into ordered slices whose rendered heights stay below GPU limits.
List<ShareSlice> buildShareSlices(
  List<MessageItem> messages, {
  double maxBodyHeight = 3600.0,
}) {
  final allSegments = <ShareSegment>[];
  var pendingHeight = 0.0;
  for (final m in messages) {
    final firstBudget =
        pendingHeight > 0 && pendingHeight < maxBodyHeight * 0.6
            ? (maxBodyHeight - pendingHeight).clamp(400.0, maxBodyHeight)
            : maxBodyHeight;
    final segs = _splitMessageIfOversized(
      m,
      maxBodyHeight,
      firstChunkMaxHeight: firstBudget,
    );
    for (final s in segs) {
      allSegments.add(s);
      if (pendingHeight + s.estimatedHeight > maxBodyHeight) {
        pendingHeight = s.estimatedHeight;
      } else {
        pendingHeight += s.estimatedHeight;
      }
    }
  }
  if (allSegments.isEmpty) return const [];

  final grouped = <List<ShareSegment>>[];
  final heights = <double>[];
  var current = <ShareSegment>[];
  var currentHeight = 0.0;

  for (final seg in allSegments) {
    if (current.isNotEmpty &&
        currentHeight + seg.estimatedHeight > maxBodyHeight) {
      grouped.add(current);
      heights.add(currentHeight);
      current = [];
      currentHeight = 0.0;
    }
    current.add(seg);
    currentHeight += seg.estimatedHeight;
  }
  if (current.isNotEmpty) {
    grouped.add(current);
    heights.add(currentHeight);
  }

  return [
    for (var i = 0; i < grouped.length; i++)
      ShareSlice(
        index: i,
        total: grouped.length,
        segments: grouped[i],
        estimatedHeight: heights[i],
      ),
  ];
}

class ShareImageDialog extends StatefulWidget {
  final ConversationDetail detail;
  final List<MessageItem> activeItems;
  final ArchiveDirectStore store;
  final AppSettingsController? settings;
  final int? initialAssistantItemId;
  final String? initialOutputDir;

  const ShareImageDialog({
    super.key,
    required this.detail,
    required this.activeItems,
    required this.store,
    this.settings,
    this.initialAssistantItemId,
    this.initialOutputDir,
  });

  @override
  State<ShareImageDialog> createState() => _ShareImageDialogState();
}

class _ShareImageDialogState extends State<ShareImageDialog> {
  late ShareScopeMode _scopeMode;
  late bool _includeToolDetails;
  int? _selectedAssistantId;
  int _previewSliceIdx = 0;

  late ShareColorStyle _colorStyle;
  late bool _showAuthor;
  late bool _enableWatermark;
  late bool _showBrandText;
  bool _mobileLayout = false;
  bool _showShareDate = true;
  late final TextEditingController _authorCtrl;
  late final TextEditingController _watermarkCtrl;
  late final TextEditingController _brandTextCtrl;
  late final TextEditingController _outputDirCtrl;

  bool _generating = false;
  int _currentSliceIdx = 0;
  int _totalSlices = 0;
  List<File> _savedFiles = [];
  String? _errorMsg;

  List<MessageItem> get _assistantTurns => widget.activeItems
      .where((m) {
        if (m.id == widget.initialAssistantItemId) return true;
        if (m.role != 'assistant' || m.isHidden || _isToolLikeItem(m)) {
          return false;
        }
        return _sanitizeShareItem(m, includeToolDetails: false) != null;
      })
      .toList();

  @override
  void initState() {
    super.initState();
    final assistants = _assistantTurns;
    _scopeMode = widget.initialAssistantItemId != null
        ? ShareScopeMode.singleTurn
        : ShareScopeMode.fullConversation;
    _includeToolDetails = false;
    _selectedAssistantId = widget.initialAssistantItemId ??
        (assistants.isNotEmpty ? assistants.last.id : null);

    final cfg = widget.settings;
    final defaultAuthor =
        cfg?.authorName ?? AppSettingsController.defaultSystemAuthorName();
    _colorStyle = cfg?.shareColorStyle ?? ShareColorStyle.paperLight;
    _showAuthor = cfg?.shareShowAuthor ?? true;
    _enableWatermark = cfg?.shareEnableWatermark ?? true;
    _showBrandText = cfg?.shareShowBrandText ?? true;

    _authorCtrl = TextEditingController(text: defaultAuthor)
      ..addListener(_onPreviewTextEdited);
    _watermarkCtrl = TextEditingController(
      text: cfg?.effectiveWatermarkText ?? '@$defaultAuthor · SessionManager',
    )..addListener(_onPreviewTextEdited);
    _brandTextCtrl = TextEditingController(
      text: cfg?.shareBrandText ?? '由 SessionManager 分享',
    )..addListener(_onPreviewTextEdited);
    _outputDirCtrl = TextEditingController(
      text: widget.initialOutputDir ?? _defaultShareDir(),
    );
  }

  void _onPreviewTextEdited() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _authorCtrl.dispose();
    _watermarkCtrl.dispose();
    _brandTextCtrl.dispose();
    _outputDirCtrl.dispose();
    super.dispose();
  }

  String _defaultShareDir() {
    final home = (Platform.environment['USERPROFILE'] ??
            Platform.environment['HOME'] ??
            '')
        .trim();
    if (home.isNotEmpty) {
      return p.join(home, 'Pictures', 'SessionManager Shares');
    }
    return p.join(p.dirname(widget.store.dbPath), 'shares');
  }

  List<ShareSlice> _computeCurrentSlices() {
    final filtered = filterShareMessages(
      widget.activeItems,
      scope: _scopeMode,
      targetAssistantId: _selectedAssistantId,
      includeToolDetails: _includeToolDetails,
    );
    return buildShareSlices(filtered);
  }

  String _safeSlug(String raw) {
    final cleaned = raw
        .replaceAll(RegExp(r'[\\/:*?"<>|\s]+'), '_')
        .replaceAll(RegExp(r'_+'), '_')
        .replaceAll(RegExp(r'^_|_$'), '');
    if (cleaned.isEmpty) return 'session';
    return cleaned.length > 36 ? cleaned.substring(0, 36) : cleaned;
  }

  Future<void> _pickOutputFolder() async {
    if (!Platform.isWindows) return;
    final res = await Process.run('powershell', [
      '-NoProfile',
      '-STA',
      '-Command',
      '''
Add-Type -AssemblyName System.Windows.Forms
\$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
\$dlg.Description = 'Select Share Image Output Folder'
if (\$dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output \$dlg.SelectedPath }
''',
    ]);
    final out = res.stdout.toString().trim();
    if (out.isNotEmpty && mounted) {
      setState(() => _outputDirCtrl.text = out);
    }
  }

  ShareRenderOptions _currentRenderOptions() {
    return ShareRenderOptions(
      style: _colorStyle,
      showAuthor: _showAuthor,
      authorName: _authorCtrl.text.trim(),
      enableWatermark: _enableWatermark,
      watermarkText: _watermarkCtrl.text.trim(),
      showBrandText: _showBrandText,
      brandText: _brandTextCtrl.text.trim(),
      mobileLayout: _mobileLayout,
      showShareDate: _showShareDate,
    );
  }

  Future<void> _generatePngs() async {
    final slices = _computeCurrentSlices();
    if (slices.isEmpty) return;

    final outDirPath = _outputDirCtrl.text.trim();
    if (outDirPath.isEmpty) return;

    setState(() {
      _generating = true;
      _errorMsg = null;
      _savedFiles = [];
      _currentSliceIdx = 0;
      _totalSlices = slices.length;
    });

    try {
      final outDir = Directory(outDirPath);
      if (!outDir.existsSync()) {
        outDir.createSync(recursive: true);
      }
      final stamp = DateFormat('yyyyMMdd_HHmmss').format(DateTime.now());
      final slug = _safeSlug(widget.detail.title);
      final files = <File>[];
      final renderOpts = _currentRenderOptions();

      for (var i = 0; i < slices.length; i++) {
        if (!mounted) return;
        setState(() => _currentSliceIdx = i + 1);
        final bytes = await _captureSlicePng(slices[i], renderOpts);
        final suffix =
            slices.length > 1 ? '_part${i + 1}of${slices.length}' : '';
        final file =
            File(p.join(outDir.path, 'share_${slug}_$stamp$suffix.png'));
        await file.writeAsBytes(bytes, flush: true);
        files.add(file);
      }

      if (!mounted) return;
      setState(() {
        _generating = false;
        _savedFiles = files;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _generating = false;
        _errorMsg = err.toString();
      });
    }
  }

  Future<List<int>> _captureSlicePng(
    ShareSlice slice,
    ShareRenderOptions renderOptions,
  ) async {
    final key = GlobalKey();
    final palette = SharePalette.forStyle(renderOptions.style);
    final cardTheme = palette.isDark ? Gm3.dark() : Gm3.light();
    final strings = AppStringsScope.of(context);
    final overlay = Overlay.of(context, rootOverlay: true);

    final canvasWidth = renderOptions.mobileLayout ? 430.0 : 780.0;
    final entry = OverlayEntry(
      builder: (_) => Positioned(
        left: -12000,
        top: 0,
        width: canvasWidth,
        height: 1200,
        child: SingleChildScrollView(
          physics: const NeverScrollableScrollPhysics(),
          child: Material(
            color: Colors.transparent,
            child: Theme(
              data: cardTheme,
              child: AppStringsScope(
                notifier: AppStringsScope.notifierOf(context) ??
                    ValueNotifier<AppLocale>(strings.locale),
                child: Align(
                  alignment: Alignment.topLeft,
                  child: RepaintBoundary(
                    key: key,
                    child: _ShareCardCanvas(
                      detail: widget.detail,
                      slice: slice,
                      includeToolDetails: _includeToolDetails,
                      options: renderOptions,
                      resolveBlobFile: widget.store.resolveBlobFile,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    overlay.insert(entry);
    try {
      await SchedulerBinding.instance.endOfFrame;
      await Future<void>.delayed(const Duration(milliseconds: 32));
      await SchedulerBinding.instance.endOfFrame;
      final ro = key.currentContext?.findRenderObject();
      if (ro is! RenderRepaintBoundary) {
        throw StateError(
            'RepaintBoundary failed to mount for slice ${slice.index + 1}');
      }
      final logicalHeight = math.max(1.0, ro.size.height);
      final pixelRatio = math.min(2.0, 8000.0 / logicalHeight);
      final image = await ro.toImage(pixelRatio: pixelRatio);
      try {
        final byteData =
            await image.toByteData(format: ui.ImageByteFormat.png);
        if (byteData == null) {
          throw StateError(
              'Failed to encode PNG bytes for slice ${slice.index + 1}');
        }
        return byteData.buffer.asUint8List();
      } finally {
        image.dispose();
      }
    } finally {
      entry.remove();
    }
  }

  String _turnPreview(MessageItem item) {
    final clean = item.text.replaceAll(RegExp(r'\s+'), ' ').trim();
    if (clean.isEmpty) return '#${item.id} (${item.blocks.length} blocks)';
    return clean.length > 56 ? '${clean.substring(0, 53)}...' : clean;
  }

  String _styleLabel(AppStrings s, ShareColorStyle style) {
    return switch (style) {
      ShareColorStyle.paperLight => s.isZh ? '素雅浅纸' : 'Paper',
      ShareColorStyle.obsidianDark => s.isZh ? '极夜深黑' : 'Obsidian',
      ShareColorStyle.auroraBlue => s.isZh ? '晴空澄蓝' : 'Aurora',
      ShareColorStyle.warmSand => s.isZh ? '暖阳米沙' : 'Warm Sand',
      ShareColorStyle.forestMint => s.isZh ? '薄荷青瓷' : 'Forest Mint',
    };
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final assistants = _assistantTurns;
    final slices = _computeCurrentSlices();
    final safeSliceIdx =
        slices.isEmpty ? 0 : _previewSliceIdx.clamp(0, slices.length - 1);
    final renderOpts = _currentRenderOptions();
    final previewPalette = SharePalette.forStyle(_colorStyle);

    return Dialog(
      backgroundColor: surfaces.card,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Gm3.radiusLg),
      ),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 1080, maxHeight: 740),
        child: Padding(
          padding: const EdgeInsets.all(22),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Header
              Row(
                children: [
                  Icon(Icons.image_outlined, color: cs.primary, size: 22),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      s.shareSheetTitle,
                      style: theme.textTheme.titleMedium,
                    ),
                  ),
                  if (slices.isNotEmpty)
                    Gm3Pill(
                      label:
                          '${slices.length} ${s.isZh ? "张 PNG 图片" : "PNG slice(s)"}',
                      color: cs.primary,
                      background: surfaces.chipFill,
                    ),
                  const SizedBox(width: 8),
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    onPressed:
                        _generating ? null : () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 14),

              // Two-Column Body: Left Preview + Right Controls
              Expanded(
                child: LayoutBuilder(
                  builder: (ctx, constraints) {
                    final previewPane = _buildPreviewPane(
                      context,
                      s: s,
                      slices: slices,
                      activeIdx: safeSliceIdx,
                      renderOpts: renderOpts,
                      previewPalette: previewPalette,
                    );
                    final controlsPane = _buildControlsPane(
                      context,
                      s: s,
                      assistants: assistants,
                      slices: slices,
                    );

                    if (constraints.maxWidth < 740) {
                      return Column(
                        children: [
                          SizedBox(height: 280, child: previewPane),
                          const SizedBox(height: 12),
                          Expanded(child: controlsPane),
                        ],
                      );
                    }

                    return Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(flex: 11, child: previewPane),
                        const SizedBox(width: 18),
                        Expanded(flex: 9, child: controlsPane),
                      ],
                    );
                  },
                ),
              ),

              const SizedBox(height: 14),
              // Footer Action Row
              Row(
                children: [
                  if (_savedFiles.isNotEmpty && Platform.isWindows)
                    TextButton.icon(
                      onPressed: () => Process.run(
                        'explorer.exe',
                        [_savedFiles.first.parent.path],
                      ),
                      icon: const Icon(Icons.folder_outlined, size: 17),
                      label: Text(s.shareOpenFolder),
                    ),
                  const Spacer(),
                  FilledButton.icon(
                    onPressed:
                        _generating || slices.isEmpty ? null : _generatePngs,
                    icon: const Icon(Icons.download_outlined, size: 17),
                    label: Text(s.shareGenerateBtn),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildPreviewPane(
    BuildContext context, {
    required AppStrings s,
    required List<ShareSlice> slices,
    required int activeIdx,
    required ShareRenderOptions renderOpts,
    required SharePalette previewPalette,
  }) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    return Container(
      decoration: BoxDecoration(
        color: surfaces.inset,
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
        border: Border.all(color: surfaces.hairline.withOpacity(0.5)),
      ),
      child: Column(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: BoxDecoration(
              color: surfaces.panel,
              borderRadius: const BorderRadius.vertical(
                top: Radius.circular(Gm3.radiusMd),
              ),
            ),
            child: Row(
              children: [
                Icon(Icons.visibility_outlined, size: 15, color: cs.primary),
                const SizedBox(width: 6),
                Text(
                  s.sharePreviewTitle,
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                if (slices.length > 1) ...[
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.chevron_left, size: 18),
                    onPressed: activeIdx > 0
                        ? () => setState(() => _previewSliceIdx = activeIdx - 1)
                        : null,
                  ),
                  Text(
                    '${activeIdx + 1} / ${slices.length}',
                    style: GoogleMaterialTheme.monoTextStyle(
                      fontSize: Gm3.monoSm,
                      color: cs.primary,
                    ),
                  ),
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    icon: const Icon(Icons.chevron_right, size: 18),
                    onPressed: activeIdx < slices.length - 1
                        ? () => setState(() => _previewSliceIdx = activeIdx + 1)
                        : null,
                  ),
                ],
              ],
            ),
          ),
          Divider(color: surfaces.hairline.withOpacity(0.4), height: 1),
          Expanded(
            child: slices.isEmpty
                ? Center(
                    child: Text(
                      s.shareNoTurns,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: cs.error,
                      ),
                    ),
                  )
                : SingleChildScrollView(
                    padding: const EdgeInsets.all(14),
                    child: Center(
                      child: FittedBox(
                        fit: BoxFit.scaleDown,
                        alignment: Alignment.topCenter,
                        child: Theme(
                          data: previewPalette.isDark
                              ? Gm3.dark()
                              : Gm3.light(),
                          child: Container(
                            decoration: BoxDecoration(
                              borderRadius:
                                  BorderRadius.circular(Gm3.radiusMd),
                              boxShadow: [
                                BoxShadow(
                                  color: Colors.black.withOpacity(0.14),
                                  blurRadius: 16,
                                  offset: const Offset(0, 6),
                                ),
                              ],
                            ),
                            child: ClipRRect(
                              borderRadius:
                                  BorderRadius.circular(Gm3.radiusMd),
                              child: _ShareCardCanvas(
                                detail: widget.detail,
                                slice: slices[activeIdx],
                                includeToolDetails: _includeToolDetails,
                                options: renderOpts,
                                resolveBlobFile: widget.store.resolveBlobFile,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildRoundedSwitch({
    required bool value,
    required String title,
    required ValueChanged<bool>? onChanged,
    bool dense = false,
  }) {
    return SwitchListTile.adaptive(
      value: value,
      dense: dense,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 8),
      title: Text(title, style: Theme.of(context).textTheme.bodyMedium),
      onChanged: onChanged,
    );
  }

  Widget _buildControlsPane(
    BuildContext context, {
    required AppStrings s,
    required List<MessageItem> assistants,
    required List<ShareSlice> slices,
  }) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    return SingleChildScrollView(
      padding: const EdgeInsets.only(right: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Scope Mode Selector (no full-row wrapper)
          SegmentedButton<ShareScopeMode>(
            segments: [
              ButtonSegment(
                value: ShareScopeMode.fullConversation,
                label: Text(s.shareModeFull),
                icon: const Icon(Icons.forum_outlined, size: 15),
              ),
              ButtonSegment(
                value: ShareScopeMode.singleTurn,
                label: Text(s.shareModeSingleTurn),
                icon: const Icon(Icons.chat_bubble_outline, size: 15),
              ),
            ],
            selected: {_scopeMode},
            onSelectionChanged: _generating
                ? null
                : (val) => setState(() {
                      _scopeMode = val.first;
                      _previewSliceIdx = 0;
                      if (_selectedAssistantId == null &&
                          assistants.isNotEmpty) {
                        _selectedAssistantId = assistants.last.id;
                      }
                    }),
          ),

          if (_scopeMode == ShareScopeMode.singleTurn &&
              assistants.isNotEmpty) ...[
            const SizedBox(height: 12),
            Text(s.shareSelectTurn, style: theme.textTheme.labelMedium),
            const SizedBox(height: 6),
            DropdownButtonFormField<int>(
              value: assistants.any((a) => a.id == _selectedAssistantId)
                  ? _selectedAssistantId
                  : assistants.last.id,
              isExpanded: true,
              menuMaxHeight: 320,
              itemHeight: 48,
              dropdownColor: surfaces.card,
              borderRadius: BorderRadius.circular(Gm3.radiusMd),
              decoration: InputDecoration(
                filled: true,
                fillColor: surfaces.inset,
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(Gm3.radiusMd),
                  borderSide: BorderSide.none,
                ),
              ),
              selectedItemBuilder: (ctx) => [
                for (var i = 0; i < assistants.length; i++)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      'Reply #${i + 1}: ${_turnPreview(assistants[i])}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
              ],
              items: [
                for (var i = 0; i < assistants.length; i++)
                  DropdownMenuItem(
                    value: assistants[i].id,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 320),
                      child: Text(
                        'Reply #${i + 1}: ${_turnPreview(assistants[i])}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium?.copyWith(fontSize: 13),
                      ),
                    ),
                  ),
              ],
              onChanged: _generating
                  ? null
                  : (v) => setState(() {
                        _selectedAssistantId = v;
                        _previewSliceIdx = 0;
                      }),
            ),
          ],

          const SizedBox(height: 8),
          _buildRoundedSwitch(
            value: _includeToolDetails,
            title: s.shareIncludeToolDetails,
            onChanged: _generating
                ? null
                : (v) => setState(() {
                      _includeToolDetails = v;
                      _previewSliceIdx = 0;
                    }),
          ),
          _buildRoundedSwitch(
            value: _mobileLayout,
            dense: true,
            title: s.shareMobileLayout,
            onChanged: _generating
                ? null
                : (v) => setState(() => _mobileLayout = v),
          ),

          const Divider(height: 16),

          // Color Style Swatches
          Text(s.shareColorStyleLabel, style: theme.textTheme.labelMedium),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final style in ShareColorStyle.values)
                Builder(
                  builder: (_) {
                    final pal = SharePalette.forStyle(style);
                    final selected = _colorStyle == style;
                    return InkWell(
                      onTap: _generating
                          ? null
                          : () => setState(() => _colorStyle = style),
                      borderRadius: BorderRadius.circular(Gm3.radiusMd),
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 120),
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 6),
                        decoration: BoxDecoration(
                          color: selected
                              ? cs.primaryContainer.withOpacity(0.65)
                              : surfaces.inset,
                          borderRadius: BorderRadius.circular(Gm3.radiusMd),
                          border: Border.all(
                            color: selected
                                ? cs.primary
                                : surfaces.hairline.withOpacity(0.5),
                            width: selected ? 1.5 : 1,
                          ),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              width: 14,
                              height: 14,
                              decoration: BoxDecoration(
                                color: pal.canvasBg,
                                shape: BoxShape.circle,
                                border: Border.all(color: pal.accent, width: 2),
                              ),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              _styleLabel(s, style),
                              style: theme.textTheme.labelMedium?.copyWith(
                                fontWeight: selected
                                    ? FontWeight.w700
                                    : FontWeight.w500,
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
            ],
          ),

          const SizedBox(height: 12),

          // Signature Toggle & Text
          _buildRoundedSwitch(
            value: _showAuthor,
            dense: true,
            title: s.shareShowAuthorLabel,
            onChanged: _generating
                ? null
                : (v) => setState(() => _showAuthor = v),
          ),
          if (_showAuthor) ...[
            TextField(
              controller: _authorCtrl,
              enabled: !_generating,
              decoration: InputDecoration(
                isDense: true,
                labelText: s.shareAuthorInputLabel,
                prefixText: '@',
              ),
            ),
            const SizedBox(height: 8),
          ],

          // "由 SessionManager 分享" Brand Text Toggle & Input
          _buildRoundedSwitch(
            value: _showBrandText,
            dense: true,
            title: s.shareBrandToggle,
            onChanged: _generating
                ? null
                : (v) => setState(() => _showBrandText = v),
          ),
          if (_showBrandText) ...[
            TextField(
              controller: _brandTextCtrl,
              enabled: !_generating,
              decoration: InputDecoration(
                isDense: true,
                labelText: s.shareBrandTextLabel,
              ),
            ),
            const SizedBox(height: 8),
          ],

          // Share Date Toggle
          _buildRoundedSwitch(
            value: _showShareDate,
            dense: true,
            title: s.shareShowDate,
            onChanged: _generating
                ? null
                : (v) => setState(() => _showShareDate = v),
          ),

          // Diagonal Watermark Toggle & Input
          _buildRoundedSwitch(
            value: _enableWatermark,
            dense: true,
            title: s.shareWatermarkToggle,
            onChanged: _generating
                ? null
                : (v) => setState(() => _enableWatermark = v),
          ),
          if (_enableWatermark) ...[
            TextField(
              controller: _watermarkCtrl,
              enabled: !_generating,
              decoration: InputDecoration(
                isDense: true,
                labelText: s.shareWatermarkTextLabel,
              ),
            ),
            const SizedBox(height: 10),
          ],

          const Divider(height: 16),

          // Output Folder
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _outputDirCtrl,
                  enabled: !_generating,
                  decoration: InputDecoration(
                    isDense: true,
                    labelText: s.shareOutputDirLabel,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton.icon(
                onPressed: _generating ? null : _pickOutputFolder,
                icon: const Icon(Icons.folder_open, size: 16),
                label: Text(s.browseFolder),
              ),
            ],
          ),

          if (_generating) ...[
            const SizedBox(height: 12),
            LinearProgressIndicator(
              value: _totalSlices > 0 ? _currentSliceIdx / _totalSlices : null,
            ),
            const SizedBox(height: 6),
            Text(
              '${s.shareGenerating} ($_currentSliceIdx / $_totalSlices)',
              style: theme.textTheme.labelSmall,
            ),
          ],

          if (_errorMsg != null) ...[
            const SizedBox(height: 10),
            Text(
              _errorMsg!,
              style: theme.textTheme.bodySmall?.copyWith(color: cs.error),
            ),
          ],

          if (_savedFiles.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: surfaces.inset,
                borderRadius: BorderRadius.circular(Gm3.radiusMd),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    s.shareSavedCount(
                        _savedFiles.length, _outputDirCtrl.text.trim()),
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: const Color(0xFF137333),
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 4),
                  for (final f in _savedFiles)
                    Text(
                      '• ${p.basename(f.path)} (${(f.lengthSync() / 1024).toStringAsFixed(0)} KB)',
                      style: GoogleMaterialTheme.monoTextStyle(
                        fontSize: Gm3.monoSm,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class ShareRenderOptions {
  final ShareColorStyle style;
  final bool showAuthor;
  final String authorName;
  final bool enableWatermark;
  final String watermarkText;
  final bool showBrandText;
  final String brandText;
  final bool mobileLayout;
  final bool showShareDate;

  const ShareRenderOptions({
    required this.style,
    required this.showAuthor,
    required this.authorName,
    required this.enableWatermark,
    required this.watermarkText,
    required this.showBrandText,
    required this.brandText,
    this.mobileLayout = false,
    this.showShareDate = false,
  });
}

class _ShareCardCanvas extends StatelessWidget {
  final ConversationDetail detail;
  final ShareSlice slice;
  final bool includeToolDetails;
  final ShareRenderOptions options;
  final File? Function(String sha) resolveBlobFile;

  const _ShareCardCanvas({
    required this.detail,
    required this.slice,
    required this.includeToolDetails,
    required this.options,
    required this.resolveBlobFile,
  });

  @override
  Widget build(BuildContext context) {
    final palette = SharePalette.forStyle(options.style);
    final watermark = options.watermarkText;
    final hasWatermark =
        options.enableWatermark && watermark.trim().isNotEmpty;
    final isMobile = options.mobileLayout;
    final canvasWidth = isMobile ? 430.0 : 780.0;
    final outerPad = isMobile ? 12.0 : 24.0;
    final hPad = isMobile ? 18.0 : 32.0;

    final hasBrand = options.showBrandText && options.brandText.trim().isNotEmpty;
    final hasAuthor = options.showAuthor && options.authorName.trim().isNotEmpty;
    final hasDate = options.showShareDate;
    final hasPaging = slice.total > 1;
    final showFooter = hasBrand || hasAuthor || hasDate || hasPaging;
    final shareDateStr = hasDate
        ? DateFormat('yyyy-MM-dd HH:mm').format(DateTime.now())
        : '';

    return Container(
      width: canvasWidth,
      color: palette.canvasBg,
      padding: EdgeInsets.all(outerPad),
      child: CustomPaint(
        foregroundPainter: hasWatermark
            ? _DiagonalWatermarkPainter(
                text: watermark,
                color: palette.watermarkColor.withOpacity(0.075),
              )
            : null,
        child: Container(
          decoration: BoxDecoration(
            color: palette.cardBg,
            borderRadius: BorderRadius.circular(Gm3.radiusLg),
            border: Border.all(color: palette.cardBorder),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Styled Header Band
              Container(
                color: palette.headerBg,
                padding: EdgeInsets.fromLTRB(
                    hPad, isMobile ? 18 : 24, hPad, isMobile ? 14 : 20),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            detail.title,
                            style: TextStyle(
                              fontFamily: Gm3.uiFontFamily,
                              fontFamilyFallback: Gm3.uiFontFallback,
                              fontSize: isMobile ? 18 : 20,
                              fontWeight: FontWeight.w700,
                              color: palette.assistantText,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            '${detail.provider}'
                            '${detail.defaultModel != null ? ' · ${detail.defaultModel}' : ''}'
                            '${detail.cwd != null ? ' · ${detail.cwd}' : ''}',
                            style: GoogleMaterialTheme.monoTextStyle(
                              fontSize: Gm3.monoSm,
                              color: palette.metaText,
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (hasPaging)
                      Gm3Pill(
                        label: '${slice.index + 1} / ${slice.total}',
                        color: palette.accent,
                        background: palette.cardBg.withOpacity(0.9),
                      ),
                  ],
                ),
              ),

              // Conversation Body
              Padding(
                padding: EdgeInsets.fromLTRB(
                    hPad, isMobile ? 18 : 24, hPad, isMobile ? 12 : 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    for (final seg in slice.segments)
                      _buildSegment(context, seg, palette),
                  ],
                ),
              ),

              // Attribution Footer (only shown when at least one item is enabled)
              if (showFooter)
                Container(
                  color: palette.headerBg.withOpacity(0.65),
                  padding: EdgeInsets.fromLTRB(hPad, 14, hPad, 16),
                  child: Row(
                    children: [
                      if (hasBrand) ...[
                        Icon(Icons.auto_awesome,
                            size: 14, color: palette.accent),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(
                            options.brandText,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontFamily: Gm3.uiFontFamily,
                              fontFamilyFallback: Gm3.uiFontFallback,
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: palette.accent,
                            ),
                          ),
                        ),
                      ],
                      if (hasDate) ...[
                        if (hasBrand) const SizedBox(width: 10),
                        Text(
                          shareDateStr,
                          style: GoogleMaterialTheme.monoTextStyle(
                            fontSize: Gm3.monoSm,
                            color: palette.metaText,
                          ),
                        ),
                      ],
                      const Spacer(),
                      if (hasAuthor)
                        Text(
                          '@${options.authorName}',
                          style: GoogleMaterialTheme.monoTextStyle(
                            fontSize: Gm3.monoSm,
                            fontWeight: FontWeight.w600,
                            color: palette.assistantText,
                          ),
                        ),
                      if (hasPaging) ...[
                        const SizedBox(width: 12),
                        Text(
                          '${slice.index + 1}/${slice.total}',
                          style: GoogleMaterialTheme.monoTextStyle(
                            fontSize: Gm3.monoSm,
                            color: palette.metaText,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSegment(
    BuildContext context,
    ShareSegment seg,
    SharePalette palette,
  ) {
    final proseFontSize = options.mobileLayout ? 15.5 : null;
    if (seg.role == 'user') {
      return Padding(
        padding: const EdgeInsets.only(bottom: 22),
        child: Align(
          alignment: Alignment.centerRight,
          child: ConstrainedBox(
            constraints:
                BoxConstraints(maxWidth: options.mobileLayout ? 310 : 500),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
              decoration: BoxDecoration(
                color: palette.userBubbleBg,
                borderRadius: BorderRadius.circular(20),
              ),
              child: DefaultTextStyle.merge(
                style: TextStyle(color: palette.userBubbleText),
                child: MarkdownProse(
                  text: seg.text.isNotEmpty
                      ? seg.text
                      : seg.blocks.map((b) => b.text ?? '').join('\n'),
                  selectable: false,
                  showCopyButtons: false,
                  fontSize: proseFontSize,
                ),
              ),
            ),
          ),
        ),
      );
    }

    if (seg.role == 'tool' || seg.role == 'system') {
      final raw = (seg.text.isNotEmpty
              ? seg.text
              : seg.blocks.map((b) => b.toolInput ?? b.text ?? '').join('\n'))
          .trim();
      final preview =
          raw.length > 1400 ? '${raw.substring(0, 1400)}\n...(truncated)' : raw;
      return Container(
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: palette.assistantCardBg,
          borderRadius: BorderRadius.circular(Gm3.radiusMd),
          border: Border.all(color: palette.cardBorder),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${seg.role.toUpperCase()}${seg.toolName != null ? ' · ${seg.toolName}' : ''}',
              style: GoogleMaterialTheme.monoTextStyle(
                fontSize: Gm3.monoSm,
                fontWeight: FontWeight.w700,
                color: palette.accent,
              ),
            ),
            const SizedBox(height: 6),
            SyntaxHighlightedCodeText(
              text: preview,
              selectable: false,
              style: GoogleMaterialTheme.monoTextStyle(
                fontSize: Gm3.monoSm,
                color: palette.metaText,
              ),
            ),
          ],
        ),
      );
    }

    // Assistant reply
    return Padding(
      padding: const EdgeInsets.only(bottom: 22),
      child: DefaultTextStyle.merge(
        style: TextStyle(color: palette.assistantText),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (seg.blocks.isNotEmpty)
              for (final block in seg.blocks)
                _buildAssistantBlock(context, block, palette)
            else
              MarkdownProse(
                text: seg.text,
                selectable: false,
                showCopyButtons: false,
                fontSize: proseFontSize,
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildAssistantBlock(
    BuildContext context,
    ViewBlock block,
    SharePalette palette,
  ) {
    if (block.type == 'code') {
      return MarkdownCodeBlock(
        code: block.text ?? '',
        lang: block.lang,
        selectable: false,
        showCopyButton: false,
      );
    }
    if (block.type == 'image') {
      final file =
          block.blobSha256 != null ? resolveBlobFile(block.blobSha256!) : null;
      if (file != null && file.existsSync()) {
        return Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(Gm3.radiusMd),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 280),
              child: Image.file(file, fit: BoxFit.contain),
            ),
          ),
        );
      }
      return const SizedBox.shrink();
    }
    if (_isToolLikeBlock(block)) {
      if (!includeToolDetails) return const SizedBox.shrink();
      final body = (block.toolInput ?? block.text ?? '').trim();
      final capped =
          body.length > 900 ? '${body.substring(0, 900)}\n...' : body;
      return Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: palette.assistantCardBg,
          borderRadius: BorderRadius.circular(Gm3.radiusMd),
          border: Border.all(color: palette.cardBorder),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${block.type}${block.toolName != null ? ': ${block.toolName}' : ''}',
              style: GoogleMaterialTheme.monoTextStyle(
                fontSize: Gm3.monoSm,
                fontWeight: FontWeight.w700,
                color: palette.accent,
              ),
            ),
            if (capped.isNotEmpty) ...[
              const SizedBox(height: 4),
              SyntaxHighlightedCodeText(
                text: capped,
                selectable: false,
                style: GoogleMaterialTheme.monoTextStyle(
                  fontSize: Gm3.monoSm,
                  color: palette.metaText,
                ),
              ),
            ],
          ],
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: MarkdownProse(
        text: block.text ?? '',
        selectable: false,
        showCopyButtons: false,
        fontSize: options.mobileLayout ? 15.5 : null,
      ),
    );
  }
}

class _DiagonalWatermarkPainter extends CustomPainter {
  final String text;
  final Color color;

  const _DiagonalWatermarkPainter({
    required this.text,
    required this.color,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (text.trim().isEmpty || size.isEmpty) return;

    canvas.save();
    canvas.clipRect(Offset.zero & size);

    final tp = TextPainter(
      text: TextSpan(
        text: text,
        style: TextStyle(
          fontFamily: Gm3.uiFontFamily,
          fontFamilyFallback: Gm3.uiFontFallback,
          fontSize: 15,
          fontWeight: FontWeight.w600,
          color: color,
          letterSpacing: 0.6,
        ),
      ),
      textDirection: ui.TextDirection.ltr,
      maxLines: 1,
    )..layout(maxWidth: 340);

    const angle = -0.45; // ~ -26 deg
    final stepX = math.max(tp.width + 90, 240.0);
    final stepY = 140.0;

    canvas.translate(size.width / 2, size.height / 2);
    canvas.rotate(angle);
    final diag = math.sqrt(size.width * size.width + size.height * size.height);

    for (double y = -diag / 2; y <= diag / 2; y += stepY) {
      final rowShift = ((y ~/ stepY).isOdd) ? stepX * 0.5 : 0.0;
      for (double x = -diag / 2 - rowShift; x <= diag / 2; x += stepX) {
        tp.paint(canvas, Offset(x, y));
      }
    }

    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _DiagonalWatermarkPainter oldDelegate) {
    return oldDelegate.text != text || oldDelegate.color != color;
  }
}
