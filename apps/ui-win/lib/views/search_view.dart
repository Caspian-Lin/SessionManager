import 'package:flutter/material.dart';

import '../data/archive_direct_store.dart';
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
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return Padding(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Full-Text Archive Search', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const SizedBox(height: 2),
          Text(
            'Dual FTS5 router (unicode61 + trigram + bounded CJK LIKE) with BM25 weighting.',
            style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _ctrl,
                  focusNode: widget.searchFocusNode,
                  onSubmitted: (_) => _executeSearch(),
                  decoration: const InputDecoration(
                    hintText: 'Search English tokens or 中文关键词 (Ctrl+F)...',
                    prefixIcon: Icon(Icons.search, size: 18),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              FilledButton(
                onPressed: _executeSearch,
                child: const Text('Search'),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              DropdownButton<String>(
                value: _provider,
                isDense: true,
                underline: const SizedBox.shrink(),
                items: const [
                  DropdownMenuItem(value: 'all', child: Text('All Providers')),
                  DropdownMenuItem(value: 'openai-web', child: Text('openai-web')),
                  DropdownMenuItem(value: 'codex-local', child: Text('codex-local')),
                  DropdownMenuItem(value: 'dsh-local', child: Text('dsh-local')),
                  DropdownMenuItem(value: 'claude-code-local', child: Text('claude-code-local')),
                ],
                onChanged: (v) {
                  if (v != null) setState(() => _provider = v);
                },
              ),
              DropdownButton<String>(
                value: _role,
                isDense: true,
                underline: const SizedBox.shrink(),
                items: const [
                  DropdownMenuItem(value: 'all', child: Text('All Roles')),
                  DropdownMenuItem(value: 'user', child: Text('user')),
                  DropdownMenuItem(value: 'assistant', child: Text('assistant')),
                  DropdownMenuItem(value: 'tool', child: Text('tool')),
                  DropdownMenuItem(value: 'system', child: Text('system')),
                ],
                onChanged: (v) {
                  if (v != null) setState(() => _role = v);
                },
              ),
              FilterChip(
                label: const Text('Include Synthetic', style: TextStyle(fontSize: 11)),
                selected: _includeSynthetic,
                visualDensity: VisualDensity.compact,
                onSelected: (v) => setState(() => _includeSynthetic = v),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Expanded(
            child: _searching
                ? const Center(child: CircularProgressIndicator())
                : _hits.isEmpty
                    ? Center(
                        child: Text(
                          'Enter keywords and press Enter to search across local SQLite FTS5 indexes.',
                          style: TextStyle(color: cs.onSurfaceVariant),
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
                              margin: const EdgeInsets.only(bottom: 8),
                              child: ListTile(
                                dense: true,
                                onTap: () => widget.onSelectSession(hit.conversationId),
                                title: Row(
                                  children: [
                                    Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                                      decoration: BoxDecoration(
                                        color: cs.primary.withOpacity(0.12),
                                        borderRadius: BorderRadius.circular(4),
                                      ),
                                      child: Text(
                                        hit.strategy,
                                        style: WinAdaptiveTheme.monoTextStyle(fontSize: 10, color: cs.primary),
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    Expanded(
                                      child: Text(
                                        hit.title,
                                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                    Text(
                                      hit.provider,
                                      style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                                    ),
                                  ],
                                ),
                                subtitle: Padding(
                                  padding: const EdgeInsets.only(top: 4),
                                  child: Text(
                                    '[${hit.role}] ${hit.snippet}',
                                    maxLines: 3,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(fontSize: 12, color: cs.onSurfaceVariant),
                                  ),
                                ),
                                trailing: const Icon(Icons.chevron_right, size: 18),
                              ),
                            );
                          },
                        ),
                      ),
          ),
        ],
      ),
    );
  }
}
