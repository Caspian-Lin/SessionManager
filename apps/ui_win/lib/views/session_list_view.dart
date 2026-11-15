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
  bool _shrunkOnly = false;
  SmSortBy _sortBy = SmSortBy.updatedDesc;
  final TextEditingController _searchCtrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();

  final Set<String> _collapsedProviders = <String>{};
  final Set<String> _collapsedProjects = <String>{};
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
      if (_starredOnly) {
        _loadSessions();
      } else {
        setState(() {});
      }
    }
  }

  Future<void> _loadSessions() async {
    setState(() => _loading = true);
    final starredProjs = widget.settings?.starredProjects ?? const <String>{};
    final needInMemoryStarFilter = _starredOnly && starredProjs.isNotEmpty;
    final results = await Future.wait([
      widget.store.getConversations(
        provider: _providerFilter == 'all' ? null : _providerFilter,
        projectId: _projectIdFilter,
        starredOnly: _starredOnly && !needInMemoryStarFilter,
        shrunkOnly: _shrunkOnly,
        searchFilter: _searchCtrl.text,
        sortBy: _sortBy,
      ),
      widget.store.getProjects(),
    ]);
    if (!mounted) return;
    var loaded = results[0] as List<ConversationSummary>;
    if (needInMemoryStarFilter) {
      loaded = loaded.where((s) {
        if (s.starred) return true;
        final label = _projectLabelForRaw(s);
        final gKey = _globalProjectKey(label, s.cwd);
        return starredProjs.contains(gKey);
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

      final projectEntries = byProject.entries.toList()
        ..sort((a, b) {
          final aPin = settings?.isProjectPinned(a.key) == true ? 1 : 0;
          final bPin = settings?.isProjectPinned(b.key) == true ? 1 : 0;
          if (aPin != bPin) return bPin.compareTo(aPin);
          final aStar =
              settings?.isProjectStarred(globalKeys[a.key]!) == true ? 1 : 0;
          final bStar =
              settings?.isProjectStarred(globalKeys[b.key]!) == true ? 1 : 0;
          if (aStar != bStar) return bStar.compareTo(aStar);
          return 0;
        });

      for (final entry in projectEntries) {
        final pKey = entry.key;
        final gKey = globalKeys[pKey]!;
        final pSessions = List<ConversationSummary>.from(entry.value)
          ..sort((a, b) {
            final aPin = settings?.isSessionPinned(a.id) == true ? 1 : 0;
            final bPin = settings?.isSessionPinned(b.id) == true ? 1 : 0;
            if (aPin != bPin) return bPin.compareTo(aPin);
            final aStar = a.starred ? 1 : 0;
            final bStar = b.starred ? 1 : 0;
            if (aStar != bStar) return bStar.compareTo(aStar);
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
        ));
        if (!projExpanded) continue;

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
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Row(
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
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  ),
                  const Spacer(),
                  if (_sessions.isNotEmpty)
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

class _ProjectTreeHeader extends StatelessWidget {
  final _ProjectTreeRow row;
  final VoidCallback onToggle;
  final VoidCallback? onTogglePin;
  final VoidCallback? onToggleStar;

  const _ProjectTreeHeader({
    required this.row,
    required this.onToggle,
    this.onTogglePin,
    this.onToggleStar,
  });

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final pathLabel = row.projectPath ?? row.projectLabel;

    return Tooltip(
      waitDuration: const Duration(seconds: 2),
      decoration: BoxDecoration(
        color: surfaces.card,
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
        border: Border.all(color: surfaces.hairline.withOpacity(0.75)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(theme.brightness == Brightness.dark ? 0.35 : 0.10),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      richMessage: WidgetSpan(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 320),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                row.projectLabel,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelLarge?.copyWith(
                  fontWeight: FontWeight.w700,
                  color: cs.onSurface,
                ),
              ),
              if (pathLabel != row.projectLabel) ...[
                const SizedBox(height: 2),
                Text(
                  pathLabel,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: onToggle,
        child: SizedBox(
          height: 30,
          child: Padding(
            padding: const EdgeInsets.only(left: 16, right: 6),
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
                if (onTogglePin != null)
                  Tooltip(
                    message: row.pinned ? s.unpinInProvider : s.pinInProvider,
                    child: InkWell(
                      borderRadius: BorderRadius.circular(10),
                      onTap: onTogglePin,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 2),
                        child: Icon(
                          row.pinned ? Icons.push_pin_rounded : Icons.push_pin_outlined,
                          size: 13,
                          color: row.pinned
                              ? cs.primary
                              : cs.onSurfaceVariant.withOpacity(0.45),
                        ),
                      ),
                    ),
                  ),
                if (onToggleStar != null)
                  Tooltip(
                    message: row.starred ? s.unstarProjectGlobal : s.starProjectGlobal,
                    child: InkWell(
                      borderRadius: BorderRadius.circular(10),
                      onTap: onToggleStar,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 2),
                        child: Icon(
                          row.starred ? Icons.star_rounded : Icons.star_border_rounded,
                          size: 14,
                          color: row.starred
                              ? const Color(0xFFF9AB00)
                              : cs.onSurfaceVariant.withOpacity(0.45),
                        ),
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
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CompactSessionRow extends StatelessWidget {
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

  InlineSpan _buildHoverTooltipSpan(BuildContext context, AppStrings s) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final updatedStr = session.updatedAt != null
        ? DateFormat('yyyy-MM-dd HH:mm')
            .format(DateTime.fromMillisecondsSinceEpoch(session.updatedAt!))
        : '-';
    final summaryText = (session.summary ?? '').trim();

    return WidgetSpan(
      child: SizedBox(
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
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final shrunkColor =
        Gm3.adaptiveTint(const Color(0xFFB06000), theme.brightness);
    final subColor =
        Gm3.adaptiveTint(const Color(0xFF7627BB), theme.brightness);

    final updatedShort = session.updatedAt != null
        ? DateFormat('MM-dd HH:mm')
            .format(DateTime.fromMillisecondsSinceEpoch(session.updatedAt!))
        : '';

    return Tooltip(
      richMessage: _buildHoverTooltipSpan(context, s),
      waitDuration: const Duration(seconds: 2),
      preferBelow: false,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: surfaces.card,
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
        border: Border.all(color: surfaces.hairline.withOpacity(0.75)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withOpacity(theme.brightness == Brightness.dark ? 0.35 : 0.10),
            blurRadius: 12,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Padding(
        padding: EdgeInsets.only(left: isSubagent ? 42 : 26, right: 2, top: 1, bottom: 1),
        child: Material(
          color: isSelected
              ? cs.secondaryContainer.withOpacity(0.75)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(6),
          child: InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: onTap,
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
                      color: isSelected ? cs.primary : Colors.transparent,
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
                      InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: onTogglePin,
                        child: Padding(
                          padding: const EdgeInsets.only(right: 4),
                          child: Icon(
                            Icons.push_pin_rounded,
                            size: 13,
                            color: cs.primary,
                          ),
                        ),
                      ),
                    if (onToggleStar != null || session.starred)
                      InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: onToggleStar,
                        child: Padding(
                          padding: const EdgeInsets.only(right: 5),
                          child: Icon(
                            session.starred
                                ? Icons.star_rounded
                                : Icons.star_border_rounded,
                            size: 14,
                            color: session.starred
                                ? const Color(0xFFF9AB00)
                                : cs.onSurfaceVariant.withOpacity(0.45),
                          ),
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
                        fontWeight:
                            isSelected ? FontWeight.w600 : FontWeight.w400,
                        color: isSelected ? cs.onSecondaryContainer : cs.onSurface,
                      ),
                    ),
                  ),
                  if (!isSubagent && session.subagents.isNotEmpty) ...<Widget>[
                    const SizedBox(width: 4),
                    InkWell(
                      borderRadius: BorderRadius.circular(8),
                      onTap: onToggleSubagents,
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
                              subagentsExpanded
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
                      padding:
                          const EdgeInsets.symmetric(horizontal: 4, vertical: 0),
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
                  if (session.revisionCount > 1 && showExtraBadges) ...<Widget>[
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
                  if (updatedShort.isNotEmpty && showDate) ...<Widget>[
                    const SizedBox(width: 6),
                    Text(
                      updatedShort,
                      style: theme.textTheme.labelSmall?.copyWith(
                        fontSize: 10.5,
                        color: cs.onSurfaceVariant.withOpacity(0.75),
                      ),
                    ),
                  ],
                  if (!isSubagent && onSoftDelete != null)
                    SizedBox(
                      width: 24,
                      height: 24,
                      child: PopupMenuButton<String>(
                        padding: EdgeInsets.zero,
                        iconSize: 14,
                        icon: Icon(Icons.more_horiz,
                            size: 14,
                            color: cs.onSurfaceVariant.withOpacity(0.6)),
                        onSelected: (v) {
                          if (v == 'pin') onTogglePin?.call();
                          if (v == 'star') onToggleStar?.call();
                          if (v == 'delete') onSoftDelete?.call();
                        },
                        itemBuilder: (_) => [
                          if (onTogglePin != null)
                            PopupMenuItem(
                              value: 'pin',
                              child: Text(isPinned
                                  ? s.unpinInProvider
                                  : s.pinInProvider),
                            ),
                          PopupMenuItem(
                            value: 'star',
                            child: Text(
                                session.starred ? s.unstarAction : s.starAction),
                          ),
                          PopupMenuItem(
                            value: 'delete',
                            child: Text(s.deleteAction),
                          ),
                        ],
                      ),
                    ),
                ],
                  );
                },
              ),
            ),
          ),
        ),
      ),
    );
  }
}
