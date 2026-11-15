import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

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

  /// Chosen child index per parent fork node (`null` represents root parent).
  final Map<int?, int> _selectedChildIdxByParent = {};
  final Set<int> _expandedProcessGroupIds = {};
  final Set<String> _expandedBlockKeys = {};
  final Map<String, String> _loadedPayloads = {};
  final Set<String> _loadingPayloads = {};

  final ScrollController _scrollController = ScrollController();
  int _activeTurnIndex = 0;

  @override
  void initState() {
    super.initState();
    widget.refreshTick.addListener(_reloadCurrent);
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
      _expandedBlockKeys.clear();
      _loadedPayloads.clear();
      _branchViewMode = false;
      _activeTurnIndex = 0;
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

  static bool _isProcessBlockType(String type) {
    return type == 'thinking' ||
        type == 'tool_use' ||
        type == 'tool_call' ||
        type == 'tool_result' ||
        type == 'file_diff';
  }

  static bool _isProcessOnlyItem(MessageItem item) {
    if (item.isSynthetic) return true;
    if (item.role == 'tool' || item.role == 'system') return true;
    if (item.kind == 'thinking' ||
        item.kind == 'tool_call' ||
        item.kind == 'tool_result' ||
        item.kind == 'system_note' ||
        item.kind == 'summary' ||
        item.kind == 'compaction') {
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
      if (node.item.role == 'user') {
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
          steps: List<_ProcessStep>.from(buf),
        ),
      );
      buf.clear();
    }

    for (final slice in turnSlices) {
      final startIdx =
          slice.isNotEmpty && slice.first.item.role == 'user' ? 1 : 0;

      // Determine the index (within slice) of the final complete assistant reply
      int? lastFinalIdx;
      for (var i = slice.length - 1; i >= startIdx; i--) {
        if (_hasSubstantiveAssistantOutput(slice[i].item)) {
          lastFinalIdx = i;
          break;
        }
      }

      // Emit User prompt bubble (and register Turn Directory anchor)
      _TurnDirectoryEntry? pendingTurnDir;
      GlobalKey? turnKey;
      final bool isCompactedTurn = slice.any((n) => _looksCompacted(n.item));

      if (startIdx == 1) {
        final userNode = slice.first;
        turnKey = GlobalKey();
        final entryIdx = entries.length;
        final isFinalOnlyUser = lastFinalIdx == null && slice.length == 1;
        entries.add(
          _TimelineEntry.message(
            node: userNode,
            anchorKey: turnKey,
            isFinalTurnReply: false,
            hideProcessBlocks: false,
          ),
        );

        final finalAssistantItem =
            lastFinalIdx != null ? slice[lastFinalIdx].item : null;
        final rawPrompt = userNode.item.text.trim().replaceAll(RegExp(r'\s+'), ' ');
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
        turnKey = GlobalKey();
        final finalAssistantItem = slice[lastFinalIdx].item;
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

        entries.add(
          _TimelineEntry.message(
            node: node,
            anchorKey: startIdx == 0 ? turnKey : null,
            isFinalTurnReply: true,
            hideProcessBlocks: true,
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

  void _jumpToTurn(_TurnDirectoryEntry turn, int totalEntries) {
    setState(() => _activeTurnIndex = turn.turnIndex);

    final ctx = turn.anchorKey.currentContext;
    if (ctx != null) {
      Scrollable.ensureVisible(
        ctx,
        duration: const Duration(milliseconds: 240),
        curve: Curves.easeOutCubic,
        alignment: 0.06,
      );
      return;
    }

    if (!_scrollController.hasClients) return;
    final maxExtent = _scrollController.position.maxScrollExtent;
    final ratio = totalEntries <= 1
        ? 0.0
        : (turn.entryIndex / (totalEntries - 1)).clamp(0.0, 1.0);
    _scrollController.jumpTo(maxExtent * ratio);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      final delayedCtx = turn.anchorKey.currentContext;
      if (delayedCtx != null) {
        Scrollable.ensureVisible(
          delayedCtx,
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOutCubic,
          alignment: 0.06,
        );
      }
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
                            if (!_expandAllProcess) {
                              _expandedProcessGroupIds.clear();
                            }
                          }),
                        ),

                      // Conversation View | Branch View Switcher
                      Gm3SegmentedTrack(
                        height: 32,
                        child: SegmentedButton<bool>(
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
                        visualDensity: VisualDensity.compact,
                        backgroundColor: surfaces.chipFill,
                        side: BorderSide.none,
                        onPressed: () => widget.onSelectOtherSession(sub.id),
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
            ],
          ),
        ),
        Divider(color: surfaces.hairline.withOpacity(0.45), height: 1),

        // Main Area: Conversation Canvas (+ Codex Jump Rail) OR Dedicated Branch View
        Expanded(
          child: Container(
            color: surfaces.panel,
            child: _branchViewMode
                ? _buildDedicatedBranchView(context, detail)
                : Stack(
                    clipBehavior: Clip.none,
                    children: [
                      ListView.builder(
                        controller: _scrollController,
                        padding: EdgeInsets.fromLTRB(
                          turns.isNotEmpty ? 52 : 28,
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
                                );
                          return Center(
                            child: ConstrainedBox(
                              constraints: const BoxConstraints(maxWidth: 780),
                              child: KeyedSubtree(
                                key: entry.anchorKey,
                                child: child,
                              ),
                            ),
                          );
                        },
                      ),

                      if (turns.isNotEmpty)
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
    final isExpanded =
        _expandAllProcess || _expandedProcessGroupIds.contains(entry.groupId);

    var thinkingCount = 0;
    var toolCallCount = 0;
    var toolResultCount = 0;
    var systemCount = 0;
    var noteCount = 0;

    for (final step in steps) {
      if (step.block != null) {
        final t = step.block!.type;
        if (t == 'thinking') {
          thinkingCount++;
        } else if (t == 'tool_result') {
          toolResultCount++;
        } else {
          toolCallCount++;
        }
      } else if (step.node != null) {
        final it = step.node!.item;
        final blockThinking =
            it.blocks.where((b) => b.type == 'thinking').length;
        final blockToolCalls = it.blocks
            .where((b) =>
                b.type == 'tool_use' ||
                b.type == 'tool_call' ||
                b.type == 'file_diff')
            .length;
        final blockToolResults =
            it.blocks.where((b) => b.type == 'tool_result').length;

        if (it.isSynthetic || it.role == 'system') {
          systemCount++;
        } else if (it.kind == 'thinking' || blockThinking > 0) {
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

    if (!isExpanded) {
      return Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Material(
          color: surfaces.inset,
          borderRadius: BorderRadius.circular(Gm3.radiusPill),
          child: InkWell(
            onTap: () =>
                setState(() => _expandedProcessGroupIds.add(entry.groupId)),
            borderRadius: BorderRadius.circular(Gm3.radiusPill),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
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
                ],
              ),
            ),
          ),
        ),
      );
    }

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
      decoration: BoxDecoration(
        color: surfaces.inset.withOpacity(0.75),
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
        border: Border.all(color: surfaces.hairline.withOpacity(0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: () =>
                setState(() => _expandedProcessGroupIds.remove(entry.groupId)),
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
          ),
          const SizedBox(height: 6),
          for (var i = 0; i < steps.length; i++)
            _buildExpandedProcessStep(context, steps[i], i),
        ],
      ),
    );
  }

  Widget _buildExpandedProcessStep(
      BuildContext context, _ProcessStep step, int index) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    if (step.block != null && step.parentItem != null) {
      final b = step.block!;
      final isThinking = b.type == 'thinking';
      final body = (b.toolInput ?? b.text ?? '').trim();
      return Container(
        margin: const EdgeInsets.only(top: 6),
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: surfaces.card,
          borderRadius: BorderRadius.circular(Gm3.radiusSm),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  isThinking
                      ? Icons.psychology_outlined
                      : Icons.terminal_rounded,
                  size: 14,
                  color: cs.primary,
                ),
                const SizedBox(width: 6),
                Text(
                  isThinking
                      ? s.thinkingProcess
                      : '${b.type}${b.toolName != null ? ': ${b.toolName}' : ''}',
                  style: GoogleMaterialTheme.monoTextStyle(
                    fontSize: Gm3.monoSm,
                    fontWeight: FontWeight.w600,
                    color: cs.primary,
                  ),
                ),
              ],
            ),
            if (body.isNotEmpty) ...[
              const SizedBox(height: 4),
              SelectableText(
                body,
                style: GoogleMaterialTheme.monoTextStyle(
                  fontSize: Gm3.monoSm,
                  color: cs.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      );
    }

    final node = step.node!;
    final item = node.item;
    final processBlocks = item.blocks;
    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: surfaces.card,
        borderRadius: BorderRadius.circular(Gm3.radiusSm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Gm3Pill(
                label: item.toolName != null
                    ? '${item.kind}: ${item.toolName}'
                    : '${item.role.toUpperCase()} · ${item.kind}',
                color: cs.primary,
                background: surfaces.chipFill,
              ),
              const SizedBox(width: 8),
              if (item.isSynthetic)
                Gm3Pill(
                  label: s.syntheticBadge,
                  color: cs.onSurfaceVariant,
                  background: surfaces.inset,
                ),
              const Spacer(),
              if (node.branchCount > 1)
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
          ),
          if (processBlocks.isNotEmpty) ...[
            const SizedBox(height: 6),
            for (final b in processBlocks) _buildProcessBlockContent(context, b),
          ] else if (item.text.trim().isNotEmpty) ...[
            const SizedBox(height: 6),
            SelectableText(
              item.text,
              style: GoogleMaterialTheme.monoTextStyle(
                fontSize: Gm3.monoSm,
                color: cs.onSurface,
              ),
            ),
          ],
          if (ArchiveDirectStore.extractPayloadSha256(item.payloadRef) !=
              null) ...[
            const SizedBox(height: 8),
            _buildSpilledPayloadControl(item.payloadRef!),
          ],
        ],
      ),
    );
  }

  Widget _buildProcessBlockContent(BuildContext context, ViewBlock block) {
    final cs = Theme.of(context).colorScheme;
    final body = (block.toolInput ?? block.text ?? '').trim();
    if (body.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: SelectableText(
        block.toolName != null ? '[${block.toolName}] $body' : body,
        style: GoogleMaterialTheme.monoTextStyle(
          fontSize: Gm3.monoSm,
          color: cs.onSurfaceVariant,
        ),
      ),
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
        padding: const EdgeInsets.only(bottom: 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Align(
              alignment: Alignment.centerRight,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 580),
                child: Container(
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
                        for (final block in contentBlocks)
                          _buildViewBlock(item, block)
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

            if (contentBlocks.isNotEmpty)
              for (final block in contentBlocks) _buildViewBlock(item, block)
            else
              MarkdownProse(text: item.text),

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
        .where((b) => b.type != 'thinking')
        .map((b) => b.text ?? b.toolInput ?? '')
        .where((t) => t.trim().isNotEmpty)
        .join('\n\n');
  }

  Widget _buildViewBlock(MessageItem item, ViewBlock block) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    if (block.type == 'thinking' ||
        block.type == 'tool_use' ||
        block.type == 'tool_call' ||
        block.type == 'tool_result' ||
        block.type == 'file_diff') {
      final isThinking = block.type == 'thinking';
      final title = isThinking
          ? s.thinkingProcess
          : '${block.type}${block.toolName != null ? ': ${block.toolName}' : ''}';
      final body = (block.toolInput ?? block.text ?? '').trim();
      final blockKey = '${item.id}_${block.idx}_${block.type}';
      final expanded = _expandedBlockKeys.contains(blockKey);

      return Container(
        margin: const EdgeInsets.only(bottom: 8),
        decoration: BoxDecoration(
          color: surfaces.inset,
          borderRadius: BorderRadius.circular(Gm3.radiusMd),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            InkWell(
              onTap: () => setState(() {
                if (expanded) {
                  _expandedBlockKeys.remove(blockKey);
                } else {
                  _expandedBlockKeys.add(blockKey);
                }
              }),
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
            if (expanded && body.isNotEmpty)
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
                child: SelectableText(
                  body,
                  style: GoogleMaterialTheme.monoTextStyle(
                    fontSize: Gm3.monoSm,
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ),
          ],
        ),
      );
    }

    if (block.type == 'code') {
      return MarkdownCodeBlock(code: block.text ?? '', lang: block.lang);
    }

    if (block.type == 'image') {
      final sha = block.blobSha256;
      final File? imgFile =
          sha != null ? widget.store.resolveBlobFile(sha) : null;
      if (imgFile != null && imgFile.existsSync()) {
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
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
        padding: const EdgeInsets.only(bottom: 8),
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
      padding: const EdgeInsets.only(bottom: 6),
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
        child: SelectableText(
          loaded,
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
  int? _hoveredIndex;

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
      width: 28,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 460),
              child: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (final turn in widget.turns)
                      MouseRegion(
                        cursor: SystemMouseCursors.click,
                        onEnter: (_) =>
                            setState(() => _hoveredIndex = turn.turnIndex),
                        onExit: (_) => setState(() {
                          if (_hoveredIndex == turn.turnIndex) {
                            _hoveredIndex = null;
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
                              duration: const Duration(milliseconds: 120),
                              width: (_hoveredIndex == turn.turnIndex ||
                                      widget.activeTurnIndex ==
                                          turn.turnIndex)
                                  ? 22
                                  : (turn.isCompacted ? 14 : 10),
                              height: (_hoveredIndex == turn.turnIndex ||
                                      widget.activeTurnIndex ==
                                          turn.turnIndex)
                                  ? 2.5
                                  : 2,
                              decoration: BoxDecoration(
                                color: (_hoveredIndex == turn.turnIndex ||
                                        widget.activeTurnIndex ==
                                            turn.turnIndex)
                                    ? cs.primary
                                    : cs.outline.withOpacity(0.55),
                                borderRadius:
                                    BorderRadius.circular(Gm3.radiusPill),
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

          if (hoveredTurn != null)
            Positioned(
              left: 34,
              top: 12,
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

class _ProcessStep {
  final _ActiveChainNode? node;
  final MessageItem? parentItem;
  final ViewBlock? block;

  const _ProcessStep._({this.node, this.parentItem, this.block});

  factory _ProcessStep.item(_ActiveChainNode node) =>
      _ProcessStep._(node: node);

  factory _ProcessStep.block(MessageItem parentItem, ViewBlock block) =>
      _ProcessStep._(parentItem: parentItem, block: block);
}

class _TimelineEntry {
  final _ActiveChainNode? node;
  final GlobalKey? anchorKey;
  final bool isFinalTurnReply;
  final bool hideProcessBlocks;
  final int groupId;
  final List<_ProcessStep>? processSteps;

  const _TimelineEntry._({
    this.node,
    this.anchorKey,
    this.isFinalTurnReply = false,
    this.hideProcessBlocks = false,
    this.groupId = 0,
    this.processSteps,
  });

  factory _TimelineEntry.message({
    required _ActiveChainNode node,
    GlobalKey? anchorKey,
    required bool isFinalTurnReply,
    required bool hideProcessBlocks,
  }) {
    return _TimelineEntry._(
      node: node,
      anchorKey: anchorKey,
      isFinalTurnReply: isFinalTurnReply,
      hideProcessBlocks: hideProcessBlocks,
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
