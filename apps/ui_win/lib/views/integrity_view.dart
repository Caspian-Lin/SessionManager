import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../data/archive_direct_store.dart';
import '../data/sm_cli_runner.dart';
import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';

class IntegrityReportView extends StatefulWidget {
  final ArchiveDirectStore store;
  final SmCliRunner cliRunner;
  final ValueNotifier<int> refreshTick;
  final VoidCallback onDataChanged;
  final ValueChanged<int> onOpenConversation;

  const IntegrityReportView({
    super.key,
    required this.store,
    required this.cliRunner,
    required this.refreshTick,
    required this.onDataChanged,
    required this.onOpenConversation,
  });

  @override
  State<IntegrityReportView> createState() => _IntegrityReportViewState();
}

class _IntegrityReportViewState extends State<IntegrityReportView> {
  List<BatchReport> _batches = [];
  List<DedupeCandidatePair> _candidates = [];
  bool _loading = true;
  bool _runningCli = false;
  String? _cliStatusMessage;
  final ScrollController _scrollCtrl = ScrollController();

  @override
  void initState() {
    super.initState();
    widget.refreshTick.addListener(_loadData);
    _loadData();
  }

  @override
  void dispose() {
    widget.refreshTick.removeListener(_loadData);
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadData() async {
    setState(() => _loading = true);
    final results = await Future.wait([
      widget.store.getBatches(),
      widget.store.getDedupeCandidates(),
    ]);
    if (!mounted) return;
    setState(() {
      _batches = results[0] as List<BatchReport>;
      _candidates = results[1] as List<DedupeCandidatePair>;
      _loading = false;
    });
  }

  Future<void> _runCliAction(String label, Future<SmCliResult> Function() action) async {
    if (_runningCli) return;
    setState(() {
      _runningCli = true;
      _cliStatusMessage = 'Running $label...';
    });
    final res = await action();
    if (!mounted) return;
    setState(() {
      _runningCli = false;
      _cliStatusMessage = res.ok
          ? '$label completed (${res.summary})'
          : '$label failed: ${res.errorMessage}';
    });
    widget.onDataChanged();
  }

  Future<void> _jumpToShrunkId(String rawId) async {
    final id = await widget.store.resolveConversationId(rawId);
    if (!mounted) return;
    if (id != null) {
      widget.onOpenConversation(id);
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Conversation "$rawId" not found in archive.')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    if (_loading) return const Center(child: CircularProgressIndicator());

    final totalShrunk = _batches.fold<int>(0, (sum, b) => sum + b.shrunkConversations);
    final allShrunkIds = _batches.expand((b) => b.shrunkConversationIds).toSet().toList();

    return Scrollbar(
      controller: _scrollCtrl,
      child: SingleChildScrollView(
        controller: _scrollCtrl,
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        AppStringsScope.of(context).integrityTitle,
                        style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${AppStringsScope.of(context).integritySubtitle} (${widget.store.dbPath})',
                        style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: _runningCli ? null : () => _runCliAction('sm verify', widget.cliRunner.verify),
                  icon: const Icon(Icons.verified_outlined, size: 16),
                  label: Text(AppStringsScope.of(context).runVerify),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: _runningCli ? null : () => _runCliAction('sm dedupe', widget.cliRunner.dedupe),
                  icon: const Icon(Icons.compare_arrows, size: 16),
                  label: Text(AppStringsScope.of(context).isZh ? '执行查重' : 'Dedupe'),
                ),
                const SizedBox(width: 8),
                FilledButton.tonalIcon(
                  onPressed: _runningCli ? null : () => _runCliAction('sm reindex', widget.cliRunner.reindex),
                  icon: const Icon(Icons.manage_search, size: 16),
                  label: Text(AppStringsScope.of(context).runReindex),
                ),
              ],
            ),
            if (_cliStatusMessage != null) ...[
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                decoration: BoxDecoration(
                  color: cs.surfaceContainerLow,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: cs.outlineVariant.withOpacity(0.45)),
                ),
                child: Text(_cliStatusMessage!, style: GoogleMaterialTheme.monoTextStyle(fontSize: 11.5)),
              ),
            ],
            const SizedBox(height: 16),

            // High-priority shrunk_conversations alert with clickable deep links
            if (totalShrunk > 0)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(14),
                margin: const EdgeInsets.only(bottom: 16),
                decoration: BoxDecoration(
                  color: Colors.amber.withOpacity(0.12),
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: const Color(0xFFD97706)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.warning_amber_rounded, color: Color(0xFFD97706), size: 22),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            AppStringsScope.of(context).shrunkAlertTitle(totalShrunk),
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      AppStringsScope.of(context).shrunkAlertDesc,
                      style: const TextStyle(fontSize: 12),
                    ),
                    if (allShrunkIds.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: allShrunkIds
                            .map((id) => ActionChip(
                                  avatar: const Icon(Icons.open_in_new, size: 13),
                                  label: Text(id, style: GoogleMaterialTheme.monoTextStyle(fontSize: 11)),
                                  onPressed: () => _jumpToShrunkId(id),
                                ))
                            .toList(),
                      ),
                    ],
                  ],
                ),
              ),

            // Overview metrics
            Row(
              children: [
                _MetricCard(
                  label: AppStringsScope.of(context).metricBatches,
                  value: '${_batches.length}',
                  icon: Icons.layers_outlined,
                  color: cs.primary,
                ),
                const SizedBox(width: 12),
                _MetricCard(
                  label: AppStringsScope.of(context).metricShrunk,
                  value: '$totalShrunk',
                  icon: Icons.compress,
                  color: totalShrunk > 0 ? const Color(0xFFD97706) : const Color(0xFF1E8E3E),
                ),
                const SizedBox(width: 12),
                _MetricCard(
                  label: AppStringsScope.of(context).metricCandidates,
                  value: '${_candidates.length}',
                  icon: Icons.compare_arrows,
                  color: const Color(0xFF7C3AED),
                ),
              ],
            ),
            const SizedBox(height: 20),

            // Side-by-Side Dedupe Candidate Comparison
            Text(
              AppStringsScope.of(context).dedupePairsTitle,
              style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            if (_candidates.isEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Text(AppStringsScope.of(context).noDedupePairs, style: TextStyle(color: cs.onSurfaceVariant)),
              )
            else
              for (final pair in _candidates)
                DedupeDoubleColumnComparison(
                  pair: pair,
                  onOpenConversation: widget.onOpenConversation,
                ),

            const SizedBox(height: 16),
            Text(
              AppStringsScope.of(context).batchLedgerTitle,
              style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            for (final b in _batches)
              Card(
                margin: const EdgeInsets.only(bottom: 10),
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text('Batch #${b.id}', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                          const SizedBox(width: 8),
                          Chip(label: Text('${b.provider} (${b.kind})', style: const TextStyle(fontSize: 10.5))),
                          const Spacer(),
                          Text(
                            DateFormat('yyyy-MM-dd HH:mm').format(DateTime.fromMillisecondsSinceEpoch(b.importedAt)),
                            style: TextStyle(color: cs.onSurfaceVariant, fontSize: 11.5),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        children: [
                          _DiffPill(label: '+ ${b.addedConversations} Added', color: const Color(0xFF10B981)),
                          _DiffPill(label: '~ ${b.grownConversations} Grown', color: cs.primary),
                          _DiffPill(
                            label: '! ${b.shrunkConversations} Shrunk',
                            color: b.shrunkConversations > 0 ? const Color(0xFFD97706) : cs.onSurfaceVariant,
                          ),
                          _DiffPill(label: '= ${b.identicalConversations} Identical', color: cs.onSurfaceVariant),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class DedupeDoubleColumnComparison extends StatelessWidget {
  final DedupeCandidatePair pair;
  final ValueChanged<int> onOpenConversation;

  const DedupeDoubleColumnComparison({
    super.key,
    required this.pair,
    required this.onOpenConversation,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final pct = (pair.similarity * 100).toStringAsFixed(1);

    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                    color: const Color(0xFF7C3AED).withOpacity(0.14),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    '$pct% Similarity',
                    style: const TextStyle(fontSize: 11, fontWeight: FontWeight.bold, color: Color(0xFF7C3AED)),
                  ),
                ),
                const SizedBox(width: 8),
                Text(pair.reason, style: GoogleMaterialTheme.monoTextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
                const Spacer(),
                Text('status: ${pair.status}', style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: _CandidateColumn(
                    sideLabel: 'Conversation A (#${pair.aId})',
                    title: pair.aTitle,
                    provider: pair.aProvider,
                    headHash: pair.aHeadHash,
                    itemCount: pair.aItemCount,
                    previewTurns: pair.aPreviewTurns,
                    onOpen: () => onOpenConversation(pair.aId),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _CandidateColumn(
                    sideLabel: 'Conversation B (#${pair.bId})',
                    title: pair.bTitle,
                    provider: pair.bProvider,
                    headHash: pair.bHeadHash,
                    itemCount: pair.bItemCount,
                    previewTurns: pair.bPreviewTurns,
                    onOpen: () => onOpenConversation(pair.bId),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _CandidateColumn extends StatelessWidget {
  final String sideLabel;
  final String title;
  final String provider;
  final String? headHash;
  final int itemCount;
  final List<String> previewTurns;
  final VoidCallback onOpen;

  const _CandidateColumn({
    required this.sideLabel,
    required this.title,
    required this.provider,
    this.headHash,
    required this.itemCount,
    required this.previewTurns,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final hashPrefix = (headHash == null || headHash!.isEmpty)
        ? 'N/A'
        : (headHash!.length > 10 ? headHash!.substring(0, 10) : headHash!);

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surfaceContainerLowest,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cs.outlineVariant.withOpacity(0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(sideLabel, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: cs.primary)),
              const Spacer(),
              TextButton(
                onPressed: onOpen,
                child: Text(AppStringsScope.of(context).openInReader, style: const TextStyle(fontSize: 11.5)),
              ),
            ],
          ),
          Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
          const SizedBox(height: 3),
          Text(
            '$provider · $itemCount items · hash:$hashPrefix',
            style: GoogleMaterialTheme.monoTextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
          ),
          if (previewTurns.isNotEmpty) ...[
            const SizedBox(height: 6),
            for (final t in previewTurns)
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text(
                  t,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 11, color: cs.onSurfaceVariant),
                ),
              ),
          ],
        ],
      ),
    );
  }
}

class _MetricCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;
  final Color color;

  const _MetricCard({
    required this.label,
    required this.value,
    required this.icon,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              CircleAvatar(
                radius: 16,
                backgroundColor: color.withOpacity(0.14),
                child: Icon(icon, color: color, size: 17),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurfaceVariant),
                    ),
                    Text(value, style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: color)),
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

class _DiffPill extends StatelessWidget {
  final String label;
  final Color color;

  const _DiffPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(label, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600)),
    );
  }
}
