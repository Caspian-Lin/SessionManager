import 'package:flutter/material.dart';

/// Flutter native Material 3 + Windows 11 platform-adapted desktop styling:
/// Win11 Fluent neutral surfaces, Segoe UI Variable / Segoe UI typography,
/// Cascadia Mono code typography, compact desktop density, and adaptive light/dark palettes.
class WinAdaptiveTheme {
  WinAdaptiveTheme._();

  static const String uiFontFamily = 'Segoe UI Variable Display';
  static const List<String> uiFontFallback = ['Segoe UI', 'Microsoft YaHei UI', 'sans-serif'];

  static const String monoFontFamily = 'Cascadia Mono';
  static const List<String> monoFontFallback = ['Consolas', 'Courier New', 'monospace'];

  static const Color winLightAccent = Color(0xFF0067C0);
  static const Color winDarkAccent = Color(0xFF60CDFF);

  static const Color winLightCanvas = Color(0xFFF3F3F3);
  static const Color winLightSurface = Color(0xFFFBFBFB);
  static const Color winLightCard = Color(0xFFFFFFFF);
  static const Color winLightBorder = Color(0xFFE5E5E5);

  static const Color winDarkCanvas = Color(0xFF1C1C1F);
  static const Color winDarkSurface = Color(0xFF202024);
  static const Color winDarkCard = Color(0xFF2B2B30);
  static const Color winDarkBorder = Color(0xFF38383E);

  static TextStyle monoTextStyle({
    double fontSize = 12.5,
    Color? color,
    FontWeight fontWeight = FontWeight.normal,
    double height = 1.45,
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
    const scheme = ColorScheme.light(
      primary: winLightAccent,
      onPrimary: Colors.white,
      secondary: Color(0xFF0F6CBD),
      surface: winLightSurface,
      surfaceContainer: winLightCard,
      onSurface: Color(0xFF1A1A1A),
      onSurfaceVariant: Color(0xFF5C5C5C),
      outline: winLightBorder,
      error: Color(0xFFC42B1C),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      visualDensity: VisualDensity.compact,
      colorScheme: scheme,
      scaffoldBackgroundColor: winLightCanvas,
      dividerColor: winLightBorder,
      fontFamily: uiFontFamily,
      textTheme: _buildTextTheme(ThemeData.light().textTheme, scheme.onSurface),
      cardTheme: const CardTheme(
        color: winLightCard,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: winLightBorder),
          borderRadius: BorderRadius.all(Radius.circular(6)),
        ),
      ),
      navigationRailTheme: const NavigationRailThemeData(
        backgroundColor: winLightSurface,
        indicatorColor: Color(0xFFE3EFFB),
        selectedIconTheme: IconThemeData(color: winLightAccent, size: 20),
        unselectedIconTheme: IconThemeData(color: Color(0xFF5C5C5C), size: 20),
        selectedLabelTextStyle: TextStyle(color: winLightAccent, fontSize: 11, fontWeight: FontWeight.w600),
        unselectedLabelTextStyle: TextStyle(color: Color(0xFF5C5C5C), fontSize: 11),
      ),
      scrollbarTheme: ScrollbarThemeData(
        thumbVisibility: const WidgetStatePropertyAll(true),
        thickness: const WidgetStatePropertyAll(8),
        radius: const Radius.circular(4),
        thumbColor: WidgetStatePropertyAll(Colors.black.withOpacity(0.22)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        isDense: true,
        filled: true,
        fillColor: winLightCard,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: winLightBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: winLightBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: winLightAccent, width: 1.5),
        ),
      ),
    );
  }

  static ThemeData dark() {
    const scheme = ColorScheme.dark(
      primary: winDarkAccent,
      onPrimary: Color(0xFF002033),
      secondary: Color(0xFF4CC2FF),
      surface: winDarkSurface,
      surfaceContainer: winDarkCard,
      onSurface: Color(0xFFF3F3F3),
      onSurfaceVariant: Color(0xFFA0A0A8),
      outline: winDarkBorder,
      error: Color(0xFFFF99A4),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      visualDensity: VisualDensity.compact,
      colorScheme: scheme,
      scaffoldBackgroundColor: winDarkCanvas,
      dividerColor: winDarkBorder,
      fontFamily: uiFontFamily,
      textTheme: _buildTextTheme(ThemeData.dark().textTheme, scheme.onSurface),
      cardTheme: const CardTheme(
        color: winDarkCard,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          side: BorderSide(color: winDarkBorder),
          borderRadius: BorderRadius.all(Radius.circular(6)),
        ),
      ),
      navigationRailTheme: const NavigationRailThemeData(
        backgroundColor: winDarkSurface,
        indicatorColor: Color(0xFF1F3B4D),
        selectedIconTheme: IconThemeData(color: winDarkAccent, size: 20),
        unselectedIconTheme: IconThemeData(color: Color(0xFFA0A0A8), size: 20),
        selectedLabelTextStyle: TextStyle(color: winDarkAccent, fontSize: 11, fontWeight: FontWeight.w600),
        unselectedLabelTextStyle: TextStyle(color: Color(0xFFA0A0A8), fontSize: 11),
      ),
      scrollbarTheme: ScrollbarThemeData(
        thumbVisibility: const WidgetStatePropertyAll(true),
        thickness: const WidgetStatePropertyAll(8),
        radius: const Radius.circular(4),
        thumbColor: WidgetStatePropertyAll(Colors.white.withOpacity(0.24)),
      ),
      inputDecorationTheme: InputDecorationTheme(
        isDense: true,
        filled: true,
        fillColor: winDarkCard,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: winDarkBorder),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: winDarkBorder),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(4),
          borderSide: const BorderSide(color: winDarkAccent, width: 1.5),
        ),
      ),
    );
  }

  static TextTheme _buildTextTheme(TextTheme base, Color textColor) {
    return base.apply(
      fontFamily: uiFontFamily,
      fontFamilyFallback: uiFontFallback,
      bodyColor: textColor,
      displayColor: textColor,
    );
  }
}
