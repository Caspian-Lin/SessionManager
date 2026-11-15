import 'package:flutter/material.dart';

import '../data/archive_direct_store.dart';
import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';

String formatArchiveBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  if (bytes < 1024 * 1024 * 1024) {
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
  return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(2)} GB';
}

Future<ArchiveResetResult?> showResetArchiveDialog({
  required BuildContext context,
  required ArchiveDirectStore store,
  required VoidCallback onDataChanged,
}) {
  return showDialog<ArchiveResetResult>(
    context: context,
    builder: (ctx) => _ResetArchiveDialog(
      store: store,
      onDataChanged: onDataChanged,
    ),
  );
}

class _ResetArchiveDialog extends StatefulWidget {
  final ArchiveDirectStore store;
  final VoidCallback onDataChanged;

  const _ResetArchiveDialog({
    required this.store,
    required this.onDataChanged,
  });

  @override
  State<_ResetArchiveDialog> createState() => _ResetArchiveDialogState();
}

class _ResetArchiveDialogState extends State<_ResetArchiveDialog> {
  late final Future<ArchiveDiskStats> _statsFuture;
  bool _includeCache = true;
  bool _deleting = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _statsFuture = widget.store.inspectArchiveStats();
  }

  Future<void> _confirmDelete() async {
    if (_deleting) return;
    setState(() {
      _deleting = true;
      _error = null;
    });
    final res = await widget.store.resetArchiveData(includeBlobsAndRaw: _includeCache);
    if (!mounted) return;
    if (res.ok) {
      widget.onDataChanged();
      Navigator.of(context).pop(res);
    } else {
      setState(() {
        _deleting = false;
        _error = res.errorMessage;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;

    return AlertDialog(
      icon: Icon(Icons.delete_forever_outlined, color: cs.error, size: 30),
      title: Text(s.resetArchiveDialogTitle),
      content: SizedBox(
        width: 520,
        child: FutureBuilder<ArchiveDiskStats>(
          future: _statsFuture,
          builder: (context, snapshot) {
            final stats = snapshot.data;
            return Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: cs.surfaceContainerHighest.withOpacity(0.55),
                    borderRadius: BorderRadius.circular(Gm3.radiusSm),
                  ),
                  child: SelectableText(
                    widget.store.dbPath,
                    style: GoogleMaterialTheme.monoTextStyle(
                      fontSize: Gm3.monoSm,
                      color: cs.onSurface,
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                if (snapshot.connectionState == ConnectionState.waiting)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 8),
                    child: LinearProgressIndicator(minHeight: 3),
                  )
                else if (stats != null) ...[
                  if (!stats.hasAnyData)
                    Text(
                      s.resetArchiveNoData,
                      style: theme.textTheme.bodyMedium?.copyWith(color: cs.onSurfaceVariant),
                    )
                  else
                    Wrap(
                      spacing: 12,
                      runSpacing: 6,
                      children: [
                        _StatChip(
                          label: s.isZh
                              ? '${stats.conversationCount} 个会话'
                              : '${stats.conversationCount} conversations',
                        ),
                        _StatChip(
                          label: s.isZh
                              ? '${stats.batchCount} 个导入批次'
                              : '${stats.batchCount} batches',
                        ),
                        _StatChip(
                          label: s.isZh
                              ? 'SQLite: ${formatArchiveBytes(stats.dbBytes)}'
                              : 'SQLite: ${formatArchiveBytes(stats.dbBytes)}',
                        ),
                        _StatChip(
                          label: s.isZh
                              ? '缓存(blobs/raw): ${formatArchiveBytes(stats.cacheBytes)}'
                              : 'Caches(blobs/raw): ${formatArchiveBytes(stats.cacheBytes)}',
                        ),
                      ],
                    ),
                ],
                const SizedBox(height: 12),
                Text(
                  s.resetArchiveWarning,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: cs.onSurfaceVariant,
                    height: 1.45,
                  ),
                ),
                const SizedBox(height: 8),
                CheckboxListTile(
                  value: _includeCache,
                  onChanged: _deleting ? null : (v) => setState(() => _includeCache = v ?? true),
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(
                    s.resetArchiveIncludeCache,
                    style: theme.textTheme.bodySmall,
                  ),
                ),
                if (_error != null) ...[
                  const SizedBox(height: 8),
                  Text(
                    _error!,
                    style: theme.textTheme.bodySmall?.copyWith(color: cs.error),
                  ),
                ],
              ],
            );
          },
        ),
      ),
      actions: [
        TextButton(
          onPressed: _deleting ? null : () => Navigator.of(context).pop(null),
          child: Text(s.cancel),
        ),
        FutureBuilder<ArchiveDiskStats>(
          future: _statsFuture,
          builder: (context, snapshot) {
            final hasAnyData = snapshot.data?.hasAnyData ?? true;
            return FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: cs.error,
                foregroundColor: cs.onError,
              ),
              onPressed: (_deleting || !hasAnyData) ? null : _confirmDelete,
              icon: _deleting
                  ? SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: cs.onError,
                      ),
                    )
                  : const Icon(Icons.delete_forever_outlined, size: 17),
              label: Text(s.resetArchiveConfirmBtn),
            );
          },
        ),
      ],
    );
  }
}

class _StatChip extends StatelessWidget {
  final String label;

  const _StatChip({required this.label});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: cs.secondaryContainer.withOpacity(0.65),
        borderRadius: BorderRadius.circular(Gm3.radiusPill),
      ),
      child: Text(
        label,
        style: Gm3.text(
          fontSize: Gm3.fontSizeLabelSmall,
          fontWeight: FontWeight.w600,
          color: cs.onSecondaryContainer,
        ),
      ),
    );
  }
}
