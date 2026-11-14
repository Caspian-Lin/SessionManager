import 'package:flutter/material.dart';

import '../data/archive_direct_store.dart';
import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';

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
  void dispose() {
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
      padding: const EdgeInsets.all(24),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1040),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(s.searchTitle, style: theme.textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              Text(s.searchSubtitle, style: theme.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant)),
              const SizedBox(height: 18),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _ctrl,
                      focusNode: widget.searchFocusNode,
                      onSubmitted: (_) => _executeSearch(),
                      decoration: InputDecoration(
                        hintText: s.searchInputHint,
                        prefixIcon: const Icon(Icons.search),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  FilledButton.icon(
                    onPressed: _searching ? null : _executeSearch,
                    icon: const Icon(Icons.search, size: 18),
                    label: Text(s.searchAction),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 12,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  DropdownButton<String>(
                    value: _provider,
                    isDense: true,
                    underline: const SizedBox.shrink(),
                    items: [
                      DropdownMenuItem(value: 'all', child: Text(s.allProviders)),
                      const DropdownMenuItem(value: 'openai-web', child: Text('openai-web')),
                      const DropdownMenuItem(value: 'codex-local', child: Text('codex-local')),
                      const DropdownMenuItem(value: 'dsh-local', child: Text('dsh-local')),
                      const DropdownMenuItem(value: 'claude-code-local', child: Text('claude-code-local')),
                    ],
                    onChanged: (v) {
                      if (v != null) setState(() => _provider = v);
                    },
                  ),
                  DropdownButton<String>(
                    value: _role,
                    isDense: true,
                    underline: const SizedBox.shrink(),
                    items: [
                      DropdownMenuItem(value: 'all', child: Text(s.allRoles)),
                      const DropdownMenuItem(value: 'user', child: Text('user')),
                      const DropdownMenuItem(value: 'assistant', child: Text('assistant')),
                      const DropdownMenuItem(value: 'tool', child: Text('tool')),
                      const DropdownMenuItem(value: 'system', child: Text('system')),
                    ],
                    onChanged: (v) {
                      if (v != null) setState(() => _role = v);
                    },
                  ),
                  FilterChip(
                    label: Text(s.includeSynthetic),
                    selected: _includeSynthetic,
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
                              _hasSearched ? s.searchNoHits : s.searchEmptyHint,
                              style: theme.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
                            ),
                          )
                        : Scrollbar(
                            controller: _scrollCtrl,
                            child: ListView.builder(
                              controller: _scrollCtrl,
                              itemCount: _hits.length,
                              itemBuilder: (context, index) {
                                final hit = _hits[index];
                                return Card(
                                  margin: const EdgeInsets.only(bottom: 10),
                                  child: ListTile(
                                    contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                                    onTap: () => widget.onSelectSession(hit.conversationId),
                                    title: Row(
                                      children: [
                                        Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                                          decoration: BoxDecoration(
                                            color: cs.secondaryContainer,
                                            borderRadius: BorderRadius.circular(8),
                                          ),
                                          child: Text(
                                            hit.strategy,
                                            style: GoogleMaterialTheme.monoTextStyle(
                                              fontSize: 11,
                                              color: cs.onSecondaryContainer,
                                            ),
                                          ),
                                        ),
                                        const SizedBox(width: 10),
                                        Expanded(
                                          child: Text(
                                            hit.title,
                                            style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        ),
                                        Text(
                                          hit.provider,
                                          style: theme.textTheme.labelMedium?.copyWith(color: cs.onSurfaceVariant),
                                        ),
                                      ],
                                    ),
                                    subtitle: Padding(
                                      padding: const EdgeInsets.only(top: 6),
                                      child: Text(
                                        '[${hit.role}] ${hit.snippet}',
                                        maxLines: 3,
                                        overflow: TextOverflow.ellipsis,
                                        style: theme.textTheme.bodySmall?.copyWith(color: cs.onSurfaceVariant, height: 1.45),
                                      ),
                                    ),
                                    trailing: const Icon(Icons.chevron_right),
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
