<div align="center">

<h1>Session Manager · 本地 AI 会话库</h1>

把散落在各家网页导出包、以及本地 Agent 运行日志里的对话，收进一个<strong>原始不可变、可查重、可校验、带多媒体</strong>的本地会话库。

<p>
  <a href="https://github.com/Caspian-Lin/SessionManager/releases"><img alt="release" src="https://img.shields.io/badge/release-v0.1.0.0-1A73E8"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%2011-1A73E8">
  <img alt="node" src="https://img.shields.io/badge/Node-%E2%89%A524-1A73E8">
  <img alt="flutter" src="https://img.shields.io/badge/Flutter-3.24-1A73E8">
</p>

<p><strong>简体中文</strong> · <a href="README.en.md">English</a></p>

</div>

---

**当前版本：`v0.1.0.0`（首个公开版本，2026-11-16）。** 已有可用的 `sm` CLI 闭环与 Windows 桌面阅读器，覆盖主流网页导出包、本地 Agent 会话、同源查重与完整性校验。

---

## 一页结论

| 问题 | 结论 |
|---|---|
| 支持的来源 | OpenAI / Anthropic / DeepSeek 网页导出；Codex / Claude Code / DSH / OpenCode / ZCode 本地会话；`sm-native` 往返导出包；通用 JSON / Markdown 兜底 |
| 产品形态 | **`sm` CLI + Windows 桌面阅读器**（Flutter 原生窗口，无 WebView、无常驻守护进程） |
| 技术栈 | 多态 `SessionDocument<TRaw>` 契约 + TypeScript 核心（`shared` / `store` / `adapters` / `core` / `cli`）+ **CQRS 混合直连**（Dart `sqlite3` FFI 只读直连 `archive.db` + `blobs/` 直读 + 按需调用 `sm --json`） |
| 存储 | SQLite（WAL + FTS5 双索引）+ 内容寻址 `blobs/` + 只读 `raw/` 原始层 |
| 差异化 | ① 分支保真（保留 regenerate 全部旁支）② 多次导出之间的**同源会话级查重与差异报告** ③ 网页对话与 Agent 轨迹统一行为接口（按需投影为阅读 ViewModel 与 FTS 索引）④ 原始数据只读、索引可重建 |
| 已知限制 | 阅读器仅 Windows 11；MSIX 使用开发自签名证书；Anthropic 网页导出仍有边界用例在补充（[#9](https://github.com/Caspian-Lin/SessionManager/issues/9)） |

---

## 0.1.0.0 有什么

- **CLI 闭环**：`probe → import → ls / show / search → verify / dedupe → export / reindex`，并支持 `tag`、`star`、`rm`、`vacuum` 的归档治理。
- **Windows 阅读器**：来源 → 项目 → 会话的三级树、分支树阅读、多轮思考与工具调用单行折叠、Codex 跳转目录条、Markdown 表格 / KaTeX 公式 / 代码高亮、上下文统计条、长图分享（可按轮次裁剪、可加水印与日期）。
- **多态适配器**：保留各 provider 原生结构，每个来源独立实现校验、哈希与视图投影；格式漂移时只改对应适配器。
- **同源查重**：Batch SHA256 → External ID → Merkle Root → MinHash LSH 四级流水线，重复导出可幂等导入，内容缩短 / 上游删除会生成差异报告。
- **中文检索**：FTS5 `unicode61` + `trigram` 双索引、BM25 排序，并对 1–2 字 CJK 查询走有界 `LIKE` 兜底。
- **零常驻服务**：桌面端只读打开 SQLite（WAL 并发读），写操作按需拉起 `sm` 子进程，没有端口、没有后台守护进程。

---

## 下载与安装（Windows）

从 [Releases](https://github.com/Caspian-Lin/SessionManager/releases) 下载 `SessionManager_0.1.0.0_x64.msix`。

MSIX 使用仓库内的**开发自签名证书**（`SessionManagerDev.cer`），首次安装需要先信任该证书：

```powershell
# 需要管理员权限：将开发证书加入“受信任的根证书颁发机构”
Import-Certificate -FilePath .\SessionManagerDev.cer -CertStoreLocation Cert:\LocalMachine\Root

# 安装应用
Add-AppxPackage -Path .\SessionManager_0.1.0.0_x64.msix
```

> 这只适用于本机/受控环境。面向公众分发前应换成受信任的代码签名证书，并在 Release 中附带校验和。

---

## 快速开始（源码）

需要 **Node.js ≥ 24**、**pnpm ≥ 9**；构建 Windows 阅读器还需要 **Flutter 3.24+** 与 Visual Studio 2022（Desktop development with C++）。

```powershell
pnpm install
pnpm build

# 1) 探测一个来源，确认适配器识别与体量
pnpm sm probe "$env:USERPROFILE\.codex"

# 2) 导入归档（可重复执行，同源导入幂等）
pnpm sm import "$env:USERPROFILE\.codex" --kind codex-local --db .\archive.db

# 3) 浏览、检索与校验
pnpm sm ls --db .\archive.db
pnpm sm show 1 --db .\archive.db --all-branches
pnpm sm search "架构" --db .\archive.db
pnpm sm verify --db .\archive.db
pnpm sm dedupe --db .\archive.db

# 4) 按来源原样导出，或导出 Markdown / JSONL
pnpm sm export --format native --zip --out .\export\native.zip --db .\archive.db
```

启动 Windows 阅读器：

```powershell
cd apps/ui_win
flutter pub get
flutter run -d windows `
  --dart-define=SM_ARCHIVE_DIR=C:\path\to\archive `
  --dart-define=SM_CLI_BIN=C:\path\to\SessionManager\apps\cli\dist\index.js
```

打包 MSIX（含 CLI 运行时与 Flutter Release 产物）：

```powershell
pnpm package:msix -- --version 0.1.0.0
```

---

## 支持的来源

| Provider ID | 来源 | 说明 |
|---|---|---|
| `openai-web` | ChatGPT 导出 ZIP | `mapping` 树、`current_node`、隐藏消息标记、`.dat` 资产对齐 |
| `anthropic-web` | Claude 导出 | `content[]` 块、memories / projects；边界用例持续补充（[#9](https://github.com/Caspian-Lin/SessionManager/issues/9)） |
| `deepseek-web` | DeepSeek 导出 ZIP | `messages` / `mapping` / `fragments`、UTF-8 BOM、数字 id、`current_message_id` 活动分支推导 |
| `codex-local` | `~/.codex` | `rollout-*.jsonl.zst` 与 `thread_history_1.sqlite` 双源对齐 |
| `claude-code-local` | `~/.claude/projects` | `parentUuid` 树、`isSidechain` 子线程、坏尾行容错 |
| `dsh-local` | `~/.dsh/sessions` | 多帧 zstd、流式 chunk 聚合、synthetic 系统消息过滤 |
| `opencode-local` | OpenCode 本地库 | 共享 `opencode-common` 解析 |
| `zcode-local` | ZCode 本地库 | 本地会话目录 |
| `sm-native` | `sm export --format native` | 往返重导入、原生清单与查重 |
| `generic-json` / `generic-md` | 任意 JSON / Markdown | 无匹配适配器时的兜底导入 |

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-既有方案调研.md](docs/01-既有方案调研.md) | 竞品/开源项目横评、可借鉴的具体机制、合规边界 |
| [docs/02-数据格式规范.md](docs/02-数据格式规范.md) | 6 个数据源的真实格式（部分在本机实测）、坑位、原生数据类型与统一 `SessionDocument` 行为接口规范 |
| [docs/03-架构设计.md](docs/03-架构设计.md) | 分层、技术选型对比、目录结构、简化后 SQLite Schema、同源查重/校验算法、搜索方案 |
| [docs/04-开发计划.md](docs/04-开发计划.md) | 里程碑、WBS 工时表、三种范围口径、风险登记表、路线图 |
| [docs/ui/google-native-shell.md](docs/ui/google-native-shell.md) | Windows 阅读器的 Google 原生风格壳层与布局规范 |

---

## 已核实的格式事实（本机实测）

调研阶段已经在本机验证过几件会决定架构的事，避免方案建立在猜测上：

1. **Codex 的 rollout 是 zstd 压缩的**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst`，单帧，Node 24 内置 `zlib.zstdDecompressSync` 可直接解。记录形如 `{timestamp, ordinal, type, payload}`，`type ∈ {session_meta, turn_context, response_item, event_msg}`。
2. **Codex 还有一份 SQLite 主存储**：`~/.codex/thread_history_1.sqlite`，本机 331.8 MiB / 203 个会话 / 45,231 条 item。`thread_items(item_json)` 里 `commandExecution` 平均 9.7 KB、`imageGeneration` 平均 **3 MB**（内联 base64）——这直接决定了必须做「大负载外置」。
3. **DSH 会话是多帧拼接的 zstd**：`.dsh/sessions/<enc-cwd>/<id>/session.v4.jsonl.zstd` 是「每次追加一个 zstd frame」的流。Node 内置 zstd 只能解第一帧（会抛 `Unknown frame descriptor`），必须用能处理连续帧的解码器（实测 `fzstd` 可完整解出 15.9 MB / 18,744 行）。且日志是**流式增量事件**（`assistant/chunk`、`reasoning-chunks`、`tool-call-chunks` 需要聚合）。
4. **Codex 自己就在用内容哈希做导入台账**：`.codex/external_agent_session_imports.json` 里记 `source_path + content_sha256 + imported_thread_id`——这正是本项目查重/幂等所采用的机制，算是官方背书。
5. **Claude Code 的本地会话路径**：`~/.claude/projects/<编码后的工作目录>/<uuid>.jsonl`（从上面那份导入台账里得到实证）。
6. **SQLite 中文检索不能只靠 `unicode61`**：实测 `unicode61` 对「会话管理」零命中，`trigram` 对 ≥3 字命中、2 字仍不命中——需要双索引或查询改写。

> 这些结论可以直接跑 `pnpm sm probe` 复现。

### 探针实测输出（本机，2026-11）

```
■ Codex  C:\Users\28491\.codex
  rollout 文件      256  (477.5 MB 压缩后)
  唯一会话          234
  用户/助手消息     1995 / 8560
  文本体量          14.44 M 字符
  主存储            thread_history_1.sqlite  331.8 MB
  会话/轮次/items   203 / 860 / 45231
  >32KB 的 item     1283 条  ← 必须外置到 blob
    commandExecution  12192  avg 9704 B  max 1.3 MB
    mcpToolCall        1879  avg 74305 B max 1.0 MB
    imageGeneration       3  avg 2959966 B max 3.1 MB

■ DSH  C:\Users\28491\.dsh
  会话日志文件      22  (22.9 MB 压缩后)
  用户/助手消息     318 / 3271     工具调用 4411
  流式 chunk 事件   15185           注入(非用户)消息 294
  附件文件          335

■ ZIP 导出包  synth-chatgpt.zip
  推断 provider     openai-web
  命中特征: ✓ mapping 图  ✓ current_node  ✓ 隐藏消息标记  ✓ content_type
```

三个数字直接改变了设计：
- **1283 条 item 超过 32 KB**（最大 3.1 MB）→ 不做大负载外置，4.5 万条就能把库撑到几百 MB；
- **15,185 条流式 chunk 事件占 DSH 记录的 1/3** → 必须聚合或丢弃，否则存储与渲染双双爆炸；
- **477 MB 压缩 / 14.4 M 字符** → 全量导入是分钟级任务，需要并发 + 断点续传，不能做成「点一下转圈到天亮」。

---

## 开发与测试

```powershell
pnpm install
pnpm typecheck          # TypeScript 全仓类型检查
pnpm test               # vitest：适配器、store、core、CLI E2E

cd apps/ui_win
flutter test            # 阅读器 / 分享 / Markdown / 快照测试
```

`flutter test` 会同时刷新 `docs/ui/` 下的壳层快照，提交 UI 改动时请一并更新。

---

## 目录结构

```
SessionManager/
├─ apps/
│  ├─ cli/                  # sm CLI（TypeScript，Node 24）
│  └─ ui_win/               # Flutter Windows 阅读器
├─ packages/
│  ├─ shared/               # 契约、哈希、zstd、CJK 工具
│  ├─ store/                # SQLite schema、FTS5、raw/blobs 仓储
│  ├─ adapters/             # 各 provider 多态适配器
│  ├─ core/                 # 校验、查重、修订合并、差异报告
│  └─ fixtures/             # 合成夹具
├─ docs/                    # 设计文档、UI 规范与快照
├─ tools/                   # 格式探针（只读扫描，不上传任何数据）
├─ scripts/                 # Windows 便携版 / MSIX 打包脚本
└─ dist/                    # 本地打包产物（git 忽略）
```

---

## 版本号与发布

首个版本使用 Windows 安装包的四段式版本号 **`0.1.0.0`**，与 GitHub Release tag `v0.1.0.0` 对应；仓库内其他生态保持各自的版本格式：

| 位置 | 版本 |
|---|---|
| GitHub tag / Release | `v0.1.0.0` |
| MSIX `AppxManifest.xml` | `0.1.0.0` |
| `package.json`（npm 语义化版本，三段式） | `0.1.0` |
| `apps/ui_win/pubspec.yaml`（Dart `version+build`） | `0.1.0+1` |

发布流程：从 `main` 切 release 分支 → 开 PR 关联 issue → 合并 → 打 tag → 用 `scripts/build-win-msix.mjs` 构建并签名 MSIX → 创建 Release 并上传安装包与校验和。
