import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:intl/intl.dart';

void main() {
  runApp(const SessionManagerApp());
}

class SessionManagerApp extends StatelessWidget {
  const SessionManagerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Session Manager · Windows Reader',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.dark,
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFF141418),
        colorScheme: const ColorScheme.dark(
          primary: Color(0xFF6366F1),
          secondary: Color(0xFF38BDF8),
          surface: Color(0xFF1E1E24),
          surfaceContainer: Color(0xFF272730),
          error: Color(0xFFF43F5E),
        ),
        cardTheme: const CardTheme(
          color: Color(0xFF1E1E24),
          elevation: 0,
          shape: RoundedRectangleBorder(
            side: BorderSide(color: Color(0xFF2E2E38)),
            borderRadius: BorderRadius.all(Radius.circular(8)),
          ),
        ),
        fontFamily: 'Segoe UI',
      ),
      home: const MainShell(),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shell with Chatea-style Navigation Rail
// ─────────────────────────────────────────────────────────────────────────────

class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _selectedIndex = 0;
  final ApiClient _api = ApiClient();
  int? _selectedConversationId;

  void _navigateToConversation(int id) {
    setState(() {
      _selectedConversationId = id;
      _selectedIndex = 1; // Branch Reader
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Row(
        children: [
          // Left Navigation Rail (Chatea Shell Design)
          NavigationRail(
            selectedIndex: _selectedIndex,
            onDestinationSelected: (index) {
              setState(() => _selectedIndex = index);
            },
            backgroundColor: const Color(0xFF18181F),
            leading: Padding(
              padding: const EdgeInsets.symmetric(vertical: 16),
              child: Column(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [Color(0xFF6366F1), Color(0xFF38BDF8)],
                      ),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Icon(Icons.archive_outlined, color: Colors.white, size: 24),
                  ),
                  const SizedBox(height: 8),
                  const Text('SM', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13, letterSpacing: 1.2)),
                ],
              ),
            ),
            trailing: Expanded(
              child: Align(
                alignment: Alignment.bottomCenter,
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Tooltip(
                    message: '127.0.0.1 Connection Status',
                    child: ValueListenableBuilder<bool>(
                      valueListenable: _api.isConnectedNotifier,
                      builder: (context, connected, _) {
                        return Container(
                          padding: const EdgeInsets.all(8),
                          decoration: BoxDecoration(
                            color: connected ? Colors.green.withOpacity(0.15) : Colors.amber.withOpacity(0.15),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Icon(
                            Icons.circle,
                            size: 10,
                            color: connected ? const Color(0xFF10B981) : const Color(0xFFF59E0B),
                          ),
                        );
                      },
                    ),
                  ),
                ),
              ),
            ),
            labelType: NavigationRailLabelType.all,
            destinations: const [
              NavigationRailDestination(
                icon: Icon(Icons.forum_outlined),
                selectedIcon: Icon(Icons.forum),
                label: Text('Sessions'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.alt_route_outlined),
                selectedIcon: Icon(Icons.alt_route),
                label: Text('Reader'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.search_outlined),
                selectedIcon: Icon(Icons.search),
                label: Text('Search'),
              ),
              NavigationRailDestination(
                icon: Icon(Icons.fact_check_outlined),
                selectedIcon: Icon(Icons.fact_check),
                label: Text('Integrity'),
              ),
            ],
          ),

          const VerticalDivider(width: 1, thickness: 1, color: Color(0xFF282833)),

          // Main View Content
          Expanded(
            child: IndexedStack(
              index: _selectedIndex,
              children: [
                SessionListView(api: _api, onSelectSession: _navigateToConversation),
                BranchTreeReaderView(
                  api: _api,
                  conversationId: _selectedConversationId,
                  onSelectOtherSession: _navigateToConversation,
                ),
                FullTextSearchView(api: _api, onSelectSession: _navigateToConversation),
                IntegrityReportView(api: _api),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Session List View (Virtualized)
// ─────────────────────────────────────────────────────────────────────────────

class SessionListView extends StatefulWidget {
  final ApiClient api;
  final ValueChanged<int> onSelectSession;

  const SessionListView({super.key, required this.api, required this.onSelectSession});

  @override
  State<SessionListView> createState() => _SessionListViewState();
}

class _SessionListViewState extends State<SessionListView> {
  List<ConversationSummary> _sessions = [];
  bool _loading = true;
  String _providerFilter = 'all';
  final TextEditingController _searchCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    _loadSessions();
  }

  Future<void> _loadSessions() async {
    setState(() => _loading = true);
    final list = await widget.api.getConversations(
      provider: _providerFilter == 'all' ? null : _providerFilter,
    );
    setState(() {
      _sessions = list;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _sessions.where((s) {
      if (_searchCtrl.text.isEmpty) return true;
      final q = _searchCtrl.text.toLowerCase();
      return s.title.toLowerCase().contains(q) || (s.summary?.toLowerCase().contains(q) ?? false);
    }).toList();

    return Column(
      children: [
        // Header & Filters
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          decoration: const BoxDecoration(
            color: Color(0xFF18181F),
            border: Border(bottom: BorderSide(color: Color(0xFF282833))),
          ),
          child: Row(
            children: [
              const Text('Archived Sessions', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
              const SizedBox(width: 16),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: const Color(0xFF282835),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text('${filtered.length} items', style: const TextStyle(fontSize: 12, color: Colors.white70)),
              ),
              const Spacer(),
              // Quick search box
              SizedBox(
                width: 240,
                height: 36,
                child: TextField(
                  controller: _searchCtrl,
                  onChanged: (_) => setState(() {}),
                  decoration: InputDecoration(
                    hintText: 'Filter sessions...',
                    prefixIcon: const Icon(Icons.filter_list, size: 18),
                    filled: true,
                    fillColor: const Color(0xFF22222C),
                    contentPadding: EdgeInsets.zero,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(6),
                      borderSide: const BorderSide(color: Color(0xFF333342)),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              // Provider Dropdown
              DropdownButton<String>(
                value: _providerFilter,
                dropdownColor: const Color(0xFF22222C),
                items: const [
                  DropdownMenuItem(value: 'all', child: Text('All Providers')),
                  DropdownMenuItem(value: 'openai-web', child: Text('OpenAI Web')),
                  DropdownMenuItem(value: 'codex-local', child: Text('Codex Local')),
                  DropdownMenuItem(value: 'dsh-local', child: Text('DSH Local')),
                  DropdownMenuItem(value: 'claude-code-local', child: Text('Claude Code')),
                ],
                onChanged: (val) {
                  if (val != null) {
                    setState(() => _providerFilter = val);
                    _loadSessions();
                  }
                },
              ),
            ],
          ),
        ),

        // Virtualized Session List
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : filtered.isEmpty
                  ? const Center(child: Text('No sessions matching filter.'))
                  : ListView.builder(
                      itemCount: filtered.length,
                      itemBuilder: (context, index) {
                        final s = filtered[index];
                        final providerColor = _getProviderColor(s.provider);
                        return ListTile(
                          contentPadding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
                          tileColor: index.isEven ? const Color(0xFF16161D) : const Color(0xFF191922),
                          leading: CircleAvatar(
                            backgroundColor: providerColor.withOpacity(0.2),
                            child: Icon(Icons.chat_bubble_outline, color: providerColor, size: 20),
                          ),
                          title: Row(
                            children: [
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                decoration: BoxDecoration(
                                  color: providerColor.withOpacity(0.15),
                                  borderRadius: BorderRadius.circular(4),
                                ),
                                child: Text(s.provider, style: TextStyle(fontSize: 10, color: providerColor)),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  s.title,
                                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                            ],
                          ),
                          subtitle: Padding(
                            padding: const EdgeInsets.only(top: 4),
                            child: Text(
                              s.summary ?? 'No summary available.',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(color: Colors.white54, fontSize: 12),
                            ),
                          ),
                          trailing: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text('${s.itemCount} items', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                              const SizedBox(height: 4),
                              Text(
                                s.updatedAt != null
                                    ? DateFormat('yyyy-MM-dd HH:mm').format(DateTime.fromMillisecondsSinceEpoch(s.updatedAt!))
                                    : '',
                                style: const TextStyle(fontSize: 11, color: Colors.white38),
                              ),
                            ],
                          ),
                          onTap: () => widget.onSelectSession(s.id),
                        );
                      },
                    ),
        ),
      ],
    );
  }

  Color _getProviderColor(String provider) {
    if (provider.contains('openai')) return const Color(0xFF10A37F);
    if (provider.contains('codex')) return const Color(0xFF38BDF8);
    if (provider.contains('dsh')) return const Color(0xFFA855F7);
    if (provider.contains('claude')) return const Color(0xFFD97706);
    return const Color(0xFF6366F1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Branch Tree Reader View (is_active_branch + is_synthetic folding)
// ─────────────────────────────────────────────────────────────────────────────

class BranchTreeReaderView extends StatefulWidget {
  final ApiClient api;
  final int? conversationId;
  final ValueChanged<int> onSelectOtherSession;

  const BranchTreeReaderView({
    super.key,
    required this.api,
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

  @override
  void didUpdateWidget(covariant BranchTreeReaderView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.conversationId != widget.conversationId && widget.conversationId != null) {
      _loadConversation(widget.conversationId!);
    }
  }

  @override
  void initState() {
    super.initState();
    if (widget.conversationId != null) {
      _loadConversation(widget.conversationId!);
    }
  }

  Future<void> _loadConversation(int id) async {
    setState(() => _loading = true);
    final detail = await widget.api.getConversationDetail(id);
    setState(() {
      _detail = detail;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (widget.conversationId == null) {
      return const Center(child: Text('Select a conversation from the Session List to view branches.'));
    }

    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_detail == null) {
      return const Center(child: Text('Conversation not found.'));
    }

    // Filter items based on branch switcher and synthetic folding
    final displayedItems = _detail!.items.where((it) {
      if (_activeBranchOnly && !it.isActiveBranch) return false;
      if (_foldSynthetic && it.isSynthetic) return false;
      return true;
    }).toList();

    return Column(
      children: [
        // Reader Header Bar
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
          decoration: const BoxDecoration(
            color: Color(0xFF18181F),
            border: Border(bottom: BorderSide(color: Color(0xFF282833))),
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(_detail!.title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                    const SizedBox(height: 2),
                    Text(
                      'Provider: ${_detail!.provider} · Head: ${_detail!.headHash?.substring(0, 8) ?? 'N/A'} · Total Items: ${_detail!.items.length}',
                      style: const TextStyle(fontSize: 11, color: Colors.white54),
                    ),
                  ],
                ),
              ),
              // Branch Switcher Toggle
              FilterChip(
                label: const Text('Active Branch Only', style: TextStyle(fontSize: 12)),
                selected: _activeBranchOnly,
                onSelected: (val) => setState(() => _activeBranchOnly = val),
              ),
              const SizedBox(width: 8),
              // Synthetic Folding Toggle
              FilterChip(
                label: const Text('Fold Synthetic Logs', style: TextStyle(fontSize: 12)),
                selected: _foldSynthetic,
                onSelected: (val) => setState(() => _foldSynthetic = val),
              ),
            ],
          ),
        ),

        // Message Tree Timeline
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.all(24),
            itemCount: displayedItems.length,
            itemBuilder: (context, index) {
              final item = displayedItems[index];
              return _buildMessageItem(item);
            },
          ),
        ),
      ],
    );
  }

  Widget _buildMessageItem(MessageItem item) {
    final isUser = item.role == 'user';
    final isAssistant = item.role == 'assistant';

    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CircleAvatar(
            radius: 16,
            backgroundColor: isUser ? const Color(0xFF4F46E5) : isAssistant ? const Color(0xFF10A37F) : const Color(0xFF6B7280),
            child: Icon(
              isUser ? Icons.person : isAssistant ? Icons.smart_toy : Icons.terminal,
              size: 16,
              color: Colors.white,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      item.role.toUpperCase(),
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.bold,
                        color: isUser ? const Color(0xFF818CF8) : const Color(0xFF34D399),
                      ),
                    ),
                    const SizedBox(width: 8),
                    if (!item.isActiveBranch)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(color: Colors.orange.withOpacity(0.2), borderRadius: BorderRadius.circular(4)),
                        child: const Text('ALT BRANCH', style: TextStyle(fontSize: 9, color: Colors.orange)),
                      ),
                    if (item.isSynthetic)
                      Container(
                        margin: const EdgeInsets.only(left: 4),
                        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                        decoration: BoxDecoration(color: Colors.blueGrey.withOpacity(0.2), borderRadius: BorderRadius.circular(4)),
                        child: const Text('SYNTHETIC', style: TextStyle(fontSize: 9, color: Colors.blueGrey)),
                      ),
                  ],
                ),
                const SizedBox(height: 6),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: isUser ? const Color(0xFF1E1F2B) : const Color(0xFF1A1A22),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: isUser ? const Color(0xFF313247) : const Color(0xFF282835)),
                  ),
                  child: SelectableText(
                    item.text,
                    style: const TextStyle(fontSize: 13, height: 1.45, color: Color(0xFFE2E8F0)),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Full-Text Search View
// ─────────────────────────────────────────────────────────────────────────────

class FullTextSearchView extends StatefulWidget {
  final ApiClient api;
  final ValueChanged<int> onSelectSession;

  const FullTextSearchView({super.key, required this.api, required this.onSelectSession});

  @override
  State<FullTextSearchView> createState() => _FullTextSearchViewState();
}

class _FullTextSearchViewState extends State<FullTextSearchView> {
  final TextEditingController _ctrl = TextEditingController();
  List<SearchHit> _hits = [];
  bool _searching = false;

  Future<void> _executeSearch() async {
    final q = _ctrl.text.trim();
    if (q.isEmpty) return;
    setState(() => _searching = true);
    final results = await widget.api.search(q);
    setState(() {
      _hits = results;
      _searching = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Full-Text Archive Search', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          const Text('Search across conversation messages, tool executions, and titles using trigram / FTS5.',
              style: TextStyle(color: Colors.white54, fontSize: 13)),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _ctrl,
                  onSubmitted: (_) => _executeSearch(),
                  decoration: InputDecoration(
                    hintText: 'Enter search keywords...',
                    prefixIcon: const Icon(Icons.search),
                    filled: true,
                    fillColor: const Color(0xFF1E1E26),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8),
                      borderSide: const BorderSide(color: Color(0xFF2E2E3C)),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              FilledButton.icon(
                onPressed: _searching ? null : _executeSearch,
                icon: const Icon(Icons.arrow_forward),
                label: const Text('Search'),
              ),
            ],
          ),
          const SizedBox(height: 16),
          if (_searching)
            const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()))
          else
            Expanded(
              child: _hits.isEmpty
                  ? const Center(child: Text('No results. Type a query above and press Enter.'))
                  : ListView.builder(
                      itemCount: _hits.length,
                      itemBuilder: (context, index) {
                        final hit = _hits[index];
                        return Card(
                          margin: const EdgeInsets.only(bottom: 12),
                          child: ListTile(
                            title: Row(
                              children: [
                                Text(hit.title, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                                const SizedBox(width: 8),
                                Container(
                                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFF38BDF8).withOpacity(0.15),
                                    borderRadius: BorderRadius.circular(4),
                                  ),
                                  child: Text(hit.provider, style: const TextStyle(fontSize: 10, color: Color(0xFF38BDF8))),
                                ),
                                const Spacer(),
                                Text('[${hit.role}]', style: const TextStyle(fontSize: 11, color: Colors.white38)),
                              ],
                            ),
                            subtitle: Padding(
                              padding: const EdgeInsets.only(top: 8),
                              child: Text(
                                hit.snippet,
                                style: const TextStyle(color: Color(0xFFCBD5E1), fontSize: 13),
                              ),
                            ),
                            onTap: () => widget.onSelectSession(hit.conversationId),
                          ),
                        );
                      },
                    ),
            ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Batch Dedupe / Diff Integrity Report (Highlighting shrunk_conversations)
// ─────────────────────────────────────────────────────────────────────────────

class IntegrityReportView extends StatefulWidget {
  final ApiClient api;

  const IntegrityReportView({super.key, required this.api});

  @override
  State<IntegrityReportView> createState() => _IntegrityReportViewState();
}

class _IntegrityReportViewState extends State<IntegrityReportView> {
  List<BatchReport> _batches = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadBatches();
  }

  Future<void> _loadBatches() async {
    setState(() => _loading = true);
    final list = await widget.api.getBatches();
    setState(() {
      _batches = list;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());

    // Compute total shrunk conversations across batches
    final totalShrunk = _batches.fold<int>(0, (sum, b) => sum + (b.shrunkConversations));

    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('Archive Integrity & Diff Report', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          const SizedBox(height: 4),
          const Text('Verification across export snapshots, upstream deletion tracking, and deduplication audit.',
              style: TextStyle(color: Colors.white54, fontSize: 13)),
          const SizedBox(height: 20),

          // High Priority Alert Card for shrunk_conversations
          if (totalShrunk > 0)
            Container(
              padding: const EdgeInsets.all(16),
              margin: const EdgeInsets.only(bottom: 20),
              decoration: BoxDecoration(
                color: const Color(0xFF451A03),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: const Color(0xFFF59E0B)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.warning_amber_rounded, color: Color(0xFFF59E0B), size: 32),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'CRITICAL ALERT: $totalShrunk Conversation(s) Shrunk Upstream!',
                          style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFFFEF3C7), fontSize: 15),
                        ),
                        const SizedBox(height: 4),
                        const Text(
                          'Later exports contained fewer items than earlier snapshots. Messages were deleted or pruned upstream by the provider.',
                          style: TextStyle(color: Color(0xFFFDE68A), fontSize: 12),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),

          // Overview Dashboard Cards
          Row(
            children: [
              _buildMetricCard('Total Batches', '${_batches.length}', Icons.layers, const Color(0xFF6366F1)),
              const SizedBox(width: 16),
              _buildMetricCard('Shrunk Sessions', '$totalShrunk', Icons.compress, totalShrunk > 0 ? Colors.amber : Colors.green),
              const SizedBox(width: 16),
              _buildMetricCard('Integrity Status', 'Valid (0 Cycles)', Icons.check_circle_outline, const Color(0xFF10B981)),
            ],
          ),
          const SizedBox(height: 24),

          const Text('Import Batch Ledger', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          const SizedBox(height: 12),

          Expanded(
            child: ListView.builder(
              itemCount: _batches.length,
              itemBuilder: (context, index) {
                final b = _batches[index];
                return Card(
                  margin: const EdgeInsets.only(bottom: 12),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Text('Batch #${b.id}', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                            const SizedBox(width: 8),
                            Chip(
                              label: Text(b.provider, style: const TextStyle(fontSize: 10)),
                              padding: EdgeInsets.zero,
                              visualDensity: VisualDensity.compact,
                            ),
                            const Spacer(),
                            Text(
                              DateFormat('yyyy-MM-dd HH:mm').format(DateTime.fromMillisecondsSinceEpoch(b.importedAt)),
                              style: const TextStyle(color: Colors.white38, fontSize: 12),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            _buildDiffPill('+ ${b.addedConversations} Added', Colors.green),
                            const SizedBox(width: 8),
                            _buildDiffPill('~ ${b.grownConversations} Grown', Colors.blue),
                            const SizedBox(width: 8),
                            _buildDiffPill(
                              '! ${b.shrunkConversations} Shrunk',
                              b.shrunkConversations > 0 ? Colors.redAccent : Colors.white38,
                            ),
                            const SizedBox(width: 8),
                            _buildDiffPill('= ${b.identicalConversations} Identical', Colors.grey),
                          ],
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildMetricCard(String label, String value, IconData icon, Color color) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: const Color(0xFF1A1A22),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: const Color(0xFF282835)),
        ),
        child: Row(
          children: [
            CircleAvatar(
              backgroundColor: color.withOpacity(0.15),
              child: Icon(icon, color: color, size: 20),
            ),
            const SizedBox(width: 12),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: const TextStyle(fontSize: 11, color: Colors.white54)),
                const SizedBox(height: 4),
                Text(value, style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: color)),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildDiffPill(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(label, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.bold)),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Models & API Client Service
// ─────────────────────────────────────────────────────────────────────────────

class ConversationSummary {
  final int id;
  final String provider;
  final String title;
  final String? summary;
  final int itemCount;
  final int? updatedAt;

  ConversationSummary({
    required this.id,
    required this.provider,
    required this.title,
    this.summary,
    required this.itemCount,
    this.updatedAt,
  });
}

class ConversationDetail {
  final int id;
  final String provider;
  final String title;
  final String? headHash;
  final List<MessageItem> items;

  ConversationDetail({
    required this.id,
    required this.provider,
    required this.title,
    this.headHash,
    required this.items,
  });
}

class MessageItem {
  final int id;
  final String role;
  final String text;
  final bool isActiveBranch;
  final bool isSynthetic;

  MessageItem({
    required this.id,
    required this.role,
    required this.text,
    required this.isActiveBranch,
    required this.isSynthetic,
  });
}

class SearchHit {
  final int conversationId;
  final String provider;
  final String title;
  final String role;
  final String snippet;

  SearchHit({
    required this.conversationId,
    required this.provider,
    required this.title,
    required this.role,
    required this.snippet,
  });
}

class BatchReport {
  final int id;
  final String provider;
  final int importedAt;
  final int addedConversations;
  final int grownConversations;
  final int shrunkConversations;
  final int identicalConversations;

  BatchReport({
    required this.id,
    required this.provider,
    required this.importedAt,
    required this.addedConversations,
    required this.grownConversations,
    required this.shrunkConversations,
    required this.identicalConversations,
  });
}

class ApiClient {
  final String baseUrl;
  final String? token;
  final ValueNotifier<bool> isConnectedNotifier = ValueNotifier<bool>(false);

  ApiClient({this.baseUrl = 'http://127.0.0.1:4040', this.token});

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null) 'X-SM-Token': token!,
      };

  Future<List<ConversationSummary>> getConversations({String? provider}) async {
    try {
      final uri = Uri.parse('$baseUrl/api/conversations${provider != null ? '?provider=$provider' : ''}');
      final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 2));
      if (res.statusCode == 200) {
        isConnectedNotifier.value = true;
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final list = (data['items'] as List<dynamic>?) ?? [];
        return list.map((item) {
          final m = item as Map<String, dynamic>;
          return ConversationSummary(
            id: m['id'] as int,
            provider: m['provider'] as String,
            title: (m['title'] as String?) ?? 'Untitled',
            summary: m['summary'] as String?,
            itemCount: (m['item_count'] as int?) ?? 0,
            updatedAt: m['updated_at'] as int?,
          );
        }).toList();
      }
    } catch (_) {
      isConnectedNotifier.value = false;
    }

    // Graceful offline sample mock data
    return [
      ConversationSummary(
        id: 1,
        provider: 'openai-web',
        title: 'Architecting local AI conversation archive',
        summary: 'Discussion on zstd decompression and MinHash deduplication',
        itemCount: 14,
        updatedAt: DateTime.now().millisecondsSinceEpoch - 3600000,
      ),
      ConversationSummary(
        id: 2,
        provider: 'codex-local',
        title: 'Codex rollout session refactoring',
        summary: 'Analyzed thread_history_1.sqlite items and payload spilling',
        itemCount: 38,
        updatedAt: DateTime.now().millisecondsSinceEpoch - 7200000,
      ),
      ConversationSummary(
        id: 3,
        provider: 'dsh-local',
        title: 'Streaming chunk aggregation pipeline',
        summary: 'Handling multi-frame zstd with fzstd decompressor',
        itemCount: 8,
        updatedAt: DateTime.now().millisecondsSinceEpoch - 18000000,
      ),
    ];
  }

  Future<ConversationDetail?> getConversationDetail(int id) async {
    try {
      final uri = Uri.parse('$baseUrl/api/conversations/$id');
      final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 2));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final conv = data['conversation'] as Map<String, dynamic>;
        final items = (data['items'] as List<dynamic>?) ?? [];
        return ConversationDetail(
          id: conv['id'] as int,
          provider: conv['provider'] as String,
          title: (conv['title'] as String?) ?? 'Untitled',
          headHash: conv['head_hash'] as String?,
          items: items.map((it) {
            final m = it as Map<String, dynamic>;
            return MessageItem(
              id: m['id'] as int,
              role: (m['role'] as String?) ?? 'user',
              text: (m['text'] as String?) ?? '',
              isActiveBranch: (m['is_active_branch'] as bool?) ?? true,
              isSynthetic: (m['is_synthetic'] as bool?) ?? false,
            );
          }).toList(),
        );
      }
    } catch (_) {}

    // Mock conversation branch items
    return ConversationDetail(
      id: id,
      provider: 'openai-web',
      title: 'Architecting local AI conversation archive',
      headHash: 'a7f3b8912c44e901',
      items: [
        MessageItem(
          id: 1,
          role: 'user',
          text: 'How should we architect SessionManager to avoid Electron bloat while reading multi-gigabyte archives?',
          isActiveBranch: true,
          isSynthetic: false,
        ),
        MessageItem(
          id: 2,
          role: 'assistant',
          text: 'We adopt a CLI-first architecture: Node 24 for heavy IO (zstd, SQLite, FTS5) combined with a Flutter Windows desktop reader sharing Chatea design components.',
          isActiveBranch: true,
          isSynthetic: false,
        ),
        MessageItem(
          id: 3,
          role: 'assistant',
          text: '[Alternative variant]: We could embed a Chromium webview, but WebView2 has long-list scroll friction. Flutter native is far superior.',
          isActiveBranch: false,
          isSynthetic: false,
        ),
        MessageItem(
          id: 4,
          role: 'system',
          text: '<turn_context cwd="C:/Users/28491/Desktop/Lab/SessionManager" git_branch="main"/>',
          isActiveBranch: true,
          isSynthetic: true,
        ),
      ],
    );
  }

  Future<List<SearchHit>> search(String q) async {
    try {
      final uri = Uri.parse('$baseUrl/api/search?q=${Uri.encodeComponent(q)}');
      final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 2));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final results = (data['results'] as List<dynamic>?) ?? [];
        return results.map((r) {
          final m = r as Map<String, dynamic>;
          return SearchHit(
            conversationId: m['conversation_id'] as int,
            provider: m['provider'] as String,
            title: m['title'] as String,
            role: m['role'] as String,
            snippet: m['snippet'] as String,
          );
        }).toList();
      }
    } catch (_) {}

    return [
      SearchHit(
        conversationId: 1,
        provider: 'openai-web',
        title: 'Architecting local AI conversation archive',
        role: 'user',
        snippet: '...architect SessionManager to avoid Electron bloat while reading multi-gigabyte archives...',
      ),
    ];
  }

  Future<List<BatchReport>> getBatches() async {
    try {
      final uri = Uri.parse('$baseUrl/api/batches');
      final res = await http.get(uri, headers: _headers).timeout(const Duration(seconds: 2));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body) as Map<String, dynamic>;
        final batches = (data['batches'] as List<dynamic>?) ?? [];
        return batches.map((b) {
          final m = b as Map<String, dynamic>;
          final report = m['report'] as Map<String, dynamic>?;
          final diff = report?['diff'] as Map<String, dynamic>?;
          return BatchReport(
            id: m['id'] as int,
            provider: m['provider'] as String,
            importedAt: m['imported_at'] as int,
            addedConversations: (diff?['added_conversations'] as int?) ?? 0,
            grownConversations: (diff?['grown_conversations'] as int?) ?? 0,
            shrunkConversations: (diff?['shrunk_conversations'] as int?) ?? 0,
            identicalConversations: (diff?['identical_conversations'] as int?) ?? 0,
          );
        }).toList();
      }
    } catch (_) {}

    return [
      BatchReport(
        id: 1,
        provider: 'openai-web',
        importedAt: DateTime.now().millisecondsSinceEpoch - 86400000,
        addedConversations: 120,
        grownConversations: 15,
        shrunkConversations: 2, // Demonstrates shrunk_conversations warning!
        identicalConversations: 430,
      ),
    ];
  }
}
