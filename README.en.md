<div align="center">

<h1>Session Manager · Local AI Conversation Archive</h1>

Collect conversations scattered across web export bundles and local agent logs into a local archive that is <strong>immutable by default, deduplicated, verifiable, and media-aware</strong>.

<p>
  <a href="https://github.com/Caspian-Lin/SessionManager/releases"><img alt="release" src="https://img.shields.io/badge/release-v0.1.0.0-1A73E8"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2011-1A73E8">
  <img alt="node" src="https://img.shields.io/badge/Node-%E2%89%A524-1A73E8">
  <img alt="flutter" src="https://img.shields.io/badge/Flutter-3.24-1A73E8">
</p>

<p><a href="README.md">简体中文</a> · <strong>English</strong></p>

</div>

---

**Current version: `v0.1.0.0` (first public release, 2026-11-16).** The `sm` CLI closed loop and the Windows desktop reader are usable today, covering mainstream web export bundles, local agent sessions, same-origin deduplication, and integrity verification.

---

## At a glance

| Question | Answer |
|---|---|
| Supported sources | OpenAI / Anthropic / DeepSeek web exports; Codex / Claude Code / DSH / OpenCode / ZCode local sessions; `sm-native` round-trip bundles; generic JSON / Markdown fallback |
| Product shape | **`sm` CLI + Windows desktop reader** (native Flutter window, no WebView, no resident daemon) |
| Stack | Polymorphic `SessionDocument<TRaw>` contract + TypeScript core (`shared` / `store` / `adapters` / `core` / `cli`) + **CQRS hybrid direct connection** (Dart `sqlite3` FFI read-only access to `archive.db`, direct `blobs/` reads, on-demand `sm --json`) |
| Storage | SQLite (WAL + dual FTS5 indexes) + content-addressed `blobs/` + read-only `raw/` layer |
| Differentiation | ① Branch fidelity (every regenerate side-branch is kept) ② **Same-origin conversation dedupe and diff reports** across repeated exports ③ One behavioural interface for web chats and agent traces (projected on demand into reading ViewModels and FTS indexes) ④ Raw data is read-only and indexes are rebuildable |
| Known limits | Reader is Windows 11 only; MSIX is signed with a development self-signed certificate; Anthropic web export still has edge cases being filled in ([#9](https://github.com/Caspian-Lin/SessionManager/issues/9)) |

---

## What's in 0.1.0.0

- **CLI closed loop**: `probe → import → ls / show / search → verify / dedupe → export / reindex`, plus `tag`, `star`, `rm`, and `vacuum` for archive governance.
- **Windows reader**: source → project → conversation tree, branch-aware reader, single-line folding of multi-round reasoning and tool calls, Codex jump rail, Markdown tables / KaTeX formulas / syntax highlighting, context statistics bar, and long-image sharing (per-turn cropping, watermark, optional share date).
- **Polymorphic adapters**: each provider keeps its native structure and implements its own validation, hashing, and view projection; format drift only requires touching the affected adapter.
- **Same-origin dedupe**: Batch SHA256 → External ID → Merkle Root → MinHash LSH, so repeated exports import idempotently and shortened or upstream-deleted content produces a diff report.
- **CJK search**: FTS5 `unicode61` + `trigram` dual indexes with BM25 ranking, plus a bounded `LIKE` fallback for 1–2 character CJK queries.
- **No resident service**: the desktop app opens SQLite read-only (WAL concurrent reads) and launches `sm` as a one-shot subprocess for writes — no ports, no background daemon.

---

## Download & install (Windows)

Download `SessionManager_0.1.0.0_x64.msix` from [Releases](https://github.com/Caspian-Lin/SessionManager/releases).

The MSIX is signed with the repository's **development self-signed certificate** (`SessionManagerDev.cer`). Trust it before installing:

```powershell
# Requires administrator rights: add the dev certificate to Trusted Root CAs
Import-Certificate -FilePath .\SessionManagerDev.cer -CertStoreLocation Cert:\LocalMachine\Root

# Install the app
Add-AppxPackage -Path .\SessionManager_0.1.0.0_x64.msix
```

> This is suitable for local or controlled environments only. Public distribution should use a trusted code-signing certificate and publish a checksum with the release.

---

## Quick start (from source)

Requires **Node.js ≥ 24** and **pnpm ≥ 9**. Building the Windows reader additionally requires **Flutter 3.24+** and Visual Studio 2022 with "Desktop development with C++".

```powershell
pnpm install
pnpm build

# 1) Probe a source to confirm adapter detection and volume
pnpm sm probe "$env:USERPROFILE\.codex"

# 2) Import into the archive (idempotent for the same source)
pnpm sm import "$env:USERPROFILE\.codex" --kind codex-local --db .\archive.db

# 3) Browse, search, and verify
pnpm sm ls --db .\archive.db
pnpm sm show 1 --db .\archive.db --all-branches
pnpm sm search "architecture" --db .\archive.db
pnpm sm verify --db .\archive.db
pnpm sm dedupe --db .\archive.db

# 4) Export provider-native, Markdown, or JSONL
pnpm sm export --format native --zip --out .\export\native.zip --db .\archive.db
```

Launch the Windows reader:

```powershell
cd apps/ui_win
flutter pub get
flutter run -d windows `
  --dart-define=SM_ARCHIVE_DIR=C:\path\to\archive `
  --dart-define=SM_CLI_BIN=C:\path\to\SessionManager\apps\cli\dist\index.js
```

Build the MSIX (bundles the CLI runtime and the Flutter release output):

```powershell
pnpm package:msix -- --version 0.1.0.0
```

---

## Supported sources

| Provider ID | Source | Notes |
|---|---|---|
| `openai-web` | ChatGPT export ZIP | `mapping` tree, `current_node`, hidden-message markers, `.dat` asset alignment |
| `anthropic-web` | Claude export | `content[]` blocks, memories / projects; edge cases still being added ([#9](https://github.com/Caspian-Lin/SessionManager/issues/9)) |
| `deepseek-web` | DeepSeek export ZIP | `messages` / `mapping` / `fragments`, UTF-8 BOM, numeric ids, active-branch inference from `current_message_id` |
| `codex-local` | `~/.codex` | Aligns `rollout-*.jsonl.zst` with `thread_history_1.sqlite` |
| `claude-code-local` | `~/.claude/projects` | `parentUuid` tree, `isSidechain` sub-threads, truncated-tail tolerance |
| `dsh-local` | `~/.dsh/sessions` | Multi-frame zstd, streaming chunk aggregation, synthetic system-message filtering |
| `opencode-local` | OpenCode local store | Shared `opencode-common` parsing |
| `zcode-local` | ZCode local store | Local session directory |
| `sm-native` | `sm export --format native` | Round-trip re-import, native manifest, and dedupe |
| `generic-json` / `generic-md` | Any JSON / Markdown | Fallback import when no adapter matches |

---

## Documentation

| Document | Contents |
|---|---|
| [docs/01-既有方案调研.md](docs/01-既有方案调研.md) | Competitor / open-source landscape, mechanisms worth borrowing, compliance boundaries |
| [docs/02-数据格式规范.md](docs/02-数据格式规范.md) | Real formats of six data sources (partly verified on this machine), pitfalls, native types, and the unified `SessionDocument` behavioural contract |
| [docs/03-架构设计.md](docs/03-架构设计.md) | Layering, technology trade-offs, directory layout, simplified SQLite schema, dedupe/verification algorithms, search design |
| [docs/04-开发计划.md](docs/04-开发计划.md) | Milestones, WBS estimates, three scope options, risk register, roadmap |
| [docs/ui/google-native-shell.md](docs/ui/google-native-shell.md) | Google-native shell and layout specification for the Windows reader |

---

## Verified format facts (on this machine)

A few architecture-deciding facts were verified locally during research so the design would not rest on guesses:

1. **Codex rollouts are zstd-compressed**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst`, a single frame that Node 24's built-in `zlib.zstdDecompressSync` can decode. Records look like `{timestamp, ordinal, type, payload}` with `type ∈ {session_meta, turn_context, response_item, event_msg}`.
2. **Codex also keeps a SQLite primary store**: `~/.codex/thread_history_1.sqlite` — 331.8 MiB, 203 conversations, 45,231 items on this machine. In `thread_items(item_json)`, `commandExecution` averages 9.7 KB and `imageGeneration` averages **3 MB** (inline base64) — which is why large payloads must be externalised.
3. **DSH sessions are multi-frame concatenated zstd**: `.dsh/sessions/<enc-cwd>/<id>/session.v4.jsonl.zstd` appends one zstd frame at a time. Node's built-in zstd only decodes the first frame (it throws `Unknown frame descriptor`), so a streaming decoder is required (`fzstd` decoded 15.9 MB / 18,744 lines in testing). The log is a stream of incremental events (`assistant/chunk`, `reasoning-chunks`, `tool-call-chunks` must be aggregated).
4. **Codex already uses content hashes as an import ledger**: `.codex/external_agent_session_imports.json` records `source_path + content_sha256 + imported_thread_id` — exactly the mechanism this project uses for dedupe and idempotency, effectively an official endorsement.
5. **Claude Code local session path**: `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (confirmed from the ledger above).
6. **SQLite CJK search cannot rely on `unicode61` alone**: in testing, `unicode61` returned zero hits for "会话管理"; `trigram` matched 3+ character terms but still missed 2-character terms — hence dual indexes or query rewriting.

> Reproduce these conclusions with `pnpm sm probe`.

### Probe output (this machine, 2026-11)

```
■ Codex  C:\Users\28491\.codex
  rollout files     256  (477.5 MB compressed)
  unique sessions   234
  user/assistant    1995 / 8560
  text volume       14.44 M chars
  primary store     thread_history_1.sqlite  331.8 MB
  sessions/turns/items  203 / 860 / 45231
  items > 32 KB     1283  ← must be externalised to blobs
    commandExecution  12192  avg 9704 B  max 1.3 MB
    mcpToolCall        1879  avg 74305 B max 1.0 MB
    imageGeneration       3  avg 2959966 B max 3.1 MB

■ DSH  C:\Users\28491\.dsh
  session log files 22  (22.9 MB compressed)
  user/assistant    318 / 3271     tool calls 4411
  stream chunks     15185           injected (non-user) messages 294
  attachments       335

■ ZIP export  synth-chatgpt.zip
  inferred provider  openai-web
  markers: ✓ mapping graph  ✓ current_node  ✓ hidden-message flags  ✓ content_type
```

Three numbers changed the design:
- **1,283 items exceed 32 KB** (max 3.1 MB) → without externalising large payloads, 45k items would push the database into the hundreds of MB;
- **15,185 stream chunk events are one third of all DSH records** → they must be aggregated or dropped, or storage and rendering both explode;
- **477 MB compressed / 14.4 M chars** → a full import is a multi-minute job that needs concurrency and resumability, not a spinner that runs until morning.

---

## Development & tests

```powershell
pnpm install
pnpm typecheck          # TypeScript typecheck across the workspace
pnpm test               # vitest: adapters, store, core, CLI E2E

cd apps/ui_win
flutter test            # reader / share / Markdown / snapshot tests
```

`flutter test` also refreshes the shell snapshots under `docs/ui/`; commit them together with UI changes.

---

## Repository layout

```
SessionManager/
├─ apps/
│  ├─ cli/                  # sm CLI (TypeScript, Node 24)
│  └─ ui_win/               # Flutter Windows reader
├─ packages/
│  ├─ shared/               # contracts, hashing, zstd, CJK utilities
│  ├─ store/                # SQLite schema, FTS5, raw/blobs repositories
│  ├─ adapters/             # polymorphic provider adapters
│  ├─ core/                 # validation, dedupe, revision merge, diff reports
│  └─ fixtures/             # synthetic fixtures
├─ docs/                    # design docs, UI spec, and snapshots
├─ tools/                   # format probe (read-only scan; uploads nothing)
├─ scripts/                 # Windows portable / MSIX packaging scripts
└─ dist/                    # local build artifacts (git-ignored)
```

---

## Versioning & releases

The first release uses the four-part Windows installer version **`0.1.0.0`**, matching the GitHub Release tag `v0.1.0.0`; the rest of the toolchain keeps its own version format:

| Location | Version |
|---|---|
| GitHub tag / Release | `v0.1.0.0` |
| MSIX `AppxManifest.xml` | `0.1.0.0` |
| `package.json` (three-part npm semver) | `0.1.0` |
| `apps/ui_win/pubspec.yaml` (Dart `version+build`) | `0.1.0+1` |

Release flow: cut a release branch from `main` → open a PR linked to an issue → merge → tag → build and sign the MSIX with `scripts/build-win-msix.mjs` → create the Release with the installer and checksum attached.
