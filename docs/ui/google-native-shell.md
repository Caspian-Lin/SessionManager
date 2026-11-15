# Google 原生风格 Windows 壳层（`ui_win`）

> 目标：把原来的「原生标题栏 + 网页感三栏 + 到处 1px 描边」改成 Google Workspace（Material 3）
> 的桌面壳层：**一个顶栏（同时就是 Windows 标题栏）+ 一个圆角内容面板**，容器全部是
> 「纯色填充、无描边」。

---

## 1. 结构：两层色调 + 一个圆角面板

```
┌─────────────────────────────────────────────────────────────────────────┐  ← 画布（chrome 色）
│ [图标] Session Manager  ● 演示数据  ⌗ archive.db       中文|EN  ⟳ ☾  ─ □ ✕ │  56px 顶栏 = 窗口标题栏
├────────┬────────────────────────────────────────────────────────────────┤
│        │╭──────────────────────────────────────────────────────────────╮│
│  80px  ││  内容面板（sheet 色，仅上两角 16px 圆角，无描边、无阴影）        ││
│  导航轨 ││  会话列表 448px │ 1px 结构细线 │ 分支阅读器                    ││
│        │╰──────────────────────────────────────────────────────────────╯│
└────────┴────────────────────────────────────────────────────────────────┘
```

* **画布 / 顶栏 / 导航轨 = 同一个颜色**（单一纯色，不分层）。
  这是「顶栏与侧边栏之间圆角过渡」成立的前提：两者不同色时，面板圆角会在接缝处被
  切出一个 90° 缺口；同色时，圆角看起来是从顶栏「挖」出来的，衔接干净。
  （对应 Material 3 的 tone-based surface 规则与 Google Drive 2025 的顶部圆角排版。）
* **内容面板 = 高一层的颜色**（`panelTop → panelBottom`），**只圆上面两个角**，
  下沿直接落到窗口边缘。Windows 11 的 DWM 会把窗口四个角裁成 8px 圆角，所以面板
  底部不需要自己圆角。
* **不再有分隔线**：顶栏 / 导航轨 / 画布之间没有任何 1px 线；面板内部只保留
  `hairline`（会话列表与阅读器之间、代码块标题栏）。

## 2. 唯一的一套圆角与字号

所有视图都必须从这里取值，禁止在组件里写死数字。

### 圆角（`Gm3.radius*`）

| Token | 值 | 用途 |
|---|---|---|
| `radiusXs` | 6 | 行内代码、微型标签 |
| `radiusSm` | 10 | 紧凑控件（窗口按钮 hover、应用图标底） |
| `radiusMd` | 12 | 卡片、列表行、代码块、输入框、内嵌块 |
| `radiusLg` | 16 | 内容面板、导入页的大区块 |
| `radiusPill` | 999 | 按钮、Chip、搜索框、Select、导航指示器 |

同心规则：外 16 / 内 12（面板 16，内层卡片 12，区块 16 内嵌 12）。

### 字号（`Gm3.fontSize*`，对应 `TextTheme`）

| 语义 | 字号/字重 | 用途 |
|---|---|---|
| `titleLarge` | 22 / 500 | 页面标题（导入、校验） |
| `titleMedium` | 16 / 600 | 顶栏应用名、面板标题 |
| `titleSmall` | 14 / 600 | 卡片标题、区块小标题 |
| `bodyLarge` | 14 / 400 | 阅读器正文（行高 1.62） |
| `bodyMedium` | 13 / 400 | 默认正文、输入框 |
| `bodySmall` | 12 / 400 | 摘要、次要说明（默认 `onSurfaceVariant`） |
| `labelLarge` | 13 / 600 | 按钮文字 |
| `labelMedium` | 11.5 / 600 | 徽章、Chip |
| `labelSmall` | 11 / 500 | 时间戳、计数、路径（默认 `onSurfaceVariant`） |
| 等宽 | 11 / 12 / 13 | `Cascadia Mono`，路径、代码、LaTeX |

字体族一律通过 `Gm3.text()` / `textTheme` 显式带上 `Segoe UI`，**不要**依赖
`ThemeData.fontFamily` 的隐式继承：`ChipThemeData`、`SegmentedButtonThemeData` 里的
`TextStyle` 不会继承它。

## 3. 容器：纯色填充、无描边、无渐变

* `Gm3Surface.rounded(...)`：唯一的圆角容器原语（`DecoratedBox` + 纯色，可选裁剪）。
* `Gm3Card(...)`：列表行/卡片，带 hover 与 selected 的色调变化（**用填充色表达状态，不用描边**）：
  * idle `#F5F8FD`
  * hover `#EAF1FB`
  * selected `#DDE9FE`（Gmail/Drive 选区蓝）
* 三层色调固定：画布 `#F1F5FC`（顶栏/导航轨同色）→ 面板 `#FFFFFF` → 卡片 `#F5F8FD`，
  卡片内部的凹陷区 `#EDF2FA`。
* **容器内不做渐变**：Material 3 没有渐变 token，卡片里的渐变会被读成「高光」而不是面，
  层级只靠色调 + 圆角 + 间距表达。
* 卡片、区块、徽章上**没有** `BorderSide`；`CardTheme` 也移除了 `side`。
  唯一允许的 1px 线是 `Gm3Hairline`（结构性分隔）。

## 4. 顶栏 = Windows 标题栏（自绘，非原生）

原生 Win32 标题栏（含最小化 / 最大化 / 关闭）已移除，改由 Flutter 绘制，但**窗口行为仍由
系统实现**（拖动、双击最大化、Aero Snap、Alt+Space 系统菜单、边缘缩放）。

### 原生侧（`windows/runner/`）

| 位置 | 作用 |
|---|---|
| `win32_window.cpp` `WM_NCCALCSIZE` | 返回 0，客户区 = 整个窗口（去掉 caption）；最大化时把客户区夹到
`rcWork`，避免被不可见边框顶到任务栏下面 |
| `WM_NCHITTEST` | 8dp（随 DPI 缩放）边缘返回 `HTLEFT/HTTOP…`；Flutter 上报的空白区返回
`HTCAPTION`；其余 `HTCLIENT` |
| `WM_SETCURSOR`（子窗口子类过程） | 边缘显示缩放指针 |
| `WM_NCUAHDRAWCAPTION/FRAME` | 吞掉，防止幽灵标题栏 |
| `DwmSetWindowAttribute(33/34)` | Win11 窗口圆角 + 去掉 1px DWM 外描边 |
| `WM_GETMINMAXINFO` | 最小窗口 960×620（DIP） |
| `flutter_window.cpp` | 方法通道 `session_manager/window`；把 Flutter 视图
（`FLUTTERVIEW` 子窗口）子类化，把非客户区命中用 `HTTRANSPARENT` 交还给宿主窗口 |

### Dart 侧

`lib/platform/window_chrome.dart`

```dart
WindowChrome.attach();                    // 监听原生 -> Dart 的状态推送
WindowChrome.setCaptionDragAreas(rects);  // 上报可拖动区域（物理像素，客户区坐标）
WindowChrome.minimize();
WindowChrome.toggleMaximize();
WindowChrome.close();
WindowChrome.state;                        // ValueNotifier<{maximized, focused}>
```

`lib/widgets/app_title_bar.dart` 负责布局与上报：

* 被动区（品牌区、中间 grab 区）用 `GlobalKey` 量出矩形，交给 Win32 返回 `HTCAPTION`，
  于是拖动、双击最大化、贴边吸附、右键系统菜单全部是系统行为；
* 交互控件（语言切换、刷新、主题、窗口三键、数据库路径 chip）保持 `HTCLIENT`，
  hover / 点击 / Tooltip 正常；
* 通道缺失时（`flutter test`）静默降级，不影响测试。

## 5. 已知取舍

* **Snap Layouts（最大化按钮悬停弹出分屏面板）没有接**：它要求该矩形对
  `WM_NCHITTEST` 返回 `HTMAXBUTTON`，而这个命中是**非客户区**——一旦这么返回，Flutter
  就收不到这块区域的鼠标事件，按钮的 hover 高亮会失效。取舍是保留 Flutter 自绘的 hover，
  放弃悬停分屏（`Win+Z` 与拖到屏幕边缘仍然可用）。若要补，需要把
  `WM_NCMOUSEMOVE/LEAVE` 转发给 Dart 自绘 hover。
* 窗口圆角由 DWM 裁剪（8px），内容自己不做窗口级圆角；最大化时系统按惯例取消圆角。
* 文字渲染依赖系统字体：`Segoe UI` / `Microsoft YaHei UI` / `Cascadia Mono`。

## 6. 评审快照

```powershell
cd apps/ui_win
flutter test test/ui_snapshot_test.dart     # 输出 test/snapshots/*.png
```

| 文件 | 场景 |
|---|---|
| `shell-light-wide.png` | 1440×920 浅色，列表 + 阅读器空态 |
| `shell-dark-wide.png` | 1440×920 深色 |
| `shell-light-narrow.png` | 1180×820 浅色（窄栏） |
| `shell-import.png` | 导入页（大区块 / Select / Segmented） |
| `shell-reader.png` | 选中会话后的阅读器（气泡、代码块、分支片） |

## 7. 设计依据（调研来源）

* Material 3 tone-based surfaces（surface / surfaceContainerLow… 的层级语义）
  <https://m3.material.io/blog/tone-based-surface-color-m3>
* M3 corner radius scale（4 / 8 / 12 / 16 / 28 / full）
  <https://m3.material.io/styles/shape/corner-radius-scale>
* M3 navigation rail 规格（80dp 收起、`56×32` 指示器、图标 24、图标-文字 4dp）
  <https://m3.material.io/components/navigation-rail/specs>
* Google Drive 2025 改版：内容容器「只圆上两角 + 左右留边 + 去掉分隔线」
  <https://9to5google.com/2026/01/06/google-drive-m3-expressive-redesign-complete/>
* Google Workspace 实际色值（`#F8F9FA` 画布 / `#FFFFFF` 面 / `#DADCE0` 细线 / `#0B57D0` 强调）
  <https://www.sokosumi.com/tools/design-md/analysis/gmail>
* Windows 11 `WM_NCCALCSIZE` 去标题栏（返回 0 时客户区 = 窗口）
  <https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-nccalcsize>
* Windows 11 圆角 API 与「不可用窗口区域」限制
  <https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/ui/apply-rounded-corners>
* Snap Layouts 需要 `HTMAXBUTTON`
  <https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/apply-snap-layout-menu>
* Flutter Windows 视图是子窗口，`HTTRANSPARENT` 才能把非客户区命中交还宿主（bitsdojo 的做法）
  <https://github.com/bitsdojo/bitsdojo_window>
