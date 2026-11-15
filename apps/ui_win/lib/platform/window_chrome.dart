import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

/// Maximize / activation state mirrored from the Win32 frame.
@immutable
class WindowChromeState {
  const WindowChromeState({this.maximized = false, this.focused = true});

  final bool maximized;
  final bool focused;

  WindowChromeState copyWith({bool? maximized, bool? focused}) {
    return WindowChromeState(
      maximized: maximized ?? this.maximized,
      focused: focused ?? this.focused,
    );
  }

  @override
  bool operator ==(Object other) {
    return other is WindowChromeState &&
        other.maximized == maximized &&
        other.focused == focused;
  }

  @override
  int get hashCode => Object.hash(maximized, focused);
}

/// Bridge to the custom title bar implemented in
/// `windows/runner/flutter_window.cpp`.
///
/// The Win32 frame owns moving, resizing, Aero snap, double-click maximize and
/// the system menu. Flutter only needs to:
///
///  * resize / minimize / close the window from its own caption buttons, and
///  * report the passive regions of its title bar so the frame can answer
///    `HTCAPTION` there (everything else stays `HTCLIENT`, so widgets keep
///    their hover and click handling).
///
/// Every call is fail-safe: on platforms without the runner channel (widget
/// tests, `flutter test`, other desktop targets) the bridge silently disables
/// itself after the first [MissingPluginException].
class WindowChrome {
  WindowChrome._();

  static const MethodChannel _channel = MethodChannel('session_manager/window');

  /// Live state pushed by the frame on maximize / activation changes.
  static final ValueNotifier<WindowChromeState> state =
      ValueNotifier<WindowChromeState>(const WindowChromeState());

  static bool _handlerInstalled = false;
  static bool _supported = true;
  static String? _lastDragPayload;

  /// True when the runner channel is present (i.e. the native custom frame).
  static bool get isSupported => _supported;

  /// Installs the native -> Dart handler and syncs the initial state.
  static void attach() {
    if (_handlerInstalled) return;
    _handlerInstalled = true;
    _channel.setMethodCallHandler(_handlePlatformCall);
    unawaited(_syncInitialState());
  }

  static Future<dynamic> _handlePlatformCall(MethodCall call) async {
    if (call.method != 'windowStateChanged') return null;
    final arguments = call.arguments;
    if (arguments is! Map) return null;
    final maximized = arguments['maximized'];
    final focused = arguments['focused'];
    state.value = state.value.copyWith(
      maximized: maximized is bool ? maximized : null,
      focused: focused is bool ? focused : null,
    );
    return null;
  }

  static Future<void> _syncInitialState() async {
    if (!_supported) return;
    try {
      final maximized = await _channel.invokeMethod<bool>('isMaximized');
      if (maximized != null) {
        state.value = state.value.copyWith(maximized: maximized);
      }
    } on MissingPluginException {
      _supported = false;
    } catch (_) {
      // The frame reports the state on the next size change anyway.
    }
  }

  /// Registers the passive (draggable) regions of the custom title bar.
  ///
  /// [areas] are in physical pixels relative to the Flutter view origin, which
  /// is the client area of the window.
  static void setCaptionDragAreas(List<Rect> areas) {
    if (!_supported) return;
    if (areas.isEmpty) return;

    final buffer = StringBuffer();
    for (final area in areas) {
      buffer
        ..write(area.left.round())
        ..write(',')
        ..write(area.top.round())
        ..write(',')
        ..write(area.right.round())
        ..write(',')
        ..write(area.bottom.round())
        ..write(';');
    }
    final payload = buffer.toString();
    // Layout can run on every frame; only talk to Win32 when it really moved.
    if (payload == _lastDragPayload) return;
    _lastDragPayload = payload;

    unawaited(_invoke('setCaptionDragAreas', <String, Object?>{
      'areas': areas
          .map(
            (area) => <int>[
              area.left.round(),
              area.top.round(),
              area.right.round(),
              area.bottom.round(),
            ],
          )
          .toList(growable: false),
    }));
  }

  static void minimize() => unawaited(_invoke('minimize'));

  static void toggleMaximize() => unawaited(_invoke('toggleMaximize'));

  static void close() => unawaited(_invoke('close'));

  static Future<void> _invoke(String method, [Object? arguments]) async {
    if (!_supported) return;
    try {
      await _channel.invokeMethod<void>(method, arguments);
    } on MissingPluginException {
      _supported = false;
    } catch (_) {
      // Window operations are best effort; never surface them to the UI.
    }
  }
}
