# Session Manager · 本地 AI 会话库

> 把散落在各家网页导出包、以及本地 Agent 运行日志里的对话，收进一个**原始不可变、可查重、可校验、带多媒体**的本地会话库。

当前状态：**架构重构与核心骨架阶段**（已包含完整设计文档、格式探针，以及 `packages/` 与 `apps/` 的多态会话引擎骨架）。

---

## 一页结论

| 问题 | 结论 |
|---|---|
| 是否已有同类项目 | 有大量「单一 provider 导出查看器」和几个「记忆中枢」，但**没有**同时做到：官方导出包 + 本地 Agent 日志 + 分支保真 + 重复导出查重/校验 + 多媒体。详见 [01-既有方案调研](docs/01-既有方案调研.md) |
| 产品形态与平台 | **CLI 核心优先（`sm` CLI）+ 简短轻量的桌面阅读器 UI（v1 仅限 Windows 端，macOS 后续再议）** |
| 技术栈 | **多态原生会话接口（`SessionDocument<TRaw>`：保留各 provider 原生结构，各自实现校验/哈希/投影方法）** + TypeScript 核心引擎（`shared` + `store` + `adapters` + `core` + `cli`）+ **CQRS 混合直连（Flutter Dart `sqlite3` FFI 只读直连 `archive.db` + `blobs/` 本地直读 + 按需单次调用 `sm` CLI `--json`）**；存储 SQLite（WAL + FTS5）+ 内容寻址 blob 仓库 |
| 为什么不是纯浏览器应用 | 需要读 `~/.codex`、`~/.claude`、`~/.dsh` 目录、处理 GB 级 zstd/JSON、做增量同步与后台任务，浏览器沙箱做不到 |
| 最大技术风险 | 各 provider 格式漂移（尤其 DeepSeek 与 Codex）；已用「探针 + 原生类型版本化适配器 + 原始层不动」把风险关进笼子 |
| MVP 工期 | **约 300 人时**（聚焦多态适配器、CLI 核心与轻量 Windows UI，去掉独立的跨格式重编码 OCA 规范包与多语言 codegen 负担），覆盖 OpenAI / Anthropic / DeepSeek 导出 + Codex / Claude Code / DSH 本地会话 + 同源查重校验 + 轻量阅读器 |
| 差异化 | ① 分支保真（保留 regenerate 的全部旁支）② 多次导出之间的**同源会话级查重与差异报告** ③ 网页对话与 Agent 轨迹保留原生类型并实现**同一套行为接口（按需投影为阅读 ViewModel 与 FTS 索引）** ④ 原始数据只读、可重建索引 |

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-既有方案调研.md](docs/01-既有方案调研.md) | 竞品/开源项目横评、可借鉴的具体机制、合规边界 |
| [docs/02-数据格式规范.md](docs/02-数据格式规范.md) | 6 个数据源的真实格式（部分在本机实测）、坑位、原生数据类型与统一 `SessionDocument` 行为接口规范 |
| [docs/03-架构设计.md](docs/03-架构设计.md) | 分层、技术选型对比、目录结构、简化后 SQLite Schema、同源查重/校验算法、搜索方案 |
| [docs/04-开发计划.md](docs/04-开发计划.md) | 里程碑、WBS 工时表、三种范围口径、风险登记表、路线图 |

---

## 已核实的格式事实（本机实测）

调研阶段已经在本机验证过几件会决定架构的事，避免方案建立在猜测上：

1. **Codex 的 rollout 是 zstd 压缩的**：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.zst`，单帧，Node 24 内置 `zlib.zstdDecompressSync` 可直接解。记录形如 `{timestamp, ordinal, type, payload}`，`type ∈ {session_meta, turn_context, response_item, event_msg}`。
2. **Codex 还有一份 SQLite 主存储**：`~/.codex/thread_history_1.sqlite`，本机 331.8 MiB / 203 个会话 / 45,231 条 item。`thread_items(item_json)` 里 `commandExecution` 平均 9.7 KB、`imageGeneration` 平均 **3 MB**（内联 base64）——这直接决定了必须做「大负载外置」。
3. **DSH 会话是多帧拼接的 zstd**：`.dsh/sessions/<enc-cwd>/<id>/session.v4.jsonl.zstd` 是「每次追加一个 zstd frame」的流。Node 内置 zstd 只能解第一帧（会抛 `Unknown frame descriptor`），必须用能处理连续帧的解码器（实测 `fzstd` 可完整解出 15.9 MB / 18,744 行）。且日志是**流式增量事件**（`assistant/chunk`、`reasoning-chunks`、`tool-call-chunks` 需要聚合）。
4. **Codex 自己就在用内容哈希做导入台账**：`.codex/external_agent_session_imports.json` 里记 `source_path + content_sha256 + imported_thread_id`——这正是本项目查重/幂等所采用的机制，算是官方背书。
5. **Claude Code 的本地会话路径**：`~/.claude/projects/<编码后的工作目录>/<uuid>.jsonl`（从上面那份导入台账里得到实证）。
6. **SQLite 中文检索不能只靠 `unicode61`**：实测 `unicode61` 对「会话管理」零命中，`trigram` 对 ≥3 字命中、2 字仍不命中——需要双索引或查询改写。

> 这些结论可以直接跑 `tools/probe-formats.mjs` 复现。

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

## 快速开始（格式探针）

```powershell
cd tools
pnpm install          # 只装一个依赖：fzstd（纯 JS，无原生编译）
node probe-formats.mjs --root "$env:USERPROFILE\.codex"
node probe-formats.mjs --root "$env:USERPROFILE\.dsh" --kind dsh
node probe-formats.mjs --zip "D:\downloads\chatgpt-export.zip"
```

输出每个数据源的文件数、会话数、事件类型分布、文本体量、内联二进制占比，用来校验适配器假设、以及估算索引体积。

---

## 目录结构（规划）

```
SessionManager/
├─ docs/                    # 设计文档（多态原生会话架构）
├─ tools/probe-formats.mjs  # 格式探针（只读扫描，不上传任何数据）
├─ scripts/                 # GitHub 计划同步等辅助脚本
├─ packages/                # shared, store, adapters, core, fixtures
└─ apps/                    # cli (`sm`), ui-win (Flutter + Dart sqlite3 FFI)
```
