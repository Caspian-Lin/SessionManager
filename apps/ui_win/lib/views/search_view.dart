import 'package:flutter/material.dart';

import '../data/archive_direct_store.dart';
import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/gm3_surface.dart';

class FullTextSearchView extends StatefulWidget {
  final ArchiveDirectStore store;
  final FocusNode searchFocusNode;
  final ValueChanged<int> onSelectSession;

  const FullTextSearchView({
    super.key,
    required this.store,
    required this.searchFocusNode,
    required this.onSelectSession,
  });

  @override
  State<FullTextSearchView> createState() => _FullTextSearchViewState();
}

class _FullTextSearchViewState extends State<FullTextSearchView> {
  final TextEditingController _ctrl = TextEditingController();
  final ScrollController _scrollCtrl = ScrollController();
  List<SearchHit> _hits = [];
  bool _searching = false;
  bool _hasSearched = false;
  String _provider = 'all';
  String _role = 'all';
  bool _includeSynthetic = false;

  @override
  void initState() {
    super.initState();
    widget.store.isConnectedNotifier.addListener(_onStoreConnectionChanged);
    widget.store.dbPathNotifier.addListener(_clearSearchOnDbChange);
  }

  void _onStoreConnectionChanged() {
    if (!widget.store.isConnectedNotifier.value && mounted) {
      setState(() {
        _hits = [];
        _hasSearched = false;
      });
    }
  }

  void _clearSearchOnDbChange() {
    if (!mounted) return;
    setState(() {
      _hits = [];
      _hasSearched = false;
    });
  }

  @override
  void dispose() {
    widget.store.isConnectedNotifier.removeListener(_onStoreConnectionChanged);
    widget.store.dbPathNotifier.removeListener(_clearSearchOnDbChange);
    _ctrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _executeSearch() async {
    final q = _ctrl.text.trim();
    if (q.isEmpty) return;
    setState(() => _searching = true);
    final results = await widget.store.search(
      q,
      provider: _provider,
      role: _role,
      includeSynthetic: _includeSynthetic,
    );
    if (!mounted) return;
    setState(() {
      _hits = results;
      _searching = false;
      _hasSearched = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1040),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(s.searchTitle, style: theme.textTheme.titleLarge),
              const SizedBox(height: 6),
              Text(
                s.searchSubtitle,
                style: theme.textTheme.bodyMedium
                    ?.copyWith(color: cs.onSurfaceVariant),
              ),
              const SizedBox(height: 18),
              Row(
                children: <Widget>[
                  Expanded(
                    child: SizedBox(
                      height: 44,
                      child: TextField(
                        controller: _ctrl,
                        focusNode: widget.searchFocusNode,
                        style: theme.textTheme.bodyLarge,
                        onSubmitted: (_) => _executeSearch(),
                        decoration: InputDecoration(
                          hintText: s.searchInputHint,
                          prefixIcon: const Icon(Icons.search, size: 20),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    height: 44,
                    child: FilledButton.icon(
                      onPressed: _searching ? null : _executeSearch,
                      icon: const Icon(Icons.search, size: 18),
                      label: Text(s.searchAction),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: <Widget>[
                  Gm3Select<String>(
                    value: _provider,
                    maxWidth: 180,
                    options: <Gm3Option<String>>[
                      Gm3Option<String>(value: 'all', label: s.allProviders),
                      const Gm3Option<String>(
                          value: 'openai-web', label: 'openai-web'),
                      const Gm3Option<String>(
                          value: 'codex-local', label: 'codex-local'),
                      const Gm3Option<String>(
                          value: 'dsh-local', label: 'dsh-local'),
                      const Gm3Option<String>(
                          value: 'claude-code-local',
                          label: 'claude-code-local'),
                      const Gm3Option<String>(
                          value: 'opencode-local',
                          label: 'opencode-local'),
                      const Gm3Option<String>(
                          value: 'zcode-local', label: 'zcode-local'),
                    ],
                    onChanged: (v) => setState(() => _provider = v),
                  ),
                  Gm3Select<String>(
                    value: _role,
                    maxWidth: 140,
                    options: <Gm3Option<String>>[
                      Gm3Option<String>(value: 'all', label: s.allRoles),
                      const Gm3Option<String>(value: 'user', label: 'user'),
                      const Gm3Option<String>(
                          value: 'assistant', label: 'assistant'),
                      const Gm3Option<String>(value: 'tool', label: 'tool'),
                      const Gm3Option<String>(value: 'system', label: 'system'),
                    ],
                    onChanged: (v) => setState(() => _role = v),
                  ),
                  FilterChip(
                    label: Text(s.includeSynthetic),
                    selected: _includeSynthetic,
                    visualDensity: VisualDensity.compact,
                    onSelected: (v) => setState(() => _includeSynthetic = v),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              Expanded(
                child: _searching
                    ? const Center(child: CircularProgressIndicator())
                    : _hits.isEmpty
                        ? Center(
                            child: Text(
                              _hasSearched
                                  ? s.searchNoHits
                                  : s.searchEmptyHint,
                              style: theme.textTheme.bodyMedium
                                  ?.copyWith(color: cs.onSurfaceVariant),
                            ),
                          )
                        : Scrollbar(
                            controller: _scrollCtrl,
                            child: ListView.builder(
                              controller: _scrollCtrl,
                              padding: const EdgeInsets.only(bottom: 12),
                              itemCount: _hits.length,
                              itemBuilder: (context, index) {
                                final hit = _hits[index];
                                return Gm3Card(
                                  margin: const EdgeInsets.only(bottom: 8),
                                  padding: EdgeInsets.zero,
                                  onTap: () => widget
                                      .onSelectSession(hit.conversationId),
                                  child: ListTile(
                                    contentPadding: const EdgeInsets.symmetric(
                                        horizontal: 16, vertical: 6),
                                    onTap: () => widget
                                        .onSelectSession(hit.conversationId),
                                    title: Row(
                                      children: <Widget>[
                                        Gm3Pill(
                                          label: hit.strategy,
                                          color: cs.onSecondaryContainer,
                                          background: cs.secondaryContainer,
                                          fontSize: Gm3.fontSizeLabelSmall,
                                          padding: const EdgeInsets.symmetric(
                                              horizontal: 7, vertical: 2),
                                        ),
                                        const SizedBox(width: 10),
                                        Expanded(
                                          child: Text(
                                            hit.title,
                                            style: theme.textTheme.titleSmall,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        ),
                                        Text(
                                          hit.provider,
                                          style: theme.textTheme.labelSmall,
                                        ),
                                      ],
                                    ),
                                    subtitle: Padding(
                                      padding: const EdgeInsets.only(top: 6),
                                      child: Text(
                                        '[${hit.role}] ${hit.snippet}',
                                        maxLines: 3,
                                        overflow: TextOverflow.ellipsis,
                                        style: theme.textTheme.bodySmall,
                                      ),
                                    ),
                                    trailing: const Icon(
                                      Icons.chevron_right,
                                      size: 20,
                                    ),
                                  ),
                                );
                              },
                            ),
                          ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
