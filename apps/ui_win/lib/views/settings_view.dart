import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../data/app_settings.dart';
import '../data/archive_direct_store.dart';
import '../data/perf_logger.dart';
import '../l10n/app_strings.dart';
import '../theme.dart';
import '../widgets/gm3_surface.dart';

class SettingsView extends StatefulWidget {
  final AppSettingsController settings;
  final ArchiveDirectStore store;

  const SettingsView({
    super.key,
    required this.settings,
    required this.store,
  });

  @override
  State<SettingsView> createState() => _SettingsViewState();
}

class _SettingsViewState extends State<SettingsView> {
  late final TextEditingController _authorCtrl;
  late final TextEditingController _watermarkCtrl;
  late final TextEditingController _brandTextCtrl;

  @override
  void initState() {
    super.initState();
    _authorCtrl = TextEditingController(text: widget.settings.authorName);
    _watermarkCtrl =
        TextEditingController(text: widget.settings.shareWatermarkText);
    _brandTextCtrl =
        TextEditingController(text: widget.settings.shareBrandText);
    widget.settings.addListener(_syncControllersFromSettings);
  }

  @override
  void didUpdateWidget(covariant SettingsView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.settings != widget.settings) {
      oldWidget.settings.removeListener(_syncControllersFromSettings);
      widget.settings.addListener(_syncControllersFromSettings);
      _syncControllersFromSettings();
    }
  }

  void _syncControllersFromSettings() {
    if (_authorCtrl.text != widget.settings.authorName) {
      _authorCtrl.text = widget.settings.authorName;
    }
    if (_watermarkCtrl.text != widget.settings.shareWatermarkText) {
      _watermarkCtrl.text = widget.settings.shareWatermarkText;
    }
    if (_brandTextCtrl.text != widget.settings.shareBrandText) {
      _brandTextCtrl.text = widget.settings.shareBrandText;
    }
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.settings.removeListener(_syncControllersFromSettings);
    _authorCtrl.dispose();
    _watermarkCtrl.dispose();
    _brandTextCtrl.dispose();
    super.dispose();
  }

  String _styleLabel(AppStrings s, ShareColorStyle style) {
    return switch (style) {
      ShareColorStyle.paperLight => s.isZh ? '素雅浅纸' : 'Paper',
      ShareColorStyle.obsidianDark => s.isZh ? '极夜深黑' : 'Obsidian',
      ShareColorStyle.auroraBlue => s.isZh ? '晴空澄蓝' : 'Aurora',
      ShareColorStyle.warmSand => s.isZh ? '暖阳米沙' : 'Warm Sand',
      ShareColorStyle.forestMint => s.isZh ? '薄荷青瓷' : 'Forest Mint',
    };
  }

  Future<void> _openGithubUrl() async {
    const url = AppSettingsController.githubUrl;
    if (Platform.isWindows) {
      await Process.run('cmd', ['/c', 'start', '', url]);
    } else if (Platform.isMacOS) {
      await Process.run('open', [url]);
    } else {
      await Process.run('xdg-open', [url]);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppStringsScope.of(context);
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final cfg = widget.settings;

    return Container(
      color: surfaces.panel,
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 880),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(s.settingsTitle, style: theme.textTheme.titleLarge),
                const SizedBox(height: 4),
                Text(
                  s.settingsSubtitle,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: cs.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 20),

                // 1. Share, Signature & Watermark Defaults
                _SettingsCard(
                  icon: Icons.share_outlined,
                  title: s.settingsShareSection,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SwitchListTile.adaptive(
                        contentPadding: EdgeInsets.zero,
                        value: cfg.shareShowAuthor,
                        title: Text(s.shareShowAuthorLabel),
                        onChanged: cfg.setShareShowAuthor,
                      ),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _authorCtrl,
                              decoration: InputDecoration(
                                labelText: s.shareAuthorInputLabel,
                                prefixText: '@',
                                isDense: true,
                              ),
                              onChanged: cfg.setAuthorName,
                            ),
                          ),
                          const SizedBox(width: 10),
                          OutlinedButton.icon(
                            onPressed: () {
                              final osName =
                                  AppSettingsController.defaultSystemAuthorName();
                              _authorCtrl.text = osName;
                              cfg.setAuthorName(osName);
                            },
                            icon: const Icon(Icons.person_outline, size: 16),
                            label: Text(s.settingsResetUsername),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),

                      SwitchListTile.adaptive(
                        contentPadding: EdgeInsets.zero,
                        value: cfg.shareShowBrandText,
                        title: Text(s.shareBrandToggle),
                        onChanged: cfg.setShareShowBrandText,
                      ),
                      TextField(
                        controller: _brandTextCtrl,
                        decoration: InputDecoration(
                          labelText: s.shareBrandTextLabel,
                          isDense: true,
                        ),
                        onChanged: cfg.setShareBrandText,
                      ),
                      const SizedBox(height: 12),

                      SwitchListTile.adaptive(
                        contentPadding: EdgeInsets.zero,
                        value: cfg.shareEnableWatermark,
                        title: Text(s.shareWatermarkToggle),
                        onChanged: cfg.setShareEnableWatermark,
                      ),
                      TextField(
                        controller: _watermarkCtrl,
                        decoration: InputDecoration(
                          labelText: s.shareWatermarkTextLabel,
                          hintText:
                              '@${cfg.authorName.trim().isEmpty ? "user" : cfg.authorName.trim()} · SessionManager',
                          isDense: true,
                        ),
                        onChanged: cfg.setShareWatermarkText,
                      ),
                      const SizedBox(height: 14),

                      Text(
                        s.shareColorStyleLabel,
                        style: theme.textTheme.labelMedium,
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          for (final style in ShareColorStyle.values)
                            Builder(
                              builder: (_) {
                                final pal = SharePalette.forStyle(style);
                                final selected = cfg.shareColorStyle == style;
                                return ChoiceChip(
                                  selected: selected,
                                  avatar: CircleAvatar(
                                    backgroundColor: pal.canvasBg,
                                    radius: 8,
                                    child: Container(
                                      width: 8,
                                      height: 8,
                                      decoration: BoxDecoration(
                                        color: pal.accent,
                                        shape: BoxShape.circle,
                                      ),
                                    ),
                                  ),
                                  label: Text(_styleLabel(s, style)),
                                  onSelected: (_) =>
                                      cfg.setShareColorStyle(style),
                                );
                              },
                            ),
                        ],
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 16),

                // 2. Appearance & Language
                _SettingsCard(
                  icon: Icons.palette_outlined,
                  title: s.settingsAppearanceSection,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Wrap(
                        spacing: 24,
                        runSpacing: 16,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                s.isZh ? '界面语言' : 'Language',
                                style: theme.textTheme.labelMedium,
                              ),
                              const SizedBox(height: 8),
                              SegmentedButton<AppLocale>(
                                segments: const [
                                  ButtonSegment(
                                    value: AppLocale.zh,
                                    label: Text('中文'),
                                  ),
                                  ButtonSegment(
                                    value: AppLocale.en,
                                    label: Text('English'),
                                  ),
                                ],
                                selected: {cfg.locale},
                                onSelectionChanged: (v) =>
                                    cfg.setLocale(v.first),
                              ),
                            ],
                          ),
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                s.isZh ? '颜色模式' : 'Color Theme Mode',
                                style: theme.textTheme.labelMedium,
                              ),
                              const SizedBox(height: 8),
                              SegmentedButton<ThemeMode>(
                                segments: [
                                  ButtonSegment(
                                    value: ThemeMode.light,
                                    label: Text(s.isZh ? '浅色' : 'Light'),
                                    icon: const Icon(Icons.light_mode_outlined,
                                        size: 15),
                                  ),
                                  ButtonSegment(
                                    value: ThemeMode.dark,
                                    label: Text(s.isZh ? '深色' : 'Dark'),
                                    icon: const Icon(Icons.dark_mode_outlined,
                                        size: 15),
                                  ),
                                  ButtonSegment(
                                    value: ThemeMode.system,
                                    label: Text(s.isZh ? '跟随系统' : 'System'),
                                    icon: const Icon(
                                        Icons.brightness_auto_outlined,
                                        size: 15),
                                  ),
                                ],
                                selected: {cfg.themeMode},
                                onSelectionChanged: (v) =>
                                    cfg.setThemeMode(v.first),
                              ),
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 16),

                // 3. Performance Profiling & Latency Logs
                _SettingsCard(
                  icon: Icons.speed_outlined,
                  title: s.settingsPerfSection,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: SwitchListTile.adaptive(
                              contentPadding: EdgeInsets.zero,
                              value: cfg.perfLoggingEnabled,
                              title: Text(s.settingsPerfToggle),
                              onChanged: cfg.setPerfLoggingEnabled,
                            ),
                          ),
                          TextButton.icon(
                            onPressed: () => PerfLogger.instance.clear(),
                            icon: const Icon(Icons.clear_all, size: 17),
                            label: Text(s.settingsClearPerfLogs),
                          ),
                        ],
                      ),
                      if (PerfLogger.instance.logFilePath != null) ...[
                        Text(
                          'JSONL Log: ${PerfLogger.instance.logFilePath}',
                          style: GoogleMaterialTheme.monoTextStyle(
                            fontSize: Gm3.monoSm,
                            color: cs.onSurfaceVariant,
                          ),
                        ),
                        const SizedBox(height: 8),
                      ],
                      ValueListenableBuilder<List<PerfLogEntry>>(
                        valueListenable: PerfLogger.instance.entriesNotifier,
                        builder: (_, entries, __) {
                          if (entries.isEmpty) {
                            return Container(
                              width: double.infinity,
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: surfaces.inset,
                                borderRadius:
                                    BorderRadius.circular(Gm3.radiusMd),
                              ),
                              child: Text(
                                s.isZh
                                    ? '暂无采样记录；打开或检索会话后将自动记录 SQLite 与首帧渲染耗时。'
                                    : 'No profile samples recorded yet; open a session to capture DB + first-frame latency.',
                                style: theme.textTheme.bodySmall?.copyWith(
                                  color: cs.onSurfaceVariant,
                                ),
                              ),
                            );
                          }
                          final recent = entries.take(12).toList();
                          return Container(
                            width: double.infinity,
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(
                              color: surfaces.inset,
                              borderRadius: BorderRadius.circular(Gm3.radiusMd),
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                for (final e in recent)
                                  Padding(
                                    padding:
                                        const EdgeInsets.symmetric(vertical: 3),
                                    child: Text(
                                      '${e.timestamp.toIso8601String().substring(11, 23)}  '
                                      '${e.operation}${e.targetId != null ? "(#${e.targetId})" : ""}  '
                                      'total=${e.totalMs}ms  '
                                      '${e.phases.entries.map((p) => "${p.key}=${p.value}ms").join(" ")}',
                                      style: GoogleMaterialTheme.monoTextStyle(
                                        fontSize: Gm3.monoSm,
                                        color: e.totalMs > 200
                                            ? cs.error
                                            : cs.onSurfaceVariant,
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          );
                        },
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 16),

                // 4. About, Version Info & GitHub Repository
                _SettingsCard(
                  icon: Icons.info_outline,
                  title: s.settingsAboutSection,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Gm3Pill(
                            label:
                                'SessionManager ${AppSettingsController.appVersion}',
                            color: cs.primary,
                            background: surfaces.chipFill,
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              'Archive: ${widget.store.dbPath}',
                              overflow: TextOverflow.ellipsis,
                              style: GoogleMaterialTheme.monoTextStyle(
                                fontSize: Gm3.monoSm,
                                color: cs.onSurfaceVariant,
                              ),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 12, vertical: 10),
                        decoration: BoxDecoration(
                          color: surfaces.inset,
                          borderRadius: BorderRadius.circular(Gm3.radiusMd),
                        ),
                        child: Row(
                          children: [
                            Icon(Icons.code_rounded,
                                size: 17, color: cs.primary),
                            const SizedBox(width: 10),
                            Expanded(
                              child: SelectableText(
                                AppSettingsController.githubUrl,
                                style: GoogleMaterialTheme.monoTextStyle(
                                  fontSize: Gm3.monoMd,
                                  color: cs.onSurface,
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            TextButton.icon(
                              onPressed: () {
                                Clipboard.setData(
                                  const ClipboardData(
                                    text: AppSettingsController.githubUrl,
                                  ),
                                );
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(
                                    content: Text(s.codeCopied),
                                    duration:
                                        const Duration(milliseconds: 1200),
                                  ),
                                );
                              },
                              icon: const Icon(Icons.copy, size: 15),
                              label: Text(s.settingsCopyUrl),
                            ),
                            const SizedBox(width: 6),
                            FilledButton.tonalIcon(
                              onPressed: _openGithubUrl,
                              icon: const Icon(Icons.open_in_new, size: 15),
                              label: Text(s.settingsOpenGithub),
                            ),
                          ],
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

class _SettingsCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final Widget child;

  const _SettingsCard({
    required this.icon,
    required this.title,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);

    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: surfaces.card,
        borderRadius: BorderRadius.circular(Gm3.radiusLg),
        border: Border.all(color: surfaces.hairline.withOpacity(0.45)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 18, color: cs.primary),
              const SizedBox(width: 8),
              Text(title, style: theme.textTheme.titleSmall),
            ],
          ),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}
