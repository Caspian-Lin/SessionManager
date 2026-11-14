import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'data/archive_direct_store.dart';
import 'data/local_agent_discovery.dart';
import 'data/sm_cli_runner.dart';
import 'l10n/app_strings.dart';
import 'models.dart';
import 'theme.dart';
import 'views/branch_reader_view.dart';
import 'views/import_view.dart';
import 'views/integrity_view.dart';
import 'views/search_view.dart';
import 'views/session_list_view.dart';

void main() {
  runApp(const SessionManagerApp());
}

class SessionManagerApp extends StatefulWidget {
  final ArchiveDirectStore? storeOverride;
  final SmCliRunner? cliRunnerOverride;
  final LocalAgentDiscoveryService? discoveryOverride;
  final AppLocale initialLocale;
  final ThemeMode initialThemeMode;
  final int initialTabIndex;

  const SessionManagerApp({
    super.key,
    this.storeOverride,
    this.cliRunnerOverride,
    this.discoveryOverride,
    this.initialLocale = AppLocale.zh,
    this.initialThemeMode = ThemeMode.light,
    this.initialTabIndex = 0,
  });

  @override
  State<SessionManagerApp> createState() => _SessionManagerAppState();
}

class _SessionManagerAppState extends State<SessionManagerApp> {
  late final ValueNotifier<ThemeMode> _themeMode;
  late final ValueNotifier<AppLocale> _locale;

  @override
  void initState() {
    super.initState();
    _themeMode = ValueNotifier<ThemeMode>(widget.initialThemeMode);
    _locale = ValueNotifier<AppLocale>(widget.initialLocale);
  }

  @override
  void dispose() {
    _themeMode.dispose();
    _locale.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AppStringsScope(
      notifier: _locale,
      child: ValueListenableBuilder<ThemeMode>(
        valueListenable: _themeMode,
        builder: (context, mode, _) {
          return MaterialApp(
            title: 'Session Manager',
            debugShowCheckedModeBanner: false,
            themeMode: mode,
            theme: GoogleMaterialTheme.light(),
            darkTheme: GoogleMaterialTheme.dark(),
            home: MainShell(
              themeModeNotifier: _themeMode,
              localeNotifier: _locale,
              storeOverride: widget.storeOverride,
              cliRunnerOverride: widget.cliRunnerOverride,
              discoveryOverride: widget.discoveryOverride,
              initialTabIndex: widget.initialTabIndex,
            ),
          );
        },
      ),
    );
  }
}

class MainShell extends StatefulWidget {
  final ValueNotifier<ThemeMode> themeModeNotifier;
  final ValueNotifier<AppLocale> localeNotifier;
  final ArchiveDirectStore? storeOverride;
  final SmCliRunner? cliRunnerOverride;
  final LocalAgentDiscoveryService? discoveryOverride;
  final int initialTabIndex;

  const MainShell({
    super.key,
    required this.themeModeNotifier,
    required this.localeNotifier,
    this.storeOverride,
    this.cliRunnerOverride,
    this.discoveryOverride,
    this.initialTabIndex = 0,
  });

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  late int _selectedIndex;
  late final ArchiveDirectStore _store;
  late final SmCliRunner _cliRunner;
  late final LocalAgentDiscoveryService _discovery;
  late final bool _ownsStore;
  final ValueNotifier<int> _refreshTick = ValueNotifier<int>(0);
  final FocusNode _searchFocusNode = FocusNode();
  int? _selectedConversationId;

  @override
  void initState() {
    super.initState();
    _selectedIndex = widget.initialTabIndex;
    _ownsStore = widget.storeOverride == null;
    _store = widget.storeOverride ?? ArchiveDirectStore();
    _cliRunner = widget.cliRunnerOverride ?? SmCliRunner(store: _store);
    _discovery = widget.discoveryOverride ?? const LocalAgentDiscoveryService();
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
        _selectedIndex = 2; // Reader tab on narrow screens or when jumping from Search/Integrity
      }
    });
  }

  void _cycleThemeMode() {
    final current = widget.themeModeNotifier.value;
    widget.themeModeNotifier.value = switch (current) {
      ThemeMode.light => ThemeMode.dark,
      ThemeMode.dark => ThemeMode.system,
      ThemeMode.system => ThemeMode.light,
    };
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final isWide = MediaQuery.sizeOf(context).width >= 1100;

    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.keyF, control: true): () {
          setState(() => _selectedIndex = 3);
          _searchFocusNode.requestFocus();
        },
        const SingleActivator(LogicalKeyboardKey.keyO, control: true): () {
          setState(() => _selectedIndex = 1);
        },
        const SingleActivator(LogicalKeyboardKey.keyR, control: true): _triggerReload,
        const SingleActivator(LogicalKeyboardKey.f5): _triggerReload,
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          body: Column(
            children: [
              // Google Material 3 Clean Top App Bar
              Container(
                height: 56,
                padding: const EdgeInsets.symmetric(horizontal: 18),
                decoration: BoxDecoration(
                  color: cs.surfaceContainerLow,
                  border: Border(bottom: BorderSide(color: theme.dividerColor)),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 34,
                      height: 34,
                      decoration: BoxDecoration(
                        color: cs.primaryContainer,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Icon(Icons.archive_outlined, size: 19, color: cs.onPrimaryContainer),
                    ),
                    const SizedBox(width: 12),
                    Text(s.appTitle, style: theme.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                    const SizedBox(width: 12),
                    ValueListenableBuilder<bool>(
                      valueListenable: _store.isConnectedNotifier,
                      builder: (context, connected, _) {
                        final badgeColor = connected ? const Color(0xFF137333) : const Color(0xFFB06000);
                        return Tooltip(
                          message: _store.dbPath,
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                            decoration: BoxDecoration(
                              color: badgeColor.withOpacity(0.12),
                              borderRadius: BorderRadius.circular(20),
                            ),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.circle, size: 8, color: badgeColor),
                                const SizedBox(width: 6),
                                Text(
                                  connected ? s.statusDirectConnected : s.statusDemoMode,
                                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: badgeColor),
                                ),
                              ],
                            ),
                          ),
                        );
                      },
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: ValueListenableBuilder<String>(
                        valueListenable: _store.dbPathNotifier,
                        builder: (context, path, _) {
                          return Text(
                            path,
                            style: GoogleMaterialTheme.monoTextStyle(fontSize: 11.5, color: cs.onSurfaceVariant),
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
                          padding: const EdgeInsets.only(right: 12),
                          child: Container(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                            decoration: BoxDecoration(
                              color: last.ok ? cs.surfaceContainerHigh : cs.errorContainer,
                              borderRadius: BorderRadius.circular(20),
                            ),
                            child: Text(
                              '${last.command}: ${last.ok ? last.summary : 'err'}',
                              style: TextStyle(
                                fontSize: 11.5,
                                color: last.ok ? cs.onSurfaceVariant : cs.onErrorContainer,
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                    // Bilingual 中文 / EN Switcher
                    ValueListenableBuilder<AppLocale>(
                      valueListenable: widget.localeNotifier,
                      builder: (context, loc, _) {
                        return SegmentedButton<AppLocale>(
                          showSelectedIcon: false,
                          style: SegmentedButton.styleFrom(
                            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 0),
                            visualDensity: VisualDensity.compact,
                            textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                          ),
                          segments: const [
                            ButtonSegment(value: AppLocale.zh, label: Text('中文')),
                            ButtonSegment(value: AppLocale.en, label: Text('EN')),
                          ],
                          selected: {loc},
                          onSelectionChanged: (val) {
                            widget.localeNotifier.value = val.first;
                          },
                        );
                      },
                    ),
                    const SizedBox(width: 8),
                    IconButton(
                      tooltip: s.reloadTooltip,
                      icon: const Icon(Icons.refresh, size: 20),
                      onPressed: _triggerReload,
                    ),
                    ValueListenableBuilder<ThemeMode>(
                      valueListenable: widget.themeModeNotifier,
                      builder: (context, mode, _) {
                        final icon = switch (mode) {
                          ThemeMode.system => Icons.brightness_auto_outlined,
                          ThemeMode.light => Icons.light_mode_outlined,
                          ThemeMode.dark => Icons.dark_mode_outlined,
                        };
                        return IconButton(
                          tooltip: s.themeTooltip(mode),
                          icon: Icon(icon, size: 20),
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
                      minWidth: 76,
                      destinations: [
                        NavigationRailDestination(
                          icon: const Icon(Icons.forum_outlined),
                          selectedIcon: const Icon(Icons.forum),
                          label: Text(s.navSessions),
                        ),
                        NavigationRailDestination(
                          icon: const Icon(Icons.cloud_download_outlined),
                          selectedIcon: const Icon(Icons.cloud_download),
                          label: Text(s.navImport),
                        ),
                        NavigationRailDestination(
                          icon: const Icon(Icons.alt_route_outlined),
                          selectedIcon: const Icon(Icons.alt_route),
                          label: Text(s.navReader),
                        ),
                        NavigationRailDestination(
                          icon: const Icon(Icons.search_outlined),
                          selectedIcon: const Icon(Icons.search),
                          label: Text(s.navSearch),
                        ),
                        NavigationRailDestination(
                          icon: const Icon(Icons.fact_check_outlined),
                          selectedIcon: const Icon(Icons.fact_check),
                          label: Text(s.navIntegrity),
                        ),
                      ],
                    ),
                    VerticalDivider(width: 1, thickness: 1, color: theme.dividerColor),
                    Expanded(
                      child: IndexedStack(
                        index: _selectedIndex,
                        children: [
                          isWide
                              ? Row(
                                  children: [
                                    SizedBox(
                                      width: 420,
                                      child: SessionListView(
                                        store: _store,
                                        refreshTick: _refreshTick,
                                        selectedConversationId: _selectedConversationId,
                                        onSelectSession: _navigateToConversation,
                                        onGoToImport: () => setState(() => _selectedIndex = 1),
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
                                  onGoToImport: () => setState(() => _selectedIndex = 1),
                                ),
                          ImportView(
                            store: _store,
                            cliRunner: _cliRunner,
                            discoveryService: _discovery,
                            onDataChanged: _triggerReload,
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
