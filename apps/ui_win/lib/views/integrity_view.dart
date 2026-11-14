import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../data/archive_direct_store.dart';
import '../data/sm_cli_runner.dart';
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
                      const Text('Archive Integrity, Diff & Dedupe Report',
                          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 2),
                      Text(
                        'SQLite WAL Read-Only (${widget.store.dbPath}) · On-demand CLI runner',
                        style: TextStyle(color: cs.onSurfaceVariant, fontSize: 12),
                      ),
                    ],
                  ),
                ),
                OutlinedButton.icon(
                  onPressed: _runningCli ? null : () => _runCliAction('sm verify', widget.cliRunner.verify),
                  icon: const Icon(Icons.verified_outlined, size: 15),
                  label: const Text('Verify'),
                ),
                const SizedBox(width: 6),
                OutlinedButton.icon(
                  onPressed: _runningCli ? null : () => _runCliAction('sm dedupe', widget.cliRunner.dedupe),
                  icon: const Icon(Icons.compare_arrows, size: 15),
                  label: const Text('Dedupe'),
                ),
                const SizedBox(width: 6),
                OutlinedButton.icon(
                  onPressed: _runningCli ? null : () => _runCliAction('sm reindex', widget.cliRunner.reindex),
                  icon: const Icon(Icons.manage_search, size: 15),
                  label: const Text('Reindex'),
                ),
              ],
            ),
            if (_cliStatusMessage != null) ...[
              const SizedBox(height: 10),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(
                  color: cs.surface,
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: theme.dividerColor),
                ),
                child: Text(_cliStatusMessage!, style: WinAdaptiveTheme.monoTextStyle(fontSize: 11.5)),
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
                            'SHRINK ALERT: $totalShrunk Conversation(s) Lost Items Upstream',
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13.5),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'Later snapshots had fewer items than earlier imports. Click an ID below to inspect:',
                      style: TextStyle(fontSize: 12),
                    ),
                    if (allShrunkIds.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: allShrunkIds
                            .map((id) => ActionChip(
                                  avatar: const Icon(Icons.open_in_new, size: 13),
                                  label: Text(id, style: WinAdaptiveTheme.monoTextStyle(fontSize: 11)),
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
                _MetricCard(label: 'Import Batches', value: '${_batches.length}', icon: Icons.layers, color: cs.primary),
                const SizedBox(width: 12),
                _MetricCard(
                  label: 'Shrunk Sessions',
                  value: '$totalShrunk',
                  icon: Icons.compress,
                  color: totalShrunk > 0 ? const Color(0xFFD97706) : const Color(0xFF10B981),
                ),
                const SizedBox(width: 12),
                _MetricCard(
                  label: 'Dedupe Candidates',
                  value: '${_candidates.length}',
                  icon: Icons.compare,
                  color: const Color(0xFF7C3AED),
                ),
              ],
            ),
            const SizedBox(height: 20),

            // Side-by-Side Dedupe Candidate Comparison
            const Text('Candidate Dedupe Double-Column Comparison',
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            if (_candidates.isEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Text('No candidate duplicate pairs found.', style: TextStyle(color: cs.onSurfaceVariant)),
              )
            else
              for (final pair in _candidates)
                DedupeDoubleColumnComparison(
                  pair: pair,
                  onOpenConversation: widget.onOpenConversation,
                ),

            const SizedBox(height: 16),
            const Text('Import Batch Ledger', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
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
                Text(pair.reason, style: WinAdaptiveTheme.monoTextStyle(fontSize: 11, color: cs.onSurfaceVariant)),
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
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: cs.surface,
        borderRadius: BorderRadius.circular(5),
        border: Border.all(color: theme.dividerColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(sideLabel, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: cs.primary)),
              const Spacer(),
              TextButton(
                onPressed: onOpen,
                child: const Text('Inspect', style: TextStyle(fontSize: 11)),
              ),
            ],
          ),
          Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13), maxLines: 1, overflow: TextOverflow.ellipsis),
          const SizedBox(height: 3),
          Text(
            '$provider · $itemCount items · hash:$hashPrefix',
            style: WinAdaptiveTheme.monoTextStyle(fontSize: 10.5, color: cs.onSurfaceVariant),
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
