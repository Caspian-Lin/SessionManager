import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import '../theme.dart';

/// A borderless, flat rounded container.
///
/// This is the only container primitive in the app. Material 3 defines surfaces
/// as flat tones and never strokes containers, so cards, panels and chips are
/// all built from this widget instead of `Card` + `BorderSide`.
class Gm3Surface extends StatelessWidget {
  const Gm3Surface({
    super.key,
    required this.child,
    this.borderRadius,
    this.color,
    this.padding,
    this.clipBehavior = Clip.none,
    this.shadows,
  });

  /// Rounded rectangle in the Material 3 shape scale.
  factory Gm3Surface.rounded({
    Key? key,
    required Widget child,
    double radius = Gm3.radiusMd,
    Color? color,
    EdgeInsetsGeometry? padding,
    bool clip = false,
    BorderRadius? borderRadius,
    List<BoxShadow>? shadows,
  }) {
    return Gm3Surface(
      key: key,
      borderRadius:
          borderRadius ?? BorderRadius.all(Radius.circular(radius)),
      color: color,
      padding: padding,
      clipBehavior: clip ? Clip.antiAlias : Clip.none,
      shadows: shadows,
      child: child,
    );
  }

  final Widget child;
  final BorderRadius? borderRadius;
  final Color? color;
  final EdgeInsetsGeometry? padding;
  final Clip clipBehavior;
  final List<BoxShadow>? shadows;

  @override
  Widget build(BuildContext context) {
    final surfaces = Gm3Surfaces.of(context);
    final resolvedRadius =
        borderRadius ?? BorderRadius.circular(Gm3.radiusMd);

    Widget content = child;
    if (padding != null) {
      content = Padding(padding: padding!, child: content);
    }

    return DecoratedBox(
      decoration: BoxDecoration(
        color: color ?? surfaces.card,
        borderRadius: resolvedRadius,
        boxShadow: shadows,
      ),
      child: clipBehavior == Clip.none
          ? content
          : ClipRRect(borderRadius: resolvedRadius, child: content),
    );
  }
}

/// Interactive container used for list rows, tiles and cards.
///
/// Selection is expressed with a tonal fill (Google Drive / Gmail list rows),
/// never with an outline, and hover is a one-step tonal lift.
class Gm3Card extends StatefulWidget {
  const Gm3Card({
    super.key,
    required this.child,
    this.onTap,
    this.onLongPress,
    this.selected = false,
    this.padding = const EdgeInsets.all(14),
    this.radius = Gm3.radiusMd,
    this.margin = EdgeInsets.zero,
    this.enabled = true,
    this.fill,
    this.selectedFill,
  });

  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool selected;
  final EdgeInsetsGeometry padding;
  final double radius;
  final EdgeInsetsGeometry margin;
  final bool enabled;

  /// Optional flat fill override for this card.
  final Color? fill;

  /// Optional flat fill for the selected state.
  final Color? selectedFill;

  @override
  State<Gm3Card> createState() => _Gm3CardState();
}

class _Gm3CardState extends State<Gm3Card> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final surfaces = Gm3Surfaces.of(context);
    final radius = BorderRadius.circular(widget.radius);

    final Color fill;
    if (widget.selected) {
      fill = widget.selectedFill ?? surfaces.cardSelected;
    } else if (_hovered && widget.enabled) {
      fill = surfaces.cardHover;
    } else {
      fill = widget.fill ?? surfaces.card;
    }

    return Padding(
      padding: widget.margin,
      child: MouseRegion(
        cursor: widget.onTap != null
            ? SystemMouseCursors.click
            : MouseCursor.defer,
        onEnter: (_) {
          if (!_hovered) setState(() => _hovered = true);
        },
        onExit: (_) {
          if (_hovered) setState(() => _hovered = false);
        },
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 140),
          curve: Curves.easeOut,
          decoration: BoxDecoration(color: fill, borderRadius: radius),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: radius,
              onTap: widget.enabled ? widget.onTap : null,
              onLongPress: widget.enabled ? widget.onLongPress : null,
              child: Padding(padding: widget.padding, child: widget.child),
            ),
          ),
        ),
      ),
    );
  }
}

/// Small tonal label used for provider badges, counts and status chips.
class Gm3Pill extends StatelessWidget {
  const Gm3Pill({
    super.key,
    required this.label,
    this.color,
    this.background,
    this.leading,
    this.fontSize = 11.5,
    this.fontWeight = FontWeight.w600,
    this.padding = const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
  });

  final String label;
  final Color? color;
  final Color? background;
  final Widget? leading;
  final double fontSize;
  final FontWeight fontWeight;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final foreground = color ?? scheme.onSurfaceVariant;

    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: background ?? foreground.withOpacity(0.10),
        borderRadius: BorderRadius.circular(Gm3.radiusPill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (leading != null) ...<Widget>[leading!, const SizedBox(width: 5)],
          Text(
            label,
            style: Gm3.text(
              fontSize: fontSize,
              fontWeight: fontWeight,
              color: foreground,
              height: 1.25,
            ),
          ),
        ],
      ),
    );
  }
}

/// Structural separator. The only 1px line the shell allows.
class Gm3Hairline extends StatelessWidget {
  const Gm3Hairline({super.key, this.axis = Axis.horizontal, this.opacity = 1});

  final Axis axis;
  final double opacity;

  @override
  Widget build(BuildContext context) {
    final surfaces = Gm3Surfaces.of(context);
    final color = surfaces.hairline.withOpacity(opacity);
    return axis == Axis.horizontal
        ? Container(height: 1, color: color)
        : Container(width: 1, color: color);
  }
}

/// Section label inside the content sheet ("Archived Sessions", "Revisions").
class Gm3SectionLabel extends StatelessWidget {
  const Gm3SectionLabel(this.text, {super.key, this.trailing});

  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Row(
      children: <Widget>[
        Expanded(
          child: Text(
            text,
            style: theme.textTheme.titleSmall?.copyWith(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.3,
              color: scheme.onSurfaceVariant,
            ),
          ),
        ),
        if (trailing != null) trailing!,
      ],
    );
  }
}

/// Tonal track for segmented controls.
///
/// Material 3 segmented buttons draw their own outline; this shell has no
/// strokes, so the control sits on a tonal pill instead. The track keeps the
/// control readable even when the first segment is not the selected one.
class Gm3SegmentedTrack extends StatelessWidget {
  const Gm3SegmentedTrack({
    super.key,
    required this.child,
    this.height = 32,
  });

  final Widget child;
  final double height;

  @override
  Widget build(BuildContext context) {
    final surfaces = Gm3Surfaces.of(context);
    return Container(
      height: height,
      padding: const EdgeInsets.all(2),
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: surfaces.chipFill,
        borderRadius: BorderRadius.circular(Gm3.radiusPill),
      ),
      child: child,
    );
  }
}
/// One entry of a [Gm3Select].
@immutable
class Gm3Option<T> {
  const Gm3Option({required this.value, required this.label});

  final T value;
  final String label;
}

/// Select control shaped like the chips next to it: a 32px tonal pill that
/// opens a Material 3 menu.
///
/// It replaces [DropdownButton] on purpose: the stock control sizes itself to
/// its widest item and overflows as soon as a project name or a locale label
/// grows, while this pill ellipsizes the current value and keeps the menu full
/// width.
class Gm3Select<T> extends StatelessWidget {
  const Gm3Select({
    super.key,
    required this.value,
    required this.options,
    required this.onChanged,
    this.maxWidth = 220,
  });

  final T value;
  final List<Gm3Option<T>> options;
  final ValueChanged<T> onChanged;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final selected = options.firstWhere(
      (option) => option.value == value,
      orElse: () => options.first,
    );

    return PopupMenuButton<T>(
      tooltip: '',
      position: PopupMenuPosition.under,
      color: surfaces.card,
      surfaceTintColor: Colors.transparent,
      elevation: 3,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
      ),
      onSelected: onChanged,
      itemBuilder: (context) => <PopupMenuEntry<T>>[
        for (final option in options)
          PopupMenuItem<T>(
            value: option.value,
            height: 36,
            child: Row(
              children: <Widget>[
                SizedBox(
                  width: 22,
                  child: option.value == value
                      ? Icon(Icons.check, size: 16, color: scheme.primary)
                      : null,
                ),
                Flexible(
                  child: Text(
                    option.label,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      fontWeight: option.value == value
                          ? FontWeight.w600
                          : FontWeight.w400,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
      child: Container(
        height: 32,
        constraints: BoxConstraints(maxWidth: maxWidth),
        padding: const EdgeInsets.only(left: 12, right: 6),
        decoration: BoxDecoration(
          color: surfaces.chipFill,
          borderRadius: BorderRadius.circular(Gm3.radiusPill),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Flexible(
              child: Text(
                selected.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontWeight: FontWeight.w500,
                  color: scheme.onSurface,
                ),
              ),
            ),
            Icon(
              Icons.keyboard_arrow_down_rounded,
              size: 17,
              color: scheme.onSurfaceVariant,
            ),
          ],
        ),
      ),
    );
  }
}

/// Global scroll behavior enabling middle-mouse-button press & drag fast
/// scrolling across every [Scrollable] in the app.
class SmScrollBehavior extends MaterialScrollBehavior {
  const SmScrollBehavior();

  @override
  Widget buildOverscrollIndicator(
    BuildContext context,
    Widget child,
    ScrollableDetails details,
  ) {
    final base = super.buildOverscrollIndicator(context, child, details);
    return MiddleMouseAutoScrollWrapper(
      details: details,
      scrollableContext: context,
      child: base,
    );
  }
}

/// Wraps a scrollable viewport to support pressing the middle mouse button and
/// dragging to fast-scroll vertically or horizontally.
class MiddleMouseAutoScrollWrapper extends StatefulWidget {
  const MiddleMouseAutoScrollWrapper({
    super.key,
    required this.details,
    required this.scrollableContext,
    required this.child,
  });

  final ScrollableDetails details;
  final BuildContext scrollableContext;
  final Widget child;

  @override
  State<MiddleMouseAutoScrollWrapper> createState() =>
      _MiddleMouseAutoScrollWrapperState();
}

class _MiddleMouseAutoScrollWrapperState
    extends State<MiddleMouseAutoScrollWrapper> {
  static final Map<int, Set<Axis>> _claimedAxes = <int, Set<Axis>>{};
  static final Set<int> _indicatorClaimedPointers = <int>{};

  int? _activePointer;
  Axis? _claimedAxis;
  bool _claimedIndicator = false;
  Offset? _anchorGlobal;
  Offset? _anchorLocal;
  Offset? _currentGlobal;
  Offset? _lastMoveGlobal;
  Timer? _autoScrollTimer;

  Axis get _axis => axisDirectionToAxis(widget.details.direction);
  bool get _reversed => axisDirectionIsReversed(widget.details.direction);

  ScrollPosition? _resolvePosition() {
    final controller = widget.details.controller;
    if (controller != null && controller.positions.length == 1) {
      return controller.position;
    }
    final ctx = widget.scrollableContext;
    if (ctx.mounted && ctx is StatefulElement && ctx.state is ScrollableState) {
      return (ctx.state as ScrollableState).position;
    }
    if (controller != null && controller.hasClients) {
      return controller.positions.last;
    }
    return null;
  }

  double _projectAxis(Offset delta) {
    final raw = _axis == Axis.vertical ? delta.dy : delta.dx;
    return _reversed ? -raw : raw;
  }

  void _applyScrollDelta(double delta) {
    if (delta == 0 || !mounted) return;
    final position = _resolvePosition();
    if (position == null || !position.hasPixels || !position.hasContentDimensions) {
      return;
    }
    final next = (position.pixels + delta).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if ((next - position.pixels).abs() > 0.01) {
      position.jumpTo(next);
    }
  }

  void _handlePointerDown(PointerDownEvent event) {
    if ((event.buttons & kMiddleMouseButton) == 0) return;
    final position = _resolvePosition();
    if (position == null ||
        !position.hasContentDimensions ||
        position.maxScrollExtent <= position.minScrollExtent) {
      return;
    }
    final pointerAxes = _claimedAxes.putIfAbsent(event.pointer, () => <Axis>{});
    if (pointerAxes.contains(_axis)) return;
    pointerAxes.add(_axis);

    final showIndicator = _indicatorClaimedPointers.add(event.pointer);
    _autoScrollTimer?.cancel();
    setState(() {
      _activePointer = event.pointer;
      _claimedAxis = _axis;
      _claimedIndicator = showIndicator;
      _anchorGlobal = event.position;
      _anchorLocal = event.localPosition;
      _currentGlobal = event.position;
      _lastMoveGlobal = event.position;
    });
    _autoScrollTimer = Timer.periodic(
      const Duration(milliseconds: 16),
      _onAutoScrollTick,
    );
  }

  void _handlePointerMove(PointerMoveEvent event) {
    if (_activePointer != event.pointer) return;
    if ((event.buttons & kMiddleMouseButton) == 0) {
      _stopAutoScroll();
      return;
    }
    final prev = _lastMoveGlobal ?? event.position;
    final stepDelta = _projectAxis(event.position - prev);
    _lastMoveGlobal = event.position;
    _currentGlobal = event.position;
    if (stepDelta.abs() > 0.01) {
      _applyScrollDelta(stepDelta * 2.5);
    }
  }

  void _handlePointerEnd(PointerEvent event) {
    if (_activePointer != event.pointer) return;
    _stopAutoScroll();
  }

  void _onAutoScrollTick(Timer timer) {
    if (!mounted ||
        _activePointer == null ||
        _anchorGlobal == null ||
        _currentGlobal == null) {
      _stopAutoScroll();
      return;
    }
    final offsetAxis = _projectAxis(_currentGlobal! - _anchorGlobal!);
    if (offsetAxis.abs() <= 6.0) return;
    final magnitude = (offsetAxis.abs() - 6.0) / 14.0;
    final step = offsetAxis.sign * math.pow(magnitude, 1.35) * 4.5;
    _applyScrollDelta(step.toDouble());
  }

  void _releaseClaims() {
    final pointer = _activePointer;
    final axis = _claimedAxis;
    if (pointer != null) {
      final axes = _claimedAxes[pointer];
      if (axes != null && axis != null) {
        axes.remove(axis);
        if (axes.isEmpty) {
          _claimedAxes.remove(pointer);
        }
      }
      if (_claimedIndicator) {
        _indicatorClaimedPointers.remove(pointer);
      }
    }
  }

  void _stopAutoScroll() {
    _autoScrollTimer?.cancel();
    _autoScrollTimer = null;
    _releaseClaims();
    if (!mounted) {
      _activePointer = null;
      _claimedAxis = null;
      _claimedIndicator = false;
      _anchorGlobal = null;
      _anchorLocal = null;
      _currentGlobal = null;
      _lastMoveGlobal = null;
      return;
    }
    if (_activePointer != null) {
      setState(() {
        _activePointer = null;
        _claimedAxis = null;
        _claimedIndicator = false;
        _anchorGlobal = null;
        _anchorLocal = null;
        _currentGlobal = null;
        _lastMoveGlobal = null;
      });
    }
  }

  @override
  void dispose() {
    _autoScrollTimer?.cancel();
    _releaseClaims();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    Widget content = widget.child;
    if (_claimedIndicator && _anchorLocal != null && _activePointer != null) {
      final cs = Theme.of(context).colorScheme;
      content = Stack(
        fit: StackFit.passthrough,
        clipBehavior: Clip.none,
        children: <Widget>[
          content,
          Positioned(
            left: _anchorLocal!.dx - 13,
            top: _anchorLocal!.dy - 13,
            child: IgnorePointer(
              child: Container(
                width: 26,
                height: 26,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: cs.surface.withOpacity(0.92),
                  border: Border.all(
                    color: cs.primary.withOpacity(0.85),
                    width: 1.5,
                  ),
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                      color: Colors.black.withOpacity(0.18),
                      blurRadius: 6,
                      offset: const Offset(0, 2),
                    ),
                  ],
                ),
                child: Icon(
                  _axis == Axis.vertical
                      ? Icons.unfold_more_rounded
                      : Icons.code_rounded,
                  size: 15,
                  color: cs.primary,
                ),
              ),
            ),
          ),
        ],
      );
    }

    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: _handlePointerDown,
      onPointerMove: _handlePointerMove,
      onPointerUp: _handlePointerEnd,
      onPointerCancel: _handlePointerEnd,
      child: content,
    );
  }
}