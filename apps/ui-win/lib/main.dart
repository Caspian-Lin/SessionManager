import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'data/archive_direct_store.dart';
import 'data/sm_cli_runner.dart';
import 'models.dart';
import 'theme.dart';
import 'views/branch_reader_view.dart';
import 'views/integrity_view.dart';
import 'views/search_view.dart';
import 'views/session_list_view.dart';

void main() {
  runApp(const SessionManagerApp());
}

class SessionManagerApp extends StatefulWidget {
  final ArchiveDirectStore? storeOverride;
  final SmCliRunner? cliRunnerOverride;

  const SessionManagerApp({
    super.key,
    this.storeOverride,
    this.cliRunnerOverride,
  });

  @override
  State<SessionManagerApp> createState() => _SessionManagerAppState();
}

class _SessionManagerAppState extends State<SessionManagerApp> {
  final ValueNotifier<ThemeMode> _themeMode = ValueNotifier<ThemeMode>(ThemeMode.system);

  @override
  void dispose() {
    _themeMode.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<ThemeMode>(
      valueListenable: _themeMode,
      builder: (context, mode, _) {
        return MaterialApp(
          title: 'Session Manager · Windows Reader',
          debugShowCheckedModeBanner: false,
          themeMode: mode,
          theme: WinAdaptiveTheme.light(),
          darkTheme: WinAdaptiveTheme.dark(),
          home: MainShell(
            themeModeNotifier: _themeMode,
            storeOverride: widget.storeOverride,
            cliRunnerOverride: widget.cliRunnerOverride,
          ),
        );
      },
    );
  }
}

class MainShell extends StatefulWidget {
  final ValueNotifier<ThemeMode> themeModeNotifier;
  final ArchiveDirectStore? storeOverride;
  final SmCliRunner? cliRunnerOverride;

  const MainShell({
    super.key,
    required this.themeModeNotifier,
    this.storeOverride,
    this.cliRunnerOverride,
  });

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  int _selectedIndex = 0;
  late final ArchiveDirectStore _store;
  late final SmCliRunner _cliRunner;
  late final bool _ownsStore;
  final ValueNotifier<int> _refreshTick = ValueNotifier<int>(0);
  final FocusNode _searchFocusNode = FocusNode();
  int? _selectedConversationId;

  @override
  void initState() {
    super.initState();
    _ownsStore = widget.storeOverride == null;
    _store = widget.storeOverride ?? ArchiveDirectStore();
    _cliRunner = widget.cliRunnerOverride ?? SmCliRunner(store: _store);
  }

  @override
  void dispose() {
    _searchFocusNode.dispose();
    _refreshTick.dispose();
    if (_ownsStore) {
      _cliRunner.dispose();
      _store.dispose();
    }
    super.dispose();
  }

  void _triggerReload() {
    _store.checkConnection();
    _refreshTick.value++;
  }

  void _navigateToConversation(int id) {
    setState(() {
      _selectedConversationId = id;
      final wide = MediaQuery.sizeOf(context).width >= 1100;
      if (!wide || _selectedIndex != 0) {
        _selectedIndex = 1; // Reader tab on narrow screens or from Search/Integrity
      }
    });
  }

  void _cycleThemeMode() {
    final current = widget.themeModeNotifier.value;
    widget.themeModeNotifier.value = switch (current) {
      ThemeMode.system => ThemeMode.light,
      ThemeMode.light => ThemeMode.dark,
      ThemeMode.dark => ThemeMode.system,
    };
  }

  Future<void> _showArchiveAndImportDialog() async {
    final dbCtrl = TextEditingController(text: _store.dbPath);
    final importCtrl = TextEditingController();
    final exportCtrl = TextEditingController();
    var kind = 'auto';
    var exportFormat = 'native';

    await showDialog<void>(
      context: context,
      builder: (ctx) {
        return StatefulBuilder(
          builder: (ctx, setDialogState) {
            return AlertDialog(
              title: const Text('Archive Location & On-Demand CLI Operations'),
              content: SizedBox(
                width: 520,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Archive Database Path (archive.db or folder)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: dbCtrl,
                            decoration: const InputDecoration(hintText: r'C:\Path\To\archive.db'),
                          ),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          onPressed: () {
                            _store.setArchiveLocation(dbCtrl.text);
                            _triggerReload();
                            Navigator.of(ctx).pop();
                          },
                          child: const Text('Connect'),
                        ),
                      ],
                    ),
                    const Divider(height: 24),
                    const Text('Import Conversation Source (sm import --json)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: importCtrl,
                            decoration: const InputDecoration(hintText: r'Path to ZIP export or ~/.codex / ~/.dsh'),
                          ),
                        ),
                        const SizedBox(width: 8),
                        DropdownButton<String>(
                          value: kind,
                          items: const [
                            DropdownMenuItem(value: 'auto', child: Text('auto')),
                            DropdownMenuItem(value: 'openai-web', child: Text('openai-web')),
                            DropdownMenuItem(value: 'codex-local', child: Text('codex-local')),
                            DropdownMenuItem(value: 'dsh-local', child: Text('dsh-local')),
                          ],
                          onChanged: (v) {
                            if (v != null) setDialogState(() => kind = v);
                          },
                        ),
                        const SizedBox(width: 8),
                        OutlinedButton(
                          onPressed: () async {
                            final src = importCtrl.text.trim();
                            if (src.isEmpty) return;
                            Navigator.of(ctx).pop();
                            final res = await _cliRunner.importSource(src, kind: kind);
                            _triggerReload();
                            if (mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text(res.ok ? 'Import finished (${res.summary})' : 'Import failed: ${res.errorMessage}')),
                              );
                            }
                          },
                          child: const Text('Import'),
                        ),
                      ],
                    ),
                    const Divider(height: 24),
                    const Text('Export Archive (sm export --json)', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: exportCtrl,
                            decoration: const InputDecoration(hintText: r'Output directory path'),
                          ),
                        ),
                        const SizedBox(width: 8),
                        DropdownButton<String>(
                          value: exportFormat,
                          items: const [
                            DropdownMenuItem(value: 'native', child: Text('native')),
                            DropdownMenuItem(value: 'md', child: Text('md')),
                            DropdownMenuItem(value: 'jsonl', child: Text('jsonl')),
                          ],
                          onChanged: (v) {
                            if (v != null) setDialogState(() => exportFormat = v);
                          },
                        ),
                        const SizedBox(width: 8),
                        OutlinedButton(
                          onPressed: () async {
                            final out = exportCtrl.text.trim();
                            if (out.isEmpty) return;
                            Navigator.of(ctx).pop();
                            final res = await _cliRunner.exportArchive(out, format: exportFormat);
                            if (mounted) {
                              ScaffoldMessenger.of(context).showSnackBar(
                                SnackBar(content: Text(res.ok ? 'Export finished (${res.summary})' : 'Export failed: ${res.errorMessage}')),
                              );
                            }
                          },
                          child: const Text('Export'),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.of(ctx).pop(),
                  child: const Text('Close'),
                ),
              ],
            );
          },
        );
      },
    );

    dbCtrl.dispose();
    importCtrl.dispose();
    exportCtrl.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final isWide = MediaQuery.sizeOf(context).width >= 1100;

    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.keyF, control: true): () {
          setState(() => _selectedIndex = 2);
          _searchFocusNode.requestFocus();
        },
        const SingleActivator(LogicalKeyboardKey.keyO, control: true): _showArchiveAndImportDialog,
        const SingleActivator(LogicalKeyboardKey.keyR, control: true): _triggerReload,
        const SingleActivator(LogicalKeyboardKey.f5): _triggerReload,
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          body: Column(
            children: [
              // Windows 11 Desktop Top Bar (Archive status, Theme toggle, CLI triggers)
              Container(
                height: 44,
                padding: const EdgeInsets.symmetric(horizontal: 14),
                decoration: BoxDecoration(
                  color: cs.surface,
                  border: Border(bottom: BorderSide(color: theme.dividerColor)),
                ),
                child: Row(
                  children: [
                    Icon(Icons.archive_outlined, size: 18, color: cs.primary),
                    const SizedBox(width: 8),
                    const Text('Session Manager', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                    const SizedBox(width: 12),
                    ValueListenableBuilder<bool>(
                      valueListenable: _store.isConnectedNotifier,
                      builder: (context, connected, _) {
                        final badgeColor = connected ? const Color(0xFF10B981) : const Color(0xFFD97706);
                        return Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                          decoration: BoxDecoration(
                            color: badgeColor.withOpacity(0.14),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.circle, size: 8, color: badgeColor),
                              const SizedBox(width: 5),
                              Text(
                                connected ? 'SQLite WAL Read-Only' : 'Demo Fallback',
                                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: badgeColor),
                              ),
                            ],
                          ),
                        );
                      },
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: ValueListenableBuilder<String>(
                        valueListenable: _store.dbPathNotifier,
                        builder: (context, path, _) {
                          return Text(
                            path,
                            style: WinAdaptiveTheme.monoTextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                            overflow: TextOverflow.ellipsis,
                          );
                        },
                      ),
                    ),
                    ValueListenableBuilder<SmCliResult?>(
                      valueListenable: _cliRunner.lastResultNotifier,
                      builder: (context, last, _) {
                        if (last == null) return const SizedBox.shrink();
                        return Padding(
                          padding: const EdgeInsets.only(right: 8),
                          child: Text(
                            'Last CLI: ${last.command} (${last.ok ? last.summary : 'err'})',
                            style: TextStyle(fontSize: 11, color: last.ok ? cs.onSurfaceVariant : cs.error),
                          ),
                        );
                      },
                    ),
                    TextButton.icon(
                      onPressed: _showArchiveAndImportDialog,
                      icon: const Icon(Icons.folder_open, size: 15),
                      label: const Text('Archive / Import', style: TextStyle(fontSize: 12)),
                    ),
                    IconButton(
                      tooltip: 'Reload SQLite Store (F5 / Ctrl+R)',
                      icon: const Icon(Icons.refresh, size: 17),
                      onPressed: _triggerReload,
                    ),
                    ValueListenableBuilder<ThemeMode>(
                      valueListenable: widget.themeModeNotifier,
                      builder: (context, mode, _) {
                        final icon = switch (mode) {
                          ThemeMode.system => Icons.brightness_auto,
                          ThemeMode.light => Icons.light_mode_outlined,
                          ThemeMode.dark => Icons.dark_mode_outlined,
                        };
                        return IconButton(
                          tooltip: 'Theme: ${mode.name} (click to switch)',
                          icon: Icon(icon, size: 17),
                          onPressed: _cycleThemeMode,
                        );
                      },
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Row(
                  children: [
                    NavigationRail(
                      selectedIndex: _selectedIndex,
                      onDestinationSelected: (index) => setState(() => _selectedIndex = index),
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
                    VerticalDivider(width: 1, thickness: 1, color: theme.dividerColor),
                    Expanded(
                      child: IndexedStack(
                        index: _selectedIndex,
                        children: [
                          // Responsive wide-screen split master-detail layout (>= 1100px)
                          isWide
                              ? Row(
                                  children: [
                                    SizedBox(
                                      width: 440,
                                      child: SessionListView(
                                        store: _store,
                                        refreshTick: _refreshTick,
                                        selectedConversationId: _selectedConversationId,
                                        onSelectSession: _navigateToConversation,
                                      ),
                                    ),
                                    VerticalDivider(width: 1, thickness: 1, color: theme.dividerColor),
                                    Expanded(
                                      child: BranchTreeReaderView(
                                        store: _store,
                                        refreshTick: _refreshTick,
                                        conversationId: _selectedConversationId,
                                        onSelectOtherSession: _navigateToConversation,
                                      ),
                                    ),
                                  ],
                                )
                              : SessionListView(
                                  store: _store,
                                  refreshTick: _refreshTick,
                                  selectedConversationId: _selectedConversationId,
                                  onSelectSession: _navigateToConversation,
                                ),
                          BranchTreeReaderView(
                            store: _store,
                            refreshTick: _refreshTick,
                            conversationId: _selectedConversationId,
                            onSelectOtherSession: _navigateToConversation,
                          ),
                          FullTextSearchView(
                            store: _store,
                            searchFocusNode: _searchFocusNode,
                            onSelectSession: _navigateToConversation,
                          ),
                          IntegrityReportView(
                            store: _store,
                            cliRunner: _cliRunner,
                            refreshTick: _refreshTick,
                            onDataChanged: _triggerReload,
                            onOpenConversation: _navigateToConversation,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
