# `ui-win` · Session Manager Windows Reader

`sm_ui_win` is a lightweight, high-performance Flutter desktop reader application tailored for Windows (`flutter build windows`). It shares its visual identity, window frame aesthetics, and conversational message components with **Chatea**, providing instant browsing and branch inspection across archived AI dialogues.

---

## 1. Architectural Role & Synergy

```
┌────────────────────────────────────────────────────────────────────────┐
│ Flutter Windows Desktop UI (sm_ui_win.exe)                             │
│   · Mica / Acrylic frosted title bar and navigation rail               │
│   · Virtualized Session List (super_sliver_list)                       │
│   · Branch Tree Reader (active branch switcher + synthetic folding)    │
│   · Full-Text Search with matched snippet highlights                   │
│   · Batch Dedupe & Integrity Diff Report (shrunk_conversations alerts) │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ HTTP JSON / SSE (127.0.0.1)
                                    │ X-SM-Token: <ephemeral-hex>
┌───────────────────────────────────▼────────────────────────────────────┐
│ Node 24 Core Backend (sm serve)                                        │
│   · Synchronous SQLite FTS5 (archive.db)                               │
│   · Content-Addressed Blob Storage (blobs/:sha256)                     │
│   · Raw Layer Immutability & Deduplication Pipeline                   │
└────────────────────────────────────────────────────────────────────────┘
```

1. **Zero WebView2 / Electron Overhead**:
   By using Flutter's native Windows renderer (DirectX 12 / Skia / Impeller), `ui-win` maintains 60–120 FPS scrolling over 50,000+ sessions without host runtime version dependencies or memory bloat (~25 MB runtime memory).
2. **Shares OCA Dart Codegen Models**:
   Directly imports `packages/oca/codegen/dart/oca_models.dart` for strongly-typed `OcaConversation`, `OcaItem`, `OcaBlock`, and `OcaIntegrityReport` entities, guaranteeing 100% schema consistency between TypeScript and Dart.
3. **Chatea Visual Shell Alignment**:
   Adheres to Chatea's design tokens: semi-transparent navigation sidebar, distinct role bubbles (`user`, `assistant`, `tool_call`, `reasoning`), subtle monospace code blocks, and collapsible synthetic logs.

---

## 2. IPC & Local Server Connection Flow

When `ui-win` launches:

1. **Auto-Spawn or Connect**:
   - `ui-win` inspects command-line arguments: `--port <port> --token <token>` or `--db <path>`.
   - If no running server is detected, it spawns `sm serve --port 0 --db <path>` as a background child process.
   - It captures stdout line: `SM_SERVER_READY port=<port> token=<token> db=<dbPath>`.
2. **Token-Guarded Security**:
   - Every outbound HTTP request to `http://127.0.0.1:<port>` includes the header:
     `X-SM-Token: <token>`
   - The Node server binds **strictly** to `127.0.0.1`, rejecting any foreign or browser-forged requests.
3. **Blob Streaming**:
   - Images and media attachments are loaded on demand via `GET /blobs/:sha256` with HTTP Range caching.

---

## 3. Core Navigation Views

1. **Session List**:
   - Fast, virtualized list displaying conversation provider badges (`openai-web`, `codex-local`, `dsh-local`, `claude-code-local`), message counts, character volume, and last updated timestamps.
2. **Branch Tree Reader**:
   - **`is_active_branch` Switcher**: Enables users to switch between regenerated response variants or alternative tool paths.
   - **`is_synthetic` Folding**: Smoothly collapses synthetic events, turn markers, and internal orchestration logs to focus on human-AI dialogue.
3. **Full-Text Search**:
   - Instant search with matched excerpt snippets, role indicators, and direct deep-linking into the conversation tree.
4. **Batch Dedupe & Integrity Report**:
   - Visual dashboard summarizing import batches, exact duplicates, and candidate clusters.
   - **`shrunk_conversations` High-Priority Alert**: Highlights conversations that lost items in subsequent export dumps (indicating upstream message deletions or model deletions).

---

## 4. Building & Running on Windows

### Prerequisites
- Flutter SDK `>=3.4.0 <4.0.0`
- Visual Studio 2022 with "Desktop development with C++"
- Node.js `>=24.0.0` with `pnpm`

### Commands

```powershell
# In apps/ui-win
cd apps/ui-win

# Get dependencies
flutter pub get

# Run in Windows desktop debug mode
flutter run -d windows

# Production release build
flutter build windows
# Output will be located in: build/windows/x64/runner/Release/
```
