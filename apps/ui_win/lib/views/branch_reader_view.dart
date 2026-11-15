import 'dart:async';
import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

import '../data/app_settings.dart';
import '../data/archive_direct_store.dart';
import '../data/perf_logger.dart';
import '../data/sm_cli_runner.dart';
import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/gm3_surface.dart';
import '../widgets/markdown_prose.dart';
import '../widgets/share_image_sheet.dart';

class BranchTreeReaderView extends StatefulWidget {
  final ArchiveDirectStore store;
  final SmCliRunner? cliRunner;
  final AppSettingsController? settings;
  final ValueNotifier<int> refreshTick;
  final int? conversationId;
  final ValueChanged<int> onSelectOtherSession;
  final VoidCallback? onDataChanged;

  const BranchTreeReaderView({
    super.key,
    required this.store,
    this.cliRunner,
    this.settings,
    required this.refreshTick,
    this.conversationId,
    required this.onSelectOtherSession,
    this.onDataChanged,
  });

  @override
  State<BranchTreeReaderView> createState() => _BranchTreeReaderViewState();
}

class _BranchTreeReaderViewState extends State<BranchTreeReaderView> {
  bool _loading = false;
  ConversationDetail? _detail;
  List<String> _tags = [];
  bool _starred = false;
  bool _branchViewMode = false;
  bool _expandAllProcess = false;
  bool _subagentsExpanded = false;
  bool _showContextStatsDetail = false;

  /// Chosen child index per parent fork node (`null` represents root parent).
  final Map<int?, int> _selectedChildIdxByParent = {};
  final Set<int> _expandedProcessGroupIds = {};
  final Set<int> _collapsedProcessGroupIds = {};
  final Set<String> _expandedProcessStepKeys = {};
  final Set<String> _expandedLinkedCallKeys = {};
  final Set<String> _expandedBlockKeys = {};
  final Map<String, String> _loadedPayloads = {};
  final Set<String> _loadingPayloads = {};

  final GlobalKey _scrollViewportKey = GlobalKey();
  final Map<int, GlobalKey> _turnAnchorKeys = {};
  final Map<int, GlobalKey> _entryItemKeys = {};
  final Map<String, GlobalKey> _processStepKeys = {};
  final ScrollController _scrollController = ScrollController();
  List<_TurnDirectoryEntry> _latestTurns = const [];
  int _activeTurnIndex = 0;
  int _jumpGeneration = 0;
  bool _isProgrammaticJump = false;

  @override
  void initState() {
    super.initState();
    widget.refreshTick.addListener(_reloadCurrent);
    _scrollController.addListener(_onMainScroll);
    if (widget.conversationId != null) {
      _loadConversation(widget.conversationId!);
    }
  }

  @override
  void didUpdateWidget(covariant BranchTreeReaderView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.refreshTick != widget.refreshTick) {
      oldWidget.refreshTick.removeListener(_reloadCurrent);
      widget.refreshTick.addListener(_reloadCurrent);
    }
    if (oldWidget.conversationId != widget.conversationId) {
      _selectedChildIdxByParent.clear();
      _expandedProcessGroupIds.clear();
      _collapsedProcessGroupIds.clear();
      _expandedProcessStepKeys.clear();
      _expandedLinkedCallKeys.clear();
      _expandedBlockKeys.clear();
      _loadedPayloads.clear();
      _turnAnchorKeys.clear();
      _entryItemKeys.clear();
      _processStepKeys.clear();
      _latestTurns = const [];
      _branchViewMode = false;
      _subagentsExpanded = false;
      _showContextStatsDetail = false;
      _activeTurnIndex = 0;
      _jumpGeneration++;
      _isProgrammaticJump = false;
      if (widget.conversationId != null) {
        _loadConversation(widget.conversationId!);
      } else {
        setState(() {
          _detail = null;
          _tags = [];
          _starred = false;
        });
      }
    }
  }

  @override
  void dispose() {
    widget.refreshTick.removeListener(_reloadCurrent);
    _scrollController.removeListener(_onMainScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _reloadCurrent() {
    if (widget.conversationId != null) {
      _loadConversation(widget.conversationId!);
    }
  }

  Future<void> _loadConversation(int id) async {
    final trace = PerfLogger.instance.startTrace(
      'open_conversation',
      targetId: '$id',
    );
    setState(() => _loading = true);

    final detail = await widget.store.getConversationDetail(id);
    trace.markPhase('store_query');

    if (!mounted || widget.conversationId != id) {
      trace.finish(extraMeta: {'cancelled': true});
      return;
    }

    setState(() {
      _detail = detail;
      _tags = detail?.tags ?? const [];
      _starred = detail?.starred ?? false;
      _loading = false;
    });
    trace.markPhase('set_state');
    trace.finishAfterFirstFrame(extraMeta: {
      'items': detail?.items.length ?? 0,
      'provider': detail?.provider,
    });
  }

  Future<void> _toggleStar() async {
    final detail = _detail;
    final runner = widget.cliRunner;
    if (detail == null || runner == null) return;
    final res = await runner.setStarred(detail.id, starred: !_starred);
    if (mounted && res.ok) {
      setState(() => _starred = !_starred);
      widget.onDataChanged?.call();
    }
  }

  Future<void> _showAddTagDialog() async {
    final detail = _detail;
    final runner = widget.cliRunner;
    if (detail == null || runner == null) return;
    final ctrl = TextEditingController();
    final s = AppStringsScope.of(context);
    final tagName = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(s.tagAction),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          decoration: InputDecoration(hintText: s.addTagHint),
          onSubmitted: (v) => Navigator.of(ctx).pop(v.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: Text(s.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()),
            child: Text(s.tagAction),
          ),
        ],
      ),
    );
    if (tagName == null || tagName.isEmpty) return;
    final res = await runner.addTag(detail.id, tagName);
    if (mounted && res.ok) {
      final updated = await widget.store.getConversationTags(detail.id);
      if (mounted) setState(() => _tags = updated);
      widget.onDataChanged?.call();
    }
  }

  Future<void> _removeTag(String tagName) async {
    final detail = _detail;
    final runner = widget.cliRunner;
    if (detail == null || runner == null) return;
    final res = await runner.removeTag(detail.id, tagName);
    if (mounted && res.ok) {
      final updated = await widget.store.getConversationTags(detail.id);
      if (mounted) setState(() => _tags = updated);
      widget.onDataChanged?.call();
    }
  }

  void _openShareSheet({int? initialAssistantItemId}) {
    final detail = _detail;
    if (detail == null) return;
    final activeChain = _resolveActiveTreePath(detail).map((e) => e.item).toList();
    showDialog<void>(
      context: context,
      builder: (ctx) => AppStringsScope(
        notifier: AppStringsScope.notifierOf(context) ??
            ValueNotifier<AppLocale>(AppStringsScope.of(context).locale),
        child: ShareImageDialog(
          detail: detail,
          activeItems: activeChain,
          store: widget.store,
          settings: widget.settings,
          initialAssistantItemId: initialAssistantItemId,
        ),
      ),
    );
  }

  /// Resolves the linear chain along currently chosen branch edges (`< Branch k / N >`),
  /// returning (item, forkParentKey, chosenIdx, branchCount).
  List<_ActiveChainNode> _resolveActiveTreePath(ConversationDetail detail) {
    final childrenByParent = detail.childrenByParent;
    final result = <_ActiveChainNode>[];
    final visited = <int>{};

    void walk(int? parentKey) {
      final children = childrenByParent[parentKey];
      if (children == null || children.isEmpty) return;

      var chosenIdx = _selectedChildIdxByParent[parentKey] ??
          children.indexWhere((c) => c.isActiveBranch);
      if (chosenIdx < 0 || chosenIdx >= children.length) {
        chosenIdx = children.length - 1;
      }

      final chosen = children[chosenIdx];
      if (!visited.add(chosen.id)) return;
      result.add(
        _ActiveChainNode(
          item: chosen,
          forkParentKey: parentKey,
          branchIndex: chosenIdx,
          branchCount: children.length,
        ),
      );
      walk(chosen.id);
    }

    walk(null);

    if (result.isEmpty && detail.items.isNotEmpty) {
      for (final it in detail.items) {
        if (!visited.contains(it.id) && it.isActiveBranch) {
          visited.add(it.id);
          result.add(
            _ActiveChainNode(
              item: it,
              forkParentKey: it.parentId,
              branchIndex: 0,
              branchCount: 1,
            ),
          );
        }
      }
    }
    return result;
  }

  static bool _isThinkingBlockType(String type) {
    return type == 'thinking' || type == 'reasoning' || type == 'thought';
  }

  static bool _isProcessBlockType(String type) {
    return _isThinkingBlockType(type) ||
        type == 'tool_use' ||
        type == 'tool_call' ||
        type == 'tool_result' ||
        type == 'file_diff';
  }

  static final RegExp _thinkTagBlockRe = RegExp(
    r'<(?:think|thought|thinking)>[\s\S]*?(?:</(?:think|thought|thinking)>|$)',
    caseSensitive: false,
  );

  static bool _isProcessOnlyItem(MessageItem item) {
    if (item.isSynthetic) return true;
    if (item.role == 'tool' || item.role == 'system') return true;
    if (item.role == 'user') {
      final trimmed = item.text.trimLeft();
      if (trimmed.isNotEmpty && _syntheticUserPrefixRe.hasMatch(trimmed)) {
        return true;
      }
    }
    if (item.kind == 'thinking' ||
        item.kind == 'reasoning' ||
        item.kind == 'thought' ||
        item.kind == 'tool_call' ||
        item.kind == 'tool_result' ||
        item.kind == 'system_note' ||
        item.kind == 'summary' ||
        item.kind == 'compaction' ||
        item.kind == 'turn_context' ||
        item.kind == 'notice' ||
        item.kind == 'file_change' ||
        item.kind == 'web_search') {
      return true;
    }
    if (item.role == 'assistant') {
      final blocks = item.blocks;
      if (blocks.isNotEmpty) {
        final hasOutputBlock = blocks.any((b) => !_isProcessBlockType(b.type));
        if (!hasOutputBlock && item.text.trim().isEmpty) {
          return true;
        }
        // Only thinking/tool blocks and text is merely the same thinking content
        if (!hasOutputBlock && blocks.every((b) => _isProcessBlockType(b.type))) {
          return true;
        }
      } else {
        final cleaned = item.text.replaceAll(_thinkTagBlockRe, '').trim();
        if (item.text.trim().isNotEmpty && cleaned.isEmpty) {
          return true;
        }
      }
    }
    return false;
  }

  static bool _hasSubstantiveAssistantOutput(MessageItem item) {
    if (item.role != 'assistant') return false;
    if (_isProcessOnlyItem(item)) return false;
    final blocks = item.blocks;
    if (blocks.isNotEmpty) {
      final hasOutputBlock = blocks.any((b) => !_isProcessBlockType(b.type));
      if (hasOutputBlock) return true;
    }
    return item.text.trim().isNotEmpty;
  }

  static bool _looksCompacted(MessageItem item) {
    final k = item.kind.toLowerCase();
    if (k == 'summary' || k == 'compaction') return true;
    final t = item.text.toLowerCase();
    return t.contains('context compacted') ||
        t.contains('上下文已压缩') ||
        t.contains('conversation was compacted');
  }

  static final RegExp _syntheticUserPrefixRe = RegExp(
    r'^(?:<(?:goal_round|goal_complete|system-reminder|system_reminder|system-notification|system_notification|system-time|time_reminder|permission_hint|permission-hint|subagent_reply|subagent-reply|agent_reply|task-notification|inbox|runtime-context|runtime_context|turn-context|turn_context|local-command-[a-z-]+)\b|\[(?:system\b|system\s+time|current\s+time|time\s+hint|permission\b|user-approval|approval\b|inbox\b|subagent\b|agent\s+reply|inter-agent|model\s+changed\s*:)|(?:system\s+time|current\s+time|permission\s+(?:hint|notice|prompt|mode)|subagent\s+(?:reply|response|report)|reply\s+from\s+(?:sub)?agent|browser\s+time\s+zone\s+for\s+this\s+request|elapsed\s+since\s+the\s+preceding\s+step\s+context)\s*[:：]|time\s+sampled\s+while\b|(?:background\s+)?subagent\s+\S+\s+(?:finished|completed|failed|stopped|canceled|cancelled)\b|background\s+subagent\b|(?:a\s+)?background\s+job\b|job\s+\S+\s+(?:finished|completed|failed|exited)\b|agent\s+[^\n:：]{1,80}\s+sent\s+a\s+message\s*[:：]|current\s+runtime\s+context\b|this\s+is\s+an\s+automatically\s+generated\s+checkpoint\b|the\s+(?:user[-\s])?approval\s+policy\b|the\s+working\s+directory\s+changed\s+from\b|model\s+changed\s*(?:from\b|to\b|[:：])|(?:系统时间|当前时间|系统权限|权限提示|子代理回复|来自子代理|后台任务|模型切换)\s*[:：]?)',
    caseSensitive: false,
  );

  static bool _isRealUserTurn(MessageItem item) {
    if (item.role != 'user') return false;
    if (item.isSynthetic) return false;
    final trimmed = item.text.trimLeft();
    if (trimmed.isNotEmpty && _syntheticUserPrefixRe.hasMatch(trimmed)) {
      return false;
    }
    return true;
  }

  /// Collapses consecutive process nodes, thinking chains, tool calls, synthetic
  /// steps, and intermediate pre-tool assistant commentary within every turn into
  /// ONE single-line expandable summary bar, and marks only the final substantive
  /// assistant message of each turn with [isFinalTurnReply] = true.
  ({List<_TimelineEntry> entries, List<_TurnDirectoryEntry> turns})
      _buildCollapsedTimelineAndDirectory(ConversationDetail detail) {
    final chain = _resolveActiveTreePath(detail)
        .where((e) => !e.item.isHidden)
        .toList();

    // Split active chain into turn slices (pre-turn + user turns)
    final turnSlices = <List<_ActiveChainNode>>[];
    var current = <_ActiveChainNode>[];
    for (final node in chain) {
      if (_isRealUserTurn(node.item)) {
        if (current.isNotEmpty) turnSlices.add(current);
        current = [node];
      } else {
        current.add(node);
      }
    }
    if (current.isNotEmpty) turnSlices.add(current);

    final entries = <_TimelineEntry>[];
    final turns = <_TurnDirectoryEntry>[];
    var groupSeq = 0;

    void flushProcessSteps(List<_ProcessStep> buf) {
      if (buf.isEmpty) return;
      entries.add(
        _TimelineEntry.processGroup(
          groupId: groupSeq++,
          steps: _linkProcessSteps(buf),
        ),
      );
      buf.clear();
    }

    int? positiveTs(int? ts) => (ts != null && ts > 0) ? ts : null;

    for (final slice in turnSlices) {
      final startIdx =
          slice.isNotEmpty && _isRealUserTurn(slice.first.item) ? 1 : 0;

      // Determine the index (within slice) of the final complete assistant reply
      int? lastFinalIdx;
      for (var i = slice.length - 1; i >= startIdx; i--) {
        if (_hasSubstantiveAssistantOutput(slice[i].item)) {
          lastFinalIdx = i;
          break;
        }
      }

      // Compute fallback timestamp across the turn slice for messages missing createdAt
      int? sliceFallbackTs;
      for (var i = slice.length - 1; i >= 0; i--) {
        final ts = positiveTs(slice[i].item.createdAt);
        if (ts != null) {
          sliceFallbackTs = ts;
          break;
        }
      }
      int? userFallbackTs = startIdx == 1
          ? (positiveTs(slice.first.item.createdAt) ?? sliceFallbackTs)
          : sliceFallbackTs;

      // Emit User prompt bubble (and register persistent Turn Directory anchor)
      _TurnDirectoryEntry? pendingTurnDir;
      GlobalKey? turnKey;
      final bool isCompactedTurn = slice.any((n) => _looksCompacted(n.item));

      if (startIdx == 1) {
        final userNode = slice.first;
        final anchorId = userNode.item.id > 0
            ? userNode.item.id
            : -(turns.length + 1000000);
        turnKey = _turnAnchorKeys.putIfAbsent(
          anchorId,
          () => GlobalKey(debugLabel: 'turn_$anchorId'),
        );
        final entryIdx = entries.length;
        final isFinalOnlyUser = lastFinalIdx == null && slice.length == 1;
        entries.add(
          _TimelineEntry.message(
            node: userNode,
            anchorKey: turnKey,
            isFinalTurnReply: false,
            hideProcessBlocks: false,
            fallbackTimestamp: userFallbackTs,
          ),
        );

        final finalAssistantItem =
            lastFinalIdx != null ? slice[lastFinalIdx].item : null;
        final rawPrompt =
            userNode.item.text.trim().replaceAll(RegExp(r'\s+'), ' ');
        final rawReply = finalAssistantItem != null
            ? _extractSummaryText(finalAssistantItem)
            : '';

        pendingTurnDir = _TurnDirectoryEntry(
          turnIndex: turns.length,
          entryIndex: entryIdx,
          anchorKey: turnKey,
          userTitle: rawPrompt.isNotEmpty
              ? rawPrompt
              : 'Turn #${turns.length + 1}${isFinalOnlyUser ? '' : ''}',
          assistantSummary: rawReply,
          isCompacted: isCompactedTurn,
          branchCount: userNode.branchCount,
        );
      } else if (lastFinalIdx != null) {
        // Conversation begins with an assistant turn without a user item
        final finalAssistantItem = slice[lastFinalIdx].item;
        final anchorId = finalAssistantItem.id > 0
            ? -finalAssistantItem.id
            : -(turns.length + 2000000);
        turnKey = _turnAnchorKeys.putIfAbsent(
          anchorId,
          () => GlobalKey(debugLabel: 'turn_$anchorId'),
        );
        pendingTurnDir = _TurnDirectoryEntry(
          turnIndex: turns.length,
          entryIndex: entries.length,
          anchorKey: turnKey,
          userTitle: 'Turn #${turns.length + 1}',
          assistantSummary: _extractSummaryText(finalAssistantItem),
          isCompacted: isCompactedTurn,
          branchCount: slice[lastFinalIdx].branchCount,
        );
      }

      final processBuf = <_ProcessStep>[];
      for (var i = startIdx; i < slice.length; i++) {
        final node = slice[i];
        final isFinal = lastFinalIdx != null && i == lastFinalIdx;

        if (!isFinal) {
          // Everything before the final reply (or trailing tool/system calls after it)
          // collapses into the 1-line process group.
          processBuf.add(_ProcessStep.item(node));
          continue;
        }

        // Split process blocks (`thinking`, `tool_use`, etc.) out of the final reply
        // into the preceding 1-line process group so only the final clean answer renders below.
        final processBlocks =
            node.item.blocks.where((b) => _isProcessBlockType(b.type)).toList();
        for (final b in processBlocks) {
          processBuf.add(_ProcessStep.block(node.item, b));
        }

        flushProcessSteps(processBuf);

        final replyEntryIdx = entries.length;
        if (startIdx == 0 && pendingTurnDir != null) {
          pendingTurnDir = _TurnDirectoryEntry(
            turnIndex: pendingTurnDir.turnIndex,
            entryIndex: replyEntryIdx,
            anchorKey: pendingTurnDir.anchorKey,
            userTitle: pendingTurnDir.userTitle,
            assistantSummary: pendingTurnDir.assistantSummary,
            isCompacted: pendingTurnDir.isCompacted,
            branchCount: pendingTurnDir.branchCount,
          );
        }

        entries.add(
          _TimelineEntry.message(
            node: node,
            anchorKey: startIdx == 0 ? turnKey : null,
            isFinalTurnReply: true,
            hideProcessBlocks: true,
            fallbackTimestamp:
                positiveTs(node.item.createdAt) ?? sliceFallbackTs,
          ),
        );
      }

      flushProcessSteps(processBuf);

      if (pendingTurnDir != null) {
        turns.add(pendingTurnDir);
      }
    }

    return (entries: entries, turns: turns);
  }

  static bool _isToolCallBlockType(String type) {
    return type == 'tool_use' || type == 'tool_call' || type == 'file_diff';
  }

  static bool _isToolCallStep(_ProcessStep step) {
    if (step.block != null) {
      return _isToolCallBlockType(step.block!.type);
    }
    if (step.node != null) {
      final item = step.node!.item;
      if (item.kind == 'tool_result') return false;
      if (item.kind == 'tool_call' || item.role == 'tool') {
        return item.kind != 'tool_result' &&
            !item.blocks.any((b) => b.type == 'tool_result');
      }
      return item.blocks.any((b) => _isToolCallBlockType(b.type));
    }
    return false;
  }

  static bool _isToolResultStep(_ProcessStep step) {
    if (step.block != null) return step.block!.type == 'tool_result';
    if (step.node != null) {
      final item = step.node!.item;
      return item.kind == 'tool_result' ||
          item.blocks.any((b) => b.type == 'tool_result');
    }
    return false;
  }

  static String? _extractStepToolName(_ProcessStep step) {
    if (step.block != null) {
      final name = step.block!.toolName?.trim();
      if (name != null && name.isNotEmpty) return name;
    }
    if (step.node != null) {
      final item = step.node!.item;
      final top = item.toolName?.trim();
      if (top != null && top.isNotEmpty) return top;
      for (final b in item.blocks) {
        final bn = b.toolName?.trim();
        if (bn != null && bn.isNotEmpty) return bn;
      }
    }
    return null;
  }

  static List<_ProcessStep> _linkProcessSteps(List<_ProcessStep> rawSteps) {
    final result = <_ProcessStep>[];
    final callById =
        <String, ({int index, _ProcessStep step, ViewBlock? block})>{};
    final callIndices = <int>[];
    final claimedCallIndices = <int>{};

    for (var i = 0; i < rawSteps.length; i++) {
      final raw = rawSteps[i];
      if (_isToolCallStep(raw)) {
        final indexed = raw.withLink(stepIndex: i);
        callIndices.add(i);
        if (raw.block != null) {
          final cid = raw.block!.toolCallId?.trim();
          if (cid != null && cid.isNotEmpty) {
            callById[cid] = (index: i, step: indexed, block: raw.block);
          }
        } else if (raw.node != null) {
          final item = raw.node!.item;
          for (final b in item.blocks) {
            if (_isToolCallBlockType(b.type)) {
              final cid = b.toolCallId?.trim();
              if (cid != null && cid.isNotEmpty) {
                callById[cid] = (index: i, step: indexed, block: b);
              }
            }
          }
        }
        result.add(indexed);
        continue;
      }

      if (_isToolResultStep(raw)) {
        ({int index, _ProcessStep step, ViewBlock? block})? matched;

        // 1. Exact toolCallId match
        final candidateIds = <String>[];
        if (raw.block?.toolCallId != null &&
            raw.block!.toolCallId!.trim().isNotEmpty) {
          candidateIds.add(raw.block!.toolCallId!.trim());
        } else if (raw.node != null) {
          final item = raw.node!.item;
          for (final b in item.blocks) {
            final bid = b.toolCallId?.trim();
            if (bid != null && bid.isNotEmpty) candidateIds.add(bid);
          }
        }
        for (final cid in candidateIds) {
          final found = callById[cid];
          if (found != null) {
            matched = found;
            claimedCallIndices.add(found.index);
            break;
          }
        }

        // 2. Fallback to nearest preceding unmatched tool_call (matching name first)
        if (matched == null && callIndices.isNotEmpty) {
          final resultToolName = _extractStepToolName(raw)?.toLowerCase();
          int? fallbackIdx;
          if (resultToolName != null) {
            for (var k = callIndices.length - 1; k >= 0; k--) {
              final cIdx = callIndices[k];
              if (claimedCallIndices.contains(cIdx)) continue;
              final cname = _extractStepToolName(result[cIdx])?.toLowerCase();
              if (cname == resultToolName) {
                fallbackIdx = cIdx;
                break;
              }
            }
          }
          fallbackIdx ??= () {
            for (var k = callIndices.length - 1; k >= 0; k--) {
              final cIdx = callIndices[k];
              if (!claimedCallIndices.contains(cIdx)) return cIdx;
            }
            return callIndices.last;
          }();

          claimedCallIndices.add(fallbackIdx);
          final callStep = result[fallbackIdx];
          ViewBlock? callBlock = callStep.block;
          if (callBlock == null && callStep.node != null) {
            for (final b in callStep.node!.item.blocks) {
              if (_isToolCallBlockType(b.type)) {
                callBlock = b;
                break;
              }
            }
          }
          matched = (index: fallbackIdx, step: callStep, block: callBlock);
        }

        result.add(
          raw.withLink(
            stepIndex: i,
            linkedCall: matched?.step,
            linkedCallIndex: matched?.index,
            linkedCallBlock: matched?.block,
          ),
        );
        continue;
      }

      result.add(raw.withLink(stepIndex: i));
    }

    return result;
  }

  static String _extractSummaryText(MessageItem item) {
    final primary = item.text.trim();
    if (primary.isNotEmpty) {
      return primary.replaceAll(RegExp(r'\s+'), ' ');
    }
    final buf = StringBuffer();
    for (final b in item.blocks) {
      if (_isProcessBlockType(b.type)) continue;
      final t = (b.text ?? '').trim();
      if (t.isNotEmpty) {
        if (buf.isNotEmpty) buf.write(' ');
        buf.write(t);
      }
      if (buf.length >= 180) break;
    }
    return buf.toString().replaceAll(RegExp(r'\s+'), ' ');
  }

  Future<void> _loadPayload(String payloadRef) async {
    if (_loadingPayloads.contains(payloadRef)) return;
    setState(() => _loadingPayloads.add(payloadRef));
    final text = await widget.store.readSpilledPayload(payloadRef);
    if (!mounted) return;
    setState(() {
      _loadingPayloads.remove(payloadRef);
      _loadedPayloads[payloadRef] = text ?? '(unable to locate blob on disk)';
    });
  }

  void _onMainScroll() {
    if (!mounted ||
        _isProgrammaticJump ||
        !_scrollController.hasClients ||
        _latestTurns.isEmpty) {
      return;
    }
    final viewportBox =
        _scrollViewportKey.currentContext?.findRenderObject() as RenderBox?;
    if (viewportBox == null || !viewportBox.hasSize) return;

    int? activeIdx;
    int? firstMountedIdx;
    for (final turn in _latestTurns) {
      final ctx = turn.anchorKey.currentContext;
      final box = ctx?.findRenderObject() as RenderBox?;
      if (box == null || !box.hasSize) continue;
      firstMountedIdx ??= turn.turnIndex;
      final dy = box.localToGlobal(Offset.zero, ancestor: viewportBox).dy;
      if (dy <= 140.0) {
        activeIdx = turn.turnIndex;
      }
    }
    if (activeIdx == null && firstMountedIdx != null) {
      activeIdx = _scrollController.offset <= 8.0
          ? 0
          : math.max(0, firstMountedIdx - 1);
    }
    if (activeIdx != null && activeIdx != _activeTurnIndex) {
      setState(() => _activeTurnIndex = activeIdx!);
    }
  }

  void _jumpToTurn(_TurnDirectoryEntry turn, int totalEntries) {
    final int gen = ++_jumpGeneration;
    setState(() {
      _activeTurnIndex = turn.turnIndex;
      _isProgrammaticJump = true;
    });

    final ctx = turn.anchorKey.currentContext;
    if (ctx != null) {
      Scrollable.ensureVisible(
        ctx,
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOutCubic,
        alignment: 0.04,
      ).whenComplete(() {
        if (mounted && _jumpGeneration == gen) {
          _isProgrammaticJump = false;
        }
      });
      return;
    }

    if (!_scrollController.hasClients) {
      _isProgrammaticJump = false;
      return;
    }

    final maxExtent = _scrollController.position.maxScrollExtent;
    final initialRatio = totalEntries <= 1
        ? 0.0
        : (turn.entryIndex / (totalEntries - 1)).clamp(0.0, 1.0);
    _scrollController.jumpTo(maxExtent * initialRatio);

    _refineJumpToTurn(
      turn,
      totalEntries,
      gen: gen,
      attempt: 0,
      lowOffset: 0.0,
      highOffset: maxExtent,
    );
  }

  void _refineJumpToTurn(
    _TurnDirectoryEntry turn,
    int totalEntries, {
    required int gen,
    required int attempt,
    required double lowOffset,
    required double highOffset,
  }) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted ||
          !_scrollController.hasClients ||
          _jumpGeneration != gen) {
        return;
      }

      final ctx = turn.anchorKey.currentContext;
      if (ctx != null) {
        Scrollable.ensureVisible(
          ctx,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          alignment: 0.04,
        ).whenComplete(() {
          if (mounted && _jumpGeneration == gen) {
            _isProgrammaticJump = false;
          }
        });
        return;
      }

      if (attempt >= 14) {
        _isProgrammaticJump = false;
        return;
      }

      final pos = _scrollController.position;
      final cur = pos.pixels;
      final maxExt = pos.maxScrollExtent;
      final viewportH = pos.viewportDimension;
      final viewportBox =
          _scrollViewportKey.currentContext?.findRenderObject() as RenderBox?;

      int? minMountedIdx;
      int? maxMountedIdx;
      double? minMountedTop;
      double? maxMountedBottom;

      if (viewportBox != null && viewportBox.hasSize) {
        for (var idx = 0; idx < totalEntries; idx++) {
          final itemCtx = _entryItemKeys[idx]?.currentContext;
          final box = itemCtx?.findRenderObject() as RenderBox?;
          if (box == null || !box.hasSize) continue;
          minMountedIdx ??= idx;
          maxMountedIdx = idx;
          final top = box.localToGlobal(Offset.zero, ancestor: viewportBox).dy;
          final bottom = top + box.size.height;
          minMountedTop =
              minMountedTop == null ? top : math.min(minMountedTop, top);
          maxMountedBottom = maxMountedBottom == null
              ? bottom
              : math.max(maxMountedBottom, bottom);
        }
      }

      double nextLow = lowOffset;
      double nextHigh = math.min(highOffset, maxExt);
      double nextOffset;

      if (minMountedIdx != null &&
          maxMountedIdx != null &&
          turn.entryIndex < minMountedIdx) {
        nextHigh = math.min(nextHigh, cur);
        final span = ((maxMountedBottom ?? viewportH) - (minMountedTop ?? 0))
            .clamp(80.0, 20000.0);
        final count = math.max(1, maxMountedIdx - minMountedIdx + 1);
        final avgH = span / count;
        final step = math.max(
          viewportH * 0.65,
          (minMountedIdx - turn.entryIndex) * avgH + viewportH * 0.2,
        );
        var candidate = cur - step;
        if (candidate <= nextLow || candidate >= cur) {
          candidate = (nextLow + cur) / 2.0;
        }
        nextOffset = candidate.clamp(0.0, maxExt);
      } else if (minMountedIdx != null &&
          maxMountedIdx != null &&
          turn.entryIndex > maxMountedIdx) {
        nextLow = math.max(nextLow, cur);
        final span = ((maxMountedBottom ?? viewportH) - (minMountedTop ?? 0))
            .clamp(80.0, 20000.0);
        final count = math.max(1, maxMountedIdx - minMountedIdx + 1);
        final avgH = span / count;
        final step = math.max(
          viewportH * 0.65,
          (turn.entryIndex - maxMountedIdx) * avgH + viewportH * 0.2,
        );
        var candidate = cur + step;
        if (candidate >= nextHigh || candidate <= cur) {
          candidate = (cur + nextHigh) / 2.0;
        }
        nextOffset = candidate.clamp(0.0, maxExt);
      } else {
        final ratio = totalEntries <= 1
            ? 0.0
            : (turn.entryIndex / (totalEntries - 1)).clamp(0.0, 1.0);
        nextOffset = (maxExt * ratio).clamp(0.0, maxExt);
      }

      if ((nextOffset - cur).abs() < 2.0) {
        _isProgrammaticJump = false;
        return;
      }

      _scrollController.jumpTo(nextOffset);
      _refineJumpToTurn(
        turn,
        totalEntries,
        gen: gen,
        attempt: attempt + 1,
        lowOffset: nextLow,
        highOffset: nextHigh,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    if (widget.conversationId == null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.forum_outlined, size: 48, color: cs.outline),
            const SizedBox(height: 12),
            Text(s.selectSessionHint, style: theme.textTheme.bodyMedium),
          ],
        ),
      );
    }

    if (_loading && _detail == null) {
      return const Center(child: CircularProgressIndicator());
    }

    final detail = _detail;
    if (detail == null) {
      return Center(
        child: Text(s.conversationNotFound, style: theme.textTheme.bodyMedium),
      );
    }

    final built = _buildCollapsedTimelineAndDirectory(detail);
    final entries = built.entries;
    final turns = built.turns;
    final activeItems = _resolveActiveTreePath(detail)
        .where((e) => !e.item.isHidden)
        .map((e) => e.item)
        .toList();
    final contextStats = computeConversationContextStats(activeItems);
    _latestTurns = turns;
    _entryItemKeys.removeWhere((idx, _) => idx >= entries.length);
    final forkCount = detail.childrenByParent.values
        .where((children) => children.length > 1)
        .length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Reader Header
        Container(
          padding: const EdgeInsets.fromLTRB(24, 14, 20, 12),
          color: surfaces.panel,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Subagent Parent Return Banner (if viewing a subagent session)
              if (detail.parentConversationId != null) ...[
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: InkWell(
                    onTap: () =>
                        widget.onSelectOtherSession(detail.parentConversationId!),
                    borderRadius: BorderRadius.circular(Gm3.radiusPill),
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 5),
                      decoration: BoxDecoration(
                        color: cs.primaryContainer.withOpacity(0.55),
                        borderRadius: BorderRadius.circular(Gm3.radiusPill),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.arrow_back_rounded,
                              size: 14, color: cs.primary),
                          const SizedBox(width: 6),
                          Text(
                            s.backToMainSession,
                            style: theme.textTheme.labelMedium?.copyWith(
                              color: cs.primary,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (detail.subagentName != null) ...[
                            const SizedBox(width: 8),
                            Gm3Pill(
                              label: '@${detail.subagentName}',
                              color: cs.secondary,
                              background: surfaces.card,
                            ),
                          ],
                        ],
                      ),
                    ),
                  ),
                ),
              ],

              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          detail.title,
                          style: theme.textTheme.titleMedium?.copyWith(
                            fontSize: 17,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 5),
                        Wrap(
                          spacing: 8,
                          runSpacing: 4,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            Gm3Pill(
                              label: detail.provider,
                              color: cs.primary,
                              background: surfaces.chipFill,
                            ),
                            if (detail.defaultModel != null)
                              Text(
                                detail.defaultModel!,
                                style: GoogleMaterialTheme.monoTextStyle(
                                  fontSize: Gm3.monoSm,
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                            if (detail.cwd != null)
                              Text(
                                detail.cwd!,
                                style: GoogleMaterialTheme.monoTextStyle(
                                  fontSize: Gm3.monoSm,
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),

                  // CLI Actions + View Mode Switcher
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      if (widget.cliRunner != null) ...[
                        IconButton(
                          tooltip: _starred ? s.unstarAction : s.starAction,
                          icon: Icon(
                            _starred
                                ? Icons.star_rounded
                                : Icons.star_border_rounded,
                            color: _starred
                                ? const Color(0xFFF59E0B)
                                : cs.onSurfaceVariant,
                            size: 20,
                          ),
                          onPressed: _toggleStar,
                        ),
                        IconButton(
                          tooltip: s.tagAction,
                          icon: Icon(
                            Icons.label_outline,
                            color: cs.onSurfaceVariant,
                            size: 20,
                          ),
                          onPressed: _showAddTagDialog,
                        ),
                      ],
                      IconButton(
                        tooltip: s.shareLongImage,
                        icon: Icon(
                          Icons.image_outlined,
                          color: cs.onSurfaceVariant,
                          size: 20,
                        ),
                        onPressed: () => _openShareSheet(),
                      ),
                      if (!_branchViewMode)
                        IconButton(
                          tooltip: _expandAllProcess
                              ? s.collapseProcessGroup
                              : s.expandAll,
                          icon: Icon(
                            _expandAllProcess
                                ? Icons.unfold_less_rounded
                                : Icons.unfold_more_rounded,
                            color: cs.onSurfaceVariant,
                            size: 19,
                          ),
                          onPressed: () => setState(() {
                            _expandAllProcess = !_expandAllProcess;
                            _collapsedProcessGroupIds.clear();
                            if (!_expandAllProcess) {
                              _expandedProcessGroupIds.clear();
                              _expandedProcessStepKeys.clear();
                            }
                          }),
                        ),

                      // Conversation View | Branch View Switcher
                      SegmentedButton<bool>(
                        showSelectedIcon: false,
                        segments: [
                          ButtonSegment<bool>(
                            value: false,
                            label: Text(s.conversationViewTab),
                            icon: const Icon(Icons.chat_bubble_outline, size: 14),
                          ),
                          ButtonSegment<bool>(
                            value: true,
                            label: Text(
                              forkCount > 0
                                  ? '${s.branchViewTab} ($forkCount)'
                                  : s.branchViewTab,
                            ),
                            icon: const Icon(Icons.alt_route_rounded, size: 14),
                          ),
                        ],
                        selected: {_branchViewMode},
                        onSelectionChanged: (val) =>
                            setState(() => _branchViewMode = val.first),
                      ),
                    ],
                  ),
                ],
              ),

              // Attached Subagents Bar (when viewing a main session that spawned subagents)
              if (detail.subagents.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Icon(Icons.account_tree_outlined,
                        size: 14, color: cs.primary),
                    Text(
                      s.attachedSubagentsLabel(detail.subagents.length),
                      style: theme.textTheme.labelMedium?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                    if (detail.subagents.length <= 3 || _subagentsExpanded)
                      for (final sub in detail.subagents)
                        ActionChip(
                          avatar: Icon(
                            Icons.subdirectory_arrow_right,
                            size: 14,
                            color: cs.primary,
                          ),
                          label: Text(
                            '${sub.subagentName ?? sub.title} · ${sub.itemCount}',
                            style: theme.textTheme.labelMedium,
                          ),
                          materialTapTargetSize:
                              MaterialTapTargetSize.shrinkWrap,
                          labelPadding: EdgeInsets.zero,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 10, vertical: 4),
                          backgroundColor: surfaces.chipFill,
                          side: BorderSide.none,
                          onPressed: () =>
                              widget.onSelectOtherSession(sub.id),
                        ),
                    if (detail.subagents.length > 3)
                      ActionChip(
                        avatar: Icon(
                          _subagentsExpanded
                              ? Icons.expand_less
                              : Icons.expand_more,
                          size: 16,
                          color: cs.primary,
                        ),
                        label: Text(
                          _subagentsExpanded
                              ? s.collapseSubagents
                              : s.expandAllSubagents(detail.subagents.length),
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: cs.primary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                        labelPadding: EdgeInsets.zero,
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 4),
                        backgroundColor: surfaces.chipFill,
                        side: BorderSide.none,
                        onPressed: () => setState(
                          () => _subagentsExpanded = !_subagentsExpanded,
                        ),
                      ),
                  ],
                ),
              ],

              // Tags & Superseded Status Row
              if (detail.supersededBy != null || _tags.isNotEmpty) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    if (detail.supersededBy != null)
                      Gm3Pill(
                        label: 'superseded_by: ${detail.supersededBy}',
                        color: cs.error,
                        background: cs.errorContainer.withOpacity(0.55),
                      ),
                    for (final tag in _tags)
                      Chip(
                        label: Text(tag),
                        onDeleted: widget.cliRunner != null
                            ? () => _removeTag(tag)
                            : null,
                        visualDensity: VisualDensity.compact,
                      ),
                  ],
                ),
              ],
              const SizedBox(height: 8),
              _ConversationContextStatsBar(
                stats: contextStats,
                expanded: _showContextStatsDetail,
                onToggle: () => setState(
                  () => _showContextStatsDetail = !_showContextStatsDetail,
                ),
              ),
            ],
          ),
        ),
        Divider(color: surfaces.hairline.withOpacity(0.45), height: 1),

        // Main Area: Conversation Canvas (+ Codex Jump Rail) OR Dedicated Branch View
        Expanded(
          child: Container(
            key: _scrollViewportKey,
            color: surfaces.panel,
            child: _branchViewMode
                ? _buildDedicatedBranchView(context, detail)
                : Stack(
                    clipBehavior: Clip.none,
                    children: [
                      ListView.builder(
                        controller: _scrollController,
                        padding: EdgeInsets.fromLTRB(
                          turns.length >= 3 ? 52 : 28,
                          22,
                          28,
                          36,
                        ),
                        itemCount: entries.length,
                        itemBuilder: (ctx, idx) {
                          final entry = entries[idx];
                          final child = entry.processSteps != null
                              ? _buildProcessGroupBar(context, entry)
                              : _buildMessageNode(
                                  context,
                                  entry.node!.item,
                                  forkParentKey: entry.node!.forkParentKey,
                                  branchIndex: entry.node!.branchIndex,
                                  branchCount: entry.node!.branchCount,
                                  isFinalTurnReply: entry.isFinalTurnReply,
                                  hideProcessBlocks: entry.hideProcessBlocks,
                                  fallbackTimestamp: entry.fallbackTimestamp,
                                );
                          final anchored = entry.anchorKey != null
                              ? KeyedSubtree(
                                  key: entry.anchorKey,
                                  child: child,
                                )
                              : child;
                          return Center(
                            child: ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 780),
                              child: KeyedSubtree(
                                key: _entryItemKeys.putIfAbsent(
                                  idx,
                                  () => GlobalKey(debugLabel: 'entry_$idx'),
                                ),
                                child: anchored,
                              ),
                            ),
                          );
                        },
                      ),

                      if (turns.length >= 3)
                        Positioned(
                          left: 10,
                          top: 24,
                          bottom: 24,
                          child: _CodexTurnJumpRail(
                            turns: turns,
                            activeTurnIndex: _activeTurnIndex,
                            onSelectTurn: (t) => _jumpToTurn(t, entries.length),
                          ),
                        ),
                    ],
                  ),
          ),
        ),
      ],
    );
  }

  /// Dedicated Branch & Revision Topology View (`分支视图`)
  Widget _buildDedicatedBranchView(
      BuildContext context, ConversationDetail detail) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    final forkEntries = detail.childrenByParent.entries
        .where((e) => e.value.length > 1)
        .toList();
    final itemById = {for (final m in detail.items) m.id: m};

    int countSubtree(int rootId) {
      var count = 0;
      final stack = [rootId];
      final seen = <int>{};
      while (stack.isNotEmpty) {
        final curr = stack.removeLast();
        if (!seen.add(curr)) continue;
        count++;
        final kids = detail.childrenByParent[curr];
        if (kids != null) {
          for (final k in kids) {
            stack.add(k.id);
          }
        }
      }
      return count;
    }

    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 860),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                s.forkPointsTitle,
                style: theme.textTheme.titleMedium,
              ),
              const SizedBox(height: 12),

              if (forkEntries.isEmpty)
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: surfaces.card,
                    borderRadius: BorderRadius.circular(Gm3.radiusMd),
                  ),
                  child: Row(
                    children: [
                      Icon(Icons.linear_scale_rounded,
                          size: 20, color: cs.primary),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          s.noBranchForksHint,
                          style: theme.textTheme.bodyMedium?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),

              for (final entry in forkEntries) ...[
                Builder(
                  builder: (_) {
                    final forkParentKey = entry.key;
                    final siblings = entry.value;
                    final parentItem =
                        forkParentKey != null ? itemById[forkParentKey] : null;
                    final chosenIdx =
                        _selectedChildIdxByParent[forkParentKey] ??
                            siblings.indexWhere((c) => c.isActiveBranch);
                    final normalizedChosen =
                        (chosenIdx >= 0 && chosenIdx < siblings.length)
                            ? chosenIdx
                            : siblings.length - 1;

                    return Container(
                      margin: const EdgeInsets.only(bottom: 16),
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: surfaces.card,
                        borderRadius: BorderRadius.circular(Gm3.radiusLg),
                        border: Border.all(
                          color: surfaces.hairline.withOpacity(0.5),
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Icon(Icons.alt_route_rounded,
                                  size: 16, color: cs.primary),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  parentItem != null
                                      ? '${parentItem.role.toUpperCase()}: ${_extractSummaryText(parentItem)}'
                                      : (s.isZh ? '会话根分叉点' : 'Root Fork Point'),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.titleSmall,
                                ),
                              ),
                              Gm3Pill(
                                label: '${siblings.length} branches',
                                color: cs.primary,
                                background: surfaces.chipFill,
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          for (var i = 0; i < siblings.length; i++)
                            Builder(
                              builder: (_) {
                                final child = siblings[i];
                                final isSelected = i == normalizedChosen;
                                final subCount = countSubtree(child.id);
                                final snippet = _extractSummaryText(child);
                                return Container(
                                  margin: const EdgeInsets.only(bottom: 8),
                                  padding: const EdgeInsets.all(12),
                                  decoration: BoxDecoration(
                                    color: isSelected
                                        ? surfaces.cardSelected
                                        : surfaces.inset,
                                    borderRadius:
                                        BorderRadius.circular(Gm3.radiusMd),
                                  ),
                                  child: Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.center,
                                    children: [
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Wrap(
                                              spacing: 8,
                                              runSpacing: 4,
                                              crossAxisAlignment:
                                                  WrapCrossAlignment.center,
                                              children: [
                                                Gm3Pill(
                                                  label: s.branchLabel(
                                                      i + 1, siblings.length),
                                                  color: isSelected
                                                      ? cs.primary
                                                      : cs.onSurfaceVariant,
                                                  background: surfaces.card,
                                                ),
                                                Gm3Pill(
                                                  label: child.isActiveBranch
                                                      ? s.currentBranchBadge
                                                      : s.historicalBranchBadge,
                                                  color: child.isActiveBranch
                                                      ? const Color(0xFF137333)
                                                      : cs.onSurfaceVariant,
                                                  background: child.isActiveBranch
                                                      ? const Color(0xFFE6F4EA)
                                                          .withOpacity(0.85)
                                                      : surfaces.chipFill,
                                                ),
                                                if (child.model != null)
                                                  Text(
                                                    child.model!,
                                                    style: GoogleMaterialTheme
                                                        .monoTextStyle(
                                                      fontSize: Gm3.monoSm,
                                                      color: cs.onSurfaceVariant,
                                                    ),
                                                  ),
                                                Text(
                                                  '$subCount nodes',
                                                  style: theme
                                                      .textTheme.labelSmall
                                                      ?.copyWith(
                                                    color: cs.onSurfaceVariant,
                                                  ),
                                                ),
                                              ],
                                            ),
                                            if (snippet.isNotEmpty) ...[
                                              const SizedBox(height: 6),
                                              Text(
                                                snippet,
                                                maxLines: 2,
                                                overflow: TextOverflow.ellipsis,
                                                style:
                                                    theme.textTheme.bodySmall,
                                              ),
                                            ],
                                          ],
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      FilledButton.tonalIcon(
                                        onPressed: () {
                                          setState(() {
                                            _selectedChildIdxByParent[
                                                forkParentKey] = i;
                                            _branchViewMode = false;
                                          });
                                        },
                                        icon: const Icon(
                                            Icons.visibility_outlined,
                                            size: 16),
                                        label: Text(s.switchToBranch),
                                      ),
                                    ],
                                  ),
                                );
                              },
                            ),
                        ],
                      ),
                    );
                  },
                ),
              ],

              // Import Revision Snapshots
              if (detail.revisions.isNotEmpty) ...[
                const SizedBox(height: 12),
                Text(
                  '${s.revisionsCount(detail.revisions.length)} (conversation_revision)',
                  style: theme.textTheme.titleSmall,
                ),
                const SizedBox(height: 8),
                for (final rev in detail.revisions)
                  Container(
                    margin: const EdgeInsets.only(bottom: 8),
                    padding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 10),
                    decoration: BoxDecoration(
                      color: surfaces.card,
                      borderRadius: BorderRadius.circular(Gm3.radiusMd),
                    ),
                    child: Row(
                      children: [
                        Gm3Pill(
                          label: 'Rev #${rev.revisionNo}',
                          color: cs.primary,
                          background: surfaces.chipFill,
                        ),
                        const SizedBox(width: 12),
                        Text(
                          '${rev.itemCount ?? '?'} items · ${rev.charCount ?? '?'} chars',
                          style: theme.textTheme.bodySmall,
                        ),
                        const Spacer(),
                        Text(
                          rev.contentHash.length > 10
                              ? rev.contentHash.substring(0, 10)
                              : rev.contentHash,
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
        ),
      ),
    );
  }

  /// Single-line folded bar for ALL thinking rounds, tool calls, tool results,
  /// synthetic nodes, and intermediate pre-tool commentary in a turn.
  Widget _buildProcessGroupBar(BuildContext context, _TimelineEntry entry) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final steps = entry.processSteps!;
    final isExpanded = (_expandAllProcess &&
            !_collapsedProcessGroupIds.contains(entry.groupId)) ||
        _expandedProcessGroupIds.contains(entry.groupId);

    var thinkingCount = 0;
    var toolCallCount = 0;
    var toolResultCount = 0;
    var systemCount = 0;
    var noteCount = 0;

    for (final step in steps) {
      if (step.block != null) {
        final t = step.block!.type;
        if (_isThinkingBlockType(t)) {
          thinkingCount++;
        } else if (t == 'tool_result') {
          toolResultCount++;
        } else {
          toolCallCount++;
        }
      } else if (step.node != null) {
        final it = step.node!.item;
        final blockThinking =
            it.blocks.where((b) => _isThinkingBlockType(b.type)).length;
        final blockToolCalls =
            it.blocks.where((b) => _isToolCallBlockType(b.type)).length;
        final blockToolResults =
            it.blocks.where((b) => b.type == 'tool_result').length;

        if (it.isSynthetic || it.role == 'system') {
          systemCount++;
        } else if (it.kind == 'thinking' ||
            it.kind == 'reasoning' ||
            it.kind == 'thought' ||
            blockThinking > 0) {
          thinkingCount += math.max(1, blockThinking);
        } else if (it.kind == 'tool_result' || blockToolResults > 0) {
          toolResultCount += math.max(1, blockToolResults);
        } else if (it.role == 'tool' ||
            it.kind == 'tool_call' ||
            blockToolCalls > 0) {
          toolCallCount += math.max(1, blockToolCalls);
        } else {
          noteCount++;
        }
      }
    }

    final summaryText = s.processCollapsedSummary(
      thinkingCount: thinkingCount,
      toolCallCount: toolCallCount,
      toolResultCount: toolResultCount,
      systemCount: systemCount,
      noteCount: noteCount,
    );

    void expandGroup() {
      setState(() {
        _collapsedProcessGroupIds.remove(entry.groupId);
        _expandedProcessGroupIds.add(entry.groupId);
      });
    }

    void collapseGroup() {
      setState(() {
        _expandedProcessGroupIds.remove(entry.groupId);
        if (_expandAllProcess) {
          _collapsedProcessGroupIds.add(entry.groupId);
        }
      });
    }

    int? groupTimestampMs;
    for (final step in steps) {
      final ts = step.node?.item.createdAt ?? step.parentItem?.createdAt;
      if (ts != null && ts > 0) {
        groupTimestampMs = ts;
        break;
      }
    }

    if (!isExpanded) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: _HoverProbe(
          builder: (ctx, hovered) {
            final formattedTs = groupTimestampMs != null
                ? _MessageHoverTimeWrapperState.formatTimestamp(
                    ctx,
                    groupTimestampMs,
                  )
                : null;
            return Material(
              color: surfaces.inset,
              borderRadius: BorderRadius.circular(Gm3.radiusPill),
              child: InkWell(
                onTap: expandGroup,
                borderRadius: BorderRadius.circular(Gm3.radiusPill),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                  child: Row(
                    children: [
                      Icon(
                        Icons.chevron_right_rounded,
                        size: 16,
                        color: cs.onSurfaceVariant,
                      ),
                      const SizedBox(width: 6),
                      Icon(
                        thinkingCount > 0 && toolCallCount == 0
                            ? Icons.psychology_outlined
                            : Icons.build_circle_outlined,
                        size: 14,
                        color: cs.primary,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          summaryText,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                      ),
                      if (hovered && formattedTs != null) ...[
                        const SizedBox(width: 8),
                        _InlineHoverTimeChip(label: formattedTs),
                      ],
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );
    }

    Widget groupHeaderContent(BuildContext ctx, bool isSticky) => InkWell(
          onTap: collapseGroup,
          borderRadius: BorderRadius.circular(Gm3.radiusSm),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 4),
            child: Row(
              children: [
                Icon(Icons.expand_more_rounded,
                    size: 16, color: cs.onSurfaceVariant),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    summaryText,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: cs.primary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                Text(
                  s.collapseProcessGroup,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        );

    return _ProcessGroupStickyHost(
      builder: (ctx, footerRegistry) {
        return _StickyLongBlockOverlay(
          scrollController: _scrollController,
          viewportKey: _scrollViewportKey,
          stickyTopInset: 0.0,
          stickyHeaderBackground: surfaces.inset,
          stickyHeaderPadding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
          containerPadding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          containerMargin: const EdgeInsets.only(bottom: 16),
          clipBorderRadius: BorderRadius.circular(Gm3.radiusMd),
          containerDecoration: BoxDecoration(
            color: surfaces.inset.withOpacity(0.75),
            borderRadius: BorderRadius.circular(Gm3.radiusMd),
            border: Border.all(color: surfaces.hairline.withOpacity(0.45)),
          ),
          collapseRightOffset: 22.0,
          isLongBlock: steps.length >= 8,
          collapseLabel: s.collapseProcessGroup,
          onCollapse: collapseGroup,
          suppressFooterWhenNonEmpty: footerRegistry,
          headerBuilder: groupHeaderContent,
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 6),
              for (var i = 0; i < steps.length; i++)
                _buildExpandedProcessStep(
                  ctx,
                  entry.groupId,
                  steps[i],
                  i,
                  footerRegistry: footerRegistry,
                ),
              if (steps.length >= 8) const SizedBox(height: 30),
            ],
          ),
        );
      },
    );
  }

  ({
    IconData icon,
    String label,
    String preview,
    bool isLong,
    String? linkedToolName,
  }) _summarizeProcessStep(_ProcessStep step, AppStrings s) {
    final linkedToolName = _extractStepToolName(step) ??
        step.linkedCallBlock?.toolName ??
        (step.linkedCall != null ? _extractStepToolName(step.linkedCall!) : null);

    if (step.block != null && step.parentItem != null) {
      final b = step.block!;
      final isThinking = _isThinkingBlockType(b.type);
      final isToolResult = b.type == 'tool_result';
      final body = (b.toolInput ?? b.text ?? '').trim();
      final oneLine = body.replaceAll(RegExp(r'\s+'), ' ').trim();
      final effectiveTool = b.toolName ?? linkedToolName;
      final label = isThinking
          ? s.thinkingProcess
          : '${b.type}${effectiveTool != null ? ': $effectiveTool' : ''}';
      final isLong = body.length > 220 || '\n'.allMatches(body).length >= 5;
      return (
        icon: isThinking
            ? Icons.psychology_outlined
            : isToolResult
                ? Icons.receipt_long_outlined
                : Icons.terminal_rounded,
        label: label,
        preview: oneLine,
        isLong: isLong,
        linkedToolName: linkedToolName,
      );
    }

    final item = step.node!.item;
    final isThinking = item.kind == 'thinking' ||
        item.kind == 'reasoning' ||
        item.kind == 'thought' ||
        item.blocks.any((b) => _isThinkingBlockType(b.type));
    final isToolResult = item.kind == 'tool_result' ||
        item.blocks.any((b) => b.type == 'tool_result');
    final isSystem = item.isSynthetic || item.role == 'system';
    final icon = isSystem
        ? Icons.info_outline_rounded
        : isThinking
            ? Icons.psychology_outlined
            : isToolResult
                ? Icons.receipt_long_outlined
                : Icons.terminal_rounded;
    final effectiveTool = item.toolName ?? linkedToolName;
    final label = effectiveTool != null
        ? '${item.kind}: $effectiveTool'
        : '${item.role.toUpperCase()} · ${item.kind}';

    final rawParts = <String>[];
    if (item.blocks.isNotEmpty) {
      for (final b in item.blocks) {
        final t = (b.toolInput ?? b.text ?? '').trim();
        if (t.isNotEmpty) rawParts.add(t);
      }
    }
    if (rawParts.isEmpty && item.text.trim().isNotEmpty) {
      rawParts.add(item.text.trim());
    }
    final combined = rawParts.join(' ');
    final oneLine = combined.replaceAll(RegExp(r'\s+'), ' ').trim();
    final isLong = combined.length > 220 ||
        '\n'.allMatches(combined).length >= 5 ||
        ArchiveDirectStore.extractPayloadSha256(item.payloadRef) != null;

    return (
      icon: icon,
      label: label,
      preview: oneLine,
      isLong: isLong,
      linkedToolName: linkedToolName,
    );
  }

  static bool _looksLikeRawCode(String text) {
    final t = text.trimLeft();
    if (t.isEmpty) return false;
    if (t.startsWith('{') || t.startsWith('[')) return true;
    if (t.startsWith('<') && !t.contains('\n#') && !t.contains('```')) {
      return true;
    }
    return false;
  }

  Widget _buildProcessOrThinkingBody(
    BuildContext context, {
    required String body,
    required bool isThinking,
    String? language,
    Color? textColor,
  }) {
    final cs = Theme.of(context).colorScheme;
    if (isThinking && !_looksLikeRawCode(body)) {
      return MarkdownProse(text: body);
    }
    return SyntaxHighlightedCodeText(
      text: body,
      language: language,
      style: GoogleMaterialTheme.monoTextStyle(
        fontSize: Gm3.monoSm,
        color: textColor ?? cs.onSurfaceVariant,
      ),
    );
  }

  void _jumpToProcessStep(String targetStepKey) {
    setState(() {
      _expandedProcessStepKeys.add(targetStepKey);
    });
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final ctx = _processStepKeys[targetStepKey]?.currentContext;
      if (ctx != null) {
        Scrollable.ensureVisible(
          ctx,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
          alignment: 0.12,
        );
      }
    });
  }

  Widget? _buildLinkedCallBanner(
    BuildContext context,
    int groupId,
    String currentStepKey,
    _ProcessStep step,
  ) {
    final linked = step.linkedCall;
    if (linked == null) return null;

    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    final linkedBlock = step.linkedCallBlock;
    final linkedName = linkedBlock?.toolName ??
        _extractStepToolName(linked) ??
        'tool_call';
    final rawInput = (linkedBlock?.toolInput ??
            linkedBlock?.text ??
            linked.node?.item.blocks
                .map((b) => (b.toolInput ?? b.text ?? '').trim())
                .where((t) => t.isNotEmpty)
                .join('\n') ??
            linked.node?.item.text ??
            '')
        .trim();
    final oneLineInput = rawInput.replaceAll(RegExp(r'\s+'), ' ').trim();
    final inlineKey = 'link:$currentStepKey';
    final isPreviewExpanded = _expandedLinkedCallKeys.contains(inlineKey);
    final linkedStepIdx = step.linkedCallIndex;
    final linkedStepKey =
        linkedStepIdx != null ? '$groupId:$linkedStepIdx' : null;

    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: surfaces.inset.withOpacity(0.65),
        borderRadius: BorderRadius.circular(Gm3.radiusSm),
        border: Border.all(color: surfaces.hairline.withOpacity(0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.link_rounded, size: 14, color: cs.primary),
              const SizedBox(width: 5),
              Text(
                s.linkedToolCallLabel,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: cs.primary,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(width: 6),
              Gm3Pill(
                label: linkedName,
                color: cs.primary,
                background: surfaces.chipFill,
                fontSize: 10.5,
                padding:
                    const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
              ),
              if (oneLineInput.isNotEmpty) ...[
                const SizedBox(width: 8),
                Expanded(
                  child: InkWell(
                    onTap: () => setState(() {
                      if (!_expandedLinkedCallKeys.add(inlineKey)) {
                        _expandedLinkedCallKeys.remove(inlineKey);
                      }
                    }),
                    borderRadius: BorderRadius.circular(4),
                    child: Text(
                      oneLineInput,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: GoogleMaterialTheme.monoTextStyle(
                        fontSize: Gm3.monoSm,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                ),
              ] else
                const Spacer(),
              if (rawInput.isNotEmpty)
                InkWell(
                  onTap: () => setState(() {
                    if (!_expandedLinkedCallKeys.add(inlineKey)) {
                      _expandedLinkedCallKeys.remove(inlineKey);
                    }
                  }),
                  borderRadius: BorderRadius.circular(4),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: Icon(
                      isPreviewExpanded
                          ? Icons.expand_less_rounded
                          : Icons.unfold_more_rounded,
                      size: 16,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
              if (linkedStepKey != null) ...[
                const SizedBox(width: 4),
                InkWell(
                  onTap: () => _jumpToProcessStep(linkedStepKey),
                  borderRadius: BorderRadius.circular(4),
                  child: Padding(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.north_west_rounded,
                          size: 13,
                          color: cs.primary,
                        ),
                        const SizedBox(width: 2),
                        Text(
                          '#${linkedStepIdx! + 1}',
                          style: theme.textTheme.labelSmall?.copyWith(
                            color: cs.primary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ],
          ),
          if (isPreviewExpanded && rawInput.isNotEmpty) ...[
            const SizedBox(height: 6),
            SyntaxHighlightedCodeText(
              text: rawInput,
              style: GoogleMaterialTheme.monoTextStyle(
                fontSize: Gm3.monoSm,
                color: cs.onSurface,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildExpandedProcessStep(
    BuildContext context,
    int groupId,
    _ProcessStep step,
    int index, {
    _StickyFooterRegistry? footerRegistry,
  }) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final stepKey = '$groupId:$index';
    final widgetKey = _processStepKeys.putIfAbsent(
      stepKey,
      () => GlobalKey(debugLabel: 'step_$stepKey'),
    );
    final isStepExpanded = _expandedProcessStepKeys.contains(stepKey);
    final info = _summarizeProcessStep(step, s);

    void toggleStep() {
      setState(() {
        if (!_expandedProcessStepKeys.add(stepKey)) {
          _expandedProcessStepKeys.remove(stepKey);
        }
      });
    }

    final stepTimestampMs =
        step.node?.item.createdAt ?? step.parentItem?.createdAt;

    if (!isStepExpanded) {
      return KeyedSubtree(
        key: widgetKey,
        child: _HoverProbe(
          builder: (ctx, hovered) {
            final formattedTs = stepTimestampMs != null
                ? _MessageHoverTimeWrapperState.formatTimestamp(
                    ctx,
                    stepTimestampMs,
                  )
                : null;
            return Container(
              margin: const EdgeInsets.only(top: 4),
              decoration: BoxDecoration(
                color: surfaces.card,
                borderRadius: BorderRadius.circular(Gm3.radiusSm),
              ),
              child: InkWell(
                onTap: toggleStep,
                borderRadius: BorderRadius.circular(Gm3.radiusSm),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  child: Row(
                    children: [
                      Icon(info.icon, size: 14, color: cs.primary),
                      const SizedBox(width: 6),
                      Gm3Pill(
                        label: info.label,
                        color: cs.primary,
                        background: surfaces.chipFill,
                        fontSize: 10.5,
                        padding: const EdgeInsets.symmetric(
                            horizontal: 6, vertical: 1),
                      ),
                      if (info.preview.isNotEmpty) ...[
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            info.preview,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: GoogleMaterialTheme.monoTextStyle(
                              fontSize: Gm3.monoSm,
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                        ),
                      ] else
                        const Spacer(),
                      if (hovered && formattedTs != null) ...[
                        const SizedBox(width: 8),
                        _InlineHoverTimeChip(label: formattedTs),
                      ],
                      const SizedBox(width: 6),
                      Icon(
                        Icons.chevron_right_rounded,
                        size: 16,
                        color: cs.onSurfaceVariant,
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      );
    }

    final linkedBanner = _buildLinkedCallBanner(context, groupId, stepKey, step);

    if (step.block != null && step.parentItem != null) {
      final b = step.block!;
      final isThinking = _isThinkingBlockType(b.type);
      final body = (b.toolInput ?? b.text ?? '').trim();

      Widget stepHeader(BuildContext ctx, bool isSticky) {
        return InkWell(
          onTap: toggleStep,
          borderRadius: BorderRadius.circular(Gm3.radiusSm),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(
              children: [
                Icon(info.icon, size: 14, color: cs.primary),
                const SizedBox(width: 6),
                Gm3Pill(
                  label: info.label,
                  color: cs.primary,
                  background: surfaces.chipFill,
                ),
                if (info.preview.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      info.preview,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: GoogleMaterialTheme.monoTextStyle(
                        fontSize: Gm3.monoSm,
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                ] else
                  const Spacer(),
                const SizedBox(width: 6),
                Icon(Icons.expand_more_rounded,
                    size: 16, color: cs.onSurfaceVariant),
              ],
            ),
          ),
        );
      }

      return KeyedSubtree(
        key: widgetKey,
        child: _StickyLongBlockOverlay(
          scrollController: _scrollController,
          viewportKey: _scrollViewportKey,
          stickyTopInset: 38.0,
          stickyHeaderBackground: surfaces.card,
          stickyHeaderPadding: const EdgeInsets.fromLTRB(10, 8, 10, 6),
          containerPadding: const EdgeInsets.all(10),
          containerMargin: const EdgeInsets.only(top: 6),
          clipBorderRadius: BorderRadius.circular(Gm3.radiusSm),
          containerDecoration: BoxDecoration(
            color: surfaces.card,
            borderRadius: BorderRadius.circular(Gm3.radiusSm),
          ),
          collapseRightOffset: 10.0,
          isLongBlock: info.isLong,
          collapseLabel: s.collapseProcessGroup,
          onCollapse: toggleStep,
          footerRegistrationId: 'step:$stepKey',
          reportFooterTo: footerRegistry,
          headerBuilder: stepHeader,
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (linkedBanner != null) linkedBanner,
              if (body.isNotEmpty) ...[
                const SizedBox(height: 6),
                _buildProcessOrThinkingBody(
                  context,
                  body: body,
                  isThinking: isThinking,
                  language: b.type == 'file_diff' ? 'diff' : b.lang,
                  textColor: cs.onSurfaceVariant,
                ),
              ],
              if (info.isLong) const SizedBox(height: 36),
            ],
          ),
        ),
      );
    }

    final node = step.node!;
    final item = node.item;
    final processBlocks = item.blocks;
    final isThinkingItem = item.kind == 'thinking' ||
        item.kind == 'reasoning' ||
        item.kind == 'thought';

    Widget nodeHeader(BuildContext ctx, bool isSticky) {
      return InkWell(
        onTap: toggleStep,
        borderRadius: BorderRadius.circular(Gm3.radiusSm),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 2),
          child: Row(
            children: [
              Icon(info.icon, size: 14, color: cs.primary),
              const SizedBox(width: 6),
              Gm3Pill(
                label: info.label,
                color: cs.primary,
                background: surfaces.chipFill,
              ),
              const SizedBox(width: 6),
              if (item.isSynthetic) ...[
                Gm3Pill(
                  label: s.syntheticBadge,
                  color: cs.onSurfaceVariant,
                  background: surfaces.inset,
                ),
                const SizedBox(width: 6),
              ],
              if (info.preview.isNotEmpty)
                Expanded(
                  child: Text(
                    info.preview,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: GoogleMaterialTheme.monoTextStyle(
                      fontSize: Gm3.monoSm,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                )
              else
                const Spacer(),
              if (node.branchCount > 1) ...[
                const SizedBox(width: 6),
                _BranchSelectorPill(
                  branchIndex: node.branchIndex,
                  branchCount: node.branchCount,
                  onPrev: node.branchIndex > 0
                      ? () => setState(() =>
                          _selectedChildIdxByParent[node.forkParentKey] =
                              node.branchIndex - 1)
                      : null,
                  onNext: node.branchIndex < node.branchCount - 1
                      ? () => setState(() =>
                          _selectedChildIdxByParent[node.forkParentKey] =
                              node.branchIndex + 1)
                      : null,
                ),
              ],
              const SizedBox(width: 4),
              Icon(Icons.expand_more_rounded,
                  size: 16, color: cs.onSurfaceVariant),
            ],
          ),
        ),
      );
    }

    return KeyedSubtree(
      key: widgetKey,
      child: _StickyLongBlockOverlay(
        scrollController: _scrollController,
        viewportKey: _scrollViewportKey,
        stickyTopInset: 38.0,
        stickyHeaderBackground: surfaces.card,
        stickyHeaderPadding: const EdgeInsets.fromLTRB(10, 8, 10, 6),
        containerPadding: const EdgeInsets.all(10),
        containerMargin: const EdgeInsets.only(top: 6),
        clipBorderRadius: BorderRadius.circular(Gm3.radiusSm),
        containerDecoration: BoxDecoration(
          color: surfaces.card,
          borderRadius: BorderRadius.circular(Gm3.radiusSm),
        ),
        collapseRightOffset: 10.0,
        isLongBlock: info.isLong,
        collapseLabel: s.collapseProcessGroup,
        onCollapse: toggleStep,
        footerRegistrationId: 'step:$stepKey',
        reportFooterTo: footerRegistry,
        headerBuilder: nodeHeader,
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (linkedBanner != null) linkedBanner,
            if (processBlocks.isNotEmpty) ...[
              const SizedBox(height: 6),
              for (final b in processBlocks)
                _buildProcessBlockContent(context, b),
            ] else if (item.text.trim().isNotEmpty) ...[
              const SizedBox(height: 6),
              _buildProcessOrThinkingBody(
                context,
                body: item.text,
                isThinking: isThinkingItem,
                textColor: cs.onSurface,
              ),
            ],
            if (ArchiveDirectStore.extractPayloadSha256(item.payloadRef) !=
                null) ...[
              const SizedBox(height: 8),
              _buildSpilledPayloadControl(item.payloadRef!),
            ],
            if (info.isLong) const SizedBox(height: 36),
          ],
        ),
      ),
    );
  }

  Widget _buildProcessBlockContent(BuildContext context, ViewBlock block) {
    final cs = Theme.of(context).colorScheme;
    final body = (block.toolInput ?? block.text ?? '').trim();
    if (body.isEmpty) return const SizedBox.shrink();
    final isThinking = _isThinkingBlockType(block.type);
    final displayText =
        (!isThinking && block.toolName != null) ? '[${block.toolName}] $body' : body;
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: _buildProcessOrThinkingBody(
        context,
        body: displayText,
        isThinking: isThinking,
        language: block.type == 'file_diff' ? 'diff' : block.lang,
        textColor: cs.onSurfaceVariant,
      ),
    );
  }

  Widget _wrapWithHoverTime(
    BuildContext context,
    MessageItem item,
    Widget child, {
    int? fallbackTimestamp,
    required _HoverTimePlacement placement,
  }) {
    return _MessageHoverTimeWrapper(
      timestampMs: item.createdAt,
      fallbackTimestampMs: fallbackTimestamp,
      placement: placement,
      viewportKey: _scrollViewportKey,
      label: AppStringsScope.of(context).invokedAtLabel,
      child: child,
    );
  }

  Widget _buildMessageNode(
    BuildContext context,
    MessageItem item, {
    required int? forkParentKey,
    required int branchIndex,
    required int branchCount,
    required bool isFinalTurnReply,
    required bool hideProcessBlocks,
    int? fallbackTimestamp,
  }) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    final blocks = item.blocks;
    final attachmentBlocks = blocks
        .where((b) => b.type == 'file' || b.type == 'link')
        .toList();
    final contentBlocks = blocks
        .where((b) =>
            b.type != 'file' &&
            b.type != 'link' &&
            (!hideProcessBlocks || !_isProcessBlockType(b.type)))
        .toList();

    // User Prompt -> Google/Gemini compact right-aligned tonal pill bubble
    if (item.role == 'user') {
      return Padding(
        padding: const EdgeInsets.only(bottom: 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Align(
              alignment: Alignment.centerRight,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 580),
                child: _wrapWithHoverTime(
                  context,
                  item,
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 18,
                      vertical: 12,
                    ),
                    decoration: BoxDecoration(
                      color: surfaces.chipFill,
                      borderRadius: BorderRadius.circular(22),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (contentBlocks.isNotEmpty)
                          for (var i = 0; i < contentBlocks.length; i++)
                            _buildViewBlock(
                              item,
                              contentBlocks[i],
                              isLast: i == contentBlocks.length - 1 &&
                                  attachmentBlocks.isEmpty,
                            )
                        else
                          MarkdownProse(text: item.text),
                        if (attachmentBlocks.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          AttachmentChipGroup(
                            attachmentBlocks: attachmentBlocks,
                            resolveBlobFile: widget.store.resolveBlobFile,
                          ),
                        ],
                      ],
                    ),
                  ),
                  fallbackTimestamp: fallbackTimestamp,
                  placement: _HoverTimePlacement.leftOutside,
                ),
              ),
            ),
            if (branchCount > 1 ||
                !item.isActiveBranch ||
                item.supersededBy != null) ...[
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (!item.isActiveBranch)
                    Gm3Pill(
                      label: s.altBranchBadge,
                      color: cs.onSurfaceVariant,
                      background: surfaces.chipFill,
                    ),
                  if (item.supersededBy != null)
                    Gm3Pill(
                      label: '${s.supersededBadge} (${item.supersededBy})',
                      color: cs.error,
                      background: cs.errorContainer.withOpacity(0.55),
                    ),
                  if (branchCount > 1)
                    _BranchSelectorPill(
                      branchIndex: branchIndex,
                      branchCount: branchCount,
                      onPrev: branchIndex > 0
                          ? () => setState(() =>
                              _selectedChildIdxByParent[forkParentKey] =
                                  branchIndex - 1)
                          : null,
                      onNext: branchIndex < branchCount - 1
                          ? () => setState(() =>
                              _selectedChildIdxByParent[forkParentKey] =
                                  branchIndex + 1)
                          : null,
                    ),
                ],
              ),
            ],
          ],
        ),
      );
    }

    // Final Assistant Complete Reply -> Borderless editorial prose + Copy/Share/More ONLY here
    if (item.role == 'assistant') {
      return Padding(
        padding: const EdgeInsets.only(bottom: 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (!item.isActiveBranch || item.supersededBy != null) ...[
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Wrap(
                  spacing: 6,
                  children: [
                    if (!item.isActiveBranch)
                      Gm3Pill(
                        label: s.altBranchBadge,
                        color: cs.onSurfaceVariant,
                        background: surfaces.chipFill,
                      ),
                    if (item.supersededBy != null)
                      Gm3Pill(
                        label: '${s.supersededBadge} (${item.supersededBy})',
                        color: cs.error,
                        background: cs.errorContainer.withOpacity(0.55),
                      ),
                  ],
                ),
              ),
            ],

            _wrapWithHoverTime(
              context,
              item,
              contentBlocks.isNotEmpty
                  ? Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (var i = 0; i < contentBlocks.length; i++)
                          _buildViewBlock(
                            item,
                            contentBlocks[i],
                            isLast: i == contentBlocks.length - 1,
                          ),
                      ],
                    )
                  : MarkdownProse(text: item.text),
              fallbackTimestamp: fallbackTimestamp,
              placement: _HoverTimePlacement.bottomRightOutside,
            ),

            if (ArchiveDirectStore.extractPayloadSha256(item.payloadRef) !=
                null) ...[
              const SizedBox(height: 8),
              _buildSpilledPayloadControl(item.payloadRef!),
            ],

            if (attachmentBlocks.isNotEmpty) ...[
              const SizedBox(height: 6),
              AttachmentChipGroup(
                attachmentBlocks: attachmentBlocks,
                resolveBlobFile: widget.store.resolveBlobFile,
              ),
            ],

            if (isFinalTurnReply || branchCount > 1) ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  if (isFinalTurnReply) ...[
                    IconButton(
                      tooltip: s.copyTurn,
                      visualDensity: VisualDensity.compact,
                      constraints:
                          const BoxConstraints(minWidth: 32, minHeight: 32),
                      icon: Icon(Icons.content_copy_rounded,
                          size: 16, color: cs.onSurfaceVariant),
                      onPressed: () {
                        Clipboard.setData(
                            ClipboardData(text: _collectCopyableText(item)));
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text(s.codeCopied),
                            duration: const Duration(milliseconds: 1200),
                          ),
                        );
                      },
                    ),
                    const SizedBox(width: 2),
                    IconButton(
                      tooltip: s.shareLongImage,
                      visualDensity: VisualDensity.compact,
                      constraints:
                          const BoxConstraints(minWidth: 32, minHeight: 32),
                      icon: Icon(Icons.image_outlined,
                          size: 17, color: cs.onSurfaceVariant),
                      onPressed: () =>
                          _openShareSheet(initialAssistantItemId: item.id),
                    ),
                  ],
                  if (branchCount > 1) ...[
                    const SizedBox(width: 6),
                    _BranchSelectorPill(
                      branchIndex: branchIndex,
                      branchCount: branchCount,
                      onPrev: branchIndex > 0
                          ? () => setState(() =>
                              _selectedChildIdxByParent[forkParentKey] =
                                  branchIndex - 1)
                          : null,
                      onNext: branchIndex < branchCount - 1
                          ? () => setState(() =>
                              _selectedChildIdxByParent[forkParentKey] =
                                  branchIndex + 1)
                          : null,
                    ),
                  ],
                  if (isFinalTurnReply)
                    PopupMenuButton<String>(
                      tooltip: '',
                      padding: EdgeInsets.zero,
                      icon: Icon(Icons.more_horiz,
                          size: 17, color: cs.onSurfaceVariant),
                      onSelected: (action) {
                        if (action == 'share_full') {
                          _openShareSheet();
                        } else if (action == 'share_turn') {
                          _openShareSheet(initialAssistantItemId: item.id);
                        } else if (action == 'copy') {
                          Clipboard.setData(ClipboardData(text: item.text));
                        }
                      },
                      itemBuilder: (ctx) => [
                        PopupMenuItem<String>(
                          value: 'share_turn',
                          child: Text(s.shareModeSingleTurn),
                        ),
                        PopupMenuItem<String>(
                          value: 'share_full',
                          child: Text(s.shareModeFull),
                        ),
                        PopupMenuItem<String>(
                          value: 'copy',
                          child: Text(s.copyTurn),
                        ),
                      ],
                    ),
                ],
              ),
            ],
          ],
        ),
      );
    }

    // Fallback (should generally be folded in process groups, kept for safety)
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: MarkdownProse(text: item.text),
    );
  }

  String _collectCopyableText(MessageItem item) {
    if (item.text.trim().isNotEmpty) return item.text;
    return item.blocks
        .where((b) => !_isThinkingBlockType(b.type))
        .map((b) => b.text ?? b.toolInput ?? '')
        .where((t) => t.trim().isNotEmpty)
        .join('\n\n');
  }

  Widget _buildViewBlock(
    MessageItem item,
    ViewBlock block, {
    bool isLast = false,
  }) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    if (_isProcessBlockType(block.type)) {
      final isThinking = _isThinkingBlockType(block.type);
      final title = isThinking
          ? s.thinkingProcess
          : '${block.type}${block.toolName != null ? ': ${block.toolName}' : ''}';
      final body = (block.toolInput ?? block.text ?? '').trim();
      final blockKey = '${item.id}_${block.idx}_${block.type}';
      final expanded = _expandedBlockKeys.contains(blockKey);
      final isLong = body.length > 220 || '\n'.allMatches(body).length >= 5;

      void toggleBlock() {
        setState(() {
          if (expanded) {
            _expandedBlockKeys.remove(blockKey);
          } else {
            _expandedBlockKeys.add(blockKey);
          }
        });
      }

      if (!expanded || body.isEmpty) {
        return Container(
          margin: EdgeInsets.only(bottom: isLast ? 0 : 8),
          decoration: BoxDecoration(
            color: surfaces.inset,
            borderRadius: BorderRadius.circular(Gm3.radiusMd),
          ),
          child: InkWell(
            onTap: toggleBlock,
            borderRadius: BorderRadius.circular(Gm3.radiusMd),
            child: Padding(
              padding:
                  const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
                  Icon(
                    expanded
                        ? Icons.expand_more_rounded
                        : Icons.chevron_right_rounded,
                    size: 16,
                    color: cs.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      title,
                      style: GoogleMaterialTheme.monoTextStyle(
                        fontSize: Gm3.monoSm,
                        fontWeight: FontWeight.w600,
                        color: cs.primary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      }

      return _StickyLongBlockOverlay(
        scrollController: _scrollController,
        viewportKey: _scrollViewportKey,
        stickyTopInset: 0.0,
        stickyHeaderBackground: surfaces.inset,
        stickyHeaderPadding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        containerPadding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
        containerMargin: EdgeInsets.only(bottom: isLast ? 0 : 8),
        clipBorderRadius: BorderRadius.circular(Gm3.radiusMd),
        containerDecoration: BoxDecoration(
          color: surfaces.inset,
          borderRadius: BorderRadius.circular(Gm3.radiusMd),
        ),
        collapseRightOffset: 12.0,
        isLongBlock: isLong,
        collapseLabel: s.collapseProcessGroup,
        onCollapse: toggleBlock,
        headerBuilder: (ctx, isSticky) => InkWell(
          onTap: toggleBlock,
          borderRadius: BorderRadius.circular(Gm3.radiusMd),
          child: Row(
            children: [
              Icon(
                Icons.expand_more_rounded,
                size: 16,
                color: cs.onSurfaceVariant,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  title,
                  style: GoogleMaterialTheme.monoTextStyle(
                    fontSize: Gm3.monoSm,
                    fontWeight: FontWeight.w600,
                    color: cs.primary,
                  ),
                ),
              ),
            ],
          ),
        ),
        body: Padding(
          padding: EdgeInsets.only(top: 6, bottom: isLong ? 34 : 0),
          child: _buildProcessOrThinkingBody(
            context,
            body: body,
            isThinking: isThinking,
            language: block.type == 'file_diff' ? 'diff' : block.lang,
            textColor: cs.onSurfaceVariant,
          ),
        ),
      );
    }

    if (block.type == 'code') {
      return Padding(
        padding: EdgeInsets.only(bottom: isLast ? 0 : 6),
        child: MarkdownCodeBlock(code: block.text ?? '', lang: block.lang),
      );
    }

    if (block.type == 'image') {
      final sha = block.blobSha256;
      final File? imgFile =
          sha != null ? widget.store.resolveBlobFile(sha) : null;
      if (imgFile != null && imgFile.existsSync()) {
        return Padding(
          padding: EdgeInsets.only(bottom: isLast ? 0 : 8),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(Gm3.radiusMd),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 340),
              child: Image.file(imgFile, fit: BoxFit.contain),
            ),
          ),
        );
      }
      return Padding(
        padding: EdgeInsets.only(bottom: isLast ? 0 : 8),
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: surfaces.inset,
            borderRadius: BorderRadius.circular(Gm3.radiusMd),
          ),
          child: Row(
            children: [
              const Icon(Icons.broken_image_outlined, size: 16),
              const SizedBox(width: 8),
              Text(
                '${s.mediaFileMissing}: ${block.text ?? sha ?? ""}',
                style: theme.textTheme.bodySmall,
              ),
            ],
          ),
        ),
      );
    }

    return Padding(
      padding: EdgeInsets.only(bottom: isLast ? 0 : 6),
      child: MarkdownProse(text: block.text ?? ''),
    );
  }

  Widget _buildSpilledPayloadControl(String payloadRef) {
    final s = AppStringsScope.of(context);
    final loaded = _loadedPayloads[payloadRef];
    if (loaded != null) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: Gm3Surfaces.of(context).inset,
          borderRadius: BorderRadius.circular(Gm3.radiusMd),
        ),
        child: SyntaxHighlightedCodeText(
          text: loaded,
          style: GoogleMaterialTheme.monoTextStyle(fontSize: Gm3.monoSm),
        ),
      );
    }
    return OutlinedButton.icon(
      onPressed: _loadingPayloads.contains(payloadRef)
          ? null
          : () => _loadPayload(payloadRef),
      icon: const Icon(Icons.storage_outlined, size: 16),
      label: Text(s.loadFullPayload),
    );
  }
}

class _CodexTurnJumpRail extends StatefulWidget {
  final List<_TurnDirectoryEntry> turns;
  final int activeTurnIndex;
  final ValueChanged<_TurnDirectoryEntry> onSelectTurn;

  const _CodexTurnJumpRail({
    required this.turns,
    required this.activeTurnIndex,
    required this.onSelectTurn,
  });

  @override
  State<_CodexTurnJumpRail> createState() => _CodexTurnJumpRailState();
}

class _CodexTurnJumpRailState extends State<_CodexTurnJumpRail> {
  final GlobalKey _railKey = GlobalKey();
  final ScrollController _railScrollCtrl = ScrollController();
  int? _hoveredIndex;
  double? _hoveredTickTop;
  bool _canScrollUp = false;
  bool _canScrollDown = false;

  @override
  void initState() {
    super.initState();
    _railScrollCtrl.addListener(_syncScrollArrows);
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncScrollArrows());
  }

  @override
  void didUpdateWidget(covariant _CodexTurnJumpRail oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.turns.length != widget.turns.length) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _syncScrollArrows());
    }
  }

  @override
  void dispose() {
    _railScrollCtrl.removeListener(_syncScrollArrows);
    _railScrollCtrl.dispose();
    super.dispose();
  }

  void _syncScrollArrows() {
    if (!mounted || !_railScrollCtrl.hasClients) return;
    final pos = _railScrollCtrl.position;
    final up = pos.pixels > 2.0;
    final down = pos.pixels < pos.maxScrollExtent - 2.0;
    if (up != _canScrollUp || down != _canScrollDown) {
      setState(() {
        _canScrollUp = up;
        _canScrollDown = down;
      });
    }
  }

  void _scrollRailBy(double delta) {
    if (!_railScrollCtrl.hasClients) return;
    final pos = _railScrollCtrl.position;
    final target = (pos.pixels + delta).clamp(0.0, pos.maxScrollExtent);
    _railScrollCtrl.animateTo(
      target,
      duration: const Duration(milliseconds: 180),
      curve: Curves.easeOutCubic,
    );
  }

  void _onHoverTick(BuildContext tickCtx, int turnIndex) {
    double? topOffset;
    final tickBox = tickCtx.findRenderObject() as RenderBox?;
    final railBox = _railKey.currentContext?.findRenderObject() as RenderBox?;
    if (tickBox != null &&
        tickBox.hasSize &&
        railBox != null &&
        railBox.hasSize) {
      topOffset = tickBox.localToGlobal(Offset.zero, ancestor: railBox).dy;
    }
    setState(() {
      _hoveredIndex = turnIndex;
      _hoveredTickTop = topOffset;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final isDark = theme.brightness == Brightness.dark;

    const double tickHeight = 14.0;
    final hoveredTurn = (_hoveredIndex != null &&
            _hoveredIndex! >= 0 &&
            _hoveredIndex! < widget.turns.length)
        ? widget.turns[_hoveredIndex!]
        : null;

    return SizedBox(
      key: _railKey,
      width: 28,
      child: LayoutBuilder(
        builder: (context, constraints) {
          final maxH = constraints.maxHeight.isFinite
              ? constraints.maxHeight
              : 460.0;
          final rawTop = (_hoveredTickTop ?? 12.0) - 20.0;
          final clampedTop =
              rawTop.clamp(0.0, math.max(0.0, maxH - 148.0)).toDouble();

          return Stack(
            clipBehavior: Clip.none,
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 460),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (_canScrollUp)
                        InkWell(
                          onTap: () => _scrollRailBy(-140),
                          borderRadius: BorderRadius.circular(6),
                          child: Container(
                            width: 28,
                            height: 20,
                            alignment: Alignment.centerLeft,
                            child: SizedBox(
                              width: 14,
                              height: 18,
                              child: Center(
                                child: Icon(
                                  Icons.keyboard_arrow_up_rounded,
                                  size: 14,
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                            ),
                          ),
                        ),
                      Flexible(
                        child: ScrollConfiguration(
                          behavior: ScrollConfiguration.of(context)
                              .copyWith(scrollbars: false),
                          child: SingleChildScrollView(
                            controller: _railScrollCtrl,
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                for (final turn in widget.turns)
                                  Builder(
                                    builder: (tickCtx) => MouseRegion(
                                      cursor: SystemMouseCursors.click,
                                      onEnter: (_) =>
                                          _onHoverTick(tickCtx, turn.turnIndex),
                                      onExit: (_) => setState(() {
                                        if (_hoveredIndex == turn.turnIndex) {
                                          _hoveredIndex = null;
                                          _hoveredTickTop = null;
                                        }
                                      }),
                                      child: GestureDetector(
                                        behavior: HitTestBehavior.opaque,
                                        onTap: () => widget.onSelectTurn(turn),
                                        child: Container(
                                          width: 28,
                                          height: tickHeight,
                                          alignment: Alignment.centerLeft,
                                          child: AnimatedContainer(
                                            duration: const Duration(
                                                milliseconds: 120),
                                            width: (_hoveredIndex ==
                                                        turn.turnIndex ||
                                                    widget.activeTurnIndex ==
                                                        turn.turnIndex)
                                                ? 22
                                                : (turn.isCompacted ? 16 : 14),
                                            height: (_hoveredIndex ==
                                                        turn.turnIndex ||
                                                    widget.activeTurnIndex ==
                                                        turn.turnIndex)
                                                ? 2.5
                                                : 2,
                                            decoration: BoxDecoration(
                                              color: (_hoveredIndex ==
                                                          turn.turnIndex ||
                                                      widget.activeTurnIndex ==
                                                          turn.turnIndex)
                                                  ? cs.primary
                                                  : cs.outline
                                                      .withOpacity(0.55),
                                              borderRadius:
                                                  BorderRadius.circular(
                                                      Gm3.radiusPill),
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      if (_canScrollDown)
                        InkWell(
                          onTap: () => _scrollRailBy(140),
                          borderRadius: BorderRadius.circular(6),
                          child: Container(
                            width: 28,
                            height: 20,
                            alignment: Alignment.centerLeft,
                            child: SizedBox(
                              width: 14,
                              height: 18,
                              child: Center(
                                child: Icon(
                                  Icons.keyboard_arrow_down_rounded,
                                  size: 14,
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),

              if (hoveredTurn != null)
                Positioned(
                  left: 34,
                  top: clampedTop,
                  width: 296,
                  child: IgnorePointer(
                child: Material(
                  elevation: 6,
                  color: isDark ? const Color(0xFF282C34) : surfaces.card,
                  borderRadius: BorderRadius.circular(Gm3.radiusMd),
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(Gm3.radiusMd),
                      border: Border.all(
                        color: surfaces.hairline.withOpacity(0.6),
                      ),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (hoveredTurn.isCompacted) ...[
                          Row(
                            children: [
                              Icon(Icons.compress_rounded,
                                  size: 13, color: cs.onSurfaceVariant),
                              const SizedBox(width: 5),
                              Text(
                                s.contextCompacted,
                                style: theme.textTheme.labelSmall?.copyWith(
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                        ],
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                hoveredTurn.userTitle,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: theme.textTheme.titleSmall?.copyWith(
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            const SizedBox(width: 6),
                            Icon(Icons.bookmark_border_rounded,
                                size: 15, color: cs.onSurfaceVariant),
                          ],
                        ),
                        if (hoveredTurn.assistantSummary.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text(
                            hoveredTurn.assistantSummary,
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: cs.onSurfaceVariant,
                              height: 1.45,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
            ],
          );
        },
      ),
    );
  }
}

class _BranchSelectorPill extends StatelessWidget {
  final int branchIndex;
  final int branchCount;
  final VoidCallback? onPrev;
  final VoidCallback? onNext;

  const _BranchSelectorPill({
    required this.branchIndex,
    required this.branchCount,
    this.onPrev,
    this.onNext,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    return Container(
      height: 26,
      padding: const EdgeInsets.symmetric(horizontal: 4),
      decoration: BoxDecoration(
        color: surfaces.chipFill,
        borderRadius: BorderRadius.circular(Gm3.radiusPill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            onTap: onPrev,
            borderRadius: BorderRadius.circular(Gm3.radiusPill),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: Icon(
                Icons.chevron_left,
                size: 16,
                color: onPrev != null ? cs.onSurface : cs.outline,
              ),
            ),
          ),
          Text(
            AppStringsScope.of(context).branchLabel(branchIndex + 1, branchCount),
            style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: cs.primary,
                ),
          ),
          InkWell(
            onTap: onNext,
            borderRadius: BorderRadius.circular(Gm3.radiusPill),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: Icon(
                Icons.chevron_right,
                size: 16,
                color: onNext != null ? cs.onSurface : cs.outline,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ActiveChainNode {
  final MessageItem item;
  final int? forkParentKey;
  final int branchIndex;
  final int branchCount;

  const _ActiveChainNode({
    required this.item,
    required this.forkParentKey,
    required this.branchIndex,
    required this.branchCount,
  });
}

enum _HoverTimePlacement { leftOutside, bottomRightOutside }

class _HoverProbe extends StatefulWidget {
  final Widget Function(BuildContext context, bool hovered) builder;

  const _HoverProbe({required this.builder});

  @override
  State<_HoverProbe> createState() => _HoverProbeState();
}

class _HoverProbeState extends State<_HoverProbe> {
  static const Duration _hoverDelay = Duration(milliseconds: 1500);
  bool _hovered = false;
  Timer? _hoverTimer;

  @override
  void dispose() {
    _hoverTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) {
        _hoverTimer?.cancel();
        if (_hovered) return;
        _hoverTimer = Timer(_hoverDelay, () {
          if (mounted && !_hovered) setState(() => _hovered = true);
        });
      },
      onExit: (_) {
        _hoverTimer?.cancel();
        _hoverTimer = null;
        if (_hovered) setState(() => _hovered = false);
      },
      child: widget.builder(context, _hovered),
    );
  }
}

class _InlineHoverTimeChip extends StatelessWidget {
  final String label;

  const _InlineHoverTimeChip({required this.label});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    return IgnorePointer(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: surfaces.card,
          borderRadius: BorderRadius.circular(Gm3.radiusPill),
          border: Border.all(color: surfaces.hairline.withOpacity(0.7)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.schedule_rounded, size: 11, color: cs.primary),
            const SizedBox(width: 4),
            Text(
              label,
              style: theme.textTheme.labelSmall?.copyWith(
                fontSize: 10.5,
                color: cs.onSurfaceVariant,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MessageHoverTimeWrapper extends StatefulWidget {
  final int? timestampMs;
  final int? fallbackTimestampMs;
  final _HoverTimePlacement placement;
  final GlobalKey? viewportKey;
  final String label;
  final Widget child;

  const _MessageHoverTimeWrapper({
    required this.timestampMs,
    required this.fallbackTimestampMs,
    required this.placement,
    this.viewportKey,
    required this.label,
    required this.child,
  });

  @override
  State<_MessageHoverTimeWrapper> createState() =>
      _MessageHoverTimeWrapperState();
}

class _MessageHoverTimeWrapperState extends State<_MessageHoverTimeWrapper> {
  static const Duration _hoverDelay = Duration(milliseconds: 1500);
  bool _hovered = false;
  bool _hasLeftBlankSpace = true;
  Timer? _hoverTimer;

  @override
  void dispose() {
    _hoverTimer?.cancel();
    super.dispose();
  }

  static int? _normalizeEpochMs(int? raw) {
    if (raw == null || raw <= 0) return null;
    return raw < 100000000000 ? raw * 1000 : raw;
  }

  static String? formatTimestamp(BuildContext context, int? raw) {
    final effectiveTs = _normalizeEpochMs(raw);
    if (effectiveTs == null) return null;
    final s = AppStringsScope.of(context);
    final formatted = DateFormat('yyyy-MM-dd HH:mm:ss')
        .format(DateTime.fromMillisecondsSinceEpoch(effectiveTs));
    return '${s.invokedAtLabel}: $formatted';
  }

  void _updateLeftSpaceAvailability() {
    if (widget.placement != _HoverTimePlacement.leftOutside) return;
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    final viewportBox =
        widget.viewportKey?.currentContext?.findRenderObject() as RenderBox?;
    final leftOffset = viewportBox != null
        ? box.localToGlobal(Offset.zero, ancestor: viewportBox).dx
        : box.localToGlobal(Offset.zero).dx;
    final hasRoom = leftOffset >= 186.0;
    if (hasRoom != _hasLeftBlankSpace && mounted) {
      setState(() => _hasLeftBlankSpace = hasRoom);
    }
  }

  @override
  Widget build(BuildContext context) {
    final effectiveTs = _normalizeEpochMs(widget.timestampMs) ??
        _normalizeEpochMs(widget.fallbackTimestampMs);
    if (effectiveTs == null) return widget.child;

    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final formatted = DateFormat('yyyy-MM-dd HH:mm:ss')
        .format(DateTime.fromMillisecondsSinceEpoch(effectiveTs));
    final text = '${widget.label}: $formatted';

    final placeLeft =
        widget.placement == _HoverTimePlacement.leftOutside &&
            _hasLeftBlankSpace;

    final badge = IgnorePointer(
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: 8,
          vertical: 3,
        ),
        decoration: BoxDecoration(
          color: surfaces.card,
          borderRadius: BorderRadius.circular(Gm3.radiusPill),
          border: Border.all(
            color: surfaces.hairline.withOpacity(0.7),
          ),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(
                  theme.brightness == Brightness.dark ? 0.30 : 0.08),
              blurRadius: 8,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.schedule_rounded,
              size: 11,
              color: cs.primary,
            ),
            const SizedBox(width: 4),
            Text(
              text,
              style: theme.textTheme.labelSmall?.copyWith(
                fontSize: 10.5,
                color: cs.onSurfaceVariant,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ),
      ),
    );

    return MouseRegion(
      onEnter: (_) {
        _hoverTimer?.cancel();
        _updateLeftSpaceAvailability();
        if (_hovered) return;
        _hoverTimer = Timer(_hoverDelay, () {
          if (!mounted || _hovered) return;
          _updateLeftSpaceAvailability();
          setState(() => _hovered = true);
        });
      },
      onExit: (_) {
        _hoverTimer?.cancel();
        _hoverTimer = null;
        if (_hovered) setState(() => _hovered = false);
      },
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          widget.child,
          if (_hovered && placeLeft)
            Positioned(
              top: 8,
              left: 0,
              child: FractionalTranslation(
                translation: const Offset(-1.0, 0.0),
                child: Padding(
                  padding: const EdgeInsets.only(right: 10),
                  child: badge,
                ),
              ),
            )
          else if (_hovered)
            Positioned(
              top: -24,
              right: 4,
              child: badge,
            ),
        ],
      ),
    );
  }
}

class _StickyFooterRegistry extends ValueNotifier<Set<String>> {
  _StickyFooterRegistry() : super(const <String>{});
  bool _disposed = false;

  void setActive(String id, bool active) {
    if (_disposed) return;
    final has = value.contains(id);
    if (has == active) return;
    final next = Set<String>.from(value);
    if (active) {
      next.add(id);
    } else {
      next.remove(id);
    }
    value = next;
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

class _ProcessGroupStickyHost extends StatefulWidget {
  final Widget Function(
    BuildContext context,
    _StickyFooterRegistry footerRegistry,
  ) builder;

  const _ProcessGroupStickyHost({required this.builder});

  @override
  State<_ProcessGroupStickyHost> createState() =>
      _ProcessGroupStickyHostState();
}

class _ProcessGroupStickyHostState extends State<_ProcessGroupStickyHost> {
  final _StickyFooterRegistry _registry = _StickyFooterRegistry();

  @override
  void dispose() {
    _registry.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return widget.builder(context, _registry);
  }
}

class _StickyBlockMetrics {
  final double? stickyHeaderTop;
  final double? collapseTop;

  const _StickyBlockMetrics({
    this.stickyHeaderTop,
    this.collapseTop,
  });

  static const empty = _StickyBlockMetrics();

  bool approxEquals(_StickyBlockMetrics other) {
    final hSame = (stickyHeaderTop == null && other.stickyHeaderTop == null) ||
        (stickyHeaderTop != null &&
            other.stickyHeaderTop != null &&
            (stickyHeaderTop! - other.stickyHeaderTop!).abs() < 0.5);
    final cSame = (collapseTop == null && other.collapseTop == null) ||
        (collapseTop != null &&
            other.collapseTop != null &&
            (collapseTop! - other.collapseTop!).abs() < 0.5);
    return hSame && cSame;
  }
}

class _StickyLongBlockOverlay extends StatefulWidget {
  final ScrollController scrollController;
  final GlobalKey viewportKey;
  final double stickyTopInset;
  final Color stickyHeaderBackground;
  final EdgeInsetsGeometry stickyHeaderPadding;
  final EdgeInsetsGeometry containerPadding;
  final EdgeInsetsGeometry containerMargin;
  final BorderRadius? clipBorderRadius;
  final BoxDecoration containerDecoration;
  final double collapseRightOffset;
  final bool isLongBlock;
  final String collapseLabel;
  final VoidCallback onCollapse;
  final String? footerRegistrationId;
  final _StickyFooterRegistry? reportFooterTo;
  final _StickyFooterRegistry? suppressFooterWhenNonEmpty;
  final Widget Function(BuildContext context, bool isSticky) headerBuilder;
  final Widget body;

  const _StickyLongBlockOverlay({
    required this.scrollController,
    required this.viewportKey,
    required this.stickyTopInset,
    required this.stickyHeaderBackground,
    required this.stickyHeaderPadding,
    required this.containerPadding,
    required this.containerMargin,
    this.clipBorderRadius,
    required this.containerDecoration,
    required this.collapseRightOffset,
    required this.isLongBlock,
    required this.collapseLabel,
    required this.onCollapse,
    this.footerRegistrationId,
    this.reportFooterTo,
    this.suppressFooterWhenNonEmpty,
    required this.headerBuilder,
    required this.body,
  });

  @override
  State<_StickyLongBlockOverlay> createState() =>
      _StickyLongBlockOverlayState();
}

class _StickyLongBlockOverlayState extends State<_StickyLongBlockOverlay> {
  final GlobalKey _blockKey = GlobalKey();
  final GlobalKey _headerKey = GlobalKey();
  final ValueNotifier<_StickyBlockMetrics> _metrics =
      ValueNotifier<_StickyBlockMetrics>(_StickyBlockMetrics.empty);
  bool _recomputeScheduled = false;
  bool _reportedFooterActive = false;

  @override
  void initState() {
    super.initState();
    widget.scrollController.addListener(_scheduleRecompute);
    _scheduleRecompute();
  }

  @override
  void didUpdateWidget(covariant _StickyLongBlockOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.scrollController != widget.scrollController) {
      oldWidget.scrollController.removeListener(_scheduleRecompute);
      widget.scrollController.addListener(_scheduleRecompute);
    }
    _scheduleRecompute();
  }

  @override
  void dispose() {
    widget.scrollController.removeListener(_scheduleRecompute);
    if (_reportedFooterActive &&
        widget.reportFooterTo != null &&
        widget.footerRegistrationId != null) {
      final registry = widget.reportFooterTo!;
      final id = widget.footerRegistrationId!;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        registry.setActive(id, false);
      });
    }
    _metrics.dispose();
    super.dispose();
  }

  void _scheduleRecompute() {
    if (_recomputeScheduled || !mounted) return;
    _recomputeScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _recomputeScheduled = false;
      _recompute();
    });
  }

  void _recompute() {
    if (!mounted) return;
    final blockBox = _blockKey.currentContext?.findRenderObject() as RenderBox?;
    final viewportBox =
        widget.viewportKey.currentContext?.findRenderObject() as RenderBox?;
    if (blockBox == null ||
        !blockBox.hasSize ||
        viewportBox == null ||
        !viewportBox.hasSize) {
      return;
    }

    final headerBox =
        _headerKey.currentContext?.findRenderObject() as RenderBox?;
    final resolvedHeaderPad =
        widget.stickyHeaderPadding.resolve(Directionality.of(context));
    final rawHeaderH =
        (headerBox != null && headerBox.hasSize) ? headerBox.size.height : 28.0;
    final stickyHeaderH = rawHeaderH + resolvedHeaderPad.vertical;

    final viewportH = viewportBox.size.height;
    final blockTopInViewport =
        blockBox.localToGlobal(Offset.zero, ancestor: viewportBox).dy;
    final blockH = blockBox.size.height;
    final blockBottomInViewport = blockTopInViewport + blockH;

    double? stickyHeaderTop;
    if (blockH >= stickyHeaderH + 56.0 &&
        blockTopInViewport < widget.stickyTopInset - 0.5 &&
        blockBottomInViewport > widget.stickyTopInset + stickyHeaderH + 20.0) {
      stickyHeaderTop = (widget.stickyTopInset - blockTopInViewport).clamp(
        0.0,
        math.max(0.0, blockH - stickyHeaderH - 4.0),
      );
    }

    const double collapseBtnH = 28.0;
    const double bottomMargin = 10.0;
    final bool qualifiesAsLong =
        widget.isLongBlock || blockH >= math.min(320.0, viewportH * 0.55);
    final double effectiveTop = math.max(blockTopInViewport, widget.stickyTopInset);
    final bool hasVisibleRoom = blockBottomInViewport >
            effectiveTop + stickyHeaderH + collapseBtnH + 18.0 &&
        blockTopInViewport < viewportH - 52.0;

    double? collapseTop;
    if (qualifiesAsLong && hasVisibleRoom) {
      final viewportBottomInBlock = viewportH - blockTopInViewport;
      final desiredTop = viewportBottomInBlock - collapseBtnH - 14.0;
      final minTop = (stickyHeaderTop ?? 0.0) + stickyHeaderH + 8.0;
      final maxTop = math.max(minTop, blockH - collapseBtnH - bottomMargin);
      collapseTop = desiredTop.clamp(minTop, maxTop);
    }

    final next = _StickyBlockMetrics(
      stickyHeaderTop: stickyHeaderTop,
      collapseTop: collapseTop,
    );
    if (!next.approxEquals(_metrics.value)) {
      _metrics.value = next;
    }

    final shouldReportActive = collapseTop != null;
    if (shouldReportActive != _reportedFooterActive &&
        widget.reportFooterTo != null &&
        widget.footerRegistrationId != null) {
      _reportedFooterActive = shouldReportActive;
      widget.reportFooterTo!.setActive(
        widget.footerRegistrationId!,
        shouldReportActive,
      );
    }
  }

  Widget _buildFloatingCollapsePositioned(BuildContext context, double top) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return Positioned(
      top: top,
      right: widget.collapseRightOffset,
      child: Material(
        elevation: 4,
        shadowColor: Colors.black.withOpacity(isDark ? 0.45 : 0.16),
        color: surfaces.inset,
        borderRadius: BorderRadius.circular(Gm3.radiusPill),
        child: InkWell(
          onTap: widget.onCollapse,
          borderRadius: BorderRadius.circular(Gm3.radiusPill),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(Gm3.radiusPill),
              border: Border.all(
                color: cs.primary.withOpacity(0.35),
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  Icons.keyboard_arrow_up_rounded,
                  size: 15,
                  color: cs.primary,
                ),
                const SizedBox(width: 4),
                Text(
                  widget.collapseLabel,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: cs.primary,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final surfaces = Gm3Surfaces.of(context);
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Padding(
      padding: widget.containerMargin,
      child: Container(
        key: _blockKey,
        decoration: widget.containerDecoration,
        child: ClipRRect(
          borderRadius: widget.clipBorderRadius ?? BorderRadius.zero,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Padding(
                padding: widget.containerPadding,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ValueListenableBuilder<_StickyBlockMetrics>(
                      valueListenable: _metrics,
                      builder: (context, m, _) {
                        final isSticky = m.stickyHeaderTop != null;
                        return IgnorePointer(
                          ignoring: isSticky,
                          child: Opacity(
                            opacity: isSticky ? 0.0 : 1.0,
                            child: KeyedSubtree(
                              key: _headerKey,
                              child: widget.headerBuilder(context, false),
                            ),
                          ),
                        );
                      },
                    ),
                    widget.body,
                  ],
                ),
              ),
              ValueListenableBuilder<_StickyBlockMetrics>(
                valueListenable: _metrics,
                builder: (context, m, _) {
                  final top = m.stickyHeaderTop;
                  if (top == null) return const SizedBox.shrink();
                  return Positioned(
                    top: top,
                    left: 0,
                    right: 0,
                    child: Material(
                      color: widget.stickyHeaderBackground,
                      elevation: 2,
                      shadowColor:
                          Colors.black.withOpacity(isDark ? 0.35 : 0.10),
                      child: Container(
                        padding: widget.stickyHeaderPadding,
                        decoration: BoxDecoration(
                          border: Border(
                            bottom: BorderSide(
                              color: surfaces.hairline.withOpacity(0.55),
                            ),
                          ),
                        ),
                        child: widget.headerBuilder(context, true),
                      ),
                    ),
                  );
                },
              ),
              ValueListenableBuilder<_StickyBlockMetrics>(
                valueListenable: _metrics,
                builder: (context, m, _) {
                  final cTop = m.collapseTop;
                  if (cTop == null) return const SizedBox.shrink();
                  if (widget.suppressFooterWhenNonEmpty != null) {
                    return ValueListenableBuilder<Set<String>>(
                      valueListenable: widget.suppressFooterWhenNonEmpty!,
                      builder: (context, activeChildren, __) {
                        if (activeChildren.isNotEmpty) {
                          return const SizedBox.shrink();
                        }
                        return _buildFloatingCollapsePositioned(context, cTop);
                      },
                    );
                  }
                  return _buildFloatingCollapsePositioned(context, cTop);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ProcessStep {
  final _ActiveChainNode? node;
  final MessageItem? parentItem;
  final ViewBlock? block;
  final int stepIndex;
  final _ProcessStep? linkedCall;
  final int? linkedCallIndex;
  final ViewBlock? linkedCallBlock;

  const _ProcessStep._({
    this.node,
    this.parentItem,
    this.block,
    this.stepIndex = 0,
    this.linkedCall,
    this.linkedCallIndex,
    this.linkedCallBlock,
  });

  factory _ProcessStep.item(_ActiveChainNode node) =>
      _ProcessStep._(node: node);

  factory _ProcessStep.block(MessageItem parentItem, ViewBlock block) =>
      _ProcessStep._(parentItem: parentItem, block: block);

  _ProcessStep withLink({
    required int stepIndex,
    _ProcessStep? linkedCall,
    int? linkedCallIndex,
    ViewBlock? linkedCallBlock,
  }) {
    return _ProcessStep._(
      node: node,
      parentItem: parentItem,
      block: block,
      stepIndex: stepIndex,
      linkedCall: linkedCall,
      linkedCallIndex: linkedCallIndex,
      linkedCallBlock: linkedCallBlock,
    );
  }
}

class _TimelineEntry {
  final _ActiveChainNode? node;
  final GlobalKey? anchorKey;
  final bool isFinalTurnReply;
  final bool hideProcessBlocks;
  final int? fallbackTimestamp;
  final int groupId;
  final List<_ProcessStep>? processSteps;

  const _TimelineEntry._({
    this.node,
    this.anchorKey,
    this.isFinalTurnReply = false,
    this.hideProcessBlocks = false,
    this.fallbackTimestamp,
    this.groupId = 0,
    this.processSteps,
  });

  factory _TimelineEntry.message({
    required _ActiveChainNode node,
    GlobalKey? anchorKey,
    required bool isFinalTurnReply,
    required bool hideProcessBlocks,
    int? fallbackTimestamp,
  }) {
    return _TimelineEntry._(
      node: node,
      anchorKey: anchorKey,
      isFinalTurnReply: isFinalTurnReply,
      hideProcessBlocks: hideProcessBlocks,
      fallbackTimestamp: fallbackTimestamp,
    );
  }

  factory _TimelineEntry.processGroup({
    required int groupId,
    required List<_ProcessStep> steps,
  }) {
    return _TimelineEntry._(
      groupId: groupId,
      processSteps: steps,
    );
  }
}

class _TurnDirectoryEntry {
  final int turnIndex;
  final int entryIndex;
  final GlobalKey anchorKey;
  final String userTitle;
  final String assistantSummary;
  final bool isCompacted;
  final int branchCount;

  const _TurnDirectoryEntry({
    required this.turnIndex,
    required this.entryIndex,
    required this.anchorKey,
    required this.userTitle,
    required this.assistantSummary,
    required this.isCompacted,
    required this.branchCount,
  });
}

class ConversationContextCategoryStats {
  final int chars;
  final int tokens;

  const ConversationContextCategoryStats({
    required this.chars,
    required this.tokens,
  });

  double shareOf(int totalTokens) {
    if (totalTokens <= 0 || tokens <= 0) return 0;
    return (tokens / totalTokens) * 100.0;
  }
}

class ConversationContextStats {
  final int totalChars;
  final int totalTokens;
  final int inputChars;
  final int outputChars;
  final int inputTokens;
  final int outputTokens;
  final ConversationContextCategoryStats user;
  final ConversationContextCategoryStats assistant;
  final ConversationContextCategoryStats thinking;
  final ConversationContextCategoryStats tool;
  final ConversationContextCategoryStats system;

  const ConversationContextStats({
    required this.totalChars,
    required this.totalTokens,
    required this.inputChars,
    required this.outputChars,
    required this.inputTokens,
    required this.outputTokens,
    required this.user,
    required this.assistant,
    required this.thinking,
    required this.tool,
    required this.system,
  });

  double get inputPct =>
      totalTokens > 0 ? (inputTokens / totalTokens) * 100.0 : 0;

  double get outputPct =>
      totalTokens > 0 ? (outputTokens / totalTokens) * 100.0 : 0;
}

int estimateTokenCount(String text) {
  if (text.isEmpty) return 0;
  var cjk = 0;
  var nonWhitespaceOther = 0;
  for (final rune in text.runes) {
    if ((rune >= 0x4E00 && rune <= 0x9FFF) ||
        (rune >= 0x3400 && rune <= 0x4DBF) ||
        (rune >= 0xF900 && rune <= 0xFAFF) ||
        (rune >= 0x3040 && rune <= 0x30FF) ||
        (rune >= 0xAC00 && rune <= 0xD7AF)) {
      cjk++;
    } else if (rune > 32) {
      nonWhitespaceOther++;
    }
  }
  if (cjk == 0 && nonWhitespaceOther == 0) {
    return math.max(1, (text.length / 4).ceil());
  }
  return cjk + (nonWhitespaceOther / 3.8).ceil();
}

ConversationContextStats computeConversationContextStats(
  List<MessageItem> items,
) {
  var userChars = 0;
  var userTokens = 0;
  var assistantChars = 0;
  var assistantTokens = 0;
  var thinkingChars = 0;
  var thinkingTokens = 0;
  var toolCallChars = 0;
  var toolCallTokens = 0;
  var toolResultChars = 0;
  var toolResultTokens = 0;
  var systemChars = 0;
  var systemTokens = 0;

  void addUser(String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    userChars += t.length;
    userTokens += estimateTokenCount(t);
  }

  void addAssistant(String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    assistantChars += t.length;
    assistantTokens += estimateTokenCount(t);
  }

  void addThinking(String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    thinkingChars += t.length;
    thinkingTokens += estimateTokenCount(t);
  }

  void addToolCall(String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    toolCallChars += t.length;
    toolCallTokens += estimateTokenCount(t);
  }

  void addToolResult(String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    toolResultChars += t.length;
    toolResultTokens += estimateTokenCount(t);
  }

  void addSystem(String text) {
    final t = text.trim();
    if (t.isEmpty) return;
    systemChars += t.length;
    systemTokens += estimateTokenCount(t);
  }

  String fallbackItemText(MessageItem item) {
    if (item.text.trim().isNotEmpty) return item.text;
    return item.blocks
        .map((b) => (b.text ?? '').trim())
        .where((s) => s.isNotEmpty)
        .join('\n');
  }

  void splitThinkTagsAndProse(String raw) {
    var pos = 0;
    for (final m
        in _BranchTreeReaderViewState._thinkTagBlockRe.allMatches(raw)) {
      if (m.start > pos) {
        addAssistant(raw.substring(pos, m.start));
      }
      final tagBody = (m.group(0) ?? '')
          .replaceAll(
            RegExp(r'</?(?:think|thought|thinking)>', caseSensitive: false),
            '',
          )
          .trim();
      addThinking(tagBody);
      pos = m.end;
    }
    if (pos < raw.length) {
      addAssistant(raw.substring(pos));
    }
  }

  for (final item in items) {
    final k = item.kind.toLowerCase();
    if (item.role == 'system' ||
        item.isSynthetic ||
        (item.role == 'user' &&
            !_BranchTreeReaderViewState._isRealUserTurn(item)) ||
        k == 'system_note' ||
        k == 'summary' ||
        k == 'compaction' ||
        k == 'turn_context' ||
        k == 'notice') {
      addSystem(fallbackItemText(item));
      continue;
    }

    if (_BranchTreeReaderViewState._isRealUserTurn(item)) {
      addUser(fallbackItemText(item));
      continue;
    }

    if (item.role == 'tool' || k == 'tool_result') {
      addToolResult(fallbackItemText(item));
      continue;
    }

    if (k == 'tool_call' || k == 'file_change' || k == 'web_search') {
      addToolCall(fallbackItemText(item));
      continue;
    }

    if (k == 'thinking' || k == 'reasoning' || k == 'thought') {
      addThinking(fallbackItemText(item));
      continue;
    }

    if (item.blocks.isNotEmpty) {
      var sawOutputBlockText = false;
      for (final b in item.blocks) {
        final bt = (b.text ?? '').trim();
        final payloadText = bt.isNotEmpty ? bt : (b.toolName ?? '');
        if (_BranchTreeReaderViewState._isThinkingBlockType(b.type)) {
          addThinking(payloadText);
        } else if (b.type == 'tool_result') {
          addToolResult(payloadText);
        } else if (b.type == 'tool_use' ||
            b.type == 'tool_call' ||
            b.type == 'file_diff') {
          addToolCall(payloadText);
        } else if (payloadText.isNotEmpty) {
          sawOutputBlockText = true;
          splitThinkTagsAndProse(payloadText);
        }
      }
      if (!sawOutputBlockText &&
          _BranchTreeReaderViewState._hasSubstantiveAssistantOutput(item) &&
          item.text.trim().isNotEmpty) {
        splitThinkTagsAndProse(item.text);
      }
    } else if (item.text.trim().isNotEmpty) {
      splitThinkTagsAndProse(item.text);
    }
  }

  final toolChars = toolCallChars + toolResultChars;
  final toolTokens = toolCallTokens + toolResultTokens;
  final inputChars = userChars + systemChars + toolResultChars;
  final outputChars = assistantChars + thinkingChars + toolCallChars;
  final inputTokens = userTokens + systemTokens + toolResultTokens;
  final outputTokens = assistantTokens + thinkingTokens + toolCallTokens;
  final totalChars = inputChars + outputChars;
  final totalTokens = inputTokens + outputTokens;

  return ConversationContextStats(
    totalChars: totalChars,
    totalTokens: totalTokens,
    inputChars: inputChars,
    outputChars: outputChars,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    user: ConversationContextCategoryStats(chars: userChars, tokens: userTokens),
    assistant: ConversationContextCategoryStats(
      chars: assistantChars,
      tokens: assistantTokens,
    ),
    thinking: ConversationContextCategoryStats(
      chars: thinkingChars,
      tokens: thinkingTokens,
    ),
    tool: ConversationContextCategoryStats(chars: toolChars, tokens: toolTokens),
    system: ConversationContextCategoryStats(
      chars: systemChars,
      tokens: systemTokens,
    ),
  );
}

class _ConversationContextStatsBar extends StatelessWidget {
  final ConversationContextStats stats;
  final bool expanded;
  final VoidCallback onToggle;

  const _ConversationContextStatsBar({
    required this.stats,
    required this.expanded,
    required this.onToggle,
  });

  static String _fmtCompact(int value) {
    if (value < 1000) return '$value';
    if (value < 100000) return '${(value / 1000).toStringAsFixed(1)}k';
    return '${(value / 1000).round()}k';
  }

  static String _fmtPct(double pct) {
    if (pct <= 0) return '0%';
    if (pct < 1.0) return '<1%';
    return '${pct.round()}%';
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final totalTok = stats.totalTokens;

    final categories = <({
      String key,
      String label,
      Color color,
      ConversationContextCategoryStats stat,
    })>[
      (
        key: 'user',
        label: s.catUserInput,
        color: cs.primary,
        stat: stats.user,
      ),
      (
        key: 'assistant',
        label: s.catAssistantOutput,
        color: Colors.teal.shade500,
        stat: stats.assistant,
      ),
      (
        key: 'thinking',
        label: s.catThinking,
        color: Colors.deepPurple.shade400,
        stat: stats.thinking,
      ),
      (
        key: 'tool',
        label: s.catToolCallsAndResults,
        color: Colors.amber.shade700,
        stat: stats.tool,
      ),
      (
        key: 'system',
        label: s.catSystemInput,
        color: cs.outline,
        stat: stats.system,
      ),
    ];

    final nonZero = categories.where((c) => c.stat.tokens > 0).toList();

    return Material(
      color: surfaces.inset,
      borderRadius: BorderRadius.circular(Gm3.radiusMd),
      child: InkWell(
        onTap: onToggle,
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(
                    Icons.analytics_outlined,
                    size: 15,
                    color: cs.primary,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Wrap(
                      spacing: 10,
                      runSpacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          '${s.charCountLabel} ${_fmtCompact(stats.totalChars)} · ${s.estTokensLabel} ≈ ${_fmtCompact(stats.totalTokens)}',
                          style: theme.textTheme.labelMedium?.copyWith(
                            color: cs.onSurface,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        Gm3Pill(
                          label:
                              '${s.inputOutputRatioLabel} ${_fmtPct(stats.inputPct)} / ${_fmtPct(stats.outputPct)}',
                          color: cs.onSecondaryContainer,
                          background: cs.secondaryContainer.withOpacity(0.75),
                          fontSize: Gm3.fontSizeLabelSmall,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 7,
                            vertical: 1.5,
                          ),
                        ),
                        if (nonZero.isNotEmpty)
                          SizedBox(
                            width: 128,
                            height: 6,
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(
                                Gm3.radiusPill,
                              ),
                              child: Row(
                                children: [
                                  for (final cat in nonZero)
                                    Expanded(
                                      flex: math.max(1, cat.stat.tokens),
                                      child: Container(color: cat.color),
                                    ),
                                ],
                              ),
                            ),
                          ),
                        if (!expanded && nonZero.isNotEmpty)
                          Text(
                            nonZero
                                .map(
                                  (c) =>
                                      '${c.label} ${_fmtPct(c.stat.shareOf(totalTok))}',
                                )
                                .join(' · '),
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                      ],
                    ),
                  ),
                  Icon(
                    expanded
                        ? Icons.expand_less_rounded
                        : Icons.expand_more_rounded,
                    size: 16,
                    color: cs.onSurfaceVariant,
                  ),
                ],
              ),
              if (expanded) ...[
                const SizedBox(height: 8),
                Wrap(
                  spacing: 12,
                  runSpacing: 6,
                  children: [
                    for (final cat in categories)
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            width: 8,
                            height: 8,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              color: cat.color,
                            ),
                          ),
                          const SizedBox(width: 5),
                          Text(
                            '${cat.label}: ${cat.stat.chars} ${s.charCountLabel} · ≈${cat.stat.tokens} tok (${_fmtPct(cat.stat.shareOf(totalTok))})',
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
