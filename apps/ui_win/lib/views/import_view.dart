import 'dart:io';
import 'package:flutter/material.dart';

import '../data/archive_direct_store.dart';
import '../data/local_agent_discovery.dart';
import '../data/sm_cli_runner.dart';
import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';
import '../widgets/gm3_surface.dart';
import '../widgets/reset_archive_dialog.dart';

class ImportView extends StatefulWidget {
  final ArchiveDirectStore store;
  final SmCliRunner cliRunner;
  final LocalAgentDiscoveryService discoveryService;
  final VoidCallback onDataChanged;

  const ImportView({
    super.key,
    required this.store,
    required this.cliRunner,
    required this.discoveryService,
    required this.onDataChanged,
  });

  @override
  State<ImportView> createState() => _ImportViewState();
}

class _ImportViewState extends State<ImportView> {
  final ScrollController _scrollCtrl = ScrollController();
  final TextEditingController _sourcePathCtrl = TextEditingController();
  late final TextEditingController _dbPathCtrl;
  final TextEditingController _exportPathCtrl = TextEditingController();

  List<LocalAgentInstance> _instances = [];
  bool _scanning = true;
  bool _busy = false;
  String _selectedGuideKind = 'openai-web';
  String _exportFormat = 'native';
  SmCliResult? _lastCliResult;
  ImportProgressUpdate? _importProgress;
  String? _statusBanner;

  @override
  void initState() {
    super.initState();
    _dbPathCtrl = TextEditingController(text: widget.store.dbPath);
    _scanLocal();
  }

  @override
  void dispose() {
    _scrollCtrl.dispose();
    _sourcePathCtrl.dispose();
    _dbPathCtrl.dispose();
    _exportPathCtrl.dispose();
    super.dispose();
  }

  Future<void> _scanLocal() async {
    setState(() => _scanning = true);
    final found = await widget.discoveryService.scanLocalInstances();
    if (!mounted) return;
    setState(() {
      _instances = found;
      _scanning = false;
    });
  }

  Future<void> _syncInstance(LocalAgentInstance inst) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _importProgress = null;
      _statusBanner = '${inst.displayName} (${inst.path})...';
    });
    final canImport = inst.supportedForImport && inst.hasImportableData;
    final res = canImport
        ? await widget.cliRunner.importSourceWithProgress(
            inst.path,
            kind: inst.provider,
            onProgress: (p) {
              if (!mounted) return;
              setState(() => _importProgress = p);
            },
          )
        : await widget.cliRunner.probeSource(inst.path, kind: 'auto');
    if (!mounted) return;
    setState(() {
      _busy = false;
      _importProgress = null;
      _lastCliResult = res;
      _statusBanner = res.ok ? res.summary : res.errorMessage;
    });
    if (canImport && res.ok) {
      widget.onDataChanged();
    }
  }

  Future<void> _syncAllReady() async {
    if (_busy) return;
    final ready = _instances
        .where((e) => e.supportedForImport && e.hasImportableData)
        .toList();
    if (ready.isEmpty) return;

    setState(() {
      _busy = true;
      _importProgress = null;
    });
    SmCliResult? last;
    var okCount = 0;
    for (final inst in ready) {
      if (!mounted) return;
      setState(() {
        _importProgress = null;
        _statusBanner = '${inst.displayName}: ${inst.path}';
      });
      last = await widget.cliRunner.importSourceWithProgress(
        inst.path,
        kind: inst.provider,
        onProgress: (p) {
          if (!mounted) return;
          setState(() => _importProgress = p);
        },
      );
      if (last.ok) okCount++;
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _importProgress = null;
      _lastCliResult = last;
      _statusBanner = '$okCount / ${ready.length} synced (${last?.summary ?? ''})';
    });
    widget.onDataChanged();
  }

  Future<void> _runGuidedCli({required bool isProbe}) async {
    final path = _sourcePathCtrl.text.trim();
    if (path.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _importProgress = null;
      _statusBanner = path;
    });
    final res = isProbe
        ? await widget.cliRunner.probeSource(path, kind: 'auto')
        : await widget.cliRunner.importSourceWithProgress(
            path,
            kind: _selectedGuideKind,
            onProgress: (p) {
              if (!mounted) return;
              setState(() => _importProgress = p);
            },
          );
    if (!mounted) return;
    setState(() {
      _busy = false;
      _importProgress = null;
      _lastCliResult = res;
      _statusBanner = res.ok ? res.summary : res.errorMessage;
    });
    if (!isProbe && res.ok) {
      widget.onDataChanged();
    }
  }

  Future<String?> _pickWindowsPath({required bool folder}) async {
    if (!Platform.isWindows) return null;
    try {
      final script = folder
          ? 'Add-Type -AssemblyName System.Windows.Forms; \$d = New-Object System.Windows.Forms.FolderBrowserDialog; if (\$d.ShowDialog() -eq "OK") { Write-Output \$d.SelectedPath }'
          : 'Add-Type -AssemblyName System.Windows.Forms; \$d = New-Object System.Windows.Forms.OpenFileDialog; \$d.Filter = "Archives (*.zip;*.json;*.jsonl;*.md)|*.zip;*.json;*.jsonl;*.md|All Files (*.*)|*.*"; if (\$d.ShowDialog() -eq "OK") { Write-Output \$d.FileName }';
      final res = await Process.run('powershell', ['-NoProfile', '-STA', '-Command', script]);
      final out = res.stdout.toString().trim();
      return out.isNotEmpty ? out : null;
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final readyCount = _instances
        .where((e) => e.supportedForImport && e.hasImportableData)
        .length;

    return Scrollbar(
      controller: _scrollCtrl,
      child: SingleChildScrollView(
        controller: _scrollCtrl,
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 1040),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(s.importHubTitle, style: theme.textTheme.titleLarge),
                const SizedBox(height: 6),
                Text(s.importHubSubtitle, style: theme.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant)),
                const SizedBox(height: 20),

                if (_statusBanner != null) ...[
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    decoration: BoxDecoration(
                      color: (_lastCliResult?.ok ?? true)
                          ? cs.primaryContainer.withOpacity(0.55)
                          : cs.errorContainer,
                      borderRadius: BorderRadius.circular(Gm3.radiusMd),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            if (_busy)
                              const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2),
                              )
                            else
                              Icon(
                                (_lastCliResult?.ok ?? true) ? Icons.check_circle_outline : Icons.error_outline,
                                size: 18,
                                color: (_lastCliResult?.ok ?? true) ? cs.primary : cs.error,
                              ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                _statusBanner!,
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  color: (_lastCliResult?.ok ?? true) ? cs.onSurface : cs.onErrorContainer,
                                ),
                              ),
                            ),
                            if (_busy && _importProgress != null) ...[
                              const SizedBox(width: 8),
                              Text(
                                _importProgress!.total > 0
                                    ? '${_importProgress!.completed} / ${_importProgress!.total}'
                                    : ImportProgressUpdate.formatDuration(_importProgress!.elapsed),
                                style: GoogleMaterialTheme.monoTextStyle(
                                  fontSize: Gm3.monoSm,
                                  color: cs.primary,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ],
                          ],
                        ),
                        if (_busy && _importProgress != null) ...[
                          const SizedBox(height: 10),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(4),
                            child: LinearProgressIndicator(
                              value: _importProgress!.fraction,
                              minHeight: 6,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 14,
                            runSpacing: 4,
                            children: [
                              Text(
                                switch (_importProgress!.stage) {
                                  'probe' => s.stageProbeLabel,
                                  'plan' => s.stagePlanLabel,
                                  'commit' => s.stageCommitLabel,
                                  'done' => s.stageDoneLabel,
                                  _ => s.stageParseLabel,
                                },
                                style: theme.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant),
                              ),
                              if (_importProgress!.itemsPerSec > 0)
                                Text(
                                  '${_importProgress!.itemsPerSec.toStringAsFixed(1)}/s · ${_importProgress!.formattedBytesSpeed}',
                                  style: GoogleMaterialTheme.monoTextStyle(
                                    fontSize: Gm3.monoSm,
                                    color: cs.onSurfaceVariant,
                                  ),
                                ),
                              Text(
                                'Elapsed ${ImportProgressUpdate.formatDuration(_importProgress!.elapsed)}',
                                style: GoogleMaterialTheme.monoTextStyle(
                                  fontSize: Gm3.monoSm,
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                              Text(
                                'ETA: ${_importProgress!.eta != null ? ImportProgressUpdate.formatDuration(_importProgress!.eta!) : s.etaCalculating}',
                                style: GoogleMaterialTheme.monoTextStyle(
                                  fontSize: Gm3.monoSm,
                                  color: cs.primary,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                ],

                // ── Section 1: Local Agent Discovery & One-Click Incremental Sync ──
                Gm3Surface.rounded(
                  radius: Gm3.radiusLg,
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 12,
                        runSpacing: 12,
                        alignment: WrapAlignment.spaceBetween,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.radar_outlined, color: cs.primary, size: 22),
                              const SizedBox(width: 10),
                              Text(
                                s.localAgentsSection,
                                style: theme.textTheme.titleMedium,
                              ),
                            ],
                          ),
                          Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              OutlinedButton.icon(
                                onPressed: _scanning || _busy ? null : _scanLocal,
                                icon: const Icon(Icons.refresh, size: 17),
                                label: Text(s.rescanLocal),
                              ),
                              const SizedBox(width: 10),
                              FilledButton.icon(
                                onPressed: readyCount == 0 || _busy ? null : _syncAllReady,
                                icon: const Icon(Icons.sync, size: 17),
                                label: Text(_busy ? s.syncing : '${s.syncAllReady} ($readyCount)'),
                              ),
                            ],
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      if (_scanning)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 20),
                          child: Center(child: CircularProgressIndicator()),
                        )
                      else if (_instances.isEmpty)
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: surfaces.inset,
                            borderRadius: BorderRadius.circular(Gm3.radiusMd),
                          ),
                          child: Text(
                            s.noLocalAgentsFound,
                            style: theme.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
                          ),
                        )
                      else
                        Column(
                          children: [
                            for (final inst in _instances)
                              Container(
                                margin: const EdgeInsets.only(bottom: 10),
                                padding: const EdgeInsets.all(14),
                                decoration: BoxDecoration(
                                  color: surfaces.inset,
                                  borderRadius: BorderRadius.circular(Gm3.radiusMd),
                                ),
                                child: Row(
                                  children: [
                                    CircleAvatar(
                                      radius: 18,
                                      backgroundColor: inst.supportedForImport
                                          ? cs.primaryContainer
                                          : cs.surfaceContainerHigh,
                                      child: Icon(
                                        inst.supportedForImport ? Icons.terminal : Icons.extension_outlined,
                                        size: 19,
                                        color: inst.supportedForImport ? cs.onPrimaryContainer : cs.onSurfaceVariant,
                                      ),
                                    ),
                                    const SizedBox(width: 14),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Wrap(
                                            spacing: 8,
                                            runSpacing: 4,
                                            crossAxisAlignment: WrapCrossAlignment.center,
                                            children: [
                                              Text(
                                                inst.displayName,
                                                style: theme.textTheme.titleSmall,
                                              ),
                                              if (inst.installations.isNotEmpty)
                                                for (final install in inst.installations)
                                                  Tooltip(
                                                    message: install.path,
                                                    child: _PillTag(
                                                      label: install.method,
                                                      color: cs.primary,
                                                    ),
                                                  )
                                              else
                                                _PillTag(label: inst.installMethod, color: cs.primary),
                                              _PillTag(
                                                label: inst.supportedForImport ? s.adapterReady : s.adapterPending,
                                                color: inst.supportedForImport
                                                    ? const Color(0xFF137333)
                                                    : const Color(0xFFB06000),
                                              ),
                                              if (inst.supportedForImport && !inst.hasImportableData)
                                                _PillTag(
                                                  label: s.noSessionDataBadge,
                                                  color: cs.onSurfaceVariant,
                                                ),
                                            ],
                                          ),
                                          const SizedBox(height: 5),
                                          Text(
                                            inst.path,
                                            style: GoogleMaterialTheme.monoTextStyle(
                                              fontSize: Gm3.monoSm,
                                              color: cs.onSurfaceVariant,
                                            ),
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                          const SizedBox(height: 4),
                                          Text(
                                            '${inst.sessionFileCount} files · ${inst.formattedSize}'
                                            '${inst.hasSqliteDb ? ' · SQLite' : ''}'
                                            '${inst.installations.length > 1 ? ' · ${inst.installations.length} installs' : ''}',
                                            style: theme.textTheme.labelSmall,
                                          ),
                                        ],
                                      ),
                                    ),
                                    const SizedBox(width: 12),
                                    if (inst.supportedForImport && inst.hasImportableData)
                                      FilledButton.tonalIcon(
                                        onPressed: _busy ? null : () => _syncInstance(inst),
                                        icon: const Icon(Icons.download_done_outlined, size: 17),
                                        label: Text(s.oneClickSync),
                                      )
                                    else
                                      OutlinedButton.icon(
                                        onPressed: _busy ? null : () => _syncInstance(inst),
                                        icon: const Icon(Icons.troubleshoot_outlined, size: 17),
                                        label: Text(s.probeOnly),
                                      ),
                                  ],
                                ),
                              ),
                          ],
                        ),
                    ],
                  ),
                ),

                const SizedBox(height: 20),

                // ── Section 2: Guided Import for Web Exports & Custom Files ──
                Gm3Surface.rounded(
                  radius: Gm3.radiusLg,
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(Icons.cloud_download_outlined, color: cs.primary, size: 22),
                          const SizedBox(width: 10),
                          Text(
                            s.guidedImportSection,
                            style: theme.textTheme.titleMedium,
                          ),
                        ],
                      ),
                      const SizedBox(height: 16),
                      SegmentedButton<String>(
                        segments: [
                          ButtonSegment(value: 'openai-web', label: Text(s.sourceOpenAi)),
                          ButtonSegment(value: 'anthropic-web', label: Text(s.sourceAnthropic)),
                          ButtonSegment(value: 'deepseek-web', label: Text(s.sourceDeepSeek)),
                          ButtonSegment(value: 'sm-native', label: Text(s.sourceSmNative)),
                          ButtonSegment(value: 'generic', label: Text(s.sourceGeneric)),
                        ],
                        selected: {_selectedGuideKind},
                        onSelectionChanged: (val) => setState(() => _selectedGuideKind = val.first),
                      ),
                      const SizedBox(height: 14),
                      Container(
                        width: double.infinity,
                        padding: const EdgeInsets.all(16),
                        decoration: BoxDecoration(
                          color: surfaces.inset,
                          borderRadius: BorderRadius.circular(Gm3.radiusMd),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Icon(Icons.info_outline, size: 16, color: cs.primary),
                                const SizedBox(width: 6),
                                Text(
                                  '${s.guideTitle} · $_selectedGuideKind',
                                  style: theme.textTheme.labelLarge?.copyWith(
                                    color: cs.primary,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            for (final line in s.guideSteps(_selectedGuideKind))
                              Padding(
                                padding: const EdgeInsets.only(bottom: 4),
                                child: Text(
                                  line,
                                  style: theme.textTheme.bodyMedium
                                      ?.copyWith(height: 1.5),
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 16),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _sourcePathCtrl,
                              decoration: InputDecoration(hintText: s.sourcePathHint),
                            ),
                          ),
                          const SizedBox(width: 10),
                          OutlinedButton.icon(
                            onPressed: () async {
                              final picked = await _pickWindowsPath(folder: false);
                              if (picked != null) _sourcePathCtrl.text = picked;
                            },
                            icon: const Icon(Icons.insert_drive_file_outlined, size: 17),
                            label: Text(s.browseFile),
                          ),
                          const SizedBox(width: 8),
                          OutlinedButton.icon(
                            onPressed: () async {
                              final picked = await _pickWindowsPath(folder: true);
                              if (picked != null) _sourcePathCtrl.text = picked;
                            },
                            icon: const Icon(Icons.folder_outlined, size: 17),
                            label: Text(s.browseFolder),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          OutlinedButton.icon(
                            onPressed: _busy ? null : () => _runGuidedCli(isProbe: true),
                            icon: const Icon(Icons.search_outlined, size: 17),
                            label: Text(s.runProbe),
                          ),
                          const SizedBox(width: 10),
                          FilledButton.icon(
                            onPressed: _busy ? null : () => _runGuidedCli(isProbe: false),
                            icon: const Icon(Icons.file_download_outlined, size: 17),
                            label: Text(s.runImport),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 20),

                // ── Section 3: Archive Database & Export Maintenance ──
                Gm3Surface.rounded(
                  radius: Gm3.radiusLg,
                  padding: const EdgeInsets.all(20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(Icons.storage_outlined, color: cs.primary, size: 22),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              s.archiveConfigSection,
                              style: theme.textTheme.titleMedium,
                            ),
                          ),
                          OutlinedButton.icon(
                            style: OutlinedButton.styleFrom(
                              foregroundColor: cs.error,
                              side: BorderSide(color: cs.error.withOpacity(0.5)),
                            ),
                            onPressed: _busy
                                ? null
                                : () async {
                                    final res = await showResetArchiveDialog(
                                      context: context,
                                      store: widget.store,
                                      onDataChanged: widget.onDataChanged,
                                    );
                                    if (res != null && res.ok && mounted) {
                                      setState(() {
                                        _statusBanner = s.resetArchiveDone(
                                          formatArchiveBytes(res.freedBytes),
                                        );
                                      });
                                    }
                                  },
                            icon: const Icon(Icons.delete_forever_outlined, size: 17),
                            label: Text(s.resetArchiveAction),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _dbPathCtrl,
                              decoration: InputDecoration(labelText: s.dbPathLabel),
                            ),
                          ),
                          const SizedBox(width: 10),
                          OutlinedButton.icon(
                            onPressed: () async {
                              final picked = await _pickWindowsPath(folder: true);
                              if (picked != null) _dbPathCtrl.text = picked;
                            },
                            icon: const Icon(Icons.folder_open, size: 17),
                            label: Text(s.browseFolder),
                          ),
                          const SizedBox(width: 8),
                          FilledButton.tonal(
                            onPressed: () {
                              widget.store.setArchiveLocation(_dbPathCtrl.text);
                              widget.onDataChanged();
                            },
                            child: Text(s.switchDb),
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _exportPathCtrl,
                              decoration: InputDecoration(hintText: s.exportNow),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Gm3Select<String>(
                            value: _exportFormat,
                            maxWidth: 165,
                            options: const <Gm3Option<String>>[
                              Gm3Option<String>(value: 'native', label: 'native'),
                              Gm3Option<String>(value: 'provider-raw', label: 'provider-raw'),
                              Gm3Option<String>(value: 'md', label: 'md'),
                              Gm3Option<String>(value: 'jsonl', label: 'jsonl'),
                            ],
                            onChanged: (v) => setState(() => _exportFormat = v),
                          ),
                          const SizedBox(width: 8),
                          OutlinedButton.icon(
                            onPressed: _busy
                                ? null
                                : () async {
                                    final out = _exportPathCtrl.text.trim();
                                    if (out.isEmpty) return;
                                    setState(() => _busy = true);
                                    final res = await widget.cliRunner.exportArchive(
                                      out,
                                      format: _exportFormat,
                                      zip: _exportFormat == 'provider-raw' || _exportFormat == 'native',
                                      fallback: _exportFormat == 'provider-raw' ? 'native' : null,
                                    );
                                    if (!mounted) return;
                                    setState(() {
                                      _busy = false;
                                      _lastCliResult = res;
                                      _statusBanner = res.ok ? res.summary : res.errorMessage;
                                    });
                                  },
                            icon: const Icon(Icons.ios_share_outlined, size: 17),
                            label: Text(s.exportNow),
                          ),
                        ],
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

class _PillTag extends StatelessWidget {
  final String label;
  final Color color;

  const _PillTag({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    final tint = Gm3.adaptiveTint(color, Theme.of(context).brightness);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
      decoration: BoxDecoration(
        color: tint.withOpacity(0.12),
        borderRadius: BorderRadius.circular(Gm3.radiusPill),
      ),
      child: Text(
        label,
        style: Gm3.text(
          fontSize: Gm3.fontSizeLabelSmall,
          fontWeight: FontWeight.w600,
          color: tint,
        ),
      ),
    );
  }
}
