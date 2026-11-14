import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;

import '../models.dart';
import 'archive_direct_store.dart';

/// CQRS Write / Heavy-IO Path: invokes the `sm` CLI on demand (`Process.run`)
/// with `--json` output rather than running a resident HTTP server.
class SmCliRunner {
  static const String _envDefineBin = String.fromEnvironment('SM_CLI_BIN');

  final ArchiveDirectStore store;
  final ValueNotifier<SmCliResult?> lastResultNotifier = ValueNotifier<SmCliResult?>(null);
  final List<SmCliResult> history = [];

  SmCliRunner({required this.store});

  void dispose() {
    lastResultNotifier.dispose();
  }

  ({String executable, List<String> prefixArgs}) _resolveCommand() {
    final envBin = _envDefineBin.trim().isNotEmpty
        ? _envDefineBin.trim()
        : (Platform.environment['SM_CLI_BIN'] ?? '').trim();
    if (envBin.isNotEmpty) {
      if (envBin.endsWith('.js')) {
        return (executable: 'node', prefixArgs: [envBin]);
      }
      return (executable: envBin, prefixArgs: const []);
    }

    final candidates = [
      p.join(Directory.current.path, 'apps', 'cli', 'dist', 'index.js'),
      p.join(Directory.current.parent.parent.path, 'apps', 'cli', 'dist', 'index.js'),
    ];
    for (final c in candidates) {
      if (File(c).existsSync()) {
        return (executable: 'node', prefixArgs: [c]);
      }
    }
    return (executable: 'sm', prefixArgs: const []);
  }

  Future<SmCliResult> runCommand(List<String> args) async {
    final cmd = _resolveCommand();
    final isProbe = args.isNotEmpty && args.first == 'probe';
    final fullArgs = <String>[
      ...cmd.prefixArgs,
      ...args,
      if (!isProbe && !args.contains('--db')) ...['--db', store.dbPath],
      if (!args.contains('--json')) '--json',
    ];
    final cmdDisplay = 'sm ${args.join(' ')}';

    try {
      final res = await Process.run(cmd.executable, fullArgs);
      final stdoutText = res.stdout.toString();
      final stderrText = res.stderr.toString();
      Map<String, dynamic>? parsed;
      if (stdoutText.trim().isNotEmpty) {
        try {
          final decoded = jsonDecode(stdoutText);
          if (decoded is Map<String, dynamic>) parsed = decoded;
        } catch (_) {}
      }
      final result = SmCliResult(
        ok: res.exitCode == 0,
        exitCode: res.exitCode,
        command: cmdDisplay,
        data: parsed,
        stdoutText: stdoutText,
        stderrText: stderrText,
      );
      history.insert(0, result);
      if (history.length > 20) history.removeLast();
      lastResultNotifier.value = result;
      store.checkConnection();
      return result;
    } catch (err) {
      final result = SmCliResult(
        ok: false,
        exitCode: -1,
        command: cmdDisplay,
        stdoutText: '',
        stderrText: err.toString(),
      );
      history.insert(0, result);
      lastResultNotifier.value = result;
      return result;
    }
  }

  Future<SmCliResult> probeSource(String sourcePath, {String kind = 'auto'}) {
    return runCommand(['probe', sourcePath, '--kind', kind]);
  }

  Future<SmCliResult> importSource(String sourcePath, {String kind = 'auto'}) {
    return runCommand(['import', sourcePath, '--kind', kind]);
  }

  Future<SmCliResult> verify({int? batchId}) {
    return runCommand(['verify', if (batchId != null) ...['--batch', '$batchId']]);
  }

  Future<SmCliResult> dedupe() {
    return runCommand(['dedupe']);
  }

  Future<SmCliResult> reindex() {
    return runCommand(['reindex']);
  }

  Future<SmCliResult> exportArchive(String outDir, {String format = 'native'}) {
    return runCommand(['export', '--format', format, '--out', outDir]);
  }
}
