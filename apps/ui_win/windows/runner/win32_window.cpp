#include "win32_window.h"

#include <dwmapi.h>
#include <flutter_windows.h>
#include <windowsx.h>

#include <cmath>

#include "resource.h"

namespace {

/// Window attribute that enables dark mode window decorations.
///
/// Redefined in case the developer's machine has a Windows SDK older than
/// version 10.0.22000.0.
/// See: https://docs.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif

/// Windows 11 window corner shaping (DWMWCP_*).
#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif
#ifndef DWMWCP_ROUND
#define DWMWCP_ROUND 2
#endif

/// Windows 11 window border colour. DWMWA_COLOR_NONE hides it.
#ifndef DWMWA_BORDER_COLOR
#define DWMWA_BORDER_COLOR 34
#endif
#ifndef DWMWA_COLOR_NONE
#define DWMWA_COLOR_NONE ((COLORREF)0xFFFFFFFE)
#endif

/// Undocumented messages the shell sends when the themed caption has to be
/// repainted. They are not in the public headers, and a frameless window must
/// swallow them or a ghost caption can appear over the Flutter UI.
#ifndef WM_NCUAHDRAWCAPTION
#define WM_NCUAHDRAWCAPTION 0x00AE
#endif
#ifndef WM_NCUAHDRAWFRAME
#define WM_NCUAHDRAWFRAME 0x00AF
#endif

constexpr const wchar_t kWindowClassName[] = L"FLUTTER_RUNNER_WIN32_WINDOW";

/// Registry key for app theme preference.
///
/// A value of 0 indicates apps should use dark mode. A non-zero or missing
/// value indicates apps should use light mode.
constexpr const wchar_t kGetPreferredBrightnessRegKey[] =
  L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
constexpr const wchar_t kGetPreferredBrightnessRegValue[] = L"AppsUseLightTheme";

/// Thickness of the invisible resize grip along the window edges, in DIPs.
/// Matches the metrics the Windows shell uses for native frames.
constexpr int kResizeBorderDip = 8;

/// Smallest window the shell layout is designed for, in DIPs.
constexpr int kMinWidthDip = 960;
constexpr int kMinHeightDip = 620;

// The number of Win32Window objects that currently exist.
static int g_active_window_count = 0;

using EnableNonClientDpiScaling = BOOL __stdcall(HWND hwnd);

// Scale helper to convert logical scaler values to physical using passed in
// scale factor
int Scale(int source, double scale_factor) {
  return static_cast<int>(source * scale_factor);
}

// Dynamically loads the |EnableNonClientDpiScaling| from the User32 module.
// This API is only needed for PerMonitor V1 awareness mode.
void EnableFullDpiSupportIfAvailable(HWND hwnd) {
  HMODULE user32_module = LoadLibraryA("User32.dll");
  if (!user32_module) {
    return;
  }
  auto enable_non_client_dpi_scaling =
      reinterpret_cast<EnableNonClientDpiScaling*>(
          GetProcAddress(user32_module, "EnableNonClientDpiScaling"));
  if (enable_non_client_dpi_scaling != nullptr) {
    enable_non_client_dpi_scaling(hwnd);
  }
  FreeLibrary(user32_module);
}

}  // namespace

// Manages the Win32Window's window class registration.
class WindowClassRegistrar {
 public:
  ~WindowClassRegistrar() = default;

  // Returns the singleton registrar instance.
  static WindowClassRegistrar* GetInstance() {
    if (!instance_) {
      instance_ = new WindowClassRegistrar();
    }
    return instance_;
  }

  // Returns the name of the window class, registering the class if it hasn't
  // previously been registered.
  const wchar_t* GetWindowClass();

  // Unregisters the window class. Should only be called if there are no
  // instances of the window.
  void UnregisterWindowClass();

 private:
  WindowClassRegistrar() = default;

  static WindowClassRegistrar* instance_;

  bool class_registered_ = false;
};

WindowClassRegistrar* WindowClassRegistrar::instance_ = nullptr;

const wchar_t* WindowClassRegistrar::GetWindowClass() {
  if (!class_registered_) {
    WNDCLASS window_class{};
    window_class.hCursor = LoadCursor(nullptr, IDC_ARROW);
    window_class.lpszClassName = kWindowClassName;
    window_class.style = CS_HREDRAW | CS_VREDRAW;
    window_class.cbClsExtra = 0;
    window_class.cbWndExtra = 0;
    window_class.hInstance = GetModuleHandle(nullptr);
    window_class.hIcon =
        LoadIcon(window_class.hInstance, MAKEINTRESOURCE(IDI_APP_ICON));
    window_class.hbrBackground = 0;
    window_class.lpszMenuName = nullptr;
    window_class.lpfnWndProc = Win32Window::WndProc;
    RegisterClass(&window_class);
    class_registered_ = true;
  }
  return kWindowClassName;
}

void WindowClassRegistrar::UnregisterWindowClass() {
  UnregisterClass(kWindowClassName, nullptr);
  class_registered_ = false;
}

Win32Window::Win32Window() {
  ++g_active_window_count;
}

Win32Window::~Win32Window() {
  --g_active_window_count;
  Destroy();
}

bool Win32Window::Create(const std::wstring& title,
                         const Point& origin,
                         const Size& size) {
  Destroy();

  const wchar_t* window_class =
      WindowClassRegistrar::GetInstance()->GetWindowClass();

  const POINT target_point = {static_cast<LONG>(origin.x),
                              static_cast<LONG>(origin.y)};
  HMONITOR monitor = MonitorFromPoint(target_point, MONITOR_DEFAULTTONEAREST);
  UINT dpi = FlutterDesktopGetDpiForMonitor(monitor);
  double scale_factor = dpi / 96.0;

  HWND window = CreateWindow(
      window_class, title.c_str(), WS_OVERLAPPEDWINDOW,
      Scale(origin.x, scale_factor), Scale(origin.y, scale_factor),
      Scale(size.width, scale_factor), Scale(size.height, scale_factor),
      nullptr, nullptr, GetModuleHandle(nullptr), this);

  if (!window) {
    return false;
  }

  UpdateTheme(window);
  // The frame is custom painted, so the shell metrics have to be applied even
  // before the first frame: this keeps the window from flashing a caption.
  if (frameless_) {
    ApplyFramelessFrameStyle();
  }

  return OnCreate();
}

bool Win32Window::Show() {
  return ShowWindow(window_handle_, SW_SHOWNORMAL);
}

void Win32Window::CenterOnWorkArea() {
  if (window_handle_ == nullptr) {
    return;
  }

  RECT rect{};
  if (!GetWindowRect(window_handle_, &rect)) {
    return;
  }

  HMONITOR monitor =
      MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST);
  MONITORINFO monitor_info{};
  monitor_info.cbSize = sizeof(MONITORINFO);
  if (!GetMonitorInfoW(monitor, &monitor_info)) {
    return;
  }

  const RECT& work = monitor_info.rcWork;
  const int work_width = work.right - work.left;
  const int work_height = work.bottom - work.top;

  int width = rect.right - rect.left;
  int height = rect.bottom - rect.top;
  // Leave room for the drop shadow and never open larger than the display.
  if (width > work_width) {
    width = work_width;
  }
  if (height > work_height) {
    height = work_height;
  }

  const int x = work.left + (work_width - width) / 2;
  const int y = work.top + (work_height - height) / 2;

  SetWindowPos(window_handle_, nullptr, x, y, width, height,
               SWP_NOZORDER | SWP_NOACTIVATE);
}

// static
LRESULT CALLBACK Win32Window::WndProc(HWND const window,
                                      UINT const message,
                                      WPARAM const wparam,
                                      LPARAM const lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto window_struct = reinterpret_cast<CREATESTRUCT*>(lparam);
    SetWindowLongPtr(window, GWLP_USERDATA,
                     reinterpret_cast<LONG_PTR>(window_struct->lpCreateParams));

    auto that = static_cast<Win32Window*>(window_struct->lpCreateParams);
    EnableFullDpiSupportIfAvailable(window);
    that->window_handle_ = window;
  } else if (Win32Window* that = GetThisFromHandle(window)) {
    return that->MessageHandler(window, message, wparam, lparam);
  }

  return DefWindowProc(window, message, wparam, lparam);
}

LRESULT
Win32Window::MessageHandler(HWND hwnd,
                            UINT const message,
                            WPARAM const wparam,
                            LPARAM const lparam) noexcept {
  switch (message) {
    // ---- custom (frameless) title bar --------------------------------------
    case WM_NCCALCSIZE:
      return HandleNonClientCalcSize(wparam, lparam);

    case WM_NCHITTEST:
      return HitTestFrame(lparam);

    case WM_GETMINMAXINFO:
      return HandleGetMinMaxInfo(lparam);

    // The themed caption is never painted, but Windows still sends these when
    // the window text or icon changes. Swallow them so no ghost caption can be
    // drawn on top of the Flutter UI.
    case WM_NCUAHDRAWCAPTION:
    case WM_NCUAHDRAWFRAME:
      return 0;

    case WM_DESTROY:
      window_handle_ = nullptr;
      Destroy();
      if (quit_on_close_) {
        PostQuitMessage(0);
      }
      return 0;

    case WM_DPICHANGED: {
      auto newRectSize = reinterpret_cast<RECT*>(lparam);
      LONG newWidth = newRectSize->right - newRectSize->left;
      LONG newHeight = newRectSize->bottom - newRectSize->top;

      SetWindowPos(hwnd, nullptr, newRectSize->left, newRectSize->top, newWidth,
                   newHeight, SWP_NOZORDER | SWP_NOACTIVATE);

      // Drag regions are reported in physical pixels, so a display scale change
      // invalidates them.
      caption_drag_areas_.clear();
      NotifyWindowState();
      return 0;
    }
    case WM_SIZE: {
      RECT rect = GetClientArea();
      if (child_content_ != nullptr) {
        // Size and position the child window.
        MoveWindow(child_content_, rect.left, rect.top, rect.right - rect.left,
                   rect.bottom - rect.top, TRUE);
      }
      NotifyWindowState();
      return 0;
    }

    case WM_ACTIVATE:
      if (child_content_ != nullptr) {
        SetFocus(child_content_);
      }
      NotifyWindowState();
      return 0;

    case WM_DWMCOLORIZATIONCOLORCHANGED:
      UpdateTheme(hwnd);
      return 0;
  }

  return DefWindowProc(window_handle_, message, wparam, lparam);
}

// A frameless window keeps the resize frame but never paints a caption: the
// whole window rect becomes the client area, so Flutter owns every pixel.
LRESULT Win32Window::HandleNonClientCalcSize(WPARAM const wparam,
                                             LPARAM const lparam) {
  if (!frameless_ || wparam != TRUE || window_handle_ == nullptr) {
    return DefWindowProc(window_handle_, WM_NCCALCSIZE, wparam, lparam);
  }

  auto* params = reinterpret_cast<NCCALCSIZE_PARAMS*>(lparam);
  if (params != nullptr && IsZoomed(window_handle_)) {
    // The shell maximizes a WS_THICKFRAME window to the work area *inflated* by
    // the invisible resize frame (8dp per side at 100%). Without a non-client
    // area that overhang would clip the content and cover the taskbar, so clamp
    // the client to the work area instead of doing per-side arithmetic.
    MONITORINFO monitor_info{};
    monitor_info.cbSize = sizeof(MONITORINFO);
    HMONITOR monitor =
        MonitorFromWindow(window_handle_, MONITOR_DEFAULTTONEAREST);
    if (monitor != nullptr && GetMonitorInfoW(monitor, &monitor_info)) {
      params->rgrc[0] = monitor_info.rcWork;
    }
  }

  // Returning 0 leaves the (possibly clamped) rect in place: the proposed
  // window rect is used as the client rect, so no caption is ever created.
  return 0;
}

// Re-creates the resize grips the shell would normally provide, and hands the
// regions reported by Flutter back to the OS as caption areas so that moving,
// double-click maximize, edge snapping and the system menu stay native.
LRESULT Win32Window::HitTestFrame(LPARAM const lparam) const {
  if (!frameless_ || window_handle_ == nullptr) {
    return DefWindowProc(window_handle_, WM_NCHITTEST, 0, lparam);
  }

  const POINT screen_point{GET_X_LPARAM(lparam), GET_Y_LPARAM(lparam)};

  // Edge resize grips win over caption regions that touch the same pixels.
  RECT window_rect{};
  if (GetWindowRect(window_handle_, &window_rect) &&
      !IsZoomed(window_handle_)) {
    const int border = static_cast<int>(
        std::lround(kResizeBorderDip * GetScaleFactor()));
    const LONG width = window_rect.right - window_rect.left;
    const LONG height = window_rect.bottom - window_rect.top;

    const LONG x = screen_point.x - window_rect.left;
    const LONG y = screen_point.y - window_rect.top;

    const bool on_left = x < border;
    const bool on_right = x >= width - border;
    const bool on_top = y < border;
    const bool on_bottom = y >= height - border;

    if (on_top && on_left) return HTTOPLEFT;
    if (on_top && on_right) return HTTOPRIGHT;
    if (on_bottom && on_left) return HTBOTTOMLEFT;
    if (on_bottom && on_right) return HTBOTTOMRIGHT;
    if (on_top) return HTTOP;
    if (on_bottom) return HTBOTTOM;
    if (on_left) return HTLEFT;
    if (on_right) return HTRIGHT;
  }

  // Caption regions are reported in physical pixels relative to the client
  // area, which is where the Flutter view starts.
  POINT client_origin{0, 0};
  if (ClientToScreen(window_handle_, &client_origin)) {
    const LONG x = screen_point.x - client_origin.x;
    const LONG y = screen_point.y - client_origin.y;
    for (const RECT& area : caption_drag_areas_) {
      if (x >= area.left && x < area.right && y >= area.top &&
          y < area.bottom) {
        return HTCAPTION;
      }
    }
  }

  return HTCLIENT;
}

// static
LRESULT Win32Window::HitTestFrameForWindow(HWND const window,
                                          LPARAM const lparam) {
  if (window == nullptr) {
    return HTCLIENT;
  }
  Win32Window* that = GetThisFromHandle(window);
  if (that == nullptr) {
    return HTCLIENT;
  }
  return that->HitTestFrame(lparam);
}

// A frameless window keeps the (invisible) WS_THICKFRAME, so the maximized
// window rect overhangs the work area; HandleNonClientCalcSize clamps the
// client to the work area. Here only the minimum tracking size is enforced.
LRESULT Win32Window::HandleGetMinMaxInfo(LPARAM const lparam) {
  auto* info = reinterpret_cast<MINMAXINFO*>(lparam);
  if (info == nullptr) {
    return 0;
  }

  const double scale = GetScaleFactor();
  info->ptMinTrackSize.x = static_cast<LONG>(kMinWidthDip * scale);
  info->ptMinTrackSize.y = static_cast<LONG>(kMinHeightDip * scale);

  return 0;
}

void Win32Window::Destroy() {
  OnDestroy();

  if (window_handle_) {
    DestroyWindow(window_handle_);
    window_handle_ = nullptr;
  }
  if (g_active_window_count == 0) {
    WindowClassRegistrar::GetInstance()->UnregisterWindowClass();
  }
}

Win32Window* Win32Window::GetThisFromHandle(HWND const window) noexcept {
  return reinterpret_cast<Win32Window*>(
      GetWindowLongPtr(window, GWLP_USERDATA));
}

void Win32Window::SetChildContent(HWND content) {
  child_content_ = content;
  SetParent(content, window_handle_);
  RECT frame = GetClientArea();

  MoveWindow(content, frame.left, frame.top, frame.right - frame.left,
             frame.bottom - frame.top, true);

  SetFocus(child_content_);
}

RECT Win32Window::GetClientArea() {
  RECT frame;
  GetClientRect(window_handle_, &frame);
  return frame;
}

HWND Win32Window::GetHandle() {
  return window_handle_;
}

void Win32Window::SetQuitOnClose(bool quit_on_close) {
  quit_on_close_ = quit_on_close;
}

bool Win32Window::OnCreate() {
  // No-op; provided for subclasses.
  return true;
}

void Win32Window::OnDestroy() {
  // No-op; provided for subclasses.
}

void Win32Window::UpdateTheme(HWND const window) {
  DWORD light_mode;
  DWORD light_mode_size = sizeof(light_mode);
  LSTATUS result = RegGetValue(HKEY_CURRENT_USER, kGetPreferredBrightnessRegKey,
                               kGetPreferredBrightnessRegValue,
                               RRF_RT_REG_DWORD, nullptr, &light_mode,
                               &light_mode_size);

  if (result == ERROR_SUCCESS) {
    BOOL enable_dark_mode = light_mode == 0;
    DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE,
                          &enable_dark_mode, sizeof(enable_dark_mode));
  }
}

// -----------------------------------------------------------------------------
// Custom title bar support
// -----------------------------------------------------------------------------

void Win32Window::SetFrameless(bool frameless) {
  frameless_ = frameless;
  ApplyFramelessFrameStyle();
}

void Win32Window::ApplyFramelessFrameStyle() {
  if (window_handle_ == nullptr) {
    return;
  }

  // WS_CAPTION / WS_THICKFRAME look unused once the non-client area is gone,
  // but the shell needs them for Aero snap, minimize/maximize animations,
  // Snap Layouts and the Alt+Space system menu.
  DWORD style =
      static_cast<DWORD>(GetWindowLongPtr(window_handle_, GWL_STYLE));
  style |= WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX |
           WS_MAXIMIZEBOX;
  SetWindowLongPtr(window_handle_, GWL_STYLE, static_cast<LONG_PTR>(style));

  // Windows 11 rounds top level windows itself, but only for windows it still
  // recognises as having a frame. Do it explicitly, and turn off the 1px
  // outline so the Material surfaces reach the window edge.
  const int corner_preference = DWMWCP_ROUND;
  DwmSetWindowAttribute(window_handle_, DWMWA_WINDOW_CORNER_PREFERENCE,
                        &corner_preference, sizeof(corner_preference));

  const COLORREF no_border = DWMWA_COLOR_NONE;
  DwmSetWindowAttribute(window_handle_, DWMWA_BORDER_COLOR, &no_border,
                        sizeof(no_border));

  SetWindowPos(window_handle_, nullptr, 0, 0, 0, 0,
               SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER |
                   SWP_NOACTIVATE);
}

void Win32Window::SetCaptionDragAreas(std::vector<RECT> areas) {
  caption_drag_areas_ = std::move(areas);
}

void Win32Window::SetWindowStateCallback(
    std::function<void(bool maximized, bool focused)> callback) {
  window_state_callback_ = std::move(callback);
}

void Win32Window::NotifyWindowState() {
  if (!window_state_callback_) {
    return;
  }
  const bool maximized = IsWindowMaximized();
  const bool focused = IsWindowFocused();
  if (maximized == last_maximized_ && focused == last_focused_) {
    return;
  }
  last_maximized_ = maximized;
  last_focused_ = focused;
  window_state_callback_(maximized, focused);
}

bool Win32Window::IsWindowMaximized() const {
  return window_handle_ != nullptr && IsZoomed(window_handle_) != FALSE;
}

bool Win32Window::IsWindowFocused() const {
  return window_handle_ != nullptr &&
         GetForegroundWindow() == window_handle_;
}

void Win32Window::MinimizeWindow() {
  if (window_handle_ != nullptr) {
    ShowWindow(window_handle_, SW_MINIMIZE);
  }
}

void Win32Window::ToggleMaximizeWindow() {
  if (window_handle_ == nullptr) {
    return;
  }
  ShowWindow(window_handle_, IsZoomed(window_handle_) ? SW_RESTORE : SW_MAXIMIZE);
}

void Win32Window::MaximizeWindow() {
  if (window_handle_ != nullptr) {
    ShowWindow(window_handle_, SW_MAXIMIZE);
  }
}

void Win32Window::RestoreWindow() {
  if (window_handle_ != nullptr) {
    ShowWindow(window_handle_, SW_RESTORE);
  }
}

void Win32Window::CloseWindow() {
  if (window_handle_ != nullptr) {
    PostMessage(window_handle_, WM_CLOSE, 0, 0);
  }
}

double Win32Window::GetScaleFactor() const {
  if (window_handle_ == nullptr) {
    return 1.0;
  }
  const UINT dpi = FlutterDesktopGetDpiForHWND(window_handle_);
  return dpi == 0 ? 1.0 : dpi / 96.0;
}
