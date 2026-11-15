import 'dart:io';
import 'package:path/path.dart' as p;

/// Single detected installation method for a harness (e.g. npm `.cmd`,
/// native `.exe` binary, Scoop, Bun, Desktop app, Store MSIX, or WSL).
class LocalAgentInstallation {
  final String method;
  final String path;

  const LocalAgentInstallation({
    required this.method,
    required this.path,
  });
}

/// Discovered local AI agent harness on the user's machine, combining its
/// session storage directory with all detected runtime/CLI installation methods.
class LocalAgentInstance {
  final String provider;
  final String displayName;
  final String installMethod;
  final String path;
  final bool supportedForImport;
  final int sessionFileCount;
  final bool hasSqliteDb;
  final int totalBytes;
  final DateTime? lastModifiedAt;
  final List<LocalAgentInstallation> installations;

  const LocalAgentInstance({
    required this.provider,
    required this.displayName,
    required this.installMethod,
    required this.path,
    required this.supportedForImport,
    required this.sessionFileCount,
    required this.hasSqliteDb,
    required this.totalBytes,
    this.lastModifiedAt,
    this.installations = const [],
  });

  bool get hasImportableData => sessionFileCount > 0 || hasSqliteDb;

  String get formattedSize {
    if (totalBytes >= 1024 * 1024 * 1024) {
      return '${(totalBytes / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
    }
    if (totalBytes >= 1024 * 1024) {
      return '${(totalBytes / (1024 * 1024)).toStringAsFixed(1)} MB';
    }
    if (totalBytes >= 1024) {
      return '${(totalBytes / 1024).toStringAsFixed(1)} KB';
    }
    return '$totalBytes B';
  }
}

/// Discovers local AI agent harnesses (`codex-local`, `dsh-local`,
/// `claude-code-local`, `opencode-local`) modeled after CC Switch:
///
/// 1. Scans PATH, npm/pnpm/yarn/bun global prefixes, native binary bins,
///    Scoop/WinGet/Choco, Desktop/Store MSIX packages, embedded runtimes,
///    and WSL distros — capturing *multiple simultaneous installation methods*
///    per harness (e.g. native `.exe` + `npm .cmd` + Store MSIX).
/// 2. Safely traverses priority session subdirectories (`sessions/`, `projects/`,
///    `storage/`) per-directory so noisy cache/runtime/sandbox folders never
///    abort or starve session discovery.
class LocalAgentDiscoveryService {
  const LocalAgentDiscoveryService();

  static const Set<String> _skipSubdirs = {
    '.sandbox',
    '.sandbox-bin',
    '.sandbox-secrets',
    '.tmp',
    'tmp',
    'cache',
    'node_modules',
    'dsh-runtimes',
    'ds-harness-remote',
    'packages',
    'vendor_imports',
    'worktrees',
    'shell_snapshots',
    'log',
    'logs',
    'repos',
    'crash',
    'node-fallback',
    'plugin-workspace',
    'image-cache',
    'certs',
    'backup',
    'snapshot',
    'tool-output',
    'shell',
    'session',
    'grshadercache',
    'shadercache',
    'remote-assets-cache',
  };

  Future<List<LocalAgentInstance>> scanLocalInstances({
    Map<String, String>? envOverride,
    bool includeWsl = true,
  }) async {
    final env = envOverride ?? Platform.environment;
    final home = (env['USERPROFILE'] ?? env['HOME'] ?? '').trim();
    final appData = (env['APPDATA'] ?? '').trim();
    final localAppData = (env['LOCALAPPDATA'] ?? '').trim();
    final xdgData = (env['XDG_DATA_HOME'] ??
            (home.isNotEmpty ? p.join(home, '.local', 'share') : ''))
        .trim();

    final installsByProvider = _discoverAllInstallations(
      env: env,
      home: home,
      appData: appData,
      localAppData: localAppData,
    );

    final candidates = <({String provider, String name, String method, String dir, bool supported})>[
      // ── Codex (codex-local) ──
      if ((env['CODEX_HOME'] ?? '').trim().isNotEmpty)
        (provider: 'codex-local', name: 'Codex CLI / Desktop', method: 'CODEX_HOME', dir: env['CODEX_HOME']!.trim(), supported: true),
      if (home.isNotEmpty)
        (provider: 'codex-local', name: 'Codex CLI / Desktop', method: 'User Home', dir: p.join(home, '.codex'), supported: true),
      if (home.isNotEmpty)
        (provider: 'codex-local', name: 'Codex (Scoop)', method: 'Scoop', dir: p.join(home, 'scoop', 'persist', 'codex', '.codex'), supported: true),
      if (appData.isNotEmpty)
        (provider: 'codex-local', name: 'Codex (AppData)', method: 'AppData', dir: p.join(appData, 'codex'), supported: true),
      if (localAppData.isNotEmpty) ..._discoverMsixCodexDataDirs(localAppData),

      // ── DSH (dsh-local) ──
      if ((env['DSH_HOME'] ?? '').trim().isNotEmpty)
        (provider: 'dsh-local', name: 'DSH Agent', method: 'DSH_HOME', dir: env['DSH_HOME']!.trim(), supported: true),
      if (home.isNotEmpty)
        (provider: 'dsh-local', name: 'DSH Agent', method: 'User Home', dir: p.join(home, '.dsh'), supported: true),
      if (appData.isNotEmpty)
        (provider: 'dsh-local', name: 'DSH Agent', method: 'AppData', dir: p.join(appData, 'dsh'), supported: true),
      if (localAppData.isNotEmpty)
        (provider: 'dsh-local', name: 'DSH Agent', method: 'LocalAppData', dir: p.join(localAppData, 'dsh'), supported: true),

      // ── Claude Code (claude-code-local) ──
      if ((env['CLAUDE_CONFIG_DIR'] ?? '').trim().isNotEmpty)
        (provider: 'claude-code-local', name: 'Claude Code', method: 'CLAUDE_CONFIG_DIR', dir: env['CLAUDE_CONFIG_DIR']!.trim(), supported: true),
      if (home.isNotEmpty)
        (provider: 'claude-code-local', name: 'Claude Code', method: 'User Home', dir: p.join(home, '.claude'), supported: true),
      if (appData.isNotEmpty)
        (provider: 'claude-code-local', name: 'Claude Code', method: 'AppData', dir: p.join(appData, 'Claude'), supported: true),
      if (localAppData.isNotEmpty)
        (provider: 'claude-code-local', name: 'Claude Code', method: 'LocalAppData', dir: p.join(localAppData, 'claude-code'), supported: true),

      // ── ZCode (zcode-local) ──
      if ((env['ZCODE_HOME'] ?? '').trim().isNotEmpty)
        (provider: 'zcode-local', name: 'ZCode CLI / Desktop', method: 'ZCODE_HOME', dir: env['ZCODE_HOME']!.trim(), supported: true),
      if (home.isNotEmpty)
        (provider: 'zcode-local', name: 'ZCode CLI / Desktop', method: 'User Home', dir: p.join(home, '.zcode'), supported: true),
      if (appData.isNotEmpty)
        (provider: 'zcode-local', name: 'ZCode (AppData)', method: 'AppData', dir: p.join(appData, 'zcode'), supported: true),

      // ── OpenCode (opencode-local) ──
      if ((env['OPENCODE_DATA_DIR'] ?? '').trim().isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'OPENCODE_DATA_DIR', dir: env['OPENCODE_DATA_DIR']!.trim(), supported: true),
      if (xdgData.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'XDG Data', dir: p.join(xdgData, 'opencode'), supported: true),
      if (home.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'User Home', dir: p.join(home, '.opencode'), supported: true),
      if (home.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode (Scoop)', method: 'Scoop', dir: p.join(home, 'scoop', 'persist', 'opencode'), supported: true),
      if (appData.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'AppData', dir: p.join(appData, 'opencode'), supported: true),
      if (localAppData.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'LocalAppData', dir: p.join(localAppData, 'opencode'), supported: true),
    ];

    if (includeWsl && Platform.isWindows) {
      candidates.addAll(_discoverWslCandidates());
    }

    final seenPaths = <String>{};
    final found = <LocalAgentInstance>[];
    final providersWithDataCard = <String>{};

    for (final c in candidates) {
      final norm = p.normalize(c.dir).toLowerCase();
      if (!seenPaths.add(norm)) continue;
      final dir = Directory(c.dir);
      if (!dir.existsSync()) continue;

      final stats = _inspectInstanceDirectory(c.provider, dir);
      final isWsl = c.method == 'WSL';
      final providerInstalls = isWsl
          ? <LocalAgentInstallation>[LocalAgentInstallation(method: 'WSL', path: p.normalize(c.dir))]
          : _mergeDirSpecificInstallations(
              c.provider,
              dir,
              installsByProvider[c.provider] ?? const [],
            );

      final hasConfigHint = providerInstalls.isNotEmpty || _hasConfigMarker(c.provider, dir);
      if (stats.sessionFileCount == 0 && !stats.hasSqliteDb && !hasConfigHint) {
        continue;
      }

      providersWithDataCard.add(c.provider);
      found.add(
        LocalAgentInstance(
          provider: c.provider,
          displayName: c.name,
          installMethod: providerInstalls.isNotEmpty ? providerInstalls.first.method : c.method,
          path: p.normalize(c.dir),
          supportedForImport: c.supported,
          sessionFileCount: stats.sessionFileCount,
          hasSqliteDb: stats.hasSqliteDb,
          totalBytes: stats.totalBytes,
          lastModifiedAt: stats.lastModifiedAt,
          installations: providerInstalls,
        ),
      );
    }

    // If a CLI/Desktop harness binary is installed without an active data dir yet,
    // still surface its discovered installations cleanly (mirroring CC Switch).
    const fallbackMeta = <String, ({String name, bool supported})>{
      'codex-local': (name: 'Codex CLI / Desktop', supported: true),
      'dsh-local': (name: 'DSH Agent', supported: true),
      'claude-code-local': (name: 'Claude Code', supported: true),
      'zcode-local': (name: 'ZCode CLI / Desktop', supported: true),
      'opencode-local': (name: 'OpenCode', supported: true),
    };
    for (final entry in installsByProvider.entries) {
      if (providersWithDataCard.contains(entry.key) || entry.value.isEmpty) continue;
      final meta = fallbackMeta[entry.key];
      if (meta == null) continue;
      found.add(
        LocalAgentInstance(
          provider: entry.key,
          displayName: meta.name,
          installMethod: entry.value.first.method,
          path: entry.value.first.path,
          supportedForImport: meta.supported,
          sessionFileCount: 0,
          hasSqliteDb: false,
          totalBytes: 0,
          installations: entry.value,
        ),
      );
    }

    return found;
  }

  List<({String provider, String name, String method, String dir, bool supported})> _discoverMsixCodexDataDirs(
    String localAppData,
  ) {
    final out = <({String provider, String name, String method, String dir, bool supported})>[];
    final pkgRoot = Directory(p.join(localAppData, 'Packages'));
    if (!pkgRoot.existsSync()) return out;
    try {
      for (final ent in pkgRoot.listSync(followLinks: false)) {
        if (ent is! Directory) continue;
        final name = p.basename(ent.path).toLowerCase();
        if (!name.startsWith('openai.codex')) continue;
        for (final sub in [
          p.join(ent.path, 'LocalCache', 'Roaming', '.codex'),
          p.join(ent.path, 'LocalState', '.codex'),
        ]) {
          if (Directory(sub).existsSync()) {
            out.add((
              provider: 'codex-local',
              name: 'Codex (Store MSIX)',
              method: 'Store MSIX',
              dir: sub,
              supported: true,
            ));
          }
        }
      }
    } catch (_) {}
    return out;
  }

  Map<String, List<LocalAgentInstallation>> _discoverAllInstallations({
    required Map<String, String> env,
    required String home,
    required String appData,
    required String localAppData,
  }) {
    final result = <String, List<LocalAgentInstallation>>{
      'codex-local': [],
      'dsh-local': [],
      'claude-code-local': [],
      'zcode-local': [],
      'opencode-local': [],
    };
    final seenByProvider = <String, Set<String>>{
      for (final k in result.keys) k: <String>{},
    };

    void addInstall(String provider, String method, String targetPath) {
      final norm = p.normalize(targetPath);
      if (seenByProvider[provider]!.add(norm.toLowerCase())) {
        result[provider]!.add(LocalAgentInstallation(method: method, path: norm));
      }
    }

    const binNamesByProvider = <String, List<String>>{
      'codex-local': ['codex'],
      'dsh-local': ['dsh'],
      'claude-code-local': ['claude'],
      'zcode-local': ['zcode'],
      'opencode-local': ['opencode'],
    };

    final pathEnv = env['PATH'] ?? env['Path'] ?? '';
    final sep = Platform.isWindows ? ';' : ':';
    final pathDirs = pathEnv
        .split(sep)
        .map((s) => s.trim().replaceAll('"', ''))
        .where((s) => s.isNotEmpty)
        .toList();

    final searchDirs = <({String dir, String? hintMethod})>[
      for (final d in pathDirs) (dir: d, hintMethod: null),
      if (appData.isNotEmpty) (dir: p.join(appData, 'npm'), hintMethod: 'npm (.cmd)'),
      if ((env['PNPM_HOME'] ?? '').trim().isNotEmpty)
        (dir: env['PNPM_HOME']!.trim(), hintMethod: 'pnpm'),
      if (localAppData.isNotEmpty) (dir: p.join(localAppData, 'pnpm'), hintMethod: 'pnpm'),
      if (localAppData.isNotEmpty) (dir: p.join(localAppData, 'Yarn', 'bin'), hintMethod: 'Yarn'),
      if (home.isNotEmpty) (dir: p.join(home, '.bun', 'bin'), hintMethod: 'Bun'),
      if (home.isNotEmpty) (dir: p.join(home, '.local', 'bin'), hintMethod: 'Native Binary'),
      if (home.isNotEmpty) (dir: p.join(home, '.cargo', 'bin'), hintMethod: 'Native Binary'),
      if (home.isNotEmpty) (dir: p.join(home, 'scoop', 'shims'), hintMethod: 'Scoop'),
      if (localAppData.isNotEmpty)
        (dir: p.join(localAppData, 'Microsoft', 'WinGet', 'Links'), hintMethod: 'WinGet'),
      if (Platform.isWindows) ...[
        (dir: r'C:\Program_Files\nodejs', hintMethod: null),
        (dir: r'C:\Program Files\nodejs', hintMethod: null),
        (dir: r'C:\ProgramData\chocolatey\bin', hintMethod: 'Chocolatey'),
      ],
    ];

    final visitedScanDirs = <String>{};
    final exts = Platform.isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];

    for (final entry in searchDirs) {
      final normDir = p.normalize(entry.dir).toLowerCase();
      if (!visitedScanDirs.add(normDir)) continue;
      final dir = Directory(entry.dir);
      if (!dir.existsSync()) continue;

      for (final provEntry in binNamesByProvider.entries) {
        final provider = provEntry.key;
        for (final binBase in provEntry.value) {
          var matchedInDir = false;
          for (final ext in exts) {
            // Avoid counting npm's extensionless POSIX shim alongside `.cmd` in the same dir.
            if (Platform.isWindows && ext.isEmpty && matchedInDir) continue;
            final candidate = File(p.join(entry.dir, '$binBase$ext'));
            if (!candidate.existsSync()) continue;
            matchedInDir = true;
            final method = _classifyBinaryMethod(
              candidate.path,
              ext,
              hintMethod: entry.hintMethod,
            );
            addInstall(provider, method, candidate.path);
          }
        }
      }
    }

    // Native / Desktop / Store MSIX installations on Windows
    if (localAppData.isNotEmpty) {
      final desktopChecks = <({String provider, String method, String rel})>[
        (provider: 'codex-local', method: 'Desktop App', rel: p.join('Programs', 'OpenAI', 'Codex')),
        (provider: 'opencode-local', method: 'Desktop App', rel: p.join('Programs', '@opencodedesktop')),
        (provider: 'zcode-local', method: 'Desktop App', rel: p.join('Programs', 'zcode')),
        (provider: 'zcode-local', method: 'Desktop App', rel: p.join('Programs', 'ZCode')),
        (provider: 'claude-code-local', method: 'Desktop App', rel: p.join('Programs', 'Claude')),
        (provider: 'claude-code-local', method: 'Desktop App', rel: p.join('AnthropicClaude')),
      ];
      for (final chk in desktopChecks) {
        final d = Directory(p.join(localAppData, chk.rel));
        if (d.existsSync()) addInstall(chk.provider, chk.method, d.path);
      }

      final pkgRoot = Directory(p.join(localAppData, 'Packages'));
      if (pkgRoot.existsSync()) {
        try {
          for (final ent in pkgRoot.listSync(followLinks: false)) {
            if (ent is! Directory) continue;
            final name = p.basename(ent.path).toLowerCase();
            if (name.startsWith('openai.codex_')) {
              addInstall('codex-local', 'Store MSIX', ent.path);
            } else if (name.startsWith('anthropic') || name.startsWith('claude_')) {
              addInstall('claude-code-local', 'Store MSIX', ent.path);
            }
          }
        } catch (_) {}
      }
    }

    if (appData.isNotEmpty && Directory(p.join(appData, 'Claude')).existsSync()) {
      addInstall('claude-code-local', 'Claude Desktop', p.join(appData, 'Claude'));
    }
    if (appData.isNotEmpty && Directory(p.join(appData, 'zcode')).existsSync()) {
      addInstall('zcode-local', 'ZCode Desktop', p.join(appData, 'zcode'));
    }

    return result;
  }

  List<LocalAgentInstallation> _mergeDirSpecificInstallations(
    String provider,
    Directory dataDir,
    List<LocalAgentInstallation> globalInstalls,
  ) {
    final merged = <LocalAgentInstallation>[...globalInstalls];
    final seen = merged.map((e) => e.path.toLowerCase()).toSet();

    void addLocal(String method, String path) {
      final norm = p.normalize(path);
      if (seen.add(norm.toLowerCase())) {
        merged.add(LocalAgentInstallation(method: method, path: norm));
      }
    }

    if (provider == 'dsh-local') {
      final runtimes = Directory(p.join(dataDir.path, 'dsh-runtimes'));
      if (runtimes.existsSync()) {
        addLocal('Embedded Runtime', runtimes.path);
      }
    } else if (provider == 'codex-local') {
      final binDir = Directory(p.join(dataDir.path, 'bin'));
      if (binDir.existsSync()) {
        addLocal('Codex Bin', binDir.path);
      }
    } else if (provider == 'zcode-local') {
      final cliDir = Directory(p.join(dataDir.path, 'cli'));
      if (cliDir.existsSync()) {
        addLocal('ZCode CLI', cliDir.path);
      }
      final v2Dir = Directory(p.join(dataDir.path, 'v2'));
      if (v2Dir.existsSync()) {
        addLocal('ZCode Desktop v2', v2Dir.path);
      }
    }
    return merged;
  }

  String _classifyBinaryMethod(String fullPath, String ext, {String? hintMethod}) {
    if (hintMethod != null) return hintMethod;
    final lower = fullPath.toLowerCase();
    if (lower.contains(r'\scoop\')) return 'Scoop';
    if (lower.contains(r'\.bun\')) return 'Bun';
    if (lower.contains('pnpm')) return 'pnpm';
    if (lower.contains('yarn')) return 'Yarn';
    if (lower.contains('chocolatey')) return 'Chocolatey';
    if (lower.contains('winget')) return 'WinGet';
    if (ext == '.cmd' || ext == '.bat' || lower.contains('nodejs') || lower.contains(r'\npm\')) {
      return 'npm (.cmd)';
    }
    if (ext == '.exe' || ext.isEmpty) return 'Native Binary';
    return 'CLI';
  }

  bool _hasConfigMarker(String provider, Directory dir) {
    return switch (provider) {
      'codex-local' => File(p.join(dir.path, 'config.toml')).existsSync() ||
          File(p.join(dir.path, 'auth.json')).existsSync(),
      'dsh-local' => File(p.join(dir.path, 'settings.yaml.imported')).existsSync() ||
          Directory(p.join(dir.path, 'sessions')).existsSync(),
      'claude-code-local' => File(p.join(dir.path, 'settings.json')).existsSync() ||
          Directory(p.join(dir.path, 'sessions')).existsSync() ||
          Directory(p.join(dir.path, 'backups')).existsSync(),
      'opencode-local' => File(p.join(dir.path, 'opencode.db')).existsSync() ||
          File(p.join(dir.path, 'auth.json')).existsSync() ||
          Directory(p.join(dir.path, 'storage')).existsSync(),
      'zcode-local' => File(p.join(dir.path, 'cli', 'db', 'db.sqlite')).existsSync() ||
          File(p.join(dir.path, 'v2', 'tasks-index.sqlite')).existsSync() ||
          File(p.join(dir.path, 'cli', 'config.json')).existsSync(),
      _ => false,
    };
  }

  List<({String provider, String name, String method, String dir, bool supported})> _discoverWslCandidates() {
    final wslCandidates = <({String provider, String name, String method, String dir, bool supported})>[];
    try {
      final wslRoot = Directory(r'\\wsl.localhost');
      if (!wslRoot.existsSync()) return wslCandidates;
      for (final distro in wslRoot.listSync(followLinks: false)) {
        if (distro is! Directory) continue;
        final distroName = p.basename(distro.path);
        final homeDir = Directory(p.join(distro.path, 'home'));
        if (!homeDir.existsSync()) continue;
        for (final userDir in homeDir.listSync(followLinks: false)) {
          if (userDir is! Directory) continue;
          wslCandidates.addAll([
            (provider: 'codex-local', name: 'Codex (WSL $distroName)', method: 'WSL', dir: p.join(userDir.path, '.codex'), supported: true),
            (provider: 'dsh-local', name: 'DSH (WSL $distroName)', method: 'WSL', dir: p.join(userDir.path, '.dsh'), supported: true),
            (provider: 'claude-code-local', name: 'Claude Code (WSL $distroName)', method: 'WSL', dir: p.join(userDir.path, '.claude'), supported: true),
            (
              provider: 'opencode-local',
              name: 'OpenCode (WSL $distroName)',
              method: 'WSL',
              dir: p.join(userDir.path, '.local', 'share', 'opencode'),
              supported: true,
            ),
            (
              provider: 'zcode-local',
              name: 'ZCode (WSL $distroName)',
              method: 'WSL',
              dir: p.join(userDir.path, '.zcode'),
              supported: true,
            ),
          ]);
        }
      }
    } catch (_) {
      // Ignore unreachable WSL network shares
    }
    return wslCandidates;
  }

  ({int sessionFileCount, bool hasSqliteDb, int totalBytes, DateTime? lastModifiedAt}) _inspectInstanceDirectory(
    String provider,
    Directory dir,
  ) {
    var sessionFiles = 0;
    var hasSqlite = false;
    var totalBytes = 0;
    DateTime? latest;

    void inspectFile(File ent) {
      try {
        final lower = ent.path.toLowerCase();
        final name = p.basename(lower);
        final isSessionFile = switch (provider) {
          'codex-local' => name.startsWith('rollout-') &&
              (lower.endsWith('.jsonl.zst') || lower.endsWith('.jsonl')),
          'dsh-local' => lower.endsWith('.jsonl.zstd') ||
              lower.endsWith('.jsonl.zst') ||
              lower.endsWith('.jsonl'),
          'claude-code-local' => (lower.contains('projects') ||
                  lower.contains('sessions') ||
                  lower.contains('transcripts')) &&
              lower.endsWith('.jsonl'),
          'opencode-local' =>
              lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.db'),
          'zcode-local' =>
              name == 'db.sqlite' || name == 'tasks-index.sqlite',
          _ => false,
        };
        final isDb = switch (provider) {
          'codex-local' => (name.startsWith('thread_history') || name.startsWith('state_')) &&
              name.endsWith('.sqlite'),
          'opencode-local' => name.endsWith('.db') || name.endsWith('.sqlite'),
          'zcode-local' => name == 'db.sqlite' || name == 'tasks-index.sqlite',
          _ => false,
        };

        if (!isSessionFile && !isDb) return;

        final stat = ent.statSync();
        totalBytes += stat.size;
        if (latest == null || stat.modified.isAfter(latest!)) {
          latest = stat.modified;
        }
        if (isSessionFile) sessionFiles++;
        if (isDb) hasSqlite = true;
      } catch (_) {}
    }

    // 1. Check top-level files (e.g. thread_history_1.sqlite, opencode.db)
    try {
      for (final ent in dir.listSync(recursive: false, followLinks: false)) {
        if (ent is File) inspectFile(ent);
      }
    } catch (_) {}

    // 2. Walk priority data subtrees per-directory so locked or huge cache/sandbox
    //    directories never prevent discovering sessions.
    final prioritySubdirs = switch (provider) {
      'codex-local' => ['sessions', 'archived_sessions', 'sqlite'],
      'dsh-local' => ['sessions'],
      'claude-code-local' => ['projects', 'sessions', 'transcripts'],
      'opencode-local' => ['storage'],
      'zcode-local' => ['cli', 'v2', 'db'],
      _ => <String>[],
    };

    final visitedDirs = <String>{};
    final queue = <Directory>[];
    for (final sub in prioritySubdirs) {
      final subDir = Directory(p.join(dir.path, sub));
      if (subDir.existsSync()) queue.add(subDir);
    }
    if (queue.isEmpty) {
      queue.add(dir);
    }

    var visitedFiles = 0;
    const maxFiles = 10000;
    while (queue.isNotEmpty && visitedFiles < maxFiles) {
      final cur = queue.removeLast();
      final normCur = p.normalize(cur.path).toLowerCase();
      if (!visitedDirs.add(normCur)) continue;

      List<FileSystemEntity> children;
      try {
        children = cur.listSync(recursive: false, followLinks: false);
      } catch (_) {
        continue;
      }

      for (final ent in children) {
        if (ent is File) {
          visitedFiles++;
          inspectFile(ent);
          if (visitedFiles >= maxFiles) break;
        } else if (ent is Directory) {
          final base = p.basename(ent.path).toLowerCase();
          if (_skipSubdirs.contains(base)) continue;
          queue.add(ent);
        }
      }
    }

    return (
      sessionFileCount: sessionFiles,
      hasSqliteDb: hasSqlite,
      totalBytes: totalBytes,
      lastModifiedAt: latest,
    );
  }
}
