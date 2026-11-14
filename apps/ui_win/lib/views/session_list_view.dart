import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../data/archive_direct_store.dart';
import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';

class SessionListView extends StatefulWidget {
  final ArchiveDirectStore store;
  final ValueNotifier<int> refreshTick;
  final int? selectedConversationId;
  final ValueChanged<int> onSelectSession;
  final VoidCallback? onGoToImport;

  const SessionListView({
    super.key,
    required this.store,
    required this.refreshTick,
    this.selectedConversationId,
    required this.onSelectSession,
    this.onGoToImport,
  });

  @override
  State<SessionListView> createState() => _SessionListViewState();
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

  @override
  void initState() {
    super.initState();
    widget.refreshTick.addListener(_loadSessions);
    _loadSessions();
  }

  @override
  void dispose() {
    widget.refreshTick.removeListener(_loadSessions);
    _searchCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadSessions() async {
    setState(() => _loading = true);
    final results = await Future.wait([
      widget.store.getConversations(
        provider: _providerFilter == 'all' ? null : _providerFilter,
        projectId: _projectIdFilter,
        starredOnly: _starredOnly,
        shrunkOnly: _shrunkOnly,
        searchFilter: _searchCtrl.text,
        sortBy: _sortBy,
      ),
      widget.store.getProjects(),
    ]);
    if (!mounted) return;
    setState(() {
      _sessions = results[0] as List<ConversationSummary>;
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

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Column(
      children: [
        // Clean Material 3 Filter Header
        Container(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
          decoration: BoxDecoration(
            color: cs.surface,
            border: Border(bottom: BorderSide(color: theme.dividerColor)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(
                      s.archivedSessions,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
                    decoration: BoxDecoration(
                      color: cs.secondaryContainer,
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: Text(
                      s.sessionsCount(_sessions.length),
                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: cs.onSecondaryContainer),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _searchCtrl,
                onChanged: (_) => _loadSessions(),
                decoration: InputDecoration(
                  hintText: s.filterHint,
                  prefixIcon: const Icon(Icons.search, size: 19),
                  suffixIcon: _searchCtrl.text.isNotEmpty
                      ? IconButton(
                          icon: const Icon(Icons.clear, size: 17),
                          onPressed: () {
                            _searchCtrl.clear();
                            _loadSessions();
                          },
                        )
                      : null,
                ),
              ),
              const SizedBox(height: 10),
              Wrap(
                spacing: 8,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  DropdownButton<String>(
                    value: _providerFilter,
                    isDense: true,
                    underline: const SizedBox.shrink(),
                    items: [
                      DropdownMenuItem(value: 'all', child: Text(s.allProviders)),
                      const DropdownMenuItem(value: 'openai-web', child: Text('openai-web')),
                      const DropdownMenuItem(value: 'anthropic-web', child: Text('anthropic-web')),
                      const DropdownMenuItem(value: 'deepseek-web', child: Text('deepseek-web')),
                      const DropdownMenuItem(value: 'codex-local', child: Text('codex-local')),
                      const DropdownMenuItem(value: 'claude-code-local', child: Text('claude-code-local')),
                      const DropdownMenuItem(value: 'dsh-local', child: Text('dsh-local')),
                    ],
                    onChanged: (val) {
                      if (val != null) {
                        _providerFilter = val;
                        _loadSessions();
                      }
                    },
                  ),
                  if (_projects.isNotEmpty)
                    DropdownButton<int?>(
                      value: _projectIdFilter,
                      isDense: true,
                      underline: const SizedBox.shrink(),
                      items: [
                        DropdownMenuItem<int?>(value: null, child: Text(s.allProjects)),
                        ..._projects.map(
                          (proj) => DropdownMenuItem<int?>(
                            value: proj.id,
                            child: Text(proj.name, overflow: TextOverflow.ellipsis),
                          ),
                        ),
                      ],
                      onChanged: (val) {
                        _projectIdFilter = val;
                        _loadSessions();
                      },
                    ),
                  DropdownButton<SmSortBy>(
                    value: _sortBy,
                    isDense: true,
                    underline: const SizedBox.shrink(),
                    items: SmSortBy.values
                        .map((item) => DropdownMenuItem(value: item, child: Text(_sortLabel(s, item))))
                        .toList(),
                    onChanged: (val) {
                      if (val != null) {
                        _sortBy = val;
                        _loadSessions();
                      }
                    },
                  ),
                  FilterChip(
                    label: Text(s.starredOnly),
                    selected: _starredOnly,
                    onSelected: (v) {
                      _starredOnly = v;
                      _loadSessions();
                    },
                  ),
                  FilterChip(
                    label: Text(s.shrunkOnly),
                    selected: _shrunkOnly,
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

        // Virtualized Session List
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _sessions.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(Icons.inbox_outlined, size: 44, color: cs.onSurfaceVariant.withOpacity(0.5)),
                            const SizedBox(height: 12),
                            Text(s.noSessionsMatch, style: theme.textTheme.titleSmall),
                            const SizedBox(height: 6),
                            Text(
                              s.noSessionsHint,
                              style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                              textAlign: TextAlign.center,
                            ),
                            if (widget.onGoToImport != null) ...[
                              const SizedBox(height: 16),
                              FilledButton.tonalIcon(
                                onPressed: widget.onGoToImport,
                                icon: const Icon(Icons.cloud_download_outlined, size: 17),
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
                        padding: const EdgeInsets.all(14),
                        itemCount: _sessions.length,
                        itemBuilder: (context, index) {
                          final session = _sessions[index];
                          final isSelected = widget.selectedConversationId == session.id;
                          return _SessionCard(
                            session: session,
                            isSelected: isSelected,
                            onTap: () => widget.onSelectSession(session.id),
                          );
                        },
                      ),
                    ),
        ),
      ],
    );
  }
}

class _SessionCard extends StatelessWidget {
  final ConversationSummary session;
  final bool isSelected;
  final VoidCallback onTap;

  const _SessionCard({
    required this.session,
    required this.isSelected,
    required this.onTap,
  });

  Color _providerColor(String provider) {
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
      default:
        return const Color(0xFF5F6368);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final badgeColor = _providerColor(session.provider);
    final updatedStr = session.updatedAt != null
        ? DateFormat('yyyy-MM-dd HH:mm').format(DateTime.fromMillisecondsSinceEpoch(session.updatedAt!))
        : '';

    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      color: isSelected ? cs.primaryContainer.withOpacity(0.45) : cs.surfaceContainerLowest,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(
          color: isSelected ? cs.primary : cs.outlineVariant.withOpacity(0.55),
          width: isSelected ? 1.5 : 1,
        ),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(14),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: badgeColor.withOpacity(0.12),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      session.provider,
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: badgeColor),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      session.title,
                      style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (session.starred)
                    const Padding(
                      padding: EdgeInsets.only(left: 6),
                      child: Icon(Icons.star, size: 16, color: Color(0xFFF9AB00)),
                    ),
                  if (session.isShrunk)
                    Container(
                      margin: const EdgeInsets.only(left: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                      decoration: BoxDecoration(
                        color: const Color(0xFFB06000).withOpacity(0.14),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        s.shrunkBadge,
                        style: const TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: Color(0xFFB06000)),
                      ),
                    ),
                  if (session.revisionCount > 1)
                    Container(
                      margin: const EdgeInsets.only(left: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                      decoration: BoxDecoration(
                        color: cs.secondaryContainer,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        'Rev x${session.revisionCount}',
                        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: cs.onSecondaryContainer),
                      ),
                    ),
                ],
              ),
              if (session.summary != null && session.summary!.isNotEmpty) ...[
                const SizedBox(height: 6),
                Text(
                  session.summary!,
                  style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
              const SizedBox(height: 8),
              Row(
                children: [
                  Text(s.itemsLabel(session.itemCount), style: theme.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant)),
                  if (session.projectName != null) ...[
                    const SizedBox(width: 10),
                    Icon(Icons.folder_outlined, size: 14, color: cs.onSurfaceVariant),
                    const SizedBox(width: 4),
                    Flexible(
                      child: Text(
                        session.projectName!,
                        style: theme.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ] else if (session.cwd != null && session.cwd!.isNotEmpty) ...[
                    const SizedBox(width: 10),
                    Flexible(
                      child: Text(
                        session.cwd!,
                        style: GoogleMaterialTheme.monoTextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                  const Spacer(),
                  if (updatedStr.isNotEmpty)
                    Text(updatedStr, style: theme.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
