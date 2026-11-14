import 'dart:io';
import 'package:path/path.dart' as p;

/// Discovered local AI agent installation instance on the user's machine.
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
  });

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

/// Scans standard Windows install locations, environment overrides, Scoop,
/// XDG data dirs, and optional WSL homes for Codex, DSH, Claude Code, and OpenCode.
class LocalAgentDiscoveryService {
  const LocalAgentDiscoveryService();

  Future<List<LocalAgentInstance>> scanLocalInstances({
    Map<String, String>? envOverride,
    bool includeWsl = true,
  }) async {
    final env = envOverride ?? Platform.environment;
    final home = env['USERPROFILE'] ?? env['HOME'] ?? '';
    final appData = env['APPDATA'] ?? '';
    final localAppData = env['LOCALAPPDATA'] ?? '';
    final xdgData = env['XDG_DATA_HOME'] ?? (home.isNotEmpty ? p.join(home, '.local', 'share') : '');

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
      if (localAppData.isNotEmpty)
        (provider: 'codex-local', name: 'Codex (LocalAppData)', method: 'LocalAppData', dir: p.join(localAppData, 'codex'), supported: true),

      // ── DSH (dsh-local) ──
      if ((env['DSH_HOME'] ?? '').trim().isNotEmpty)
        (provider: 'dsh-local', name: 'DSH Agent', method: 'DSH_HOME', dir: env['DSH_HOME']!.trim(), supported: false),
      if (home.isNotEmpty)
        (provider: 'dsh-local', name: 'DSH Agent', method: 'User Home', dir: p.join(home, '.dsh'), supported: false),
      if (appData.isNotEmpty)
        (provider: 'dsh-local', name: 'DSH Agent', method: 'AppData', dir: p.join(appData, 'dsh'), supported: false),
      if (localAppData.isNotEmpty)
        (provider: 'dsh-local', name: 'DSH Agent', method: 'LocalAppData', dir: p.join(localAppData, 'dsh'), supported: false),

      // ── Claude Code (claude-code-local) ──
      if ((env['CLAUDE_CONFIG_DIR'] ?? '').trim().isNotEmpty)
        (provider: 'claude-code-local', name: 'Claude Code', method: 'CLAUDE_CONFIG_DIR', dir: env['CLAUDE_CONFIG_DIR']!.trim(), supported: false),
      if (home.isNotEmpty)
        (provider: 'claude-code-local', name: 'Claude Code', method: 'User Home', dir: p.join(home, '.claude'), supported: false),
      if (appData.isNotEmpty)
        (provider: 'claude-code-local', name: 'Claude Code', method: 'AppData', dir: p.join(appData, 'Claude'), supported: false),
      if (localAppData.isNotEmpty)
        (provider: 'claude-code-local', name: 'Claude Code', method: 'LocalAppData', dir: p.join(localAppData, 'claude-code'), supported: false),

      // ── OpenCode (opencode-local) ──
      if ((env['OPENCODE_DATA_DIR'] ?? '').trim().isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'OPENCODE_DATA_DIR', dir: env['OPENCODE_DATA_DIR']!.trim(), supported: false),
      if (xdgData.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'XDG Data', dir: p.join(xdgData, 'opencode'), supported: false),
      if (home.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'User Home', dir: p.join(home, '.opencode'), supported: false),
      if (home.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode (Scoop)', method: 'Scoop', dir: p.join(home, 'scoop', 'persist', 'opencode'), supported: false),
      if (appData.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'AppData', dir: p.join(appData, 'opencode'), supported: false),
      if (localAppData.isNotEmpty)
        (provider: 'opencode-local', name: 'OpenCode', method: 'LocalAppData', dir: p.join(localAppData, 'opencode'), supported: false),
    ];

    if (includeWsl && Platform.isWindows) {
      candidates.addAll(_discoverWslCandidates());
    }

    final seenPaths = <String>{};
    final found = <LocalAgentInstance>[];

    for (final c in candidates) {
      final norm = p.normalize(c.dir).toLowerCase();
      if (!seenPaths.add(norm)) continue;
      final dir = Directory(c.dir);
      if (!dir.existsSync()) continue;

      final stats = _inspectInstanceDirectory(c.provider, dir);
      if (stats.sessionFileCount == 0 && !stats.hasSqliteDb) continue;

      found.add(
        LocalAgentInstance(
          provider: c.provider,
          displayName: c.name,
          installMethod: c.method,
          path: p.normalize(c.dir),
          supportedForImport: c.supported,
          sessionFileCount: stats.sessionFileCount,
          hasSqliteDb: stats.hasSqliteDb,
          totalBytes: stats.totalBytes,
          lastModifiedAt: stats.lastModifiedAt,
        ),
      );
    }

    return found;
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
            (provider: 'dsh-local', name: 'DSH (WSL $distroName)', method: 'WSL', dir: p.join(userDir.path, '.dsh'), supported: false),
            (provider: 'claude-code-local', name: 'Claude Code (WSL $distroName)', method: 'WSL', dir: p.join(userDir.path, '.claude'), supported: false),
            (
              provider: 'opencode-local',
              name: 'OpenCode (WSL $distroName)',
              method: 'WSL',
              dir: p.join(userDir.path, '.local', 'share', 'opencode'),
              supported: false,
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

    try {
      final entries = dir.listSync(recursive: true, followLinks: false);
      var visited = 0;
      for (final ent in entries) {
        visited++;
        if (visited > 2500) break;
        if (ent is! File) continue;

        final lower = ent.path.toLowerCase();
        final name = p.basename(lower);
        final isSessionFile = switch (provider) {
          'codex-local' => name.startsWith('rollout-') && (lower.endsWith('.jsonl.zst') || lower.endsWith('.jsonl')),
          'dsh-local' => lower.endsWith('.jsonl.zstd') || lower.endsWith('.jsonl.zst'),
          'claude-code-local' => lower.contains('projects') && lower.endsWith('.jsonl'),
          'opencode-local' => lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.db'),
          _ => false,
        };
        final isDb = switch (provider) {
          'codex-local' => name.startsWith('thread_history') && name.endsWith('.sqlite'),
          'opencode-local' => name.endsWith('.db') || name.endsWith('.sqlite'),
          _ => false,
        };

        if (!isSessionFile && !isDb) continue;

        final stat = ent.statSync();
        totalBytes += stat.size;
        if (latest == null || stat.modified.isAfter(latest)) {
          latest = stat.modified;
        }
        if (isSessionFile) sessionFiles++;
        if (isDb) hasSqlite = true;
      }
    } catch (_) {
      // Ignore permission or transient IO issues during scan
    }

    return (
      sessionFileCount: sessionFiles,
      hasSqliteDb: hasSqlite,
      totalBytes: totalBytes,
      lastModifiedAt: latest,
    );
  }
}
