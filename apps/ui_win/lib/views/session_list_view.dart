import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../data/archive_direct_store.dart';
import '../models.dart';
import '../theme.dart';

class SessionListView extends StatefulWidget {
  final ArchiveDirectStore store;
  final ValueNotifier<int> refreshTick;
  final int? selectedConversationId;
  final ValueChanged<int> onSelectSession;

  const SessionListView({
    super.key,
    required this.store,
    required this.refreshTick,
    this.selectedConversationId,
    required this.onSelectSession,
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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Column(
      children: [
        // Filter Header Bar
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
                  const Flexible(
                    child: Text(
                      'Archived Sessions',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: cs.primary.withOpacity(0.12),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      '${_sessions.length}',
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: cs.primary),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: TextField(
                      controller: _searchCtrl,
                      onChanged: (_) => _loadSessions(),
                      decoration: const InputDecoration(
                        hintText: 'Filter title or summary...',
                        prefixIcon: Icon(Icons.filter_list, size: 16),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  DropdownButton<String>(
                    value: _providerFilter,
                    isDense: true,
                    underline: const SizedBox.shrink(),
                    items: const [
                      DropdownMenuItem(value: 'all', child: Text('All Providers')),
                      DropdownMenuItem(value: 'openai-web', child: Text('openai-web')),
                      DropdownMenuItem(value: 'anthropic-web', child: Text('anthropic-web')),
                      DropdownMenuItem(value: 'deepseek-web', child: Text('deepseek-web')),
                      DropdownMenuItem(value: 'codex-local', child: Text('codex-local')),
                      DropdownMenuItem(value: 'claude-code-local', child: Text('claude-code-local')),
                      DropdownMenuItem(value: 'dsh-local', child: Text('dsh-local')),
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
                        const DropdownMenuItem<int?>(value: null, child: Text('All Projects')),
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
                        .map((s) => DropdownMenuItem(value: s, child: Text(s.label)))
                        .toList(),
                    onChanged: (val) {
                      if (val != null) {
                        _sortBy = val;
                        _loadSessions();
                      }
                    },
                  ),
                  FilterChip(
                    label: const Text('Starred', style: TextStyle(fontSize: 11)),
                    selected: _starredOnly,
                    visualDensity: VisualDensity.compact,
                    onSelected: (v) {
                      _starredOnly = v;
                      _loadSessions();
                    },
                  ),
                  FilterChip(
                    label: const Text('Shrunk', style: TextStyle(fontSize: 11)),
                    selected: _shrunkOnly,
                    visualDensity: VisualDensity.compact,
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
                  ? const Center(child: Text('No sessions matching current filter.'))
                  : Scrollbar(
                      controller: _scrollCtrl,
                      child: ListView.builder(
                        controller: _scrollCtrl,
                        padding: const EdgeInsets.all(12),
                        itemCount: _sessions.length,
                        itemBuilder: (context, index) {
                          final s = _sessions[index];
                          final isSelected = widget.selectedConversationId == s.id;
                          return _SessionCard(
                            session: s,
                            isSelected: isSelected,
                            onTap: () => widget.onSelectSession(s.id),
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
        return const Color(0xFF10A37F);
      case 'anthropic-web':
      case 'claude-code-local':
        return const Color(0xFFD97706);
      case 'deepseek-web':
        return const Color(0xFF2563EB);
      case 'codex-local':
        return const Color(0xFF0067C0);
      case 'dsh-local':
        return const Color(0xFF7C3AED);
      default:
        return const Color(0xFF6B7280);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final badgeColor = _providerColor(session.provider);
    final updatedStr = session.updatedAt != null
        ? DateFormat('yyyy-MM-dd HH:mm').format(DateTime.fromMillisecondsSinceEpoch(session.updatedAt!))
        : 'Unknown';

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(6),
        side: BorderSide(
          color: isSelected ? cs.primary : theme.dividerColor,
          width: isSelected ? 1.5 : 1,
        ),
      ),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(6),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: badgeColor.withOpacity(0.14),
                      borderRadius: BorderRadius.circular(4),
                      border: Border.all(color: badgeColor.withOpacity(0.45)),
                    ),
                    child: Text(
                      session.provider,
                      style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: badgeColor),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      session.title,
                      style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (session.starred)
                    const Padding(
                      padding: EdgeInsets.only(left: 6),
                      child: Icon(Icons.star, size: 15, color: Color(0xFFF59E0B)),
                    ),
                  if (session.isShrunk)
                    Container(
                      margin: const EdgeInsets.only(left: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(
                        color: Colors.amber.withOpacity(0.18),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: const Text(
                        'SHRUNK',
                        style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFFD97706)),
                      ),
                    ),
                  if (session.revisionCount > 1)
                    Container(
                      margin: const EdgeInsets.only(left: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(
                        color: cs.primary.withOpacity(0.1),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text(
                        'Rev x${session.revisionCount}',
                        style: TextStyle(fontSize: 10, fontWeight: FontWeight.w600, color: cs.primary),
                      ),
                    ),
                ],
              ),
              if (session.summary != null && session.summary!.isNotEmpty) ...[
                const SizedBox(height: 5),
                Text(
                  session.summary!,
                  style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
              const SizedBox(height: 6),
              Row(
                children: [
                  Text('${session.itemCount} items', style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
                  if (session.projectName != null) ...[
                    const SizedBox(width: 10),
                    Icon(Icons.folder_outlined, size: 13, color: cs.onSurfaceVariant),
                    const SizedBox(width: 3),
                    Flexible(
                      child: Text(
                        session.projectName!,
                        style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ] else if (session.cwd != null && session.cwd!.isNotEmpty) ...[
                    const SizedBox(width: 10),
                    Flexible(
                      child: Text(
                        session.cwd!,
                        style: WinAdaptiveTheme.monoTextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ],
                  const Spacer(),
                  Text(updatedStr, style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
