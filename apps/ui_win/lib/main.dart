import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'data/app_settings.dart';
import 'data/archive_direct_store.dart';
import 'data/local_agent_discovery.dart';
import 'data/perf_logger.dart';
import 'data/sm_cli_runner.dart';
import 'l10n/app_strings.dart';
import 'models.dart';
import 'platform/window_chrome.dart';
import 'theme.dart';
import 'views/branch_reader_view.dart';
import 'views/import_view.dart';
import 'views/integrity_view.dart';
import 'views/search_view.dart';
import 'views/session_list_view.dart';
import 'views/settings_view.dart';
import 'widgets/app_title_bar.dart';
import 'widgets/gm3_surface.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  WindowChrome.attach();
  runApp(const SessionManagerApp());
}

class SessionManagerApp extends StatefulWidget {
  final ArchiveDirectStore? storeOverride;
  final SmCliRunner? cliRunnerOverride;
  final LocalAgentDiscoveryService? discoveryOverride;
  final AppSettingsController? settingsOverride;
  final AppLocale initialLocale;
  final ThemeMode initialThemeMode;
  final int initialTabIndex;

  const SessionManagerApp({
    super.key,
    this.storeOverride,
    this.cliRunnerOverride,
    this.discoveryOverride,
    this.settingsOverride,
    this.initialLocale = AppLocale.zh,
    this.initialThemeMode = ThemeMode.light,
    this.initialTabIndex = 0,
  });

  @override
  State<SessionManagerApp> createState() => _SessionManagerAppState();
}

class _SessionManagerAppState extends State<SessionManagerApp> {
  late final AppSettingsController _settings;
  late final bool _ownsSettings;
  late final ValueNotifier<ThemeMode> _themeMode;
  late final ValueNotifier<AppLocale> _locale;

  @override
  void initState() {
    super.initState();
    _ownsSettings = widget.settingsOverride == null;
    _settings = widget.settingsOverride ??
        AppSettingsController(
          locale: widget.initialLocale,
          themeMode: widget.initialThemeMode,
        );
    _themeMode = ValueNotifier<ThemeMode>(_settings.themeMode);
    _locale = ValueNotifier<AppLocale>(_settings.locale);

    _settings.addListener(_syncFromSettings);
    _themeMode.addListener(_syncThemeToSettings);
    _locale.addListener(_syncLocaleToSettings);
  }

  void _syncFromSettings() {
    if (_themeMode.value != _settings.themeMode) {
      _themeMode.value = _settings.themeMode;
    }
    if (_locale.value != _settings.locale) {
      _locale.value = _settings.locale;
    }
  }

  void _syncThemeToSettings() {
    if (_settings.themeMode != _themeMode.value) {
      _settings.setThemeMode(_themeMode.value);
    }
  }

  void _syncLocaleToSettings() {
    if (_settings.locale != _locale.value) {
      _settings.setLocale(_locale.value);
    }
  }

  @override
  void dispose() {
    _settings.removeListener(_syncFromSettings);
    _themeMode.removeListener(_syncThemeToSettings);
    _locale.removeListener(_syncLocaleToSettings);
    _themeMode.dispose();
    _locale.dispose();
    if (_ownsSettings) {
      _settings.dispose();
    }
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
              settings: _settings,
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
  final AppSettingsController settings;
  final ArchiveDirectStore? storeOverride;
  final SmCliRunner? cliRunnerOverride;
  final LocalAgentDiscoveryService? discoveryOverride;
  final int initialTabIndex;

  const MainShell({
    super.key,
    required this.themeModeNotifier,
    required this.localeNotifier,
    required this.settings,
    this.storeOverride,
    this.cliRunnerOverride,
    this.discoveryOverride,
    this.initialTabIndex = 0,
  });

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  static const double _wideBreakpoint = 1100;

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

    if (widget.storeOverride == null) {
      widget.settings.attachSettingsDir(_store.archiveRoot);
    } else {
      PerfLogger.instance.archiveRoot = _store.archiveRoot;
    }
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
    final connected = _store.checkConnection();
    if (widget.storeOverride == null) {
      widget.settings.attachSettingsDir(_store.archiveRoot);
    } else {
      PerfLogger.instance.archiveRoot = _store.archiveRoot;
    }
    if (!connected && _selectedConversationId != null) {
      setState(() => _selectedConversationId = null);
    }
    _refreshTick.value++;
  }

  void _navigateToConversation(int id) {
    setState(() {
      _selectedConversationId = id;
      final wide = MediaQuery.sizeOf(context).width >= _wideBreakpoint;
      if (!wide || _selectedIndex != 0) {
        _selectedIndex = 2;
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
    final surfaces = Gm3Surfaces.of(context);
    final isWide = MediaQuery.sizeOf(context).width >= _wideBreakpoint;

    return CallbackShortcuts(
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.keyF, control: true): () {
          setState(() => _selectedIndex = 3);
          _searchFocusNode.requestFocus();
        },
        const SingleActivator(LogicalKeyboardKey.keyO, control: true): () {
          setState(() => _selectedIndex = 1);
        },
        const SingleActivator(LogicalKeyboardKey.keyR, control: true):
            _triggerReload,
        const SingleActivator(LogicalKeyboardKey.f5): _triggerReload,
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          backgroundColor: surfaces.canvas,
          body: ColoredBox(
            color: surfaces.canvas,
            child: Column(
              children: <Widget>[
                ValueListenableBuilder<bool>(
                  valueListenable: _store.isConnectedNotifier,
                  builder: (context, connected, _) {
                    return ValueListenableBuilder<String>(
                      valueListenable: _store.dbPathNotifier,
                      builder: (context, dbPath, __) {
                        return AppTitleBar(
                          appTitle: s.appTitle,
                          statusLabel: connected
                              ? s.statusDirectConnected
                              : s.statusNotInitialized,
                          statusConnected: connected,
                          dbPath: dbPath,
                          localeNotifier: widget.localeNotifier,
                          themeModeNotifier: widget.themeModeNotifier,
                          onReload: _triggerReload,
                          onCycleTheme: _cycleThemeMode,
                          trailingBadge: _CliBadge(runner: _cliRunner),
                        );
                      },
                    );
                  },
                ),
                Expanded(
                  child: Row(
                    children: <Widget>[
                      _NavigationRailPane(
                        selectedIndex: _selectedIndex,
                        onDestinationSelected: (index) =>
                            setState(() => _selectedIndex = index),
                        strings: s,
                      ),
                      Expanded(
                        child: _ContentSheet(
                          child: IndexedStack(
                            index: _selectedIndex,
                            children: <Widget>[
                              isWide
                                  ? _WideSessionsPane(
                                      store: _store,
                                      cliRunner: _cliRunner,
                                      settings: widget.settings,
                                      refreshTick: _refreshTick,
                                      isActiveTab: _selectedIndex == 0,
                                      selectedConversationId:
                                          _selectedConversationId,
                                      onSelectSession: _navigateToConversation,
                                      onDataChanged: _triggerReload,
                                      onGoToImport: () =>
                                          setState(() => _selectedIndex = 1),
                                    )
                                  : SessionListView(
                                      store: _store,
                                      cliRunner: _cliRunner,
                                      settings: widget.settings,
                                      refreshTick: _refreshTick,
                                      selectedConversationId:
                                          _selectedConversationId,
                                      onSelectSession: _navigateToConversation,
                                      onDataChanged: _triggerReload,
                                      onGoToImport: () =>
                                          setState(() => _selectedIndex = 1),
                                    ),
                              ImportView(
                                store: _store,
                                cliRunner: _cliRunner,
                                discoveryService: _discovery,
                                onDataChanged: _triggerReload,
                              ),
                              BranchTreeReaderView(
                                store: _store,
                                cliRunner: _cliRunner,
                                settings: widget.settings,
                                refreshTick: _refreshTick,
                                conversationId: (!isWide || _selectedIndex == 2)
                                    ? _selectedConversationId
                                    : null,
                                onSelectOtherSession: _navigateToConversation,
                                onDataChanged: _triggerReload,
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
                              SettingsView(
                                settings: widget.settings,
                                store: _store,
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
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

class _ContentSheet extends StatelessWidget {
  const _ContentSheet({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final surfaces = Gm3Surfaces.of(context);
    return ClipRRect(
      borderRadius: const BorderRadius.only(
        topLeft: Radius.circular(Gm3.radiusLg),
        topRight: Radius.circular(Gm3.radiusLg),
      ),
      child: ColoredBox(
        color: surfaces.panel,
        child: child,
      ),
    );
  }
}

class _NavigationRailPane extends StatelessWidget {
  const _NavigationRailPane({
    required this.selectedIndex,
    required this.onDestinationSelected,
    required this.strings,
  });

  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final AppStrings strings;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: Gm3.railWidth,
      child: NavigationRail(
        selectedIndex: selectedIndex,
        onDestinationSelected: onDestinationSelected,
        labelType: NavigationRailLabelType.all,
        groupAlignment: -1,
        minWidth: Gm3.railWidth,
        minExtendedWidth: 256,
        leading: const SizedBox(height: 8),
        destinations: <NavigationRailDestination>[
          NavigationRailDestination(
            icon: const Icon(Icons.forum_outlined),
            selectedIcon: const Icon(Icons.forum),
            label: Text(strings.navSessions),
          ),
          NavigationRailDestination(
            icon: const Icon(Icons.cloud_download_outlined),
            selectedIcon: const Icon(Icons.cloud_download),
            label: Text(strings.navImport),
          ),
          NavigationRailDestination(
            icon: const Icon(Icons.alt_route_outlined),
            selectedIcon: const Icon(Icons.alt_route),
            label: Text(strings.navReader),
          ),
          NavigationRailDestination(
            icon: const Icon(Icons.search_outlined),
            selectedIcon: const Icon(Icons.search),
            label: Text(strings.navSearch),
          ),
          NavigationRailDestination(
            icon: const Icon(Icons.fact_check_outlined),
            selectedIcon: const Icon(Icons.fact_check),
            label: Text(strings.navIntegrity),
          ),
          NavigationRailDestination(
            icon: const Icon(Icons.settings_outlined),
            selectedIcon: const Icon(Icons.settings),
            label: Text(strings.navSettings),
          ),
        ],
      ),
    );
  }
}

/// Session list + branch reader inside one sheet, split by a draggable hairline.
class _WideSessionsPane extends StatefulWidget {
  const _WideSessionsPane({
    required this.store,
    required this.cliRunner,
    required this.settings,
    required this.refreshTick,
    required this.isActiveTab,
    required this.selectedConversationId,
    required this.onSelectSession,
    required this.onDataChanged,
    required this.onGoToImport,
  });

  final ArchiveDirectStore store;
  final SmCliRunner cliRunner;
  final AppSettingsController settings;
  final ValueNotifier<int> refreshTick;
  final bool isActiveTab;
  final int? selectedConversationId;
  final ValueChanged<int> onSelectSession;
  final VoidCallback onDataChanged;
  final VoidCallback onGoToImport;

  @override
  State<_WideSessionsPane> createState() => _WideSessionsPaneState();
}

class _WideSessionsPaneState extends State<_WideSessionsPane> {
  double? _dragWidth;
  bool _hoveringSplitter = false;

  @override
  Widget build(BuildContext context) {
    final surfaces = Gm3Surfaces.of(context);
    final cs = Theme.of(context).colorScheme;
    final paneWidth = (_dragWidth ?? widget.settings.sessionListWidth)
        .clamp(220.0, 560.0);

    return Row(
      children: <Widget>[
        SizedBox(
          width: paneWidth,
          child: SessionListView(
            store: widget.store,
            cliRunner: widget.cliRunner,
            settings: widget.settings,
            refreshTick: widget.refreshTick,
            selectedConversationId: widget.selectedConversationId,
            onSelectSession: widget.onSelectSession,
            onDataChanged: widget.onDataChanged,
            onGoToImport: widget.onGoToImport,
          ),
        ),
        MouseRegion(
          cursor: SystemMouseCursors.resizeColumn,
          onEnter: (_) => setState(() => _hoveringSplitter = true),
          onExit: (_) => setState(() => _hoveringSplitter = false),
          child: GestureDetector(
            behavior: HitTestBehavior.translucent,
            onHorizontalDragStart: (_) {
              setState(() => _dragWidth = widget.settings.sessionListWidth);
            },
            onHorizontalDragUpdate: (details) {
              setState(() {
                final cur = _dragWidth ?? widget.settings.sessionListWidth;
                _dragWidth = (cur + details.delta.dx).clamp(220.0, 560.0);
              });
            },
            onHorizontalDragEnd: (_) {
              final finalW = _dragWidth;
              if (finalW != null) {
                widget.settings.setSessionListWidth(finalW);
              }
              setState(() => _dragWidth = null);
            },
            child: SizedBox(
              width: 7,
              child: Center(
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 120),
                  width: _hoveringSplitter || _dragWidth != null ? 2.5 : 1,
                  color: _hoveringSplitter || _dragWidth != null
                      ? cs.primary.withOpacity(0.55)
                      : surfaces.hairline.withOpacity(0.55),
                ),
              ),
            ),
          ),
        ),
        Expanded(
          child: BranchTreeReaderView(
            store: widget.store,
            cliRunner: widget.cliRunner,
            settings: widget.settings,
            refreshTick: widget.refreshTick,
            conversationId:
                widget.isActiveTab ? widget.selectedConversationId : null,
            onSelectOtherSession: widget.onSelectSession,
            onDataChanged: widget.onDataChanged,
          ),
        ),
      ],
    );
  }
}

class _CliBadge extends StatelessWidget {
  const _CliBadge({required this.runner});

  final SmCliRunner runner;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<SmCliResult?>(
      valueListenable: runner.lastResultNotifier,
      builder: (context, last, _) {
        if (last == null) return const SizedBox.shrink();
        return HeaderBadge(
          label: '${last.command}: ${last.ok ? last.summary : 'err'}',
          emphasized: !last.ok,
        );
      },
    );
  }
}
