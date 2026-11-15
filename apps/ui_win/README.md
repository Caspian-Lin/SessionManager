# `ui_win` · Session Manager Windows Reader

`ui_win` is a lightweight, high-performance Flutter desktop reader application tailored for Windows (`flutter build windows`, producing `sm_ui_win.exe`). Built with **Flutter native Material 3 + a Google-native desktop shell** (frameless custom title bar aligned with Google Workspace surfaces, Google Blue accents, `Segoe UI` / `Microsoft YaHei UI` typography, `Cascadia Mono` code typography, compact desktop density, adaptive Light/Dark/System themes, and keyboard shortcuts), it provides instant browsing and branch inspection across archived AI dialogues.

---

## 1. Architectural Role: CQRS Hybrid Direct-Connection (混合直连)

```
┌────────────────────────────────────────────────────────────────────────┐
│ Flutter Windows Desktop UI (sm_ui_win.exe)                             │
│   · Custom frameless title bar (Win32 hit testing) + navigation rail    │
│   · Virtualized Session List, Branch Tree Reader, Search & Integrity   │
└───────────┬─────────────────────────────────────────┬──────────────────┘
            │ Read Path (Zero Daemon / Zero IPC)       │ Write / Heavy IO Path
            │ Dart sqlite3 FFI (OpenMode.readOnly)     │ On-Demand Process.run
            │ + Direct File / Image.file() reads       │ sm <cmd> --db ... --json
┌───────────▼───────────────────────────┐   ┌─────────▼──────────────────┐
│ Local Archive Storage                 │   │ Node 24 CLI (@sm/cli)      │
│   · archive.db (SQLite WAL mode)      │◄──┤   · sm import / verify     │
│   · blobs/<2-char>/<sha256><ext>      │   │   · sm dedupe / reindex    │
│   · raw/<batch_id>/...                │   │   · sm export              │
└───────────────────────────────────────┘   └────────────────────────────┘
```

1. **Zero WebView2 / Zero Resident Daemon**:
   - By using Flutter's native Windows renderer (DirectX 12 / Skia / Impeller) paired with **CQRS Hybrid Direct-Connection**, `ui_win` reads `archive.db` directly via Dart `sqlite3` FFI (`OpenMode.readOnly`, WAL concurrent reads) without spawning or managing any background HTTP server (`sm serve` has been removed).
   - No `127.0.0.1` port binding, no Windows Firewall prompts, no ephemeral token handshakes, and no orphan daemon processes.
2. **Zero-Copy Local Media (`blobs/`)**:
   - `ArchiveDirectStore.resolveBlobFile(sha256, ext: ..., relPath: ...)` resolves local paths under `<archiveRoot>/blobs/<2-char>/<sha256><ext>` directly for Flutter `Image.file()` rendering without HTTP Range proxy overhead.
3. **On-Demand CLI Runner (`SmCliRunner`)**:
   - Heavy write/compute pipelines (`sm import`, `sm verify`, `sm dedupe`, `sm reindex`, `sm export`) are invoked on demand as single-shot `Process.run(smExecutable, [..., '--json'])` subprocesses; upon exit, the read-only Flutter views immediately reload fresh WAL data.
4. **Google-native Material 3 shell (custom Win32 title bar)**:
   - The window opens **frameless**: `WM_NCCALCSIZE` removes the OS caption, so the 56px app bar *is* the
     title bar. Dragging, double-click maximize, Aero snap, edge resizing, the Alt+Space system menu and
     Windows 11 rounded corners are still implemented by the OS (`WM_NCHITTEST` / `WM_GETMINMAXINFO` /
     `DwmSetWindowAttribute`), while the minimize / maximize / close buttons are drawn in Flutter.
   - One chrome tone (canvas + app bar + navigation rail) and one content tone (a top-rounded sheet), so the
     transition between the app bar and the sidebar is a 16px arc instead of a 90° notch.
   - One radius scale (`6 / 10 / 12 / 16 / pill`) and one type scale (`22 / 16 / 14 / 13 / 12 / 11.5 / 11`);
     containers are flat fills with a ≤2% gradient and **no borders**. Google Blue (`#1A73E8`) accent,
     `Segoe UI` / `Microsoft YaHei UI` UI typography, `Cascadia Mono` code typography, Light/Dark/System
     themes, responsive wide split layout (`>= 720px`), and keyboard shortcuts (`Ctrl+F`, `Ctrl+O`,
     `Ctrl+R` / `F5`). See [`docs/ui/google-native-shell.md`](../../docs/ui/google-native-shell.md).

---

## 2. Configuration (`--dart-define`)

When running or building `ui_win`:

- **`SM_ARCHIVE_DIR`**: Path to the archive root directory containing `archive.db` and `blobs/` (or direct path to `archive.db`). Defaults to `./archive.db` or `./archive/archive.db`.
- **`SM_CLI_BIN`**: Path to the `sm` executable or `apps/cli/dist/index.js` entrypoint for `SmCliRunner`. Defaults to `apps/cli/dist/index.js` (via `node`) or `sm` on `PATH`.

Example:
```powershell
flutter run -d windows `
  --dart-define=SM_ARCHIVE_DIR=C:\Users\me\SessionArchive `
  --dart-define=SM_CLI_BIN=C:\path\to\SessionManager\apps\cli\dist\index.js
```

---

## 3. Core Navigation Views

1. **Session List**:
   - Fast, virtualized list displaying conversation provider badges (`openai-web`, `codex-local`, `dsh-local`, `claude-code-local`), message counts, timestamps, and quick **Reindex FTS5** button via `SmCliRunner`.
2. **Branch Tree Reader**:
   - **`is_active_branch` Switcher**: Enables users to switch between regenerated response variants or alternative tool paths.
   - **`is_synthetic` Folding**: Smoothly collapses synthetic events, turn markers, and internal orchestration logs to focus on human-AI dialogue.
3. **Full-Text Search**:
   - Direct SQLite FTS5 dual-index search (`item_fts_uni`, `item_fts_tri`, `conv_fts_tri`, and bounded `LIKE` fallback for 1–2 char CJK) with BM25 ranking and deep-linking into the conversation tree.
4. **Batch Dedupe & Integrity Report**:
   - Reads `import_batch.report_json` directly, exposes one-click **Run Verify** / **Reindex FTS5** actions via `SmCliRunner`, and highlights **`shrunk_conversations`** alerts.

---

## 4. Building & Running on Windows

### Prerequisites
- Flutter SDK `>=3.4.0 <4.0.0`
- Visual Studio 2022 with "Desktop development with C++"
- Node.js `>=24.0.0` (for `sm` CLI invocations)

### Commands

```powershell
# In apps/ui_win
cd apps/ui_win

# Get dependencies (sqlite3 + sqlite3_flutter_libs + path + intl)
flutter pub get

# Run in Windows desktop debug mode
flutter run -d windows

# Production release build
flutter build windows
# Output will be located in: build/windows/x64/runner/Release/
```
