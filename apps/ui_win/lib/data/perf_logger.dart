import 'dart:convert';
import 'dart:developer' as dev;
import 'dart:io';

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:path/path.dart' as p;

class PerfLogEntry {
  final DateTime timestamp;
  final String operation;
  final String? targetId;
  final int totalMs;
  final Map<String, int> phases;
  final Map<String, Object?> metadata;

  const PerfLogEntry({
    required this.timestamp,
    required this.operation,
    this.targetId,
    required this.totalMs,
    this.phases = const {},
    this.metadata = const {},
  });

  Map<String, dynamic> toJson() => {
        'ts': timestamp.toIso8601String(),
        'op': operation,
        if (targetId != null) 'target_id': targetId,
        'total_ms': totalMs,
        'phases': phases,
        if (metadata.isNotEmpty) 'meta': metadata,
      };
}

class PerfTrace {
  final PerfLogger _logger;
  final String operation;
  final String? targetId;
  final Map<String, Object?> _metadata;
  final Stopwatch _totalWatch = Stopwatch()..start();
  final Stopwatch _phaseWatch = Stopwatch()..start();
  final Map<String, int> _phases = <String, int>{};
  bool _finished = false;
  late final dev.TimelineTask _timelineTask;

  PerfTrace._(
    this._logger,
    this.operation, {
    this.targetId,
    Map<String, Object?>? metadata,
  }) : _metadata = <String, Object?>{...?metadata} {
    _timelineTask = dev.TimelineTask()..start('sm.$operation');
  }

  void markPhase(String phaseName) {
    if (_finished) return;
    _phases[phaseName] = _phaseWatch.elapsedMilliseconds;
    _phaseWatch.reset();
    _phaseWatch.start();
  }

  void addMetadata(String key, Object? value) {
    if (_finished) return;
    _metadata[key] = value;
  }

  void finish({Map<String, Object?>? extraMeta}) {
    if (_finished) return;
    _finished = true;
    _totalWatch.stop();
    _phaseWatch.stop();
    _timelineTask.finish();
    if (extraMeta != null) {
      _metadata.addAll(extraMeta);
    }
    _logger._record(
      PerfLogEntry(
        timestamp: DateTime.now(),
        operation: operation,
        targetId: targetId,
        totalMs: _totalWatch.elapsedMilliseconds,
        phases: Map<String, int>.unmodifiable(_phases),
        metadata: Map<String, Object?>.unmodifiable(_metadata),
      ),
    );
  }

  void finishAfterFirstFrame({Map<String, Object?>? extraMeta}) {
    if (_finished) return;
    try {
      final binding = WidgetsBinding.instance;
      binding.addPostFrameCallback((_) {
        if (!_finished) {
          markPhase('first_frame');
          finish(extraMeta: extraMeta);
        }
      });
    } catch (_) {
      finish(extraMeta: extraMeta);
    }
  }
}

class PerfLogger {
  PerfLogger._();

  static final PerfLogger instance = PerfLogger._();

  static const int _maxEntries = 200;

  final List<PerfLogEntry> _entries = <PerfLogEntry>[];
  bool _pendingNotifierFlush = false;

  final ValueNotifier<List<PerfLogEntry>> entriesNotifier =
      ValueNotifier<List<PerfLogEntry>>(const []);

  bool enabled = true;
  String? archiveRoot;

  String? get logFilePath {
    final root = archiveRoot;
    if (root == null || root.trim().isEmpty) return null;
    return p.join(root, 'logs', 'ui_perf.jsonl');
  }

  PerfTrace startTrace(
    String operation, {
    String? targetId,
    Map<String, Object?>? metadata,
  }) {
    return PerfTrace._(
      this,
      operation,
      targetId: targetId,
      metadata: metadata,
    );
  }

  void clear() {
    _entries.clear();
    _pendingNotifierFlush = false;
    entriesNotifier.value = const [];
  }

  void _flushEntriesNotifier() {
    _pendingNotifierFlush = false;
    entriesNotifier.value = List<PerfLogEntry>.unmodifiable(_entries);
  }

  void _record(PerfLogEntry entry) {
    if (!enabled) return;

    _entries.insert(0, entry);
    if (_entries.length > _maxEntries) {
      _entries.removeRange(_maxEntries, _entries.length);
    }

    var inBuildPhase = false;
    try {
      inBuildPhase = SchedulerBinding.instance.schedulerPhase ==
          SchedulerPhase.persistentCallbacks;
    } catch (_) {}

    if (inBuildPhase) {
      if (!_pendingNotifierFlush) {
        _pendingNotifierFlush = true;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_pendingNotifierFlush) {
            _flushEntriesNotifier();
          }
        });
      }
    } else {
      _flushEntriesNotifier();
    }

    final phasesDesc = entry.phases.entries
        .map((e) => '${e.key}=${e.value}ms')
        .join(' ');
    debugPrint(
      '[PERF] ${entry.operation}'
      '${entry.targetId != null ? '(${entry.targetId})' : ''} '
      'total=${entry.totalMs}ms'
      '${phasesDesc.isNotEmpty ? ' [$phasesDesc]' : ''}',
    );

    final path = logFilePath;
    if (path != null) {
      try {
        final file = File(path);
        file.parent.createSync(recursive: true);
        file.writeAsStringSync(
          '${jsonEncode(entry.toJson())}\n',
          mode: FileMode.append,
          flush: false,
        );
      } catch (_) {
        // Ignore disk logging failures (e.g. sandboxed test directories)
      }
    }
  }
}
