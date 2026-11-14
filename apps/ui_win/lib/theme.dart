import 'package:flutter/material.dart';

/// Google Material 3 native flat desktop theme:
/// Clean Google Blue seed palette (`#1A73E8`), tonal surfaces (`surfaceContainerLow` /
/// `surfaceContainerLowest`), generous spacing, pill navigation indicators, and crisp
/// Windows font fallbacks for Chinese + English + monospace code.
class GoogleMaterialTheme {
  GoogleMaterialTheme._();

  static const Color googleBlueSeed = Color(0xFF1A73E8);

  static const String uiFontFamily = 'Segoe UI';
  static const List<String> uiFontFallback = ['Microsoft YaHei UI', 'Segoe UI Variable Text', 'sans-serif'];

  static const String monoFontFamily = 'Cascadia Mono';
  static const List<String> monoFontFallback = ['Consolas', 'Courier New', 'monospace'];

  static TextStyle monoTextStyle({
    double fontSize = 12.5,
    Color? color,
    FontWeight fontWeight = FontWeight.normal,
    double height = 1.5,
  }) {
    return TextStyle(
      fontFamily: monoFontFamily,
      fontFamilyFallback: monoFontFallback,
      fontSize: fontSize,
      fontWeight: fontWeight,
      color: color,
      height: height,
    );
  }

  static ThemeData light() {
    final baseScheme = ColorScheme.fromSeed(
      seedColor: googleBlueSeed,
      brightness: Brightness.light,
    );
    final scheme = baseScheme.copyWith(
      surface: const Color(0xFFF8FAFD),
      surfaceContainerLowest: const Color(0xFFFFFFFF),
      surfaceContainerLow: const Color(0xFFF0F4F9),
      surfaceContainer: const Color(0xFFE9EEF6),
      surfaceContainerHigh: const Color(0xFFE1E6EE),
      outlineVariant: const Color(0xFFDADCE0),
    );

    return _buildTheme(scheme, Brightness.light);
  }

  static ThemeData dark() {
    final baseScheme = ColorScheme.fromSeed(
      seedColor: googleBlueSeed,
      brightness: Brightness.dark,
    );
    final scheme = baseScheme.copyWith(
      surface: const Color(0xFF131314),
      surfaceContainerLowest: const Color(0xFF1B1B1D),
      surfaceContainerLow: const Color(0xFF1E1F20),
      surfaceContainer: const Color(0xFF28292C),
      surfaceContainerHigh: const Color(0xFF333538),
      outlineVariant: const Color(0xFF3C4043),
    );

    return _buildTheme(scheme, Brightness.dark);
  }

  static ThemeData _buildTheme(ColorScheme scheme, Brightness brightness) {
    final baseText = (brightness == Brightness.light ? ThemeData.light() : ThemeData.dark()).textTheme;
    final textTheme = baseText.apply(
      fontFamily: uiFontFamily,
      fontFamilyFallback: uiFontFallback,
      bodyColor: scheme.onSurface,
      displayColor: scheme.onSurface,
    );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      dividerColor: scheme.outlineVariant.withOpacity(0.55),
      fontFamily: uiFontFamily,
      textTheme: textTheme,
      cardTheme: CardTheme(
        color: scheme.surfaceContainerLowest,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: scheme.outlineVariant.withOpacity(0.55)),
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: scheme.surfaceContainerLow,
        indicatorColor: scheme.secondaryContainer,
        indicatorShape: const StadiumBorder(),
        selectedIconTheme: IconThemeData(color: scheme.onSecondaryContainer, size: 20),
        unselectedIconTheme: IconThemeData(color: scheme.onSurfaceVariant, size: 20),
        selectedLabelTextStyle: TextStyle(
          color: scheme.onSurface,
          fontSize: 12,
          fontWeight: FontWeight.w600,
          fontFamily: uiFontFamily,
          fontFamilyFallback: uiFontFallback,
        ),
        unselectedLabelTextStyle: TextStyle(
          color: scheme.onSurfaceVariant,
          fontSize: 12,
          fontFamily: uiFontFamily,
          fontFamilyFallback: uiFontFallback,
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: scheme.surfaceContainerLow,
        selectedColor: scheme.secondaryContainer,
        side: BorderSide.none,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        labelStyle: TextStyle(fontSize: 12.5, color: scheme.onSurface),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          side: BorderSide(color: scheme.outlineVariant),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerLow,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide(color: scheme.primary, width: 1.5),
        ),
      ),
      scrollbarTheme: ScrollbarThemeData(
        thumbVisibility: const WidgetStatePropertyAll(false),
        thickness: const WidgetStatePropertyAll(7),
        radius: const Radius.circular(8),
        thumbColor: WidgetStatePropertyAll(scheme.onSurfaceVariant.withOpacity(0.28)),
      ),
    );
  }
}
