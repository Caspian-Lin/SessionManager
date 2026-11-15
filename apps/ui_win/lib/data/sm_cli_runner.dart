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
    final exeDir = p.dirname(Platform.resolvedExecutable);
    final bundledNode = p.join(exeDir, 'runtime', 'node.exe');
    final nodeExec = File(bundledNode).existsSync() ? bundledNode : 'node';

    final envBin = _envDefineBin.trim().isNotEmpty
        ? _envDefineBin.trim()
        : (Platform.environment['SM_CLI_BIN'] ?? '').trim();
    if (envBin.isNotEmpty) {
      if (envBin.endsWith('.js')) {
        return (executable: nodeExec, prefixArgs: [envBin]);
      }
      return (executable: envBin, prefixArgs: const []);
    }

    final bundledCli = p.join(exeDir, 'runtime', 'apps', 'cli', 'dist', 'index.js');
    if (File(bundledCli).existsSync()) {
      return (executable: nodeExec, prefixArgs: [bundledCli]);
    }

    final candidates = [
      p.join(Directory.current.path, 'apps', 'cli', 'dist', 'index.js'),
      p.join(Directory.current.parent.parent.path, 'apps', 'cli', 'dist', 'index.js'),
      p.join(exeDir, 'apps', 'cli', 'dist', 'index.js'),
    ];
    for (final c in candidates) {
      if (File(c).existsSync()) {
        return (executable: nodeExec, prefixArgs: [c]);
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

  /// Streams real-time progress events (`probe` -> `plan` -> `parse` -> `commit` -> `done`)
  /// using `--json --progress` NDJSON output.
  Future<SmCliResult> importSourceWithProgress(
    String sourcePath, {
    String kind = 'auto',
    void Function(ImportProgressUpdate update)? onProgress,
  }) async {
    final cmd = _resolveCommand();
    final args = ['import', sourcePath, '--kind', kind];
    final fullArgs = <String>[
      ...cmd.prefixArgs,
      ...args,
      '--db',
      store.dbPath,
      '--json',
      '--progress',
    ];
    final cmdDisplay = 'sm ${args.join(' ')}';
    final sw = Stopwatch()..start();

    try {
      final proc = await Process.start(cmd.executable, fullArgs);
      final stdoutBuf = StringBuffer();
      final stderrBuf = StringBuffer();
      Map<String, dynamic>? finalData;

      final stdoutFuture = proc.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .forEach((line) {
        if (stdoutBuf.isNotEmpty) stdoutBuf.writeln();
        stdoutBuf.write(line);
        final trimmed = line.trim();
        if (trimmed.isEmpty) return;
        try {
          final decoded = jsonDecode(trimmed);
          if (decoded is! Map<String, dynamic>) return;
          final type = decoded['type'];
          if (type == 'progress') {
            onProgress?.call(
              ImportProgressUpdate.fromJson(decoded, elapsed: sw.elapsed),
            );
          } else if (type == 'result' && decoded['data'] is Map<String, dynamic>) {
            finalData = decoded['data'] as Map<String, dynamic>;
          } else if (!decoded.containsKey('type')) {
            finalData = decoded;
          }
        } catch (_) {}
      });

      final stderrFuture = proc.stderr.transform(utf8.decoder).forEach(stderrBuf.write);

      final exitCode = await proc.exitCode;
      await Future.wait([stdoutFuture, stderrFuture]);

      final result = SmCliResult(
        ok: exitCode == 0,
        exitCode: exitCode,
        command: cmdDisplay,
        data: finalData,
        stdoutText: stdoutBuf.toString(),
        stderrText: stderrBuf.toString(),
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

  Future<SmCliResult> verify({int? batchId}) {
    return runCommand(['verify', if (batchId != null) ...['--batch', '$batchId']]);
  }

  Future<SmCliResult> dedupe() {
    return runCommand(['dedupe']);
  }

  Future<SmCliResult> reindex() {
    return runCommand(['reindex']);
  }

  Future<SmCliResult> exportArchive(
    String outDir, {
    String format = 'native',
    bool zip = false,
    String? fallback,
  }) {
    return runCommand([
      'export',
      '--format',
      format,
      '--out',
      outDir,
      if (zip) '--zip',
      if (fallback != null && fallback.isNotEmpty) ...['--fallback', fallback],
    ]);
  }

  Future<SmCliResult> setStarred(int convId, {required bool starred}) {
    return runCommand(['star', '$convId', if (!starred) '--off']);
  }

  Future<SmCliResult> addTag(int convId, String tagName) {
    return runCommand(['tag', '$convId', '--add', tagName]);
  }

  Future<SmCliResult> removeTag(int convId, String tagName) {
    return runCommand(['tag', '$convId', '--remove', tagName]);
  }

  Future<SmCliResult> softDelete(int convId) {
    return runCommand(['rm', '$convId']);
  }

  Future<SmCliResult> restoreConversation(int convId) {
    return runCommand(['rm', '$convId', '--restore']);
  }

  Future<SmCliResult> vacuum() {
    return runCommand(['vacuum']);
  }
}
