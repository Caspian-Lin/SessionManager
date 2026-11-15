import 'package:flutter/material.dart';

/// Design tokens for the native Google desktop shell.
///
/// The shell is built the way Google Workspace surfaces are built (Material 3
/// "tone-based surfaces" + the 2024-2026 Drive/Gmail refresh):
///
///  * **One chrome tone** — window canvas, header and navigation rail all use
///    `canvas`, so the rounded top corners of the content sheet read as a
///    transition instead of a notch.
///  * **One content tone** — the sheet is `panel`, one step toward the viewer.
///  * **No strokes, no gradients** — every container is one flat tone. Depth
///    comes from tone + radius + spacing only. Hairlines survive as structural
///    separators inside the sheet.
///
/// See `docs/ui/google-native-shell.md` for the sources behind these numbers.
class Gm3 {
  Gm3._();

  // ---- Shape scale --------------------------------------------------------
  // Exactly five radii exist in the app. Anything that looks like a container
  // uses one of them; there is no per-widget rounding.
  //
  //   radiusXs   6  inline code, 1-line micro tags
  //   radiusSm  10  compact controls (caption hover, small badges)
  //   radiusMd  12  cards, list rows, tiles, code blocks, inputs
  //   radiusLg  16  content sheet and large nested panels
  //   radiusPill ∞  buttons, chips, search field, rail indicator
  static const double radiusXs = 6;
  static const double radiusSm = 10;
  static const double radiusMd = 12;
  static const double radiusLg = 16;
  static const double radiusPill = 999;

  // ---- Type scale ---------------------------------------------------------
  // One size per semantic level. Views must read these from `textTheme`
  // instead of hard-coding font sizes.
  //
  //   titleLarge   22 / w500   empty-state + dialog headlines
  //   titleMedium  16 / w600   app bar + sheet titles
  //   titleSmall   14 / w600   card titles, section headers
  //   bodyLarge    14 / w400   reader body copy (height 1.7 applied in views)
  //   bodyMedium   13 / w400   default body text
  //   bodySmall    12 / w400   secondary copy, metadata lines
  //   labelLarge   13 / w600   filled/text button labels
  //   labelMedium  11.5 / w600 badges, pills, chips
  //   labelSmall   11 / w500   timestamps, hedges, counts
  static const double fontSizeTitleLarge = 22;
  static const double fontSizeTitleMedium = 16;
  static const double fontSizeTitleSmall = 14;
  static const double fontSizeBodyLarge = 14;
  static const double fontSizeBodyMedium = 13;
  static const double fontSizeBodySmall = 12;
  static const double fontSizeLabelLarge = 13;
  static const double fontSizeLabelMedium = 11.5;
  static const double fontSizeLabelSmall = 11;

  /// Monospace sizes are locked to the same three steps as the body scale.
  static const double monoSm = 11;
  static const double monoMd = 12;
  static const double monoLg = 13;

  // ---- Desktop shell metrics ---------------------------------------------
  /// Height of the unified title bar / app bar band.
  static const double headerHeight = 56;

  /// Collapsed navigation rail width (M3 spec + Flutter M3 default).
  static const double railWidth = 80;

  /// Width of the session list pane inside the content sheet.
  static const double listPaneWidth = 448;

  /// Size of the window caption buttons (Windows uses 46x32 for native ones).
  static const double captionButtonWidth = 36;
  static const double captionButtonHeight = 32;

  static const Color googleBlue = Color(0xFF1A73E8);
  static const Color googleRed = Color(0xFFC5221F);

  static const String uiFontFamily = 'Segoe UI';
  static const List<String> uiFontFallback = [
    'Segoe UI Variable Text',
    'Microsoft YaHei UI',
    'sans-serif',
  ];

  static const String monoFontFamily = 'Cascadia Mono';
  static const List<String> monoFontFallback = [
    'Consolas',
    'Courier New',
    'monospace',
  ];

  /// Builds a [TextStyle] that always carries the app font family.
  ///
  /// Styles created inside theme data (chips, segmented buttons, tooltips) do
  /// not inherit `ThemeData.fontFamily`, so every style has to name it
  /// explicitly or it falls back to the platform default.
  static TextStyle text({
    required double fontSize,
    FontWeight fontWeight = FontWeight.w400,
    Color? color,
    double? height,
    double? letterSpacing,
  }) {
    return TextStyle(
      fontFamily: uiFontFamily,
      fontFamilyFallback: uiFontFallback,
      fontSize: fontSize,
      fontWeight: fontWeight,
      color: color,
      height: height,
      letterSpacing: letterSpacing,
    );
  }

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

  /// Lifts a semantic accent so it stays legible on dark surfaces.
  ///
  /// Provider/status accents are defined once (green, amber, violet…) and are
  /// only readable on light tonal fills; dark mode needs the same hue lifted.
  static Color adaptiveTint(
    Color color,
    Brightness brightness, {
    double amount = 0.55,
  }) {
    if (brightness == Brightness.light) return color;
    return Color.lerp(color, Colors.white, amount)!;
  }

  // ---- Surface palette ----------------------------------------------------
  static ThemeData light() => _buildTheme(Gm3Surfaces.light());

  static ThemeData dark() => _buildTheme(Gm3Surfaces.dark());

  static ThemeData _buildTheme(Gm3Surfaces surfaces) {
    final brightness = surfaces.brightness;
    final isLight = brightness == Brightness.light;

    final baseScheme = ColorScheme.fromSeed(
      seedColor: googleBlue,
      brightness: brightness,
    );
    final scheme = baseScheme.copyWith(
      // Google's product blues, so buttons, indicators and pills stay on brand
      // instead of drifting with the seed's generated tones.
      primary: isLight ? const Color(0xFF1A73E8) : const Color(0xFF8AB4F8),
      onPrimary: isLight ? const Color(0xFFFFFFFF) : const Color(0xFF062E6F),
      primaryContainer: isLight ? const Color(0xFFD3E3FD) : const Color(0xFF1F3A5F),
      onPrimaryContainer: isLight ? const Color(0xFF041E49) : const Color(0xFFD3E3FD),
      secondaryContainer: isLight ? const Color(0xFFE8F0FE) : const Color(0xFF24354F),
      onSecondaryContainer: isLight ? const Color(0xFF0B57D0) : const Color(0xFFD2E3FC),
      surface: surfaces.panel,
      surfaceContainerLowest: surfaces.panel,
      surfaceContainerLow: isLight
          ? const Color(0xFFF1F4FA)
          : const Color(0xFF26272A),
      surfaceContainer: isLight
          ? const Color(0xFFE9EEF7)
          : const Color(0xFF2C2D31),
      surfaceContainerHigh: isLight
          ? const Color(0xFFE1E7F2)
          : const Color(0xFF34363A),
      surfaceContainerHighest: isLight
          ? const Color(0xFFDAE1ED)
          : const Color(0xFF3C3F44),
      outlineVariant: surfaces.hairline,
    );

    final baseText = (isLight ? ThemeData.light() : ThemeData.dark())
        .textTheme
        .apply(
          fontFamily: uiFontFamily,
          fontFamilyFallback: uiFontFallback,
          bodyColor: scheme.onSurface,
          displayColor: scheme.onSurface,
        );
    // One size and weight per semantic level — see the type scale above.
    final textTheme = baseText.copyWith(
      titleLarge: baseText.titleLarge?.copyWith(
        fontSize: fontSizeTitleLarge,
        fontWeight: FontWeight.w500,
        letterSpacing: -0.2,
        height: 1.3,
      ),
      titleMedium: baseText.titleMedium?.copyWith(
        fontSize: fontSizeTitleMedium,
        fontWeight: FontWeight.w600,
        letterSpacing: -0.15,
        height: 1.3,
      ),
      titleSmall: baseText.titleSmall?.copyWith(
        fontSize: fontSizeTitleSmall,
        fontWeight: FontWeight.w600,
        height: 1.35,
      ),
      bodyLarge: baseText.bodyLarge?.copyWith(
        fontSize: fontSizeBodyLarge,
        height: 1.55,
      ),
      bodyMedium: baseText.bodyMedium?.copyWith(
        fontSize: fontSizeBodyMedium,
        height: 1.5,
      ),
      bodySmall: baseText.bodySmall?.copyWith(
        fontSize: fontSizeBodySmall,
        height: 1.45,
        color: scheme.onSurfaceVariant,
      ),
      labelLarge: baseText.labelLarge?.copyWith(
        fontSize: fontSizeLabelLarge,
        fontWeight: FontWeight.w600,
      ),
      labelMedium: baseText.labelMedium?.copyWith(
        fontSize: fontSizeLabelMedium,
        fontWeight: FontWeight.w600,
        height: 1.25,
      ),
      labelSmall: baseText.labelSmall?.copyWith(
        fontSize: fontSizeLabelSmall,
        fontWeight: FontWeight.w500,
        height: 1.3,
        color: scheme.onSurfaceVariant,
      ),
    );

    final pillShape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(radiusPill),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: surfaces.canvas,
      canvasColor: surfaces.canvas,
      dividerColor: surfaces.hairline,
      fontFamily: uiFontFamily,
      textTheme: textTheme,
      extensions: <ThemeExtension<dynamic>>[surfaces],
      splashFactory: InkSparkle.splashFactory,
      cardTheme: CardTheme(
        color: surfaces.card,
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusMd),
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: Colors.transparent,
        elevation: 0,
        indicatorColor: surfaces.railIndicator,
        indicatorShape: const StadiumBorder(),
        useIndicator: true,
        minWidth: railWidth,
        labelType: NavigationRailLabelType.all,
        selectedIconTheme: IconThemeData(
          color: scheme.onSecondaryContainer,
          size: 22,
        ),
        unselectedIconTheme: IconThemeData(
          color: scheme.onSurfaceVariant,
          size: 22,
        ),
        selectedLabelTextStyle: TextStyle(
          color: scheme.onSurface,
          fontSize: 11.5,
          fontWeight: FontWeight.w600,
          fontFamily: uiFontFamily,
          fontFamilyFallback: uiFontFallback,
        ),
        unselectedLabelTextStyle: TextStyle(
          color: scheme.onSurfaceVariant,
          fontSize: 11.5,
          fontWeight: FontWeight.w500,
          fontFamily: uiFontFamily,
          fontFamilyFallback: uiFontFallback,
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: surfaces.chipFill,
        selectedColor: surfaces.chipSelected,
        side: BorderSide.none,
        shape: pillShape,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        labelStyle: Gm3.text(
          fontSize: fontSizeBodySmall,
          fontWeight: FontWeight.w500,
          color: scheme.onSurface,
        ),
        secondaryLabelStyle: Gm3.text(
          fontSize: fontSizeBodySmall,
          fontWeight: FontWeight.w600,
          color: scheme.onSecondaryContainer,
        ),
        showCheckmark: false,
      ),
      segmentedButtonTheme: SegmentedButtonThemeData(
        style: ButtonStyle(
          elevation: const WidgetStatePropertyAll(0),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          visualDensity: VisualDensity.compact,
          minimumSize: const WidgetStatePropertyAll(Size(0, 28)),
          maximumSize: const WidgetStatePropertyAll(Size(double.infinity, 28)),
          alignment: Alignment.center,
          backgroundColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.selected)) {
              return surfaces.chipSelected;
            }
            return Colors.transparent;
          }),
          foregroundColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.selected)) {
              return scheme.onSecondaryContainer;
            }
            return scheme.onSurfaceVariant;
          }),
          side: const WidgetStatePropertyAll(BorderSide.none),
          // No `shape` override: SegmentedButton derives the per-position
          // corner radii itself, so the outer ends stay rounded.
          padding: const WidgetStatePropertyAll(
            EdgeInsets.symmetric(horizontal: 10, vertical: 0),
          ),
          textStyle: WidgetStatePropertyAll(
            Gm3.text(
              fontSize: fontSizeLabelMedium,
              fontWeight: FontWeight.w600,
              height: 1.0,
            ),
          ),
        ),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          elevation: 0,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          shape: pillShape,
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
          side: BorderSide(color: surfaces.hairline),
          shape: pillShape,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          shape: pillShape,
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: ButtonStyle(
          shape: const WidgetStatePropertyAll(CircleBorder()),
          foregroundColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.disabled)) {
              return scheme.onSurface.withOpacity(0.38);
            }
            return scheme.onSurfaceVariant;
          }),
          overlayColor: WidgetStateProperty.resolveWith((states) {
            if (states.contains(WidgetState.pressed)) {
              return scheme.onSurface.withOpacity(0.12);
            }
            if (states.contains(WidgetState.hovered)) {
              return scheme.onSurface.withOpacity(0.07);
            }
            return Colors.transparent;
          }),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surfaces.fieldFill,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        hintStyle: Gm3.text(
          fontSize: fontSizeBodyMedium,
          color: scheme.onSurfaceVariant,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusPill),
          borderSide: BorderSide.none,
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusPill),
          borderSide: BorderSide.none,
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radiusPill),
          borderSide: BorderSide(
            color: scheme.primary.withOpacity(0.55),
            width: 1.5,
          ),
        ),
      ),
      tooltipTheme: TooltipThemeData(
        waitDuration: const Duration(milliseconds: 500),
        decoration: BoxDecoration(
          color: isLight ? const Color(0xFF2E3134) : const Color(0xFFE8EAED),
          borderRadius: BorderRadius.circular(radiusSm),
        ),
        textStyle: Gm3.text(
          fontSize: fontSizeLabelMedium,
          color: isLight ? const Color(0xFFF1F3F4) : const Color(0xFF1F1F1F),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      ),
      scrollbarTheme: ScrollbarThemeData(
        thumbVisibility: const WidgetStatePropertyAll(false),
        thickness: const WidgetStatePropertyAll(6),
        radius: const Radius.circular(8),
        crossAxisMargin: 2,
        thumbColor: WidgetStateProperty.resolveWith((states) {
          final base = scheme.onSurfaceVariant;
          return base.withOpacity(states.contains(WidgetState.hovered) ? 0.4 : 0.26);
        }),
      ),
      dialogTheme: DialogTheme(
        backgroundColor: surfaces.card,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusLg),
        ),
      ),
      popupMenuTheme: PopupMenuThemeData(
        color: surfaces.card,
        surfaceTintColor: Colors.transparent,
        elevation: 2,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radiusMd),
        ),
      ),
      dropdownMenuTheme: DropdownMenuThemeData(
        textStyle: Gm3.text(
          fontSize: fontSizeBodyMedium,
          color: scheme.onSurface,
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: surfaces.fieldFill,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(radiusSm),
            borderSide: BorderSide.none,
          ),
        ),
      ),
    );
  }
}

/// Flat surface tones used by the shell.
///
/// Containers are **solid fills**: Material 3 defines surfaces as flat tone
/// values, and a gradient inside a card reads as a sheen instead of a surface.
/// Hierarchy comes from tone + radius + spacing alone — never from a border and
/// never from a gradient.
@immutable
class Gm3Surfaces extends ThemeExtension<Gm3Surfaces> {
  const Gm3Surfaces({
    required this.brightness,
    required this.canvas,
    required this.panel,
    required this.card,
    required this.cardHover,
    required this.cardSelected,
    required this.inset,
    required this.hairline,
    required this.chipFill,
    required this.chipSelected,
    required this.fieldFill,
    required this.railIndicator,
    required this.captionHover,
    required this.captionPressed,
    required this.closeHover,
    required this.closePressed,
    required this.captionGlyph,
    required this.captionGlyphInactive,
    required this.readerAccent,
    required this.readerAccentSoft,
  });

  /// Window canvas **and** header **and** navigation rail: one tone by design.
  final Color canvas;

  /// The single content sheet (session list + reader).
  final Color panel;

  /// Containers inside the sheet: session cards, import sections, code blocks.
  final Color card;
  final Color cardHover;
  final Color cardSelected;

  /// Recessed wells inside a card (agent rows, guide boxes).
  final Color inset;

  /// Structural separators only. Never used to stroke a container.
  final Color hairline;

  final Color chipFill;
  final Color chipSelected;
  final Color fieldFill;
  final Color railIndicator;

  final Color captionHover;
  final Color captionPressed;
  final Color closeHover;
  final Color closePressed;
  final Color captionGlyph;
  final Color captionGlyphInactive;

  /// Accent used by the reader for user bubbles and quoted text.
  final Color readerAccent;
  final Color readerAccentSoft;

  final Brightness brightness;

  static const Gm3Surfaces lightTokens = Gm3Surfaces(
    brightness: Brightness.light,
    canvas: Color(0xFFF1F5FC),
    panel: Color(0xFFFFFFFF),
    card: Color(0xFFF5F8FD),
    cardHover: Color(0xFFEAF1FB),
    cardSelected: Color(0xFFDDE9FE),
    inset: Color(0xFFEDF2FA),
    hairline: Color(0xFFE4E9F1),
    chipFill: Color(0xFFEBF0F8),
    chipSelected: Color(0xFFD3E3FD),
    fieldFill: Color(0xFFEBF0F8),
    railIndicator: Color(0xFFD3E3FD),
    captionHover: Color(0x0F1F1F1F),
    captionPressed: Color(0x1F1F1F1F),
    closeHover: Color(0xFFC42B1C),
    closePressed: Color(0xFFB02516),
    captionGlyph: Color(0xFF3C4043),
    captionGlyphInactive: Color(0xFF9AA0A6),
    readerAccent: Color(0xFF1A73E8),
    readerAccentSoft: Color(0xFFE8F0FE),
  );

  static const Gm3Surfaces darkTokens = Gm3Surfaces(
    brightness: Brightness.dark,
    canvas: Color(0xFF1E1F22),
    panel: Color(0xFF26272A),
    card: Color(0xFF2E2F33),
    cardHover: Color(0xFF383A3F),
    cardSelected: Color(0xFF1F3A5F),
    inset: Color(0xFF212226),
    hairline: Color(0xFF3A3D42),
    chipFill: Color(0xFF323438),
    chipSelected: Color(0xFF3D5B80),
    fieldFill: Color(0xFF323438),
    railIndicator: Color(0xFF3D5B80),
    captionHover: Color(0x1FFFFFFF),
    captionPressed: Color(0x29FFFFFF),
    closeHover: Color(0xFFC42B1C),
    closePressed: Color(0xFFB02516),
    captionGlyph: Color(0xFFE8EAED),
    captionGlyphInactive: Color(0xFF9AA0A6),
    readerAccent: Color(0xFF8AB4F8),
    readerAccentSoft: Color(0xFF26384F),
  );

  static Gm3Surfaces light() => lightTokens;

  static Gm3Surfaces dark() => darkTokens;

  static Gm3Surfaces of(BuildContext context) {
    return Theme.of(context).extension<Gm3Surfaces>() ??
        (Theme.of(context).brightness == Brightness.light
            ? lightTokens
            : darkTokens);
  }

  @override
  Gm3Surfaces copyWith({
    Brightness? brightness,
    Color? canvas,
    Color? panel,
    Color? card,
    Color? cardHover,
    Color? cardSelected,
    Color? inset,
    Color? hairline,
    Color? chipFill,
    Color? chipSelected,
    Color? fieldFill,
    Color? railIndicator,
    Color? captionHover,
    Color? captionPressed,
    Color? closeHover,
    Color? closePressed,
    Color? captionGlyph,
    Color? captionGlyphInactive,
    Color? readerAccent,
    Color? readerAccentSoft,
  }) {
    return Gm3Surfaces(
      brightness: brightness ?? this.brightness,
      canvas: canvas ?? this.canvas,
      panel: panel ?? this.panel,
      card: card ?? this.card,
      cardHover: cardHover ?? this.cardHover,
      cardSelected: cardSelected ?? this.cardSelected,
      inset: inset ?? this.inset,
      hairline: hairline ?? this.hairline,
      chipFill: chipFill ?? this.chipFill,
      chipSelected: chipSelected ?? this.chipSelected,
      fieldFill: fieldFill ?? this.fieldFill,
      railIndicator: railIndicator ?? this.railIndicator,
      captionHover: captionHover ?? this.captionHover,
      captionPressed: captionPressed ?? this.captionPressed,
      closeHover: closeHover ?? this.closeHover,
      closePressed: closePressed ?? this.closePressed,
      captionGlyph: captionGlyph ?? this.captionGlyph,
      captionGlyphInactive: captionGlyphInactive ?? this.captionGlyphInactive,
      readerAccent: readerAccent ?? this.readerAccent,
      readerAccentSoft: readerAccentSoft ?? this.readerAccentSoft,
    );
  }

  @override
  Gm3Surfaces lerp(ThemeExtension<Gm3Surfaces>? other, double t) {
    if (other is! Gm3Surfaces) {
      return this;
    }
    return Gm3Surfaces(
      brightness: t < 0.5 ? brightness : other.brightness,
      canvas: Color.lerp(canvas, other.canvas, t)!,
      panel: Color.lerp(panel, other.panel, t)!,
      card: Color.lerp(card, other.card, t)!,
      cardHover: Color.lerp(cardHover, other.cardHover, t)!,
      cardSelected: Color.lerp(cardSelected, other.cardSelected, t)!,
      inset: Color.lerp(inset, other.inset, t)!,
      hairline: Color.lerp(hairline, other.hairline, t)!,
      chipFill: Color.lerp(chipFill, other.chipFill, t)!,
      chipSelected: Color.lerp(chipSelected, other.chipSelected, t)!,
      fieldFill: Color.lerp(fieldFill, other.fieldFill, t)!,
      railIndicator: Color.lerp(railIndicator, other.railIndicator, t)!,
      captionHover: Color.lerp(captionHover, other.captionHover, t)!,
      captionPressed: Color.lerp(captionPressed, other.captionPressed, t)!,
      closeHover: Color.lerp(closeHover, other.closeHover, t)!,
      closePressed: Color.lerp(closePressed, other.closePressed, t)!,
      captionGlyph: Color.lerp(captionGlyph, other.captionGlyph, t)!,
      captionGlyphInactive:
          Color.lerp(captionGlyphInactive, other.captionGlyphInactive, t)!,
      readerAccent: Color.lerp(readerAccent, other.readerAccent, t)!,
      readerAccentSoft:
          Color.lerp(readerAccentSoft, other.readerAccentSoft, t)!,
    );
  }
}

/// Backwards compatible name used across the app and the tests.
class GoogleMaterialTheme {
  GoogleMaterialTheme._();

  static const Color googleBlueSeed = Gm3.googleBlue;

  static const String uiFontFamily = Gm3.uiFontFamily;
  static const List<String> uiFontFallback = Gm3.uiFontFallback;
  static const String monoFontFamily = Gm3.monoFontFamily;
  static const List<String> monoFontFallback = Gm3.monoFontFallback;

  static TextStyle monoTextStyle({
    double fontSize = 12.5,
    Color? color,
    FontWeight fontWeight = FontWeight.normal,
    double height = 1.5,
  }) {
    return Gm3.monoTextStyle(
      fontSize: fontSize,
      color: color,
      fontWeight: fontWeight,
      height: height,
    );
  }

  static ThemeData light() => Gm3.light();

  static ThemeData dark() => Gm3.dark();
}
