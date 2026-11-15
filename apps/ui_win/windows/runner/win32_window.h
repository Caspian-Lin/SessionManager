#ifndef RUNNER_WIN32_WINDOW_H_
#define RUNNER_WIN32_WINDOW_H_

#include <windows.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

// A class abstraction for a high DPI-aware Win32 Window. Intended to be
// inherited from by classes that wish to specialize with custom
// rendering and input handling
class Win32Window {
 public:
  struct Point {
    unsigned int x;
    unsigned int y;
    Point(unsigned int x, unsigned int y) : x(x), y(y) {}
  };

  struct Size {
    unsigned int width;
    unsigned int height;
    Size(unsigned int width, unsigned int height)
        : width(width), height(height) {}
  };

  Win32Window();
  virtual ~Win32Window();

  // Creates a win32 window with |title| that is positioned and sized using
  // |origin| and |size|. New windows are created on the default monitor. Window
  // sizes are specified to the OS in physical pixels, hence to ensure a
  // consistent size this function will scale the inputted width and height as
  // as appropriate for the default monitor. The window is invisible until
  // |Show| is called. Returns true if the window was created successfully.
  bool Create(const std::wstring& title, const Point& origin, const Size& size);

  // Show the current window. Returns true if the window was successfully shown.
  bool Show();

  // Centers the window on its monitor, shrinking it if the work area is
  // smaller. Intended to be called once, right after |Create|.
  void CenterOnWorkArea();

  // Release OS resources associated with window.
  void Destroy();

  // Inserts |content| into the window tree.
  void SetChildContent(HWND content);

  // Returns the backing Window handle to enable clients to set icon and other
  // window properties. Returns nullptr if the window has been destroyed.
  HWND GetHandle();

  // If true, closing this window will quit the application.
  void SetQuitOnClose(bool quit_on_close);

  // Return a RECT representing the bounds of the current client area.
  RECT GetClientArea();

  // ---------------------------------------------------------------------------
  // Custom title bar (frameless window) support
  // ---------------------------------------------------------------------------

  // Removes the OS caption (title bar + system buttons) while keeping the
  // resize frame, Aero snap, Windows 11 snap layouts, rounded corners and the
  // system menu. The client area then covers the whole window, so Flutter can
  // paint a title bar of its own.
  void SetFrameless(bool frameless);

  // Registers the regions of the window (physical pixels, window coordinates)
  // that behave like the OS caption: click-and-drag to move, double-click to
  // maximize/restore, right-click for the system menu and edge snap. The
  // regions must be re-sent whenever the layout or the display scale changes.
  void SetCaptionDragAreas(std::vector<RECT> areas);

  // Called whenever the maximize or the activation state changes so that the
  // host can mirror it in the custom title bar.
  void SetWindowStateCallback(
      std::function<void(bool maximized, bool focused)> callback);

  bool IsWindowMaximized() const;
  bool IsWindowFocused() const;

  void MinimizeWindow();
  void ToggleMaximizeWindow();
  void MaximizeWindow();
  void RestoreWindow();
  void CloseWindow();

  // Hit-tests a point (as delivered in WM_NCHITTEST |lparam|, screen space)
  // against the custom frame: resize grips, caption regions and content.
  LRESULT HitTestFrame(LPARAM const lparam) const;

  // Same as above, resolved from |window|. Needed by the Flutter view, which
  // is a child window covering the whole client area: it must forward
  // non-client hits to the frame through HTTRANSPARENT.
  static LRESULT HitTestFrameForWindow(HWND const window, LPARAM const lparam);

  // The window scale factor derived from the current DPI (96 DPI == 1.0).
  double GetScaleFactor() const;

 protected:
  // Processes and route salient window messages for mouse handling,
  // size change and DPI. Delegates handling of these to member overloads that
  // inheriting classes can handle.
  virtual LRESULT MessageHandler(HWND window,
                                 UINT const message,
                                 WPARAM const wparam,
                                 LPARAM const lparam) noexcept;

  // Called when CreateAndShow is called, allowing subclass window-related
  // setup. Subclasses should return false if setup fails.
  virtual bool OnCreate();

  // Called when Destroy is called.
  virtual void OnDestroy();

 private:
  friend class WindowClassRegistrar;

  // OS callback called by message pump. Handles the WM_NCCREATE message which
  // is passed when the non-client area is being created and enables automatic
  // non-client DPI scaling so that the non-client area automatically
  // responds to changes in DPI. All other messages are handled by
  // MessageHandler.
  static LRESULT CALLBACK WndProc(HWND const window,
                                  UINT const message,
                                  WPARAM const wparam,
                                  LPARAM const lparam) noexcept;

  // Retrieves a class instance pointer for |window|
  static Win32Window* GetThisFromHandle(HWND const window) noexcept;

  // Update the window frame's theme to match the system theme.
  static void UpdateTheme(HWND const window);

  // Applies the Windows 11 rounded corner + border policy and re-evaluates the
  // frame after the window style changed.
  void ApplyFramelessFrameStyle();

  // Pushes the current maximize/activation state to the registered callback
  // when it changed since the last notification.
  void NotifyWindowState();

  LRESULT HandleNonClientCalcSize(WPARAM const wparam, LPARAM const lparam);
  LRESULT HandleGetMinMaxInfo(LPARAM const lparam);

  bool quit_on_close_ = false;

  // When true the window is rendered without the OS non-client area.
  bool frameless_ = true;

  // Regions that behave like the OS caption. Physical pixels, window space.
  std::vector<RECT> caption_drag_areas_;

  std::function<void(bool maximized, bool focused)> window_state_callback_;

  bool last_maximized_ = false;
  bool last_focused_ = true;

  // window handle for top level window.
  HWND window_handle_ = nullptr;

  // window handle for hosted content.
  HWND child_content_ = nullptr;
};

#endif  // RUNNER_WIN32_WINDOW_H_
