import 'package:flutter/material.dart';

import '../l10n/app_strings.dart';
import '../platform/window_chrome.dart';
import '../theme.dart';
import 'gm3_surface.dart';

/// The unified window header.
///
/// This is both the application bar and the Windows title bar: the OS caption
/// is removed by the native runner (`WM_NCCALCSIZE`), so the app title, the
/// actions and the caption buttons share a single 56px band.
///
/// Passive regions are reported to Win32 as `HTCAPTION`, which keeps moving,
/// double-click maximize, Aero snap and the system menu natively implemented
/// while interactive widgets stay normal client-area widgets.
class AppTitleBar extends StatefulWidget {
  const AppTitleBar({
    super.key,
    required this.appTitle,
    required this.statusLabel,
    required this.statusConnected,
    required this.dbPath,
    required this.localeNotifier,
    required this.themeModeNotifier,
    required this.onReload,
    required this.onCycleTheme,
    this.trailingBadge,
  });

  final String appTitle;
  final String statusLabel;
  final bool statusConnected;
  final String dbPath;
  final ValueNotifier<AppLocale> localeNotifier;
  final ValueNotifier<ThemeMode> themeModeNotifier;
  final VoidCallback onReload;
  final VoidCallback onCycleTheme;
  final Widget? trailingBadge;

  @override
  State<AppTitleBar> createState() => _AppTitleBarState();
}

class _AppTitleBarState extends State<AppTitleBar> {
  final GlobalKey _leadingAnchorKey = GlobalKey();
  final GlobalKey _grabAnchorKey = GlobalKey();

  @override
  void initState() {
    super.initState();
    WindowChrome.attach();
  }

  void _reportDragAnchors(BuildContext context) {
    if (!mounted) return;
    final pixelRatio = MediaQuery.maybeDevicePixelRatioOf(context) ?? 1.0;

    final areas = <Rect>[];
    for (final key in <GlobalKey>[_leadingAnchorKey, _grabAnchorKey]) {
      final renderObject = key.currentContext?.findRenderObject();
      if (renderObject is! RenderBox || !renderObject.hasSize) continue;
      final origin = renderObject.localToGlobal(Offset.zero);
      areas.add(
        Rect.fromLTRB(
          origin.dx * pixelRatio,
          origin.dy * pixelRatio,
          (origin.dx + renderObject.size.width) * pixelRatio,
          (origin.dy + renderObject.size.height) * pixelRatio,
        ),
      );
    }
    WindowChrome.setCaptionDragAreas(areas);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final strings = AppStringsScope.of(context);

    // LayoutBuilder re-runs whenever the band is constrained differently, which
    // is exactly when the reported caption regions change.
    return LayoutBuilder(
      builder: (context, constraints) {
        WidgetsBinding.instance
            .addPostFrameCallback((_) => _reportDragAnchors(context));

        return SizedBox(
          height: Gm3.headerHeight,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              // ---- passive / draggable: brand + title + status ---------------
              Container(
                key: _leadingAnchorKey,
                padding: const EdgeInsets.only(left: 14, right: 10),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const _AppMark(),
                    const SizedBox(width: 12),
                    Text(
                      widget.appTitle,
                      style: theme.textTheme.titleMedium,
                    ),
                    const SizedBox(width: 10),
                    _StatusPill(
                      label: widget.statusLabel,
                      connected: widget.statusConnected,
                    ),
                  ],
                ),
              ),

              // ---- database path chip (hover tooltip => client area) ---------
              Flexible(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 360),
                    child: _PathChip(path: widget.dbPath),
                  ),
                ),
              ),

              // ---- passive / draggable: the grab area ------------------------
              Expanded(
                child: Container(key: _grabAnchorKey),
              ),

              // ---- actions ---------------------------------------------------
              Center(
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    if (widget.trailingBadge != null) ...<Widget>[
                      widget.trailingBadge!,
                      const SizedBox(width: 8),
                    ],
                    _LocaleSwitch(notifier: widget.localeNotifier),
                    const SizedBox(width: 4),
                    IconButton(
                      tooltip: strings.reloadTooltip,
                      onPressed: widget.onReload,
                      icon: const Icon(Icons.refresh_rounded, size: 19),
                      visualDensity: VisualDensity.compact,
                      style: IconButton.styleFrom(
                        fixedSize: const Size(34, 34),
                        minimumSize: const Size(34, 34),
                        padding: EdgeInsets.zero,
                      ),
                    ),
                    ValueListenableBuilder<ThemeMode>(
                      valueListenable: widget.themeModeNotifier,
                      builder: (context, mode, _) {
                        final icon = switch (mode) {
                          ThemeMode.system => Icons.brightness_auto_outlined,
                          ThemeMode.light => Icons.light_mode_outlined,
                          ThemeMode.dark => Icons.dark_mode_outlined,
                        };
                        return IconButton(
                          tooltip: strings.themeTooltip(mode),
                          onPressed: widget.onCycleTheme,
                          icon: Icon(icon, size: 19),
                          visualDensity: VisualDensity.compact,
                          style: IconButton.styleFrom(
                            fixedSize: const Size(34, 34),
                            minimumSize: const Size(34, 34),
                            padding: EdgeInsets.zero,
                          ),
                        );
                      },
                    ),
                    const SizedBox(width: 10),
                    // A 1px rule is the only acceptable separator between app
                    // actions and OS window controls.
                    Container(
                      width: 1,
                      height: 20,
                      color: surfaces.hairline,
                    ),
                    const SizedBox(width: 8),
                  ],
                ),
              ),

              // ---- window caption buttons ------------------------------------
              const _CaptionCluster(),
              const SizedBox(width: 8),
            ],
          ),
        );
      },
    );
  }
}

class _AppMark extends StatelessWidget {
  const _AppMark();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 34,
      height: 34,
      decoration: BoxDecoration(
        color: Gm3.googleBlue,
        borderRadius: BorderRadius.circular(Gm3.radiusSm),
      ),
      child: const Icon(
        Icons.inventory_2_outlined,
        size: 18,
        color: Colors.white,
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.label, required this.connected});

  final String label;
  final bool connected;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accent = connected
        ? (isDark ? const Color(0xFF81C995) : const Color(0xFF137333))
        : (isDark ? const Color(0xFFFDD663) : const Color(0xFFB06000));
    final fill = connected
        ? (isDark ? const Color(0xFF1E3226) : const Color(0xFFE6F4EA))
        : (isDark ? const Color(0xFF382F1B) : const Color(0xFFFEF7E0));

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: fill,
        borderRadius: BorderRadius.circular(Gm3.radiusPill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: accent, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
          Text(
            label,
            style: Gm3.text(
              fontSize: Gm3.fontSizeLabelMedium,
              fontWeight: FontWeight.w600,
              color: accent,
              height: 1.25,
            ),
          ),
        ],
      ),
    );
  }
}

class _PathChip extends StatelessWidget {
  const _PathChip({required this.path});

  final String path;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;
    return Tooltip(
      message: path,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          // Sits on the canvas tone, so it needs a lighter fill than the
          // in-sheet chips to read as a chip at all.
          color: isDark
              ? Colors.white.withOpacity(0.06)
              : Colors.white.withOpacity(0.78),
          borderRadius: BorderRadius.circular(Gm3.radiusPill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(
              Icons.dns_outlined,
              size: 13,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                path,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Gm3.monoTextStyle(
                  fontSize: Gm3.monoSm,
                  color: theme.colorScheme.onSurfaceVariant,
                  height: 1.3,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LocaleSwitch extends StatelessWidget {
  const _LocaleSwitch({required this.notifier});

  final ValueNotifier<AppLocale> notifier;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<AppLocale>(
      valueListenable: notifier,
      builder: (context, locale, _) {
        return Gm3SegmentedTrack(
          child: SegmentedButton<AppLocale>(
            showSelectedIcon: false,
            segments: const <ButtonSegment<AppLocale>>[
              ButtonSegment<AppLocale>(value: AppLocale.zh, label: Text('中文')),
              ButtonSegment<AppLocale>(value: AppLocale.en, label: Text('EN')),
            ],
            selected: <AppLocale>{locale},
            onSelectionChanged: (selection) => notifier.value = selection.first,
            style: SegmentedButton.styleFrom(
              visualDensity: VisualDensity.compact,
              padding: const EdgeInsets.symmetric(horizontal: 10),
              minimumSize: const Size(0, 28),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ),
        );
      },
    );
  }
}

/// Minimize / maximize / close, drawn by Flutter but behaving like the shell.
class _CaptionCluster extends StatelessWidget {
  const _CaptionCluster();

  @override
  Widget build(BuildContext context) {
    final strings = AppStringsScope.of(context);
    return ValueListenableBuilder<WindowChromeState>(
      valueListenable: WindowChrome.state,
      builder: (context, state, _) {
        return Center(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              _CaptionButton(
                glyph: _CaptionGlyphKind.minimize,
                tooltip: strings.windowMinimize,
                active: state.focused,
                onPressed: WindowChrome.minimize,
              ),
              _CaptionButton(
                glyph: state.maximized
                    ? _CaptionGlyphKind.restore
                    : _CaptionGlyphKind.maximize,
                tooltip: state.maximized
                    ? strings.windowRestore
                    : strings.windowMaximize,
                active: state.focused,
                onPressed: WindowChrome.toggleMaximize,
              ),
              _CaptionButton(
                glyph: _CaptionGlyphKind.close,
                tooltip: strings.windowClose,
                active: state.focused,
                destructive: true,
                onPressed: WindowChrome.close,
              ),
            ],
          ),
        );
      },
    );
  }
}

enum _CaptionGlyphKind { minimize, maximize, restore, close }

class _CaptionButton extends StatefulWidget {
  const _CaptionButton({
    required this.glyph,
    required this.tooltip,
    required this.onPressed,
    this.active = true,
    this.destructive = false,
  });

  final _CaptionGlyphKind glyph;
  final String tooltip;
  final VoidCallback onPressed;
  final bool active;
  final bool destructive;

  @override
  State<_CaptionButton> createState() => _CaptionButtonState();
}

class _CaptionButtonState extends State<_CaptionButton> {
  bool _hovered = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final surfaces = Gm3Surfaces.of(context);

    Color background = Colors.transparent;
    if (_hovered || _pressed) {
      if (widget.destructive) {
        background = _pressed ? surfaces.closePressed : surfaces.closeHover;
      } else {
        background = _pressed ? surfaces.captionPressed : surfaces.captionHover;
      }
    }

    Color glyphColor = widget.active
        ? surfaces.captionGlyph
        : surfaces.captionGlyphInactive;
    if (widget.destructive && (_hovered || _pressed)) {
      glyphColor = Colors.white;
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 1),
      child: Tooltip(
        message: widget.tooltip,
        waitDuration: const Duration(milliseconds: 700),
        child: MouseRegion(
          cursor: SystemMouseCursors.basic,
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() {
            _hovered = false;
            _pressed = false;
          }),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTapDown: (_) => setState(() => _pressed = true),
            onTapCancel: () => setState(() => _pressed = false),
            onTap: () {
              setState(() => _pressed = false);
              widget.onPressed();
            },
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 110),
              curve: Curves.easeOut,
              width: Gm3.captionButtonWidth,
              height: Gm3.captionButtonHeight,
              decoration: BoxDecoration(
                color: background,
                borderRadius: BorderRadius.circular(Gm3.radiusSm),
              ),
              child: Center(
                child: CustomPaint(
                  size: const Size(10, 10),
                  painter: _CaptionGlyphPainter(
                    kind: widget.glyph,
                    color: glyphColor,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _CaptionGlyphPainter extends CustomPainter {
  const _CaptionGlyphPainter({required this.kind, required this.color});

  final _CaptionGlyphKind kind;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1
      ..strokeCap = StrokeCap.square;
    final width = size.width;
    final height = size.height;

    switch (kind) {
      case _CaptionGlyphKind.minimize:
        final y = (height / 2).roundToDouble();
        canvas.drawLine(Offset(0, y), Offset(width, y), paint);
        break;
      case _CaptionGlyphKind.maximize:
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTWH(0.5, 0.5, width - 1, height - 1),
            const Radius.circular(1.5),
          ),
          paint,
        );
        break;
      case _CaptionGlyphKind.restore:
        final back = Rect.fromLTWH(0.5, 0.5, width - 3.5, height - 3.5);
        final front = Rect.fromLTWH(3, 3, width - 3.5, height - 3.5);
        canvas.drawRRect(
          RRect.fromRectAndRadius(back, const Radius.circular(1.5)),
          paint,
        );
        canvas.drawRect(front, paint);
        break;
      case _CaptionGlyphKind.close:
        canvas.drawLine(
          const Offset(0.5, 0.5),
          Offset(width - 0.5, height - 0.5),
          paint,
        );
        canvas.drawLine(
          Offset(width - 0.5, 0.5),
          const Offset(0.5, 9.5),
          paint,
        );
        break;
    }
  }

  @override
  bool shouldRepaint(_CaptionGlyphPainter oldDelegate) {
    return oldDelegate.kind != kind || oldDelegate.color != color;
  }
}

/// Small tonal badge used for transient CLI feedback in the header.
class HeaderBadge extends StatelessWidget {
  const HeaderBadge({
    super.key,
    required this.label,
    required this.emphasized,
  });

  final String label;
  final bool emphasized;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Gm3Pill(
      label: label,
      color: emphasized ? scheme.onErrorContainer : scheme.onSurfaceVariant,
      background:
          emphasized ? scheme.errorContainer : scheme.surfaceContainerHigh,
      fontSize: Gm3.fontSizeLabelSmall,
    );
  }
}
