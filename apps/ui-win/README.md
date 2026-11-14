# `ui-win` · Session Manager Windows Reader

`sm_ui_win` is a lightweight, high-performance Flutter desktop reader application tailored for Windows (`flutter build windows`). Built with **Flutter native Material 3 + Windows 11 platform-adapted desktop styling** (Win11 Fluent neutral palette, `Segoe UI Variable` / `Segoe UI` typography, `Cascadia Mono` code typography, compact desktop density, adaptive Light/Dark/System themes, and keyboard shortcuts), it provides instant browsing and branch inspection across archived AI dialogues.

---

## 1. Architectural Role: CQRS Hybrid Direct-Connection (混合直连)

```
┌────────────────────────────────────────────────────────────────────────┐
│ Flutter Windows Desktop UI (sm_ui_win.exe)                             │
│   · Mica / Acrylic frosted title bar and navigation rail               │
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
   - By using Flutter's native Windows renderer (DirectX 12 / Skia / Impeller) paired with **CQRS Hybrid Direct-Connection**, `ui-win` reads `archive.db` directly via Dart `sqlite3` FFI (`OpenMode.readOnly`, WAL concurrent reads) without spawning or managing any background HTTP server (`sm serve` has been removed).
   - No `127.0.0.1` port binding, no Windows Firewall prompts, no ephemeral token handshakes, and no orphan daemon processes.
2. **Zero-Copy Local Media (`blobs/`)**:
   - `ArchiveDirectStore.resolveBlobFile(sha256, ext: ..., relPath: ...)` resolves local paths under `<archiveRoot>/blobs/<2-char>/<sha256><ext>` directly for Flutter `Image.file()` rendering without HTTP Range proxy overhead.
3. **On-Demand CLI Runner (`SmCliRunner`)**:
   - Heavy write/compute pipelines (`sm import`, `sm verify`, `sm dedupe`, `sm reindex`, `sm export`) are invoked on demand as single-shot `Process.run(smExecutable, [..., '--json'])` subprocesses; upon exit, the read-only Flutter views immediately reload fresh WAL data.
4. **Windows 11 Platform-Adapted Material 3 Styling**:
   - Uses `WinAdaptiveTheme` (`useMaterial3: true`, `ThemeMode.system` with Light/Dark/System toggle), Win11 Fluent neutral palette (`#0067C0` light / `#60CDFF` dark accents), `Segoe UI Variable` / `Segoe UI` UI typography, `Cascadia Mono` / `Consolas` monospace code blocks, compact desktop density, desktop scrollbars, responsive wide-screen split layout (`>= 1100px`), and keyboard shortcuts (`Ctrl+F`, `Ctrl+O`, `Ctrl+R` / `F5`).

---

## 2. Configuration (`--dart-define`)

When running or building `ui-win`:

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
# In apps/ui-win
cd apps/ui-win

# Get dependencies (sqlite3 + sqlite3_flutter_libs + path + intl)
flutter pub get

# Run in Windows desktop debug mode
flutter run -d windows

# Production release build
flutter build windows
# Output will be located in: build/windows/x64/runner/Release/
```
