import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../l10n/app_strings.dart';
import 'perf_logger.dart';

enum ShareColorStyle {
  paperLight,
  obsidianDark,
  auroraBlue,
  warmSand,
  forestMint,
}

class SharePalette {
  final Color canvasBg;
  final Color cardBg;
  final Color cardBorder;
  final Color headerBg;
  final Color userBubbleBg;
  final Color userBubbleText;
  final Color assistantCardBg;
  final Color assistantText;
  final Color metaText;
  final Color accent;
  final Color watermarkColor;
  final bool isDark;

  const SharePalette({
    required this.canvasBg,
    required this.cardBg,
    required this.cardBorder,
    required this.headerBg,
    required this.userBubbleBg,
    required this.userBubbleText,
    required this.assistantCardBg,
    required this.assistantText,
    required this.metaText,
    required this.accent,
    required this.watermarkColor,
    required this.isDark,
  });

  static SharePalette forStyle(ShareColorStyle style) {
    return switch (style) {
      ShareColorStyle.paperLight => const SharePalette(
          canvasBg: Color(0xFFF3F6FC),
          cardBg: Color(0xFFFFFFFF),
          cardBorder: Color(0xFFE0E5EC),
          headerBg: Color(0xFFE8F0FE),
          userBubbleBg: Color(0xFFD3E3FD),
          userBubbleText: Color(0xFF0B2545),
          assistantCardBg: Color(0xFFF8FAFC),
          assistantText: Color(0xFF1F1F1F),
          metaText: Color(0xFF5F6368),
          accent: Color(0xFF0B57D0),
          watermarkColor: Color(0xFF0B57D0),
          isDark: false,
        ),
      ShareColorStyle.obsidianDark => const SharePalette(
          canvasBg: Color(0xFF101318),
          cardBg: Color(0xFF181C24),
          cardBorder: Color(0xFF2C3340),
          headerBg: Color(0xFF1F2633),
          userBubbleBg: Color(0xFF1E3A5F),
          userBubbleText: Color(0xFFE8F0FE),
          assistantCardBg: Color(0xFF1F242E),
          assistantText: Color(0xFFE3E8EF),
          metaText: Color(0xFF9AA4B2),
          accent: Color(0xFF8AB4F8),
          watermarkColor: Color(0xFF8AB4F8),
          isDark: true,
        ),
      ShareColorStyle.auroraBlue => const SharePalette(
          canvasBg: Color(0xFFEAF2FF),
          cardBg: Color(0xFFFFFFFF),
          cardBorder: Color(0xFFC5DAFC),
          headerBg: Color(0xFFD6E6FF),
          userBubbleBg: Color(0xFF1A73E8),
          userBubbleText: Color(0xFFFFFFFF),
          assistantCardBg: Color(0xFFF4F8FF),
          assistantText: Color(0xFF132238),
          metaText: Color(0xFF4A607A),
          accent: Color(0xFF1558D6),
          watermarkColor: Color(0xFF1A73E8),
          isDark: false,
        ),
      ShareColorStyle.warmSand => const SharePalette(
          canvasBg: Color(0xFFF7F2EA),
          cardBg: Color(0xFFFFFCF7),
          cardBorder: Color(0xFFE6DAC6),
          headerBg: Color(0xFFF1E5D2),
          userBubbleBg: Color(0xFFE8D5B7),
          userBubbleText: Color(0xFF3E2C14),
          assistantCardBg: Color(0xFFFAF5EC),
          assistantText: Color(0xFF2D2418),
          metaText: Color(0xFF7B6B55),
          accent: Color(0xFF9C5E14),
          watermarkColor: Color(0xFF9C5E14),
          isDark: false,
        ),
      ShareColorStyle.forestMint => const SharePalette(
          canvasBg: Color(0xFFECF6F1),
          cardBg: Color(0xFFFFFFFF),
          cardBorder: Color(0xFFC4E2D3),
          headerBg: Color(0xFFD8EFE3),
          userBubbleBg: Color(0xFF1B7A54),
          userBubbleText: Color(0xFFFFFFFF),
          assistantCardBg: Color(0xFFF3FAF6),
          assistantText: Color(0xFF132A20),
          metaText: Color(0xFF466959),
          accent: Color(0xFF146C43),
          watermarkColor: Color(0xFF1B7A54),
          isDark: false,
        ),
    };
  }
}

class AppSettingsController extends ChangeNotifier {
  static const String appVersion = 'v0.1.0+1';
  static const String githubUrl = 'https://github.com/Caspian-Lin/SessionManager';

  String? _settingsDir;
  AppLocale _locale;
  ThemeMode _themeMode;
  String _authorName;
  bool _shareShowAuthor;
  bool _shareEnableWatermark;
  String _shareWatermarkText;
  bool _shareShowBrandText;
  String _shareBrandText;
  ShareColorStyle _shareColorStyle;
  bool _perfLoggingEnabled;

  AppSettingsController({
    String? settingsDir,
    AppLocale locale = AppLocale.zh,
    ThemeMode themeMode = ThemeMode.light,
    String? authorName,
    bool shareShowAuthor = true,
    bool shareEnableWatermark = true,
    String shareWatermarkText = '',
    bool shareShowBrandText = true,
    String shareBrandText = '由 SessionManager 分享',
    ShareColorStyle shareColorStyle = ShareColorStyle.paperLight,
    bool perfLoggingEnabled = true,
  })  : _settingsDir = settingsDir,
        _locale = locale,
        _themeMode = themeMode,
        _authorName = authorName ?? defaultSystemAuthorName(),
        _shareShowAuthor = shareShowAuthor,
        _shareEnableWatermark = shareEnableWatermark,
        _shareWatermarkText = shareWatermarkText,
        _shareShowBrandText = shareShowBrandText,
        _shareBrandText = shareBrandText,
        _shareColorStyle = shareColorStyle,
        _perfLoggingEnabled = perfLoggingEnabled {
    PerfLogger.instance.enabled = _perfLoggingEnabled;
    if (settingsDir != null) {
      loadFromDir(settingsDir);
    }
  }

  static String defaultSystemAuthorName() {
    final envUser = (Platform.environment['USERNAME'] ??
            Platform.environment['USER'] ??
            Platform.localHostname)
        .trim();
    return envUser.isNotEmpty ? envUser : 'SessionManager User';
  }

  AppLocale get locale => _locale;
  ThemeMode get themeMode => _themeMode;
  String get authorName => _authorName;
  bool get shareShowAuthor => _shareShowAuthor;
  bool get shareEnableWatermark => _shareEnableWatermark;
  String get shareWatermarkText => _shareWatermarkText;
  bool get shareShowBrandText => _shareShowBrandText;
  String get shareBrandText => _shareBrandText;
  ShareColorStyle get shareColorStyle => _shareColorStyle;
  bool get perfLoggingEnabled => _perfLoggingEnabled;

  String get effectiveWatermarkText {
    final trimmed = _shareWatermarkText.trim();
    if (trimmed.isNotEmpty) return trimmed;
    final author = _authorName.trim();
    if (author.isNotEmpty) return '@$author · SessionManager';
    return 'SessionManager';
  }

  void setLocale(AppLocale val) {
    if (_locale == val) return;
    _locale = val;
    notifyListeners();
    _persist();
  }

  void setThemeMode(ThemeMode val) {
    if (_themeMode == val) return;
    _themeMode = val;
    notifyListeners();
    _persist();
  }

  void setAuthorName(String val) {
    if (_authorName == val) return;
    _authorName = val;
    notifyListeners();
    _persist();
  }

  void setShareShowAuthor(bool val) {
    if (_shareShowAuthor == val) return;
    _shareShowAuthor = val;
    notifyListeners();
    _persist();
  }

  void setShareEnableWatermark(bool val) {
    if (_shareEnableWatermark == val) return;
    _shareEnableWatermark = val;
    notifyListeners();
    _persist();
  }

  void setShareWatermarkText(String val) {
    if (_shareWatermarkText == val) return;
    _shareWatermarkText = val;
    notifyListeners();
    _persist();
  }

  void setShareShowBrandText(bool val) {
    if (_shareShowBrandText == val) return;
    _shareShowBrandText = val;
    notifyListeners();
    _persist();
  }

  void setShareBrandText(String val) {
    if (_shareBrandText == val) return;
    _shareBrandText = val;
    notifyListeners();
    _persist();
  }

  void setShareColorStyle(ShareColorStyle val) {
    if (_shareColorStyle == val) return;
    _shareColorStyle = val;
    notifyListeners();
    _persist();
  }

  void setPerfLoggingEnabled(bool val) {
    if (_perfLoggingEnabled == val) return;
    _perfLoggingEnabled = val;
    PerfLogger.instance.enabled = val;
    notifyListeners();
    _persist();
  }

  void attachSettingsDir(String dir) {
    if (_settingsDir == dir) return;
    _settingsDir = dir;
    PerfLogger.instance.archiveRoot = dir;
    loadFromDir(dir);
  }

  void loadFromDir(String dir) {
    _settingsDir = dir;
    PerfLogger.instance.archiveRoot = dir;
    try {
      final file = File(p.join(dir, 'ui_settings.json'));
      if (!file.existsSync()) return;
      final decoded = jsonDecode(file.readAsStringSync());
      if (decoded is! Map<String, dynamic>) return;

      if (decoded['locale'] == 'en') _locale = AppLocale.en;
      if (decoded['locale'] == 'zh') _locale = AppLocale.zh;

      switch (decoded['theme_mode']) {
        case 'dark':
          _themeMode = ThemeMode.dark;
          break;
        case 'system':
          _themeMode = ThemeMode.system;
          break;
        case 'light':
          _themeMode = ThemeMode.light;
          break;
      }

      if (decoded['author_name'] is String) {
        _authorName = decoded['author_name'] as String;
      }
      if (decoded['share_show_author'] is bool) {
        _shareShowAuthor = decoded['share_show_author'] as bool;
      }
      if (decoded['share_enable_watermark'] is bool) {
        _shareEnableWatermark = decoded['share_enable_watermark'] as bool;
      }
      if (decoded['share_watermark_text'] is String) {
        _shareWatermarkText = decoded['share_watermark_text'] as String;
      }
      if (decoded['share_show_brand_text'] is bool) {
        _shareShowBrandText = decoded['share_show_brand_text'] as bool;
      }
      if (decoded['share_brand_text'] is String &&
          (decoded['share_brand_text'] as String).trim().isNotEmpty) {
        _shareBrandText = decoded['share_brand_text'] as String;
      }
      if (decoded['share_color_style'] is String) {
        final rawStyle = decoded['share_color_style'] as String;
        for (final s in ShareColorStyle.values) {
          if (s.name == rawStyle) {
            _shareColorStyle = s;
            break;
          }
        }
      }
      if (decoded['perf_logging_enabled'] is bool) {
        _perfLoggingEnabled = decoded['perf_logging_enabled'] as bool;
        PerfLogger.instance.enabled = _perfLoggingEnabled;
      }
      notifyListeners();
    } catch (_) {
      // Ignore corrupt or inaccessible settings files
    }
  }

  void _persist() {
    final dir = _settingsDir;
    if (dir == null || dir.trim().isEmpty) return;
    try {
      final file = File(p.join(dir, 'ui_settings.json'));
      file.parent.createSync(recursive: true);
      final payload = {
        'locale': _locale.name,
        'theme_mode': _themeMode.name,
        'author_name': _authorName,
        'share_show_author': _shareShowAuthor,
        'share_enable_watermark': _shareEnableWatermark,
        'share_watermark_text': _shareWatermarkText,
        'share_show_brand_text': _shareShowBrandText,
        'share_brand_text': _shareBrandText,
        'share_color_style': _shareColorStyle.name,
        'perf_logging_enabled': _perfLoggingEnabled,
      };
      file.writeAsStringSync(const JsonEncoder.withIndent('  ').convert(payload));
    } catch (_) {
      // Best-effort write
    }
  }
}
