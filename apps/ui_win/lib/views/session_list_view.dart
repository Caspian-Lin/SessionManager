import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:path/path.dart' as p;

import '../data/app_settings.dart';
import '../data/archive_direct_store.dart';
import '../data/sm_cli_runner.dart';
import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/gm3_surface.dart';

class SessionListView extends StatefulWidget {
  final ArchiveDirectStore store;
  final SmCliRunner? cliRunner;
  final AppSettingsController? settings;
  final ValueNotifier<int> refreshTick;
  final int? selectedConversationId;
  final ValueChanged<int> onSelectSession;
  final VoidCallback? onDataChanged;
  final VoidCallback? onGoToImport;

  const SessionListView({
    super.key,
    required this.store,
    this.cliRunner,
    this.settings,
    required this.refreshTick,
    this.selectedConversationId,
    required this.onSelectSession,
    this.onDataChanged,
    this.onGoToImport,
  });

  @override
  State<SessionListView> createState() => _SessionListViewState();
}

sealed class _TreeRow {
  const _TreeRow();
}

class _ProviderTreeRow extends _TreeRow {
  final String provider;
  final int projectCount;
  final int sessionCount;
  final bool expanded;

  const _ProviderTreeRow({
    required this.provider,
    required this.projectCount,
    required this.sessionCount,
    required this.expanded,
  });
}

class _ProjectTreeRow extends _TreeRow {
  final String provider;
  final String projectKey;
  final String globalProjectKey;
  final String projectLabel;
  final String? projectPath;
  final int sessionCount;
  final bool expanded;
  final bool pinned;
  final bool starred;
  final bool hidden;

  const _ProjectTreeRow({
    required this.provider,
    required this.projectKey,
    required this.globalProjectKey,
    required this.projectLabel,
    this.projectPath,
    required this.sessionCount,
    required this.expanded,
    this.pinned = false,
    this.starred = false,
    this.hidden = false,
  });
}

class _HiddenProjectsGroupRow extends _TreeRow {
  final String provider;
  final int projectCount;
  final int sessionCount;
  final bool expanded;

  const _HiddenProjectsGroupRow({
    required this.provider,
    required this.projectCount,
    required this.sessionCount,
    required this.expanded,
  });
}

class _SessionLeafRow extends _TreeRow {
  final ConversationSummary session;
  final bool subagentsExpanded;

  const _SessionLeafRow({
    required this.session,
    required this.subagentsExpanded,
  });
}

class _SubagentLeafRow extends _TreeRow {
  final ConversationSummary parent;
  final ConversationSummary subagent;

  const _SubagentLeafRow({
    required this.parent,
    required this.subagent,
  });
}

class _SessionListViewState extends State<SessionListView> {
  List<ConversationSummary> _sessions = [];
  List<ProjectInfo> _projects = [];
  bool _loading = true;
  String _providerFilter = 'all';
  int? _projectIdFilter;
  bool _starredOnly = false;
  bool _pinnedOnly = false;
  bool _collapsedOnly = false;
  bool _shrunkOnly = false;
  SmSortBy _sortBy = SmSortBy.updatedDesc;
  final TextEditingController _searchCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();

  final Set<String> _collapsedProviders = <String>{};
  final Set<String> _collapsedProjects = <String>{};
  final Set<String> _expandedHiddenProviders = <String>{};
  final Set<int> _expandedSubagentParents = <int>{};

  @override
  void initState() {
    super.initState();
    widget.refreshTick.addListener(_loadSessions);
    widget.settings?.addListener(_onSettingsChanged);
    _loadSessions();
  }

  @override
  void didUpdateWidget(covariant SessionListView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.settings != widget.settings) {
      oldWidget.settings?.removeListener(_onSettingsChanged);
      widget.settings?.addListener(_onSettingsChanged);
    }
  }

  @override
  void dispose() {
    widget.refreshTick.removeListener(_loadSessions);
    widget.settings?.removeListener(_onSettingsChanged);
    _searchCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  void _onSettingsChanged() {
    if (mounted) {
      final parsed = _parseSearchTags(_searchCtrl.text);
      if (_starredOnly ||
          _pinnedOnly ||
          _collapsedOnly ||
          parsed.starred ||
          parsed.pinned ||
          parsed.collapsed) {
        _loadSessions();
      } else {
        setState(() {});
      }
    }
  }

  static ({
    String query,
    bool pinned,
    bool starred,
    bool collapsed,
    bool shrunk,
  }) _parseSearchTags(String raw) {
    var pinned = false;
    var starred = false;
    var collapsed = false;
    var shrunk = false;
    final kept = <String>[];

    for (final token in raw.trim().split(RegExp(r'\s+'))) {
      if (token.isEmpty) continue;
      final lower = token.toLowerCase();
      String? tagVal;
      if (lower.startsWith('tag:')) {
        tagVal = lower.substring(4);
      } else if (lower.startsWith('is:')) {
        tagVal = lower.substring(3);
      } else if (lower.startsWith('#') && lower.length > 1) {
        tagVal = lower.substring(1);
      }

      if (tagVal != null) {
        if (tagVal == 'pinned' || tagVal == 'pin' || tagVal == '置顶') {
          pinned = true;
          continue;
        }
        if (tagVal == 'starred' || tagVal == 'star' || tagVal == '星标' || tagVal == '收藏') {
          starred = true;
          continue;
        }
        if (tagVal == 'collapsed' ||
            tagVal == 'hidden' ||
            tagVal == 'hide' ||
            tagVal == '折叠' ||
            tagVal == '折叠项目' ||
            tagVal == '隐藏') {
          collapsed = true;
          continue;
        }
        if (tagVal == 'shrunk' || tagVal == '精简' || tagVal == '内容缩短') {
          shrunk = true;
          continue;
        }
      }
      kept.add(token);
    }

    return (
      query: kept.join(' '),
      pinned: pinned,
      starred: starred,
      collapsed: collapsed,
      shrunk: shrunk,
    );
  }

  Future<void> _loadSessions() async {
    setState(() => _loading = true);
    final parsed = _parseSearchTags(_searchCtrl.text);
    final effStarred = _starredOnly || parsed.starred;
    final effPinned = _pinnedOnly || parsed.pinned;
    final effCollapsed = _collapsedOnly || parsed.collapsed;
    final effShrunk = _shrunkOnly || parsed.shrunk;

    final starredProjs = widget.settings?.starredProjects ?? const <String>{};
    final pinnedProjs = widget.settings?.pinnedProjects ?? const <String>{};
    final pinnedSess = widget.settings?.pinnedSessions ?? const <int>{};
    final hiddenProjs = widget.settings?.hiddenProjects ?? const <String>{};

    final needInMemoryStarFilter = effStarred && starredProjs.isNotEmpty;
    final results = await Future.wait([
      widget.store.getConversations(
        provider: _providerFilter == 'all' ? null : _providerFilter,
        projectId: _projectIdFilter,
        starredOnly: effStarred && !needInMemoryStarFilter,
        shrunkOnly: effShrunk,
        searchFilter: parsed.query,
        sortBy: _sortBy,
      ),
      widget.store.getProjects(),
    ]);
    if (!mounted) return;
    var loaded = results[0] as List<ConversationSummary>;
    if (needInMemoryStarFilter || effPinned || effCollapsed) {
      final uncategorized = AppStringsScope.of(context).uncategorizedProject;
      loaded = loaded.where((s) {
        final rawLabel = _projectLabelForRaw(s);
        final label = rawLabel.isNotEmpty ? rawLabel : uncategorized;
        final pKey = '${s.provider}::${s.projectId?.toString() ?? label.toLowerCase()}';
        final gKey = _globalProjectKey(rawLabel, s.cwd);
        if (needInMemoryStarFilter && !s.starred && !starredProjs.contains(gKey)) {
          return false;
        }
        if (effPinned && !pinnedSess.contains(s.id) && !pinnedProjs.contains(pKey)) {
          return false;
        }
        if (effCollapsed && !hiddenProjs.contains(pKey)) {
          return false;
        }
        return true;
      }).toList();
    }
    setState(() {
      _sessions = loaded;
      _projects = results[1] as List<ProjectInfo>;
      _loading = false;
    });
  }

  String _sortLabel(AppStrings s, SmSortBy sortBy) {
    return switch (sortBy) {
      SmSortBy.updatedDesc => s.sortUpdated,
      SmSortBy.itemsDesc => s.sortItems,
      SmSortBy.titleAsc => s.isZh ? '标题 A-Z' : 'Title A-Z',
    };
  }

  static String _projectLabelForRaw(ConversationSummary session) {
    if (session.projectName != null && session.projectName!.trim().isNotEmpty) {
      return session.projectName!.trim();
    }
    final cwd = session.cwd?.trim();
    if (cwd != null && cwd.isNotEmpty) {
      final normalized = cwd.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '');
      final base = p.posix.basename(normalized);
      if (base.isNotEmpty) return base;
      return normalized;
    }
    return '';
  }

  static String _globalProjectKey(String label, String? pathOrCwd) {
    final raw = (pathOrCwd ?? '').trim();
    if (raw.isNotEmpty) {
      return raw.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), '').toLowerCase();
    }
    return 'name:${label.trim().toLowerCase()}';
  }

  static String _projectLabelFor(ConversationSummary session, AppStrings s) {
    final raw = _projectLabelForRaw(session);
    return raw.isNotEmpty ? raw : s.uncategorizedProject;
  }

  List<_TreeRow> _buildTreeRows(AppStrings s) {
    final settings = widget.settings;
    final byProvider = <String, List<ConversationSummary>>{};
    for (final session in _sessions) {
      byProvider.putIfAbsent(session.provider, () => []).add(session);
    }

    // Order providers by latest updated timestamp descending inside filtered list
    final providers = byProvider.keys.toList();

    final rows = <_TreeRow>[];
    for (final prov in providers) {
      final provSessions = byProvider[prov]!;
      final byProject = <String, List<ConversationSummary>>{};
      final projectLabels = <String, String>{};
      final projectPaths = <String, String?>{};
      final globalKeys = <String, String>{};

      for (final sess in provSessions) {
        final label = _projectLabelFor(sess, s);
        final key = '$prov::${sess.projectId?.toString() ?? label.toLowerCase()}';
        byProject.putIfAbsent(key, () => []).add(sess);
        projectLabels[key] = label;
        projectPaths[key] ??= sess.cwd;
        globalKeys[key] ??= _globalProjectKey(label, sess.cwd);
      }

      final provExpanded = !_collapsedProviders.contains(prov);
      rows.add(_ProviderTreeRow(
        provider: prov,
        projectCount: byProject.length,
        sessionCount: provSessions.length,
        expanded: provExpanded,
      ));
      if (!provExpanded) continue;

      final parsed = _parseSearchTags(_searchCtrl.text);
      final showingCollapsedOnly = _collapsedOnly || parsed.collapsed;

      final projectEntries = byProject.entries.toList()
        ..sort((a, b) {
          final aPin = settings?.isProjectPinned(a.key) == true ? 1 : 0;
          final bPin = settings?.isProjectPinned(b.key) == true ? 1 : 0;
          if (aPin != bPin) return bPin.compareTo(aPin);
          return 0;
        });

      final visibleProjects = <MapEntry<String, List<ConversationSummary>>>[];
      final hiddenProjects = <MapEntry<String, List<ConversationSummary>>>[];
      for (final entry in projectEntries) {
        if (settings?.isProjectHidden(entry.key) == true) {
          hiddenProjects.add(entry);
        } else {
          visibleProjects.add(entry);
        }
      }

      void appendProjectEntry(
        MapEntry<String, List<ConversationSummary>> entry, {
        required bool isHiddenProject,
      }) {
        final pKey = entry.key;
        final gKey = globalKeys[pKey]!;
        final pSessions = List<ConversationSummary>.from(entry.value)
          ..sort((a, b) {
            final aPin = settings?.isSessionPinned(a.id) == true ? 1 : 0;
            final bPin = settings?.isSessionPinned(b.id) == true ? 1 : 0;
            if (aPin != bPin) return bPin.compareTo(aPin);
            return 0;
          });
        final projExpanded = !_collapsedProjects.contains(pKey);
        rows.add(_ProjectTreeRow(
          provider: prov,
          projectKey: pKey,
          globalProjectKey: gKey,
          projectLabel: projectLabels[pKey]!,
          projectPath: projectPaths[pKey],
          sessionCount: pSessions.length,
          expanded: projExpanded,
          pinned: settings?.isProjectPinned(pKey) ?? false,
          starred: settings?.isProjectStarred(gKey) ?? false,
          hidden: isHiddenProject,
        ));
        if (!projExpanded) return;

        for (final sess in pSessions) {
          final hasSubagents = sess.subagents.isNotEmpty;
          final childSelected = sess.subagents
              .any((sub) => sub.id == widget.selectedConversationId);
          final subsExpanded =
              hasSubagents && (_expandedSubagentParents.contains(sess.id) || childSelected);
          rows.add(_SessionLeafRow(
            session: sess,
            subagentsExpanded: subsExpanded,
          ));
          if (subsExpanded) {
            for (final sub in sess.subagents) {
              rows.add(_SubagentLeafRow(parent: sess, subagent: sub));
            }
          }
        }
      }

      if (showingCollapsedOnly) {
        for (final entry in hiddenProjects) {
          appendProjectEntry(entry, isHiddenProject: true);
        }
      } else {
        for (final entry in visibleProjects) {
          appendProjectEntry(entry, isHiddenProject: false);
        }
        if (hiddenProjects.isNotEmpty) {
          final hiddenSessionCount = hiddenProjects.fold<int>(
              0, (sum, e) => sum + e.value.length);
          final hiddenGroupExpanded = _expandedHiddenProviders.contains(prov) ||
              parsed.query.isNotEmpty;
          rows.add(_HiddenProjectsGroupRow(
            provider: prov,
            projectCount: hiddenProjects.length,
            sessionCount: hiddenSessionCount,
            expanded: hiddenGroupExpanded,
          ));
          if (hiddenGroupExpanded) {
            for (final entry in hiddenProjects) {
              appendProjectEntry(entry, isHiddenProject: true);
            }
          }
        }
      }
    }
    return rows;
  }

  void _collapseAll(List<_TreeRow> rows) {
    setState(() {
      for (final r in rows) {
        if (r is _ProviderTreeRow) _collapsedProviders.add(r.provider);
        if (r is _ProjectTreeRow) _collapsedProjects.add(r.projectKey);
      }
      _expandedSubagentParents.clear();
    });
  }

  void _expandAll() {
    setState(() {
      _collapsedProviders.clear();
      _collapsedProjects.clear();
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final treeRows = _loading ? const <_TreeRow>[] : _buildTreeRows(s);
    final hasAnyCollapsed =
        _collapsedProviders.isNotEmpty || _collapsedProjects.isNotEmpty;

    return Column(
      children: <Widget>[
        // ---- filter band -------------------------------------------------
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Row(
                children: <Widget>[
                  Expanded(
                    child: Row(
                      children: <Widget>[
                        Flexible(
                          child: Text(
                            s.archivedSessions,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.titleMedium,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Gm3Pill(
                          label: s.sessionsCount(_sessions.length),
                          color: cs.onSecondaryContainer,
                          background: cs.secondaryContainer,
                          fontSize: Gm3.fontSizeLabelSmall,
                          padding: const EdgeInsets.symmetric(
                              horizontal: 8, vertical: 2),
                        ),
                      ],
                    ),
                  ),
                  if (_sessions.isNotEmpty) ...<Widget>[
                    const SizedBox(width: 4),
                    Tooltip(
                      message: hasAnyCollapsed ? s.expandAll : s.collapseAll,
                      child: IconButton(
                        icon: Icon(
                          hasAnyCollapsed
                              ? Icons.unfold_more_rounded
                              : Icons.unfold_less_rounded,
                          size: 18,
                          color: cs.onSurfaceVariant,
                        ),
                        visualDensity: VisualDensity.compact,
                        onPressed: hasAnyCollapsed
                            ? _expandAll
                            : () => _collapseAll(treeRows),
                      ),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 10),
              SizedBox(
                height: 36,
                child: TextField(
                  controller: _searchCtrl,
                  onChanged: (_) => _loadSessions(),
                  style: theme.textTheme.bodyMedium,
                  decoration: InputDecoration(
                    hintText: s.filterHint,
                    isDense: true,
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                    prefixIcon:
                        Icon(Icons.search, size: 17, color: cs.onSurfaceVariant),
                    prefixIconConstraints:
                        const BoxConstraints(minWidth: 38, minHeight: 34),
                    suffixIcon: _searchCtrl.text.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.clear, size: 15),
                            visualDensity: VisualDensity.compact,
                            onPressed: () {
                              _searchCtrl.clear();
                              _loadSessions();
                            },
                          )
                        : null,
                  ),
                ),
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: <Widget>[
                  Gm3Select<String>(
                    value: _providerFilter,
                    maxWidth: 154,
                    options: <Gm3Option<String>>[
                      Gm3Option<String>(value: 'all', label: s.allProviders),
                      const Gm3Option<String>(
                          value: 'openai-web', label: 'openai-web'),
                      const Gm3Option<String>(
                          value: 'anthropic-web', label: 'anthropic-web'),
                      const Gm3Option<String>(
                          value: 'deepseek-web', label: 'deepseek-web'),
                      const Gm3Option<String>(
                          value: 'codex-local', label: 'codex-local'),
                      const Gm3Option<String>(
                          value: 'claude-code-local',
                          label: 'claude-code-local'),
                      const Gm3Option<String>(
                          value: 'dsh-local', label: 'dsh-local'),
                      const Gm3Option<String>(
                          value: 'opencode-local', label: 'opencode-local'),
                      const Gm3Option<String>(
                          value: 'zcode-local', label: 'zcode-local'),
                    ],
                    onChanged: (val) {
                      _providerFilter = val;
                      _loadSessions();
                    },
                  ),
                  if (_projects.isNotEmpty)
                    Gm3Select<int?>(
                      value: _projectIdFilter,
                      maxWidth: 140,
                      options: <Gm3Option<int?>>[
                        Gm3Option<int?>(value: null, label: s.allProjects),
                        ..._projects.map(
                          (proj) => Gm3Option<int?>(
                            value: proj.id,
                            label: proj.name,
                          ),
                        ),
                      ],
                      onChanged: (val) {
                        _projectIdFilter = val;
                        _loadSessions();
                      },
                    ),
                  Gm3Select<SmSortBy>(
                    value: _sortBy,
                    maxWidth: 150,
                    options: SmSortBy.values
                        .map((item) => Gm3Option<SmSortBy>(
                            value: item, label: _sortLabel(s, item)))
                        .toList(),
                    onChanged: (val) {
                      _sortBy = val;
                      _loadSessions();
                    },
                  ),
                  FilterChip(
                    label: Text(s.starredOnly),
                    selected: _starredOnly,
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    labelPadding: EdgeInsets.zero,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 5),
                    onSelected: (v) {
                      _starredOnly = v;
                      _loadSessions();
                    },
                  ),
                  FilterChip(
                    label: Text(s.pinnedOnly),
                    selected: _pinnedOnly,
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    labelPadding: EdgeInsets.zero,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 5),
                    onSelected: (v) {
                      _pinnedOnly = v;
                      _loadSessions();
                    },
                  ),
                  FilterChip(
                    label: Text(s.collapsedProjectsOnly),
                    selected: _collapsedOnly,
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    labelPadding: EdgeInsets.zero,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 5),
                    onSelected: (v) {
                      _collapsedOnly = v;
                      _loadSessions();
                    },
                  ),
                  FilterChip(
                    label: Text(s.shrunkOnly),
                    selected: _shrunkOnly,
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    labelPadding: EdgeInsets.zero,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 12, vertical: 5),
                    onSelected: (v) {
                      _shrunkOnly = v;
                      _loadSessions();
                    },
                  ),
                ],
              ),
            ],
          ),
        ),
        const Gm3Hairline(),

        // ---- virtualized 2-level collapsible tree ------------------------
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _sessions.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: <Widget>[
                            Icon(
                              Icons.inbox_outlined,
                              size: 40,
                              color: cs.onSurfaceVariant.withOpacity(0.45),
                            ),
                            const SizedBox(height: 12),
                            Text(s.noSessionsMatch,
                                style: theme.textTheme.titleSmall),
                            const SizedBox(height: 6),
                            Text(
                              s.noSessionsHint,
                              style: theme.textTheme.bodySmall,
                              textAlign: TextAlign.center,
                            ),
                            if (widget.onGoToImport != null) ...<Widget>[
                              const SizedBox(height: 16),
                              FilledButton.tonalIcon(
                                onPressed: widget.onGoToImport,
                                icon: const Icon(Icons.cloud_download_outlined,
                                    size: 17),
                                label: Text(s.goToImport),
                              ),
                            ],
                          ],
                        ),
                      ),
                    )
                  : Scrollbar(
                      controller: _scrollCtrl,
                      child: ListView.builder(
                        controller: _scrollCtrl,
                        padding: const EdgeInsets.fromLTRB(8, 6, 8, 16),
                        itemCount: treeRows.length,
                        itemBuilder: (context, index) {
                          final row = treeRows[index];
                          if (row is _ProviderTreeRow) {
                            return _ProviderTreeHeader(
                              row: row,
                              onToggle: () {
                                setState(() {
                                  if (_collapsedProviders.contains(row.provider)) {
                                    _collapsedProviders.remove(row.provider);
                                  } else {
                                    _collapsedProviders.add(row.provider);
                                  }
                                });
                              },
                            );
                          }
                          if (row is _HiddenProjectsGroupRow) {
                            return _HiddenProjectsGroupHeader(
                              row: row,
                              onToggle: () {
                                setState(() {
                                  if (_expandedHiddenProviders
                                      .contains(row.provider)) {
                                    _expandedHiddenProviders
                                        .remove(row.provider);
                                  } else {
                                    _expandedHiddenProviders.add(row.provider);
                                  }
                                });
                              },
                            );
                          }
                          if (row is _ProjectTreeRow) {
                            return _ProjectTreeHeader(
                              row: row,
                              onToggle: () {
                                setState(() {
                                  if (_collapsedProjects.contains(row.projectKey)) {
                                    _collapsedProjects.remove(row.projectKey);
                                  } else {
                                    _collapsedProjects.add(row.projectKey);
                                  }
                                });
                              },
                              onTogglePin: widget.settings == null
                                  ? null
                                  : () => widget.settings!
                                      .togglePinProject(row.projectKey),
                              onToggleStar: widget.settings == null
                                  ? null
                                  : () => widget.settings!
                                      .toggleStarProject(row.globalProjectKey),
                              onToggleHide: widget.settings == null
                                  ? null
                                  : () => widget.settings!
                                      .toggleHideProject(row.projectKey),
                            );
                          }
                          if (row is _SubagentLeafRow) {
                            return _CompactSessionRow(
                              session: row.subagent,
                              isSubagent: true,
                              isSelected:
                                  widget.selectedConversationId == row.subagent.id,
                              onTap: () => widget.onSelectSession(row.subagent.id),
                            );
                          }
                          final leaf = row as _SessionLeafRow;
                          final session = leaf.session;
                          return _CompactSessionRow(
                            session: session,
                            isSubagent: false,
                            isSelected:
                                widget.selectedConversationId == session.id,
                            isPinned: widget.settings?.isSessionPinned(session.id) ?? false,
                            onTogglePin: widget.settings == null
                                ? null
                                : () => widget.settings!.togglePinSession(session.id),
                            subagentsExpanded: leaf.subagentsExpanded,
                            onToggleSubagents: session.subagents.isEmpty
                                ? null
                                : () {
                                    setState(() {
                                      if (_expandedSubagentParents
                                          .contains(session.id)) {
                                        _expandedSubagentParents.remove(session.id);
                                      } else {
                                        _expandedSubagentParents.add(session.id);
                                      }
                                    });
                                  },
                            onTap: () => widget.onSelectSession(session.id),
                            onToggleStar: widget.cliRunner == null
                                ? null
                                : () async {
                                    final res = await widget.cliRunner!.setStarred(
                                      session.id,
                                      starred: !session.starred,
                                    );
                                    if (res.ok) {
                                      await _loadSessions();
                                      widget.onDataChanged?.call();
                                    }
                                  },
                            onSoftDelete: widget.cliRunner == null
                                ? null
                                : () async {
                                    final res = await widget.cliRunner!
                                        .softDelete(session.id);
                                    if (res.ok) {
                                      await _loadSessions();
                                      widget.onDataChanged?.call();
                                    }
                                  },
                          );
                        },
                      ),
                    ),
        ),
      ],
    );
  }
}

Color _providerColorFor(String provider) {
  switch (provider) {
    case 'openai-web':
      return const Color(0xFF137333);
    case 'anthropic-web':
    case 'claude-code-local':
      return const Color(0xFFB06000);
    case 'deepseek-web':
      return const Color(0xFF1967D2);
    case 'codex-local':
      return const Color(0xFF1A73E8);
    case 'dsh-local':
      return const Color(0xFF7627BB);
    case 'opencode-local':
      return const Color(0xFF0E7490);
    case 'zcode-local':
      return const Color(0xFF6D28D9);
    default:
      return const Color(0xFF5F6368);
  }
}

class _ProviderTreeHeader extends StatelessWidget {
  final _ProviderTreeRow row;
  final VoidCallback onToggle;

  const _ProviderTreeHeader({
    required this.row,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final badgeColor =
        Gm3.adaptiveTint(_providerColorFor(row.provider), theme.brightness);
    final isDark = theme.brightness == Brightness.dark;

    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 2),
      child: Material(
        color: cs.surfaceContainerLow,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: onToggle,
          child: SizedBox(
            height: 32,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(
                children: <Widget>[
                  Icon(
                    row.expanded
                        ? Icons.expand_more_rounded
                        : Icons.chevron_right_rounded,
                    size: 18,
                    color: cs.onSurfaceVariant,
                  ),
                  const SizedBox(width: 4),
                  Gm3Pill(
                    label: row.provider,
                    color: badgeColor,
                    background: badgeColor.withOpacity(isDark ? 0.22 : 0.12),
                    fontSize: Gm3.fontSizeLabelSmall,
                    padding:
                        const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      '${s.projectCountBadge(row.projectCount)} · ${s.sessionsCount(row.sessionCount)}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.right,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

const Color _kMarkerYellow = Color(0xFFF9AB00);

class _HoverPreviewWrapper extends StatefulWidget {
  final Widget Function(BuildContext context, bool isHovered) builder;
  final Widget Function(BuildContext context) overlayBuilder;

  const _HoverPreviewWrapper({
    required this.builder,
    required this.overlayBuilder,
  });

  @override
  State<_HoverPreviewWrapper> createState() => _HoverPreviewWrapperState();
}

class _HoverPreviewWrapperState extends State<_HoverPreviewWrapper> {
  Timer? _showTimer;
  Timer? _hideTimer;
  OverlayEntry? _entry;
  bool _rowHovered = false;
  bool _cardHovered = false;

  @override
  void dispose() {
    _cancelTimers();
    _removeOverlay();
    super.dispose();
  }

  @override
  void deactivate() {
    _cancelTimers();
    _removeOverlay();
    super.deactivate();
  }

  void _cancelTimers() {
    _showTimer?.cancel();
    _showTimer = null;
    _hideTimer?.cancel();
    _hideTimer = null;
  }

  void _removeOverlay() {
    _entry?.remove();
    _entry = null;
    _cardHovered = false;
  }

  void _scheduleHide() {
    _hideTimer?.cancel();
    _hideTimer = Timer(const Duration(milliseconds: 160), () {
      if (!_rowHovered && !_cardHovered) {
        _removeOverlay();
      }
    });
  }

  void _showOverlay() {
    _showTimer = null;
    if (!mounted || !_rowHovered || _entry != null) return;
    final box = context.findRenderObject() as RenderBox?;
    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    if (box == null || !box.hasSize || overlay == null) return;

    final topLeft = box.localToGlobal(Offset.zero);
    final rowSize = box.size;
    final screen = MediaQuery.of(context).size;
    const cardMaxWidth = 340.0;
    final left = math.max(
      8.0,
      math.min(topLeft.dx + 16.0, screen.width - cardMaxWidth - 12.0),
    );
    final showAbove = topLeft.dy > screen.height * 0.55;

    _entry = OverlayEntry(
      builder: (ctx) {
        final theme = Theme.of(ctx);
        final surfaces = Gm3Surfaces.of(ctx);
        return Positioned(
          left: left,
          top: showAbove ? null : topLeft.dy + rowSize.height + 2,
          bottom: showAbove ? (screen.height - topLeft.dy + 2) : null,
          child: MouseRegion(
            onEnter: (_) {
              _cardHovered = true;
              _hideTimer?.cancel();
            },
            onExit: (_) {
              _cardHovered = false;
              _scheduleHide();
            },
            child: Material(
              color: Colors.transparent,
              child: Container(
                constraints: const BoxConstraints(maxWidth: cardMaxWidth),
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: surfaces.card,
                  borderRadius: BorderRadius.circular(Gm3.radiusMd),
                  border: Border.all(color: surfaces.hairline.withOpacity(0.75)),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withOpacity(
                        theme.brightness == Brightness.dark ? 0.35 : 0.12,
                      ),
                      blurRadius: 14,
                      offset: const Offset(0, 4),
                    ),
                  ],
                ),
                child: widget.overlayBuilder(ctx),
              ),
            ),
          ),
        );
      },
    );
    overlay.insert(_entry!);
  }

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) {
        if (!_rowHovered) {
          setState(() => _rowHovered = true);
        }
        _hideTimer?.cancel();
        if (_entry == null && _showTimer == null) {
          _showTimer = Timer(const Duration(milliseconds: 1500), _showOverlay);
        }
      },
      onExit: (_) {
        if (_rowHovered) {
          setState(() => _rowHovered = false);
        }
        _showTimer?.cancel();
        _showTimer = null;
        _scheduleHide();
      },
      child: widget.builder(context, _rowHovered),
    );
  }
}

class _HiddenProjectsGroupHeader extends StatelessWidget {
  final _HiddenProjectsGroupRow row;
  final VoidCallback onToggle;

  const _HiddenProjectsGroupHeader({
    required this.row,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Padding(
      padding: const EdgeInsets.only(left: 10, right: 2, top: 2, bottom: 2),
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onToggle,
        child: SizedBox(
          height: 28,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6),
            child: Row(
              children: <Widget>[
                Icon(
                  row.expanded
                      ? Icons.keyboard_arrow_down_rounded
                      : Icons.keyboard_arrow_right_rounded,
                  size: 16,
                  color: cs.onSurfaceVariant,
                ),
                const SizedBox(width: 4),
                Icon(
                  Icons.visibility_off_outlined,
                  size: 13.5,
                  color: cs.onSurfaceVariant,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    '${s.collapsedProjectsGroup} (${row.projectCount})',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodySmall?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                ),
                Text(
                  '${row.sessionCount}',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ProjectTreeHeader extends StatefulWidget {
  final _ProjectTreeRow row;
  final VoidCallback onToggle;
  final VoidCallback? onTogglePin;
  final VoidCallback? onToggleStar;
  final VoidCallback? onToggleHide;

  const _ProjectTreeHeader({
    required this.row,
    required this.onToggle,
    this.onTogglePin,
    this.onToggleStar,
    this.onToggleHide,
  });

  @override
  State<_ProjectTreeHeader> createState() => _ProjectTreeHeaderState();
}

class _ProjectTreeHeaderState extends State<_ProjectTreeHeader> {
  bool _menuOpen = false;

  List<PopupMenuEntry<String>> _buildMenuItems(AppStrings s) {
    return [
      if (widget.onTogglePin != null)
        PopupMenuItem(
          value: 'pin',
          child: Text(widget.row.pinned ? s.unpinInProvider : s.pinInProvider),
        ),
      if (widget.onToggleStar != null)
        PopupMenuItem(
          value: 'star',
          child: Text(widget.row.starred
              ? s.unstarProjectGlobal
              : s.starProjectGlobal),
        ),
      if (widget.onToggleHide != null)
        PopupMenuItem(
          value: 'hide',
          child: Text(widget.row.hidden
              ? s.unhideProjectInProvider
              : s.hideProjectInProvider),
        ),
    ];
  }

  void _handleMenuAction(String? v) {
    if (v == 'pin') widget.onTogglePin?.call();
    if (v == 'star') widget.onToggleStar?.call();
    if (v == 'hide') widget.onToggleHide?.call();
  }

  Future<void> _showContextMenu(BuildContext context, Offset globalPos) async {
    final s = AppStringsScope.of(context);
    final items = _buildMenuItems(s);
    if (items.isEmpty) return;
    setState(() => _menuOpen = true);
    final overlay =
        Overlay.of(context).context.findRenderObject() as RenderBox;
    final selected = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(
        globalPos & const Size(1, 1),
        Offset.zero & overlay.size,
      ),
      items: items,
    );
    if (mounted) setState(() => _menuOpen = false);
    _handleMenuAction(selected);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final row = widget.row;
    final pathLabel = row.projectPath ?? row.projectLabel;

    return _HoverPreviewWrapper(
      overlayBuilder: (ctx) {
        final t = Theme.of(ctx);
        final c = t.colorScheme;
        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              row.projectLabel,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: t.textTheme.labelLarge?.copyWith(
                fontWeight: FontWeight.w700,
                color: c.onSurface,
              ),
            ),
            if (pathLabel != row.projectLabel) ...[
              const SizedBox(height: 2),
              Text(
                pathLabel,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: t.textTheme.bodySmall?.copyWith(
                  color: c.onSurfaceVariant,
                ),
              ),
            ],
          ],
        );
      },
      builder: (context, isHovered) {
        final showActions = isHovered || _menuOpen;
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onSecondaryTapUp: (details) =>
              _showContextMenu(context, details.globalPosition),
          child: InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: widget.onToggle,
            child: SizedBox(
              height: 30,
              child: Padding(
                padding: EdgeInsets.only(left: row.hidden ? 26 : 16, right: 4),
                child: Row(
                  children: <Widget>[
                    Icon(
                      row.expanded
                          ? Icons.keyboard_arrow_down_rounded
                          : Icons.keyboard_arrow_right_rounded,
                      size: 16,
                      color: cs.onSurfaceVariant,
                    ),
                    const SizedBox(width: 4),
                    Icon(
                      Icons.folder_outlined,
                      size: 14,
                      color: cs.primary.withOpacity(0.85),
                    ),
                    const SizedBox(width: 6),
                    if (row.pinned)
                      const Padding(
                        padding: EdgeInsets.only(right: 4),
                        child: Icon(
                          Icons.push_pin_rounded,
                          size: 13,
                          color: _kMarkerYellow,
                        ),
                      ),
                    if (row.starred)
                      const Padding(
                        padding: EdgeInsets.only(right: 4),
                        child: Icon(
                          Icons.star_rounded,
                          size: 14,
                          color: _kMarkerYellow,
                        ),
                      ),
                    Expanded(
                      child: Text(
                        row.projectLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          fontSize: 13.5,
                          fontWeight: FontWeight.w600,
                          color: cs.onSurface,
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    Text(
                      '${row.sessionCount}',
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: cs.onSurfaceVariant,
                      ),
                    ),
                    if (showActions) ...<Widget>[
                      const SizedBox(width: 2),
                      if (widget.onTogglePin != null)
                        Tooltip(
                          message:
                              row.pinned ? s.unpinInProvider : s.pinInProvider,
                          child: InkWell(
                            borderRadius: BorderRadius.circular(10),
                            onTap: widget.onTogglePin,
                            child: Padding(
                              padding: const EdgeInsets.all(3),
                              child: Icon(
                                row.pinned
                                    ? Icons.push_pin_rounded
                                    : Icons.push_pin_outlined,
                                size: 13.5,
                                color: row.pinned
                                    ? _kMarkerYellow
                                    : cs.onSurfaceVariant.withOpacity(0.75),
                              ),
                            ),
                          ),
                        ),
                      if (widget.onToggleStar != null)
                        Tooltip(
                          message: row.starred
                              ? s.unstarProjectGlobal
                              : s.starProjectGlobal,
                          child: InkWell(
                            borderRadius: BorderRadius.circular(10),
                            onTap: widget.onToggleStar,
                            child: Padding(
                              padding: const EdgeInsets.all(3),
                              child: Icon(
                                row.starred
                                    ? Icons.star_rounded
                                    : Icons.star_border_rounded,
                                size: 14.5,
                                color: row.starred
                                    ? _kMarkerYellow
                                    : cs.onSurfaceVariant.withOpacity(0.75),
                              ),
                            ),
                          ),
                        ),
                      if (_buildMenuItems(s).isNotEmpty)
                        SizedBox(
                          width: 22,
                          height: 22,
                          child: PopupMenuButton<String>(
                            padding: EdgeInsets.zero,
                            iconSize: 14,
                            tooltip: s.moreActions,
                            icon: Icon(
                              Icons.more_horiz,
                              size: 14,
                              color: cs.onSurfaceVariant.withOpacity(0.8),
                            ),
                            onOpened: () => setState(() => _menuOpen = true),
                            onCanceled: () => setState(() => _menuOpen = false),
                            onSelected: (v) {
                              setState(() => _menuOpen = false);
                              _handleMenuAction(v);
                            },
                            itemBuilder: (_) => _buildMenuItems(s),
                          ),
                        ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _CompactSessionRow extends StatefulWidget {
  final ConversationSummary session;
  final bool isSubagent;
  final bool isSelected;
  final bool isPinned;
  final bool subagentsExpanded;
  final VoidCallback? onToggleSubagents;
  final VoidCallback onTap;
  final VoidCallback? onTogglePin;
  final VoidCallback? onToggleStar;
  final VoidCallback? onSoftDelete;

  const _CompactSessionRow({
    required this.session,
    required this.isSubagent,
    required this.isSelected,
    this.isPinned = false,
    this.subagentsExpanded = false,
    this.onToggleSubagents,
    required this.onTap,
    this.onTogglePin,
    this.onToggleStar,
    this.onSoftDelete,
  });

  @override
  State<_CompactSessionRow> createState() => _CompactSessionRowState();
}

class _CompactSessionRowState extends State<_CompactSessionRow> {
  bool _menuOpen = false;

  List<PopupMenuEntry<String>> _buildMenuItems(AppStrings s) {
    final session = widget.session;
    return [
      if (widget.onTogglePin != null)
        PopupMenuItem(
          value: 'pin',
          child: Text(widget.isPinned ? s.unpinInProvider : s.pinInProvider),
        ),
      if (widget.onToggleStar != null)
        PopupMenuItem(
          value: 'star',
          child: Text(session.starred ? s.unstarAction : s.starAction),
        ),
      if (widget.onSoftDelete != null)
        PopupMenuItem(
          value: 'delete',
          child: Text(s.deleteAction),
        ),
    ];
  }

  void _handleMenuAction(String? v) {
    if (v == 'pin') widget.onTogglePin?.call();
    if (v == 'star') widget.onToggleStar?.call();
    if (v == 'delete') widget.onSoftDelete?.call();
  }

  Future<void> _showContextMenu(BuildContext context, Offset globalPos) async {
    if (widget.isSubagent) return;
    final s = AppStringsScope.of(context);
    final items = _buildMenuItems(s);
    if (items.isEmpty) return;
    setState(() => _menuOpen = true);
    final overlay =
        Overlay.of(context).context.findRenderObject() as RenderBox;
    final selected = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(
        globalPos & const Size(1, 1),
        Offset.zero & overlay.size,
      ),
      items: items,
    );
    if (mounted) setState(() => _menuOpen = false);
    _handleMenuAction(selected);
  }

  Widget _buildHoverPreviewContent(BuildContext context, AppStrings s) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final session = widget.session;
    final updatedStr = session.updatedAt != null
        ? DateFormat('yyyy-MM-dd HH:mm')
            .format(DateTime.fromMillisecondsSinceEpoch(session.updatedAt!))
        : '-';
    final summaryText = (session.summary ?? '').trim();

    return SizedBox(
      width: 310,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            session.title,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.labelLarge?.copyWith(
              fontWeight: FontWeight.w700,
              fontSize: 13,
              color: cs.onSurface,
            ),
          ),
          if (summaryText.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              summaryText,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                fontSize: 12,
                color: cs.onSurface.withOpacity(0.86),
              ),
            ),
          ],
          const SizedBox(height: 6),
          Text(
            '${session.provider}'
            '${session.defaultModel != null ? ' · ${session.defaultModel}' : ''}'
            '${session.cwd != null ? '\n${session.cwd}' : ''}'
            '\n${s.itemsLabel(session.itemCount)} · ${session.charCount} chars'
            '${session.revisionCount > 1 ? ' · Rev x${session.revisionCount}' : ''}'
            '${session.subagents.isNotEmpty ? ' · ${s.subagentsBadge(session.subagents.length)}' : ''}'
            '\nUpdated: $updatedStr',
            maxLines: 5,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.bodySmall?.copyWith(
              fontSize: 11.5,
              height: 1.4,
              color: cs.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final session = widget.session;
    final isSubagent = widget.isSubagent;
    final isSelected = widget.isSelected;
    final isPinned = widget.isPinned;
    final shrunkColor =
        Gm3.adaptiveTint(const Color(0xFFB06000), theme.brightness);
    final subColor =
        Gm3.adaptiveTint(const Color(0xFF7627BB), theme.brightness);

    final updatedShort = session.updatedAt != null
        ? DateFormat('MM-dd HH:mm')
            .format(DateTime.fromMillisecondsSinceEpoch(session.updatedAt!))
        : '';

    return _HoverPreviewWrapper(
      overlayBuilder: (ctx) => _buildHoverPreviewContent(ctx, AppStringsScope.of(ctx)),
      builder: (context, isHovered) {
        final showActions = !isSubagent && (isHovered || _menuOpen);
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onSecondaryTapUp: isSubagent
              ? null
              : (details) => _showContextMenu(context, details.globalPosition),
          child: Padding(
            padding: EdgeInsets.only(
                left: isSubagent ? 42 : 26, right: 2, top: 1, bottom: 1),
            child: Material(
              color: isSelected
                  ? cs.secondaryContainer.withOpacity(0.75)
                  : Colors.transparent,
              borderRadius: BorderRadius.circular(6),
              child: InkWell(
                borderRadius: BorderRadius.circular(6),
                onTap: widget.onTap,
                child: SizedBox(
                  height: isSubagent ? 30 : 34,
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final showExtraBadges = constraints.maxWidth >= 340;
                      final showDate = constraints.maxWidth >= 310;
                      return Row(
                        children: <Widget>[
                          Container(
                            width: 3,
                            height: 16,
                            margin: const EdgeInsets.only(right: 6),
                            decoration: BoxDecoration(
                              color:
                                  isSelected ? cs.primary : Colors.transparent,
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                          if (isSubagent) ...<Widget>[
                            Icon(
                              Icons.subdirectory_arrow_right_rounded,
                              size: 13,
                              color: subColor,
                            ),
                            const SizedBox(width: 3),
                            if (session.subagentName != null &&
                                session.subagentName!.isNotEmpty) ...<Widget>[
                              Gm3Pill(
                                label: session.subagentName!,
                                color: subColor,
                                background: subColor.withOpacity(0.10),
                                fontSize: 10,
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 5, vertical: 0),
                              ),
                              const SizedBox(width: 4),
                            ],
                          ] else ...<Widget>[
                            if (isPinned)
                              const Padding(
                                padding: EdgeInsets.only(right: 4),
                                child: Icon(
                                  Icons.push_pin_rounded,
                                  size: 13,
                                  color: _kMarkerYellow,
                                ),
                              ),
                            if (session.starred)
                              const Padding(
                                padding: EdgeInsets.only(right: 5),
                                child: Icon(
                                  Icons.star_rounded,
                                  size: 14,
                                  color: _kMarkerYellow,
                                ),
                              ),
                          ],
                          Expanded(
                            child: Text(
                              session.title,
                              maxLines: 1,
                              softWrap: false,
                              overflow: TextOverflow.ellipsis,
                              style: theme.textTheme.bodyMedium?.copyWith(
                                fontSize: isSubagent ? 13 : 14,
                                fontWeight: isSelected
                                    ? FontWeight.w600
                                    : FontWeight.w400,
                                color: isSelected
                                    ? cs.onSecondaryContainer
                                    : cs.onSurface,
                              ),
                            ),
                          ),
                          if (!isSubagent &&
                              session.subagents.isNotEmpty) ...<Widget>[
                            const SizedBox(width: 4),
                            InkWell(
                              borderRadius: BorderRadius.circular(8),
                              onTap: widget.onToggleSubagents,
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 5, vertical: 1),
                                decoration: BoxDecoration(
                                  color: subColor.withOpacity(0.12),
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: <Widget>[
                                    Icon(
                                      widget.subagentsExpanded
                                          ? Icons.expand_more_rounded
                                          : Icons.chevron_right_rounded,
                                      size: 12,
                                      color: subColor,
                                    ),
                                    Text(
                                      s.subagentsBadge(session.subagents.length),
                                      style: TextStyle(
                                        fontSize: 10,
                                        fontWeight: FontWeight.w600,
                                        color: subColor,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ],
                          if (session.isShrunk && showExtraBadges) ...<Widget>[
                            const SizedBox(width: 4),
                            Gm3Pill(
                              label: s.shrunkBadge,
                              color: shrunkColor,
                              background: shrunkColor.withOpacity(0.12),
                              fontSize: 9.5,
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 4, vertical: 0),
                            ),
                          ] else if (session.isShrunk) ...<Widget>[
                            const SizedBox(width: 4),
                            Container(
                              width: 6,
                              height: 6,
                              decoration: BoxDecoration(
                                color: shrunkColor,
                                shape: BoxShape.circle,
                              ),
                            ),
                          ],
                          if (session.revisionCount > 1 &&
                              showExtraBadges) ...<Widget>[
                            const SizedBox(width: 4),
                            Text(
                              'v${session.revisionCount}',
                              style: theme.textTheme.labelSmall?.copyWith(
                                fontSize: 10,
                                color: cs.primary,
                              ),
                            ),
                          ],
                          const SizedBox(width: 6),
                          Text(
                            '${session.itemCount}',
                            style: theme.textTheme.labelSmall?.copyWith(
                              fontSize: 10.5,
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                          if (updatedShort.isNotEmpty &&
                              showDate &&
                              !showActions) ...<Widget>[
                            const SizedBox(width: 6),
                            Text(
                              updatedShort,
                              style: theme.textTheme.labelSmall?.copyWith(
                                fontSize: 10.5,
                                color: cs.onSurfaceVariant.withOpacity(0.75),
                              ),
                            ),
                          ],
                          if (showActions) ...<Widget>[
                            const SizedBox(width: 2),
                            if (widget.onTogglePin != null)
                              Tooltip(
                                message: isPinned
                                    ? s.unpinInProvider
                                    : s.pinInProvider,
                                child: InkWell(
                                  borderRadius: BorderRadius.circular(10),
                                  onTap: widget.onTogglePin,
                                  child: Padding(
                                    padding: const EdgeInsets.all(3),
                                    child: Icon(
                                      isPinned
                                          ? Icons.push_pin_rounded
                                          : Icons.push_pin_outlined,
                                      size: 13.5,
                                      color: isPinned
                                          ? _kMarkerYellow
                                          : cs.onSurfaceVariant
                                              .withOpacity(0.75),
                                    ),
                                  ),
                                ),
                              ),
                            if (widget.onToggleStar != null)
                              Tooltip(
                                message: session.starred
                                    ? s.unstarAction
                                    : s.starAction,
                                child: InkWell(
                                  borderRadius: BorderRadius.circular(10),
                                  onTap: widget.onToggleStar,
                                  child: Padding(
                                    padding: const EdgeInsets.all(3),
                                    child: Icon(
                                      session.starred
                                          ? Icons.star_rounded
                                          : Icons.star_border_rounded,
                                      size: 14.5,
                                      color: session.starred
                                          ? _kMarkerYellow
                                          : cs.onSurfaceVariant
                                              .withOpacity(0.75),
                                    ),
                                  ),
                                ),
                              ),
                            if (_buildMenuItems(s).isNotEmpty)
                              SizedBox(
                                width: 22,
                                height: 22,
                                child: PopupMenuButton<String>(
                                  padding: EdgeInsets.zero,
                                  iconSize: 14,
                                  tooltip: s.moreActions,
                                  icon: Icon(
                                    Icons.more_horiz,
                                    size: 14,
                                    color:
                                        cs.onSurfaceVariant.withOpacity(0.8),
                                  ),
                                  onOpened: () =>
                                      setState(() => _menuOpen = true),
                                  onCanceled: () =>
                                      setState(() => _menuOpen = false),
                                  onSelected: (v) {
                                    setState(() => _menuOpen = false);
                                    _handleMenuAction(v);
                                  },
                                  itemBuilder: (_) => _buildMenuItems(s),
                                ),
                              ),
                          ],
                        ],
                      );
                    },
                  ),
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}
