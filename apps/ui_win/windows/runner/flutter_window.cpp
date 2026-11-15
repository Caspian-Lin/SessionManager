#include "flutter_window.h"

#include <commctrl.h>
#include <flutter/standard_method_codec.h>
#include <windowsx.h>

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "flutter/generated_plugin_registrant.h"

namespace {

// Channel shared with `lib/platform/window_chrome.dart`.
constexpr char kWindowChannelName[] = "session_manager/window";

// Subclass id for the Flutter view window.
constexpr UINT_PTR kFlutterViewSubclassId = 1;

double ReadNumber(const flutter::EncodableValue& value) {
  if (const auto* as_double = std::get_if<double>(&value)) {
    return *as_double;
  }
  if (const auto* as_int32 = std::get_if<int32_t>(&value)) {
    return static_cast<double>(*as_int32);
  }
  if (const auto* as_int64 = std::get_if<int64_t>(&value)) {
    return static_cast<double>(*as_int64);
  }
  return 0.0;
}

// Caption regions arrive as a list of [left, top, right, bottom] quads in
// physical pixels, in window coordinates.
std::vector<RECT> ParseCaptionAreas(const flutter::EncodableValue* arguments) {
  std::vector<RECT> areas;
  if (arguments == nullptr) {
    return areas;
  }
  const auto* map = std::get_if<flutter::EncodableMap>(arguments);
  if (map == nullptr) {
    return areas;
  }
  const auto areas_it = map->find(flutter::EncodableValue("areas"));
  if (areas_it == map->end()) {
    return areas;
  }
  const auto* list = std::get_if<flutter::EncodableList>(&areas_it->second);
  if (list == nullptr) {
    return areas;
  }
  for (const auto& entry : *list) {
    const auto* quad = std::get_if<flutter::EncodableList>(&entry);
    if (quad == nullptr || quad->size() != 4) {
      continue;
    }
    RECT rect{};
    rect.left = static_cast<LONG>(ReadNumber(quad->at(0)));
    rect.top = static_cast<LONG>(ReadNumber(quad->at(1)));
    rect.right = static_cast<LONG>(ReadNumber(quad->at(2)));
    rect.bottom = static_cast<LONG>(ReadNumber(quad->at(3)));
    if (rect.right > rect.left && rect.bottom > rect.top) {
      areas.push_back(rect);
    }
  }
  return areas;
}

// The Flutter view is a child window covering the whole client area, so it
// receives every WM_NCHITTEST first. Non-client hits have to be handed back to
// the frame with HTTRANSPARENT, otherwise the resize grips and the caption
// regions of the parent are unreachable.
LRESULT CALLBACK FlutterViewSubclassProc(HWND hwnd, UINT const message,
                                         WPARAM const wparam,
                                         LPARAM const lparam,
                                         UINT_PTR const subclass_id,
                                         DWORD_PTR const ref_data) {
  HWND frame = GetAncestor(hwnd, GA_ROOT);

  if (frame != nullptr && frame != hwnd && message == WM_NCHITTEST) {
    const LRESULT hit = Win32Window::HitTestFrameForWindow(frame, lparam);
    if (hit != HTCLIENT && hit != HTNOWHERE) {
      return HTTRANSPARENT;
    }
  }

  if (frame != nullptr && frame != hwnd && message == WM_SETCURSOR &&
      LOWORD(lparam) == HTCLIENT) {
    POINT cursor{};
    if (GetCursorPos(&cursor)) {
      const LRESULT hit = Win32Window::HitTestFrameForWindow(
          frame, MAKELPARAM(cursor.x, cursor.y));
      switch (hit) {
        case HTLEFT:
        case HTRIGHT:
          SetCursor(LoadCursor(nullptr, IDC_SIZEWE));
          return TRUE;
        case HTTOP:
        case HTBOTTOM:
          SetCursor(LoadCursor(nullptr, IDC_SIZENS));
          return TRUE;
        case HTTOPLEFT:
        case HTBOTTOMRIGHT:
          SetCursor(LoadCursor(nullptr, IDC_SIZENWSE));
          return TRUE;
        case HTTOPRIGHT:
        case HTBOTTOMLEFT:
          SetCursor(LoadCursor(nullptr, IDC_SIZENESW));
          return TRUE;
        default:
          break;
      }
    }
  }

  return DefSubclassProc(hwnd, message, wparam, lparam);
}

}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  SetChildContent(flutter_controller_->view()->GetNativeWindow());
  SetWindowSubclass(flutter_controller_->view()->GetNativeWindow(),
                    FlutterViewSubclassProc, kFlutterViewSubclassId,
                    /*ref_data=*/0);

  // The shell paints the title bar, so the OS caption must go away before the
  // window is shown.
  SetFrameless(true);
  SetWindowStateCallback([this](bool maximized, bool focused) {
    SendWindowState(maximized, focused);
  });
  RegisterWindowChannel();

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  if (window_channel_) {
    // Documented requirement: destroying a channel does not unregister its
    // handler, so drop it while the engine is still alive.
    window_channel_->SetMethodCallHandler(nullptr);
    window_channel_.reset();
  }

  if (flutter_controller_) {
    RemoveWindowSubclass(flutter_controller_->view()->GetNativeWindow(),
                         FlutterViewSubclassProc, kFlutterViewSubclassId);
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

void FlutterWindow::RegisterWindowChannel() {
  window_channel_ =
      std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          flutter_controller_->engine()->messenger(), kWindowChannelName,
          &flutter::StandardMethodCodec::GetInstance());
  window_channel_->SetMethodCallHandler(
      [this](const flutter::MethodCall<flutter::EncodableValue>& call,
             std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>
                 result) {
        HandleWindowMethodCall(call, std::move(result));
      });
}

void FlutterWindow::HandleWindowMethodCall(
    const flutter::MethodCall<flutter::EncodableValue>& call,
    std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>> result) {
  const std::string& method = call.method_name();

  if (method == "minimize") {
    MinimizeWindow();
    result->Success();
    return;
  }
  if (method == "toggleMaximize") {
    ToggleMaximizeWindow();
    result->Success();
    return;
  }
  if (method == "maximize") {
    MaximizeWindow();
    result->Success();
    return;
  }
  if (method == "restore") {
    RestoreWindow();
    result->Success();
    return;
  }
  if (method == "close") {
    CloseWindow();
    result->Success();
    return;
  }
  if (method == "isMaximized") {
    result->Success(flutter::EncodableValue(IsWindowMaximized()));
    return;
  }
  if (method == "setCaptionDragAreas") {
    SetCaptionDragAreas(ParseCaptionAreas(call.arguments()));
    result->Success();
    return;
  }

  result->NotImplemented();
}

void FlutterWindow::SendWindowState(bool maximized, bool focused) {
  if (!window_channel_) {
    return;
  }
  flutter::EncodableMap state{
      {flutter::EncodableValue("maximized"),
       flutter::EncodableValue(maximized)},
      {flutter::EncodableValue("focused"), flutter::EncodableValue(focused)},
  };
  window_channel_->InvokeMethod(
      "windowStateChanged",
      std::make_unique<flutter::EncodableValue>(std::move(state)));
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // The custom frame is computed before the engine sees the message: the
  // non-client area must never be resurrected by the embedder.
  switch (message) {
    case WM_NCCALCSIZE:
    case WM_NCHITTEST:
    case WM_GETMINMAXINFO:
      return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
    default:
      break;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
