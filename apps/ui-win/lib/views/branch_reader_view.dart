import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/archive_direct_store.dart';
import '../models.dart';
import '../theme.dart';

class BranchTreeReaderView extends StatefulWidget {
  final ArchiveDirectStore store;
  final ValueNotifier<int> refreshTick;
  final int? conversationId;
  final ValueChanged<int> onSelectOtherSession;

  const BranchTreeReaderView({
    super.key,
    required this.store,
    required this.refreshTick,
    this.conversationId,
    required this.onSelectOtherSession,
  });

  @override
  State<BranchTreeReaderView> createState() => _BranchTreeReaderViewState();
}

class _BranchTreeReaderViewState extends State<BranchTreeReaderView> {
  ConversationDetail? _detail;
  bool _loading = false;
  bool _activeBranchOnly = true;
  bool _foldSynthetic = true;
  final Map<int?, int> _selectedChildIdxByParent = {};
  final Set<int> _expandedSyntheticGroupStartIds = {};
  final Map<String, String> _loadedSpilledPayloads = {};
  final ScrollController _scrollCtrl = ScrollController();

  @override
  void initState() {
    super.initState();
    widget.refreshTick.addListener(_reloadCurrent);
    if (widget.conversationId != null) {
      _loadConversation(widget.conversationId!);
    }
  }

  @override
  void dispose() {
    widget.refreshTick.removeListener(_reloadCurrent);
    _scrollCtrl.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant BranchTreeReaderView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.conversationId != widget.conversationId && widget.conversationId != null) {
      _selectedChildIdxByParent.clear();
      _expandedSyntheticGroupStartIds.clear();
      _loadedSpilledPayloads.clear();
      _loadConversation(widget.conversationId!);
    }
  }

  void _reloadCurrent() {
    if (widget.conversationId != null) {
      _loadConversation(widget.conversationId!);
    }
  }

  Future<void> _loadConversation(int id) async {
    setState(() => _loading = true);
    final detail = await widget.store.getConversationDetail(id);
    if (!mounted) return;
    setState(() {
      _detail = detail;
      _loading = false;
    });
  }

  /// Resolves the linear chain along currently chosen branch edges (`< Branch k / N >`),
  /// returning pairs of `(item, parentKeyForFork, siblingIndex, siblingCount)`.
  List<({MessageItem item, int? forkParentKey, int branchIndex, int branchCount})> _resolveActiveTreePath(
    ConversationDetail detail,
  ) {
    final result = <({MessageItem item, int? forkParentKey, int branchIndex, int branchCount})>[];
    final visited = <int>{};

    void walk(int? parentKey) {
      final children = detail.childrenByParent[parentKey];
      if (children == null || children.isEmpty) return;

      var chosenIdx = _selectedChildIdxByParent[parentKey];
      if (chosenIdx == null || chosenIdx < 0 || chosenIdx >= children.length) {
        final activeIdx = children.indexWhere((c) => c.isActiveBranch);
        chosenIdx = activeIdx >= 0 ? activeIdx : 0;
      }

      final chosen = children[chosenIdx];
      if (!visited.add(chosen.id)) return;
      result.add((
        item: chosen,
        forkParentKey: parentKey,
        branchIndex: chosenIdx,
        branchCount: children.length,
      ));
      walk(chosen.id);
    }

    walk(null);

    // Append any disconnected items if tree edges were incomplete
    if (result.length < detail.items.length && _selectedChildIdxByParent.isEmpty) {
      for (final it in detail.items) {
        if (!visited.contains(it.id) && it.isActiveBranch) {
          visited.add(it.id);
          result.add((item: it, forkParentKey: it.parentId, branchIndex: 0, branchCount: 1));
        }
      }
    }
    return result;
  }

  List<_TimelineEntry> _buildTimelineEntries(ConversationDetail detail) {
    final entries = _activeBranchOnly
        ? _resolveActiveTreePath(detail)
        : detail.items.map((it) {
            final siblings = detail.childrenByParent[it.parentId] ?? const [];
            final idx = siblings.indexWhere((s) => s.id == it.id);
            return (
              item: it,
              forkParentKey: it.parentId,
              branchIndex: idx >= 0 ? idx : 0,
              branchCount: siblings.length > 1 ? siblings.length : 1,
            );
          }).toList();

    if (!_foldSynthetic) {
      return entries
          .map((e) => _TimelineEntry.single(e.item, e.forkParentKey, e.branchIndex, e.branchCount))
          .toList();
    }

    final grouped = <_TimelineEntry>[];
    var i = 0;
    while (i < entries.length) {
      if (!entries[i].item.isSynthetic) {
        final e = entries[i];
        grouped.add(_TimelineEntry.single(e.item, e.forkParentKey, e.branchIndex, e.branchCount));
        i++;
      } else {
        final run = <({MessageItem item, int? forkParentKey, int branchIndex, int branchCount})>[];
        while (i < entries.length && entries[i].item.isSynthetic) {
          run.add(entries[i]);
          i++;
        }
        grouped.add(_TimelineEntry.syntheticGroup(run));
      }
    }
    return grouped;
  }

  Future<void> _loadPayload(String payloadRef) async {
    final text = await widget.store.readSpilledPayload(payloadRef);
    if (!mounted) return;
    setState(() {
      _loadedSpilledPayloads[payloadRef] = text ?? '[Payload not found on disk: $payloadRef]';
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    if (widget.conversationId == null) {
      return Center(
        child: Text(
          'Select a conversation from the Session List to inspect branches.',
          style: TextStyle(color: cs.onSurfaceVariant),
        ),
      );
    }

    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_detail == null) return const Center(child: Text('Conversation not found.'));

    final detail = _detail!;
    final hh = detail.headHash;
    final headPreview = (hh == null || hh.isEmpty) ? 'N/A' : (hh.length > 10 ? hh.substring(0, 10) : hh);
    final timeline = _buildTimelineEntries(detail);

    return Column(
      children: [
        // Reader Header Bar
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: BoxDecoration(
            color: cs.surface,
            border: Border(bottom: BorderSide(color: theme.dividerColor)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          detail.title,
                          style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600),
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${detail.provider} · Head: $headPreview · Items: ${detail.items.length}'
                          '${detail.defaultModel != null ? ' · Model: ${detail.defaultModel}' : ''}',
                          style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  FilterChip(
                    label: Text(_activeBranchOnly ? 'Active Branch' : 'All Branches', style: const TextStyle(fontSize: 11)),
                    selected: _activeBranchOnly,
                    visualDensity: VisualDensity.compact,
                    onSelected: (val) => setState(() => _activeBranchOnly = val),
                  ),
                  const SizedBox(width: 6),
                  FilterChip(
                    label: const Text('Fold Synthetic', style: TextStyle(fontSize: 11)),
                    selected: _foldSynthetic,
                    visualDensity: VisualDensity.compact,
                    onSelected: (val) => setState(() => _foldSynthetic = val),
                  ),
                ],
              ),
              if (detail.revisions.isNotEmpty || detail.supersededBy != null) ...[
                const SizedBox(height: 6),
                Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    if (detail.supersededBy != null)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                          color: Colors.amber.withOpacity(0.18),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          'superseded_by: ${detail.supersededBy}',
                          style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: Color(0xFFD97706)),
                        ),
                      ),
                    for (final rev in detail.revisions)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                        decoration: BoxDecoration(
                          color: cs.primary.withOpacity(0.1),
                          borderRadius: BorderRadius.circular(4),
                        ),
                        child: Text(
                          'Rev #${rev.revisionNo} (${rev.itemCount ?? 0} items)',
                          style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w500, color: cs.primary),
                        ),
                      ),
                  ],
                ),
              ],
            ],
          ),
        ),

        // Message Tree Timeline
        Expanded(
          child: Scrollbar(
            controller: _scrollCtrl,
            child: ListView.builder(
              controller: _scrollCtrl,
              padding: const EdgeInsets.all(16),
              itemCount: timeline.length,
              itemBuilder: (context, index) {
                final entry = timeline[index];
                if (entry.isSyntheticGroup) {
                  return _buildSyntheticGroupBanner(entry.syntheticRun!);
                }
                return _buildMessageNode(
                  entry.item!,
                  forkParentKey: entry.forkParentKey,
                  branchIndex: entry.branchIndex,
                  branchCount: entry.branchCount,
                );
              },
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildSyntheticGroupBanner(
    List<({MessageItem item, int? forkParentKey, int branchIndex, int branchCount})> run,
  ) {
    final groupKey = run.first.item.id;
    final expanded = _expandedSyntheticGroupStartIds.contains(groupKey);
    final cs = Theme.of(context).colorScheme;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: Theme.of(context).dividerColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          InkWell(
            onTap: () {
              setState(() {
                if (expanded) {
                  _expandedSyntheticGroupStartIds.remove(groupKey);
                } else {
                  _expandedSyntheticGroupStartIds.add(groupKey);
                }
              });
            },
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
              child: Row(
                children: [
                  Icon(expanded ? Icons.expand_less : Icons.expand_more, size: 16, color: cs.onSurfaceVariant),
                  const SizedBox(width: 6),
                  Text(
                    '${run.length} synthetic orchestration item(s) collapsed',
                    style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant, fontWeight: FontWeight.w500),
                  ),
                ],
              ),
            ),
          ),
          if (expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              child: Column(
                children: run
                    .map((e) => _buildMessageNode(
                          e.item,
                          forkParentKey: e.forkParentKey,
                          branchIndex: e.branchIndex,
                          branchCount: e.branchCount,
                        ))
                    .toList(),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildMessageNode(
    MessageItem item, {
    required int? forkParentKey,
    required int branchIndex,
    required int branchCount,
  }) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final isUser = item.role == 'user';
    final isAssistant = item.role == 'assistant';

    final avatarColor = isUser
        ? cs.primary
        : isAssistant
            ? const Color(0xFF10A37F)
            : const Color(0xFF6B7280);

    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 14,
            backgroundColor: avatarColor,
            child: Icon(
              isUser ? Icons.person : isAssistant ? Icons.smart_toy : Icons.terminal,
              size: 14,
              color: Colors.white,
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: isUser ? cs.primary.withOpacity(0.06) : cs.surfaceContainer,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(
                  color: !item.isActiveBranch
                      ? Colors.amber.withOpacity(0.55)
                      : isUser
                          ? cs.primary.withOpacity(0.28)
                          : theme.dividerColor,
                ),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        item.role.toUpperCase(),
                        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.bold, color: cs.onSurfaceVariant),
                      ),
                      if (item.model != null) ...[
                        const SizedBox(width: 8),
                        Text(item.model!, style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant)),
                      ],
                      if (item.toolName != null) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(
                            color: cs.secondary.withOpacity(0.14),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            item.toolName!,
                            style: WinAdaptiveTheme.monoTextStyle(fontSize: 10.5, color: cs.secondary),
                          ),
                        ),
                      ],
                      if (item.isSynthetic) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(
                            color: Colors.grey.withOpacity(0.18),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: const Text('synthetic', style: TextStyle(fontSize: 10)),
                        ),
                      ],
                      if (item.supersededBy != null) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                          decoration: BoxDecoration(
                            color: Colors.amber.withOpacity(0.18),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            'superseded (${item.supersededBy})',
                            style: const TextStyle(fontSize: 10, color: Color(0xFFD97706)),
                          ),
                        ),
                      ],
                      const Spacer(),
                      if (branchCount > 1)
                        _BranchSelectorPill(
                          branchIndex: branchIndex,
                          branchCount: branchCount,
                          onPrev: branchIndex > 0
                              ? () => setState(() => _selectedChildIdxByParent[forkParentKey] = branchIndex - 1)
                              : null,
                          onNext: branchIndex < branchCount - 1
                              ? () => setState(() => _selectedChildIdxByParent[forkParentKey] = branchIndex + 1)
                              : null,
                        )
                      else if (!item.isActiveBranch)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(
                            color: Colors.amber.withOpacity(0.18),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: const Text('alt branch', style: TextStyle(fontSize: 10, color: Color(0xFFD97706))),
                        ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  if (item.blocks.isNotEmpty)
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        for (final block in item.blocks) _buildViewBlock(item, block),
                      ],
                    )
                  else
                    _buildFormattedText(item.text),
                  if (ArchiveDirectStore.extractPayloadSha256(item.payloadRef) != null) ...[
                    const SizedBox(height: 8),
                    _buildSpilledPayloadControl(item.payloadRef!),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildViewBlock(MessageItem item, ViewBlock block) {
    final cs = Theme.of(context).colorScheme;
    final theme = Theme.of(context);

    switch (block.type) {
      case 'thinking':
        return Container(
          margin: const EdgeInsets.only(bottom: 8),
          decoration: BoxDecoration(
            color: cs.surface,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: theme.dividerColor),
          ),
          child: ExpansionTile(
            dense: true,
            tilePadding: const EdgeInsets.symmetric(horizontal: 10),
            title: Text(
              'Reasoning / Thinking',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: cs.onSurfaceVariant),
            ),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
                child: SelectableText(
                  block.text ?? '',
                  style: TextStyle(fontSize: 12.5, color: cs.onSurfaceVariant),
                ),
              ),
            ],
          ),
        );

      case 'code':
        return _CodeBlockWidget(
          code: block.text ?? '',
          lang: block.lang,
        );

      case 'tool_use':
      case 'tool_call':
      case 'tool_result':
      case 'file_diff':
        final title = '${block.type}${block.toolName != null ? ': ${block.toolName}' : ''}'
            '${block.status != null ? ' (${block.status})' : ''}';
        final bodyText = block.toolInput ?? block.text ?? '';
        return Container(
          margin: const EdgeInsets.only(bottom: 8),
          decoration: BoxDecoration(
            color: cs.surface,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: theme.dividerColor),
          ),
          child: ExpansionTile(
            dense: true,
            tilePadding: const EdgeInsets.symmetric(horizontal: 10),
            title: Text(
              title,
              style: WinAdaptiveTheme.monoTextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: cs.primary),
            ),
            children: [
              if (bodyText.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
                  child: SelectableText(
                    bodyText,
                    style: WinAdaptiveTheme.monoTextStyle(fontSize: 11.5, color: cs.onSurface),
                  ),
                ),
            ],
          ),
        );

      case 'image':
        final sha = block.blobSha256;
        final File? imgFile = sha != null ? widget.store.resolveBlobFile(sha) : null;
        return Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.all(8),
          decoration: BoxDecoration(
            color: cs.surface,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: theme.dividerColor),
          ),
          child: imgFile != null && imgFile.existsSync()
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 280),
                      child: Image.file(imgFile, fit: BoxFit.contain),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      imgFile.path,
                      style: WinAdaptiveTheme.monoTextStyle(fontSize: 10, color: cs.onSurfaceVariant),
                    ),
                  ],
                )
              : Row(
                  children: [
                    Icon(Icons.image_not_supported_outlined, size: 16, color: cs.onSurfaceVariant),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Image asset (${sha ?? 'missing sha256'}, ${block.availability ?? 'missing_ref'})',
                        style: TextStyle(fontSize: 11.5, color: cs.onSurfaceVariant),
                      ),
                    ),
                  ],
                ),
        );

      case 'audio':
      case 'video':
      case 'file':
      case 'canvas':
      case 'raw_ref':
        return Container(
          margin: const EdgeInsets.only(bottom: 8),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: cs.surface,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: theme.dividerColor),
          ),
          child: Row(
            children: [
              const Icon(Icons.attachment, size: 15),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${block.type.toUpperCase()}: ${block.text ?? block.blobSha256 ?? 'attachment'}',
                  style: WinAdaptiveTheme.monoTextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                ),
              ),
            ],
          ),
        );

      default:
        return Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: _buildFormattedText(block.text ?? ''),
        );
    }
  }

  Widget _buildSpilledPayloadControl(String payloadRef) {
    final loaded = _loadedSpilledPayloads[payloadRef];
    if (loaded == null) {
      return OutlinedButton.icon(
        onPressed: () => _loadPayload(payloadRef),
        icon: const Icon(Icons.download_outlined, size: 14),
        label: Text('Load full payload from blob ($payloadRef)', style: const TextStyle(fontSize: 11)),
      );
    }
    return _CodeBlockWidget(code: loaded, lang: 'spilled payload ($payloadRef)');
  }

  Widget _buildFormattedText(String text) {
    final hasLatex = text.contains(r'$$') || text.contains(r'\(');
    final fenceRe = RegExp(r'```([a-zA-Z0-9_-]*)\n([\s\S]*?)```');
    final matches = fenceRe.allMatches(text).toList();
    if (matches.isEmpty && !hasLatex) {
      return SelectableText(text, style: const TextStyle(fontSize: 13.5, height: 1.48));
    }

    if (matches.isNotEmpty) {
      final children = <Widget>[];
      var pos = 0;
      for (final m in matches) {
        if (m.start > pos) {
          children.add(_buildLatexOrPlain(text.substring(pos, m.start)));
        }
        children.add(_CodeBlockWidget(code: m.group(2) ?? '', lang: m.group(1)));
        pos = m.end;
      }
      if (pos < text.length) {
        children.add(_buildLatexOrPlain(text.substring(pos)));
      }
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
    }

    return _buildLatexOrPlain(text);
  }

  Widget _buildLatexOrPlain(String text) {
    final blockMathRe = RegExp(r'\$\$([\s\S]+?)\$\$');
    final matches = blockMathRe.allMatches(text).toList();
    if (matches.isEmpty) {
      return SelectableText(text, style: const TextStyle(fontSize: 13.5, height: 1.48));
    }

    final cs = Theme.of(context).colorScheme;
    final widgets = <Widget>[];
    var pos = 0;
    for (final m in matches) {
      if (m.start > pos) {
        widgets.add(SelectableText(text.substring(pos, m.start), style: const TextStyle(fontSize: 13.5, height: 1.48)));
      }
      widgets.add(
        Container(
          width: double.infinity,
          margin: const EdgeInsets.symmetric(vertical: 6),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: cs.surface,
            borderRadius: BorderRadius.circular(4),
            border: Border.all(color: Theme.of(context).dividerColor),
          ),
          child: SelectableText(
            m.group(1)!.trim(),
            style: WinAdaptiveTheme.monoTextStyle(fontSize: 12.5, color: cs.primary),
          ),
        ),
      );
      pos = m.end;
    }
    if (pos < text.length) {
      widgets.add(SelectableText(text.substring(pos), style: const TextStyle(fontSize: 13.5, height: 1.48)));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: widgets);
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
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
      decoration: BoxDecoration(
        color: cs.primary.withOpacity(0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            onTap: onPrev,
            child: Icon(Icons.chevron_left, size: 15, color: onPrev != null ? cs.primary : cs.onSurfaceVariant),
          ),
          Text(
            'Branch ${branchIndex + 1} / $branchCount',
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: cs.primary),
          ),
          InkWell(
            onTap: onNext,
            child: Icon(Icons.chevron_right, size: 15, color: onNext != null ? cs.primary : cs.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class _CodeBlockWidget extends StatelessWidget {
  final String code;
  final String? lang;

  const _CodeBlockWidget({required this.code, this.lang});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(5),
        border: Border.all(color: theme.dividerColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: theme.dividerColor)),
            ),
            child: Row(
              children: [
                Text(
                  (lang == null || lang!.isEmpty) ? 'code' : lang!,
                  style: WinAdaptiveTheme.monoTextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
                ),
                const Spacer(),
                InkWell(
                  onTap: () {
                    Clipboard.setData(ClipboardData(text: code));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Code copied to clipboard'), duration: Duration(seconds: 1)),
                    );
                  },
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.copy, size: 12, color: cs.onSurfaceVariant),
                      const SizedBox(width: 4),
                      Text('Copy', style: TextStyle(fontSize: 10.5, color: cs.onSurfaceVariant)),
                    ],
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(10),
            child: SelectableText(
              code,
              style: WinAdaptiveTheme.monoTextStyle(fontSize: 12, color: cs.onSurface),
            ),
          ),
        ],
      ),
    );
  }
}

class _TimelineEntry {
  final MessageItem? item;
  final int? forkParentKey;
  final int branchIndex;
  final int branchCount;
  final List<({MessageItem item, int? forkParentKey, int branchIndex, int branchCount})>? syntheticRun;

  bool get isSyntheticGroup => syntheticRun != null;

  _TimelineEntry.single(this.item, this.forkParentKey, this.branchIndex, this.branchCount) : syntheticRun = null;

  _TimelineEntry.syntheticGroup(this.syntheticRun)
      : item = null,
        forkParentKey = null,
        branchIndex = 0,
        branchCount = 1;
}
