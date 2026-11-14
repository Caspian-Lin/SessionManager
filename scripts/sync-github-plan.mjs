#!/usr/bin/env node
/**
 * scripts/sync-github-plan.mjs
 *
 * Automated script to synchronize SessionManager's Labels, Milestones (M0–M5),
 * and 24 structured Issues to GitHub via the `gh` CLI (or GitHub REST API).
 *
 * Usage:
 *   node scripts/sync-github-plan.mjs --repo <owner/repo> [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LABELS = [
  { name: 'arch:polymorphic', color: '0052CC', description: 'Polymorphic SessionDocument interface & native slice model' },
  { name: 'pkg:shared', color: '5319E7', description: 'Shared contracts, hashing, MinHash, zstd, and CJK utilities (@sm/shared)' },
  { name: 'pkg:store', color: '006B75', description: 'SQLite schema, FTS5, raw layer, and blob store (@sm/store)' },
  { name: 'pkg:adapters', color: '1D76DB', description: 'Provider export and local agent polymorphic adapters (@sm/adapters)' },
  { name: 'pkg:core', color: '0E8A16', description: 'Validation, deduplication, merge, and diff pipeline (@sm/core)' },
  { name: 'app:cli', color: 'FBCA04', description: 'sm CLI commands and terminal reporting (@sm/cli)' },
  { name: 'app:server', color: 'D93F0B', description: 'Local 127.0.0.1 HTTP API and media streaming (@sm/server)' },
  { name: 'app:ui-win', color: 'C2E0C6', description: 'Flutter Windows lightweight desktop reader (apps/ui-win)' },
  { name: 'testing', color: 'BFD4F2', description: 'Synthetic fixtures and golden ViewModel snapshot tests' },
  { name: 'P0-blocker', color: 'B60205', description: 'Critical path blocker for milestone completion' },
  { name: 'P1-core', color: 'D93F0B', description: 'Core MVP deliverable' },
  { name: 'P2-enhancement', color: '0E8A16', description: 'Quality of life or post-core enhancement' },
];

export const MILESTONES = [
  {
    key: 'M0',
    title: 'M0 · 骨架、多态接口与存储底座',
    description:
      '跑通 Monorepo 构建、@sm/shared 轻量化契约与五级哈希算法、简化版 SQLite Schema（含 raw_format/blocks_json，无独立 block/item_blob 表）+ Raw/Blob 存储层、以及 sm probe 格式探针命令。',
  },
  {
    key: 'M1',
    title: 'M1 · 网页导出包多态适配器（Web Exports）',
    description:
      '完成 SessionDocument<TRaw> 基类、Adapter SDK 及 OpenAI、Anthropic、DeepSeek 三家网页导出包与通用兜底适配器；支持流式大 JSON、分片、无扩展名 .dat 嗅探与未知格式结构学习器。',
  },
  {
    key: 'M2',
    title: 'M2 · 本地 Agent 会话多态适配器与增量同步',
    description:
      '打通本机 ~/.codex、~/.claude、~/.dsh 三大本地 Agent 会话源并实现 SessionDocument 统一接口，支持 >32KB 大负载外置、多帧 zstd 解码、流式 chunk 聚合与增量水位同步。',
  },
  {
    key: 'M3',
    title: 'M3 · 查重、校验、修订合并与原生归档导出（核心差异化）',
    description:
      '完成由 SessionDocument 多态方法驱动的 validate -> dedupe -> merge 流水线、同源优先四级查重 + MinHash(128) LSH 候选、结构完整性校验、跨批次差异报告（捕获内容缩短）与 native/md/jsonl 导出。',
  },
  {
    key: 'M4',
    title: 'M4 · 中英文双索引全文检索与会话治理',
    description:
      '实现 SQLite FTS5 双索引（unicode61 + trigram）与查询路由器，解决中文 2 字/3+ 字与中英混合检索召回，提供项目归类、标签、星标与软删除清理。',
  },
  {
    key: 'M5',
    title: 'M5 · 本地 HTTP Server 与 Flutter Windows 轻量桌面阅读器',
    description:
      '提供绑定 127.0.0.1 的本地安全 HTTP API（直接输出 ConversationViewModel JSON DTO）与 Flutter (Dart) 原生编译 Windows 桌面端（与 Chatea 共用视觉外壳与消息分支树组件）。',
  },
];

export const ISSUES = [
  // M0
  {
    milestone: 'M0',
    title: '[M0][arch:polymorphic] 制定多态 SessionDocument<TRaw> 契约与 @sm/shared 视图模型类型',
    labels: ['arch:polymorphic', 'pkg:shared', 'P0-blocker'],
    body: `### 背景与目标
移除独立的 \`@sm/oca\` 跨格式重编码标准包；保留各 provider 原生数据结构，通过统一行为接口 \`SessionDocument<TRaw>\`（校验、指纹、检索切片、按需投影 \`ConversationViewModel\`）完成多来源统一治理。

### 任务拆解
- [x] 在 \`packages/shared/src/types.ts\` 定义轻量化视图与报告契约（\`SessionMeta\`, \`ViewNode\`, \`ViewBlock\`, \`SearchChunk\`, \`ConversationViewModel\`, \`BlobAsset\`, \`IntegrityReport\`, \`NativeArchiveManifest\`）
- [x] 定义正交 \`role\` × \`kind\` 枚举与 \`isSynthetic\` / \`isHidden\` / \`isActiveBranch\` 标记
- [x] 在 \`packages/adapters/src/contract.ts\` 定义 \`SessionDocument<TRaw>\` 与 \`BaseSessionDocument<TRaw>\` 抽象基类`,
  },
  {
    milestone: 'M0',
    title: '[M0][pkg:shared] 实现确定性文本归一化、Turn 语义哈希、Merkle 根与 MinHash(128) 算法',
    labels: ['pkg:shared', 'P0-blocker'],
    body: `### 背景与目标
同源及近似查重准确率取决于归一化与指纹规范。在零运行时依赖的 \`@sm/shared\` 中统一实现无副作用的确定性哈希算法。

### 任务拆解
- [x] 实现 \`normalizeText\`（CRLF 统一、空行折叠、剥离 ANSI 转义序列、Unicode NFC、剔除易变时间戳前缀）
- [x] 实现 \`computeTurnSemanticHash\`、\`computeSessionHeadHash\` 与 \`computeSessionMerkleRoot\`
- [x] 实现 \`computeMinHash128\`（128 维 FNV-1a 多随机种子签名）、\`estimateMinHashSimilarity\` 与 \`computeLshBands\``,
  },
  {
    milestone: 'M0',
    title: '[M0][pkg:shared] 实现流式工具集：单帧/多帧自适应 Zstd 解码器、大 JSON 数组流式 Splitter 与 CJK 检测',
    labels: ['pkg:shared', 'P1-core'],
    body: `### 背景与目标
本机实测 DSH 日志为多帧拼接 zstd（Node 内置 \`zlib.zstdDecompressSync\` 仅能解单帧），OpenAI 导出单 JSON 可达 300MB+。

### 任务拆解
- [x] 实现 \`decompressZstd\`：检测魔数 \`0xFD2FB528\`，优先使用 \`fzstd\` 解码多帧流，兼容单帧回退
- [x] 实现顶层 JSON 数组流式分片器 \`streamTopLevelJsonArray\` 与 JSONL 行迭代器 \`iterJsonLines\`
- [x] 实现 CJK 字符检测与查询分类器 \`classifySearchQuery\`（\`cjk_short\` / \`cjk_trigram\` / \`latin\` / \`mixed\`）`,
  },
  {
    milestone: 'M0',
    title: '[M0][pkg:store] 实现简化 SQLite 连接层、001_init 迁移（无独立 block 表）与 DAO 仓储基类',
    labels: ['pkg:store', 'P0-blocker'],
    body: `### 背景与目标
落地 \`docs/03-架构设计.md\` §5 定义的简化版 SQLite 数据库 Schema：取消重型的 \`block\` 与 \`item_blob\` 独立关系表，改为 \`conversation(raw_format, raw_blob_sha256)\` + \`item(tool_name, blocks_json)\` 切片索引。

### 任务拆解
- [x] 编写 \`001_init.sql\` 与 \`schema-sql.ts\`（\`meta\`, \`account\`, \`import_batch\`, \`import_file\`, \`project\`, \`tag\`, \`conversation\`, \`conversation_revision\`, \`item\`, \`blob\`, \`dedupe_candidate\`）
- [x] 编写双 FTS5 虚拟表（\`item_fts_uni\` 含 \`text, tool_name\`, \`item_fts_tri\`, \`conv_fts_tri\`）及直接基于 \`item\` 的同步触发器
- [x] 实现 \`ArchiveDatabase\` 连接管理与外部 SQLite 只读打开策略（供 \`codex-local\` 读取正在写入的 \`thread_history_*.sqlite\`）`,
  },
  {
    milestone: 'M0',
    title: '[M0][pkg:store] 实现只读原始层 (raw/) 与内容寻址媒体库 (blobs/ + >32KB Spill + 魔数嗅探)',
    labels: ['pkg:store', 'P1-core'],
    body: `### 背景与目标
确保原始导出文件及单会话原生载荷不可变（按 SHA-256 落盘），并将 >32KB 大对象与内联 Base64 媒体剥离到内容寻址 \`blobs/\` 目录。

### 任务拆解
- [x] 实现 \`RawStore.persistRaw\`：落盘至 \`raw/<provider>/<sha256前缀>/<文件名>\` 并计算 SHA-256
- [x] 实现 \`BlobStore\`：按 \`blobs/<2位前缀>/<sha256><ext>\` 去重存储（支持 \`raw_session\` 原生快照及媒体附件）
- [x] 实现魔数嗅探器 \`sniffMimeAndExt\`（识别 PNG/JPEG/WebP/GIF/PDF/MP4/JSON，解决 OpenAI \`.dat\` 无扩展名问题）
- [x] 实现 \`spillPayload\`：将 >32KB 工具输出或内联 base64 自动外置为 \`BlobAsset\``,
  },
  {
    milestone: 'M0',
    title: '[M0][app:cli] 搭建 sm CLI 骨架并收编产品化 sm probe 格式探针命令',
    labels: ['app:cli', 'P1-core'],
    body: `### 背景与目标
将 \`tools/probe-formats.mjs\` 的探测能力整合进核心 CLI \`sm probe\`，搭建完整子命令路由。

### 任务拆解
- [x] 搭建 \`apps/cli\` 入口，支持 \`sm probe|import|ls|show|search|verify|dedupe|export|reindex|serve\`
- [ ] 对接完整 \`AdapterRegistry.probeSource\` 与 \`ImportPipeline\`，支持多源目录与 ZIP 包端到端导入`,
  },

  // M1
  {
    milestone: 'M1',
    title: '[M1][pkg:adapters] 实现多态 Adapter SDK（SessionDocument 基类、Registry、ParseCtx 与结构学习器）',
    labels: ['pkg:adapters', 'arch:polymorphic', 'P0-blocker'],
    body: `### 背景与目标
统一所有适配器的 \`probe -> plan -> parse -> SessionDocument<TRaw>[]\` 生命周期，并保留各自原生数据类型 \`TRaw\`。

### 任务拆解
- [x] 定义 \`SessionDocument<TRaw>\`, \`BaseSessionDocument<TRaw>\`, \`Adapter<TRaw>\`, \`ProbeResult\`, \`ImportTask\`, \`ParseCtx\` 契约
- [x] 实现 \`AdapterRegistry\` 按特征与置信度自动路由源目录/文件
- [x] 实现 \`learnJsonSchemaSummary\`：抽样未知 JSON 数组前 50 项推断候选 \`role/content\` 键，生成脱敏结构摘要`,
  },
  {
    milestone: 'M1',
    title: '[M1][pkg:adapters] 实现 openai-web 适配器（OpenAiNativeConversation、mapping 图与 .dat 资产对齐）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [x] 定义 \`OpenAiNativeConversation\` 原生类型与 \`OpenAiSessionDocument\` 多态实现类
- [ ] 支持 \`conversations.json\` 及 \`conversations-000.json\` 多分片流式 ZIP 读取
- [x] 解析 \`mapping\` 图结构，从 \`current_node\` 回溯标记 \`isActiveBranch = true\`，保留全部 regenerate 旁支
- [ ] 对齐 \`file-service://file-xxx\` 与包内 \`.dat\` / 图片文件；提取 \`about_user_message\` 记忆候选`,
  },
  {
    milestone: 'M1',
    title: '[M1][pkg:adapters] 实现 anthropic-web 适配器（AnthropicNativeConversation、content[] 块与 memories/projects）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [x] 定义 \`AnthropicNativeConversation\` 与 \`AnthropicSessionDocument\` 多态实现类
- [x] 优先解析 \`chat_messages[].content[]\`（\`text\`, \`thinking\`, \`tool_use\`, \`tool_result\`）并在仅含降级 \`text\` 不一致时在 \`validate()\` 中给出告警
- [x] 将 \`sender: "human"\` 映射为 \`role: "user"\`，合成线性父指针链
- [ ] 完整接入导出包内 \`attachments[].extracted_content\` 与 \`memories.json\` / \`projects.json\``,
  },
  {
    milestone: 'M1',
    title: '[M1][pkg:adapters] 实现 deepseek-web 适配器与 generic-json / generic-md 兜底适配器',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [x] 定义 \`DeepSeekNativeConversation\` / \`DeepSeekSessionDocument\` 与 \`GenericNativeSession\` / \`GenericSessionDocument\`
- [ ] 用真实 DeepSeek 官方导出包校准探针特征与 \`reasoning_content\` / 树状映射细节
- [ ] 完善 \`generic-json\` / \`generic-md\` 启发式解析与原始字节外置兜底`,
  },
  {
    milestone: 'M1',
    title: '[M1][testing] 构建网页导出合成夹具（Fixtures）与黄金 ConversationViewModel 快照回归测试',
    labels: ['testing', 'P1-core'],
    body: `### 任务拆解
- [ ] 在 \`packages/fixtures\` 中构建 OpenAI（含旁支、孤儿节点、隐藏消息）、Anthropic（含 thinking/tool_use）、DeepSeek 合成样本
- [ ] 编写黄金快照回归测试，验证各适配器 \`SessionDocument.toViewModel()\` 与 \`getFingerprint()\` 稳定性`,
  },

  // M2
  {
    milestone: 'M2',
    title: '[M2][pkg:adapters] 实现 codex-local 多态适配器（thread_history SQLite + rollout.jsonl.zst 双源对齐）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [x] 定义 \`CodexNativeSession\` 与 \`CodexSessionDocument\`（保留 \`sessionMeta\` / \`events\` / \`items\` 原生字段）
- [ ] 只读方式打开 \`~/.codex/thread_history_*.sqlite\`，结合 \`session_index.jsonl\` 与 \`rollout-*.jsonl.zst\` 双源对齐
- [ ] 将 \`commandExecution\`、\`mcpToolCall\`、\`fileChange\`、\`imageGeneration\`（内联 base64 >32KB）自动外置到 \`blobs/\``,
  },
  {
    milestone: 'M2',
    title: '[M2][pkg:adapters] 实现 claude-code-local 多态适配器（parentUuid 树、isSidechain 子线程与坏尾行容错）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [x] 定义 \`ClaudeCodeNativeSession\` 与 \`ClaudeCodeSessionDocument\`
- [ ] 扫描 \`~/.claude/projects/<encoded-cwd>/*.jsonl\`，按 \`sessionId\` 合并跨文件续写会话
- [x] 还原 \`parentUuid\` 树结构，标记 \`isSidechain: true\`，并将仅含 \`tool_result\` 的 \`type: "user"\` 修正为 \`role: "tool"\`；容忍尾行截断`,
  },
  {
    milestone: 'M2',
    title: '[M2][pkg:adapters] 实现 dsh-local 多态适配器（多帧 zstd 解码、流式 chunk 事件聚合与 synthetic 过滤）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [x] 定义 \`DshNativeSession\` 与 \`DshSessionDocument\`
- [ ] 使用 \`fzstd\` 解码 \`~/.dsh/sessions/<cwd>/<id>/session.v4.jsonl.zstd\` 连续多帧流并关联 \`~/.dsh/attachments/\`
- [x] 聚合流式 \`assistant/chunk\`、\`reasoning-chunks\`、\`tool-call-chunks\` 事件，并将 \`agent/inbox/spliced\`、\`compaction/*\`、\`command/run\` 标记为 \`isSynthetic = true\``,
  },
  {
    milestone: 'M2',
    title: '[M2][pkg:core] 实现本地会话目录的增量水位同步机制（mtime + size + sha256 + ordinal 游标）',
    labels: ['pkg:core', 'P2-enhancement'],
    body: `### 任务拆解
- [ ] 基于 \`import_file(rel_path, size, mtime, sha256)\` 与 Codex \`next_rollout_ordinal\` / DSH \`seq\` 跳过未变更文件与已处理记录`,
  },

  // M3
  {
    milestone: 'M3',
    title: '[M3][pkg:core] 实现同源优先的四级查重引擎（Batch SHA256 → External ID → Merkle Root → MinHash LSH）',
    labels: ['pkg:core', 'arch:polymorphic', 'P0-blocker'],
    body: `### 任务拆解
- [ ] L0 文件/批次 SHA-256 幂等拦截
- [x] 实现 \`decideConversationMerge\`：按 \`doc.getMergeKey()\` 与 \`doc.getFingerprint()\` 做 L1 \`(provider, external_id)\`、L2 \`head_hash + content_hash\`、L3/L4 MinHash(128) LSH（≥0.90 自动合并 / 0.75–0.90 进 \`dedupe_candidate\`）`,
  },
  {
    milestone: 'M3',
    title: '[M3][pkg:core] 实现会话修订（Revision）合并策略与分支冲突保留（superseded_by）',
    labels: ['pkg:core', 'P1-core'],
    body: `### 任务拆解
- [ ] 处理「完全一致（仅更新 \`last_batch_id\`）」「超集追加（追加新 Item 并生成新 \`conversation_revision\`）」
- [ ] 处理「同 ID 内容被修改」：保留旧版 Item（置 \`is_active_branch = 0\` 并记录 \`superseded_by\`），在 \`diff_json\` 中记录增删改哈希`,
  },
  {
    milestone: 'M3',
    title: '[M3][pkg:core] 实现多态结构完整性校验与跨批次增量差异报告（捕获「内容缩短」与「上游已删除」）',
    labels: ['pkg:core', 'P1-core'],
    body: `### 任务拆解
- [x] 通过 \`doc.validate()\` 汇总原生结构问题，并实现 \`buildBatchDiffStats\` 统计新增、增长、**内容缩短（\`shrunk_conversations\`）** 与相同会话数
- [ ] 接入 SQLite 持久批次历史比对与 \`verify-report.json\` / \`verify-report.md\` 导出`,
  },
  {
    milestone: 'M3',
    title: '[M3][app:cli] 实现 sm export（支持原生归档清单 native、Markdown Vault、JSONL 导出）',
    labels: ['app:cli', 'pkg:core', 'P1-core'],
    body: `### 任务拆解
- [x] 在 \`@sm/core\` 与 \`apps/cli\` 实现 \`sm export --format native\`：输出 \`native-manifest.json\` + \`sessions.json\`（含 \`raw_format\` / \`raw_blob_sha256\` 原生定位信息）+ \`blobs/\`
- [x] 支持 \`--format md\`（Markdown 逃生舱）与 \`--format jsonl\``,
  },

  // M4
  {
    milestone: 'M4',
    title: '[M4][pkg:store] 实现 FTS5 双索引（unicode61 + trigram）、查询路由器与 BM25 加权排序',
    labels: ['pkg:store', 'pkg:core', 'P1-core'],
    body: `### 任务拆解
- [ ] 实现查询路由：纯拉丁词走 \`item_fts_uni\`（同步索引 \`text\` 与 \`item.tool_name\`），≥3 字中文走 \`item_fts_tri\`，1–2 字中文走受限 \`LIKE\`，混合查询双表融合
- [ ] 实现排序公式：\`bm25() + 0.15 * role_boost(user) + 0.1 * recency_decay\`，默认降权 \`is_synthetic = 1\`
- [ ] 实现 \`sm reindex\` 批量重建命令`,
  },
  {
    milestone: 'M4',
    title: '[M4][pkg:core] 实现项目自动归类（按 cwd/repo）、标签管理、星标收藏与软删除 Vacuum',
    labels: ['pkg:core', 'app:cli', 'P2-enhancement'],
    body: `### 任务拆解
- [ ] 根据本地 Agent 的 \`cwd\` 自动提取/关联 \`project\` 表（排除 \`C:\\Windows\\System32\` 等系统目录噪声）
- [ ] 实现 \`sm ls\` 筛选、标签增删、星标切换与软删除清理`,
  },

  // M5
  {
    milestone: 'M5',
    title: '[M5][app:server] 实现本地 HTTP Server（127.0.0.1 绑定、一次性 Token 鉴权、Range 媒体流协议）',
    labels: ['app:server', 'P1-core'],
    body: `### 任务拆解
- [x] 严格绑定 \`127.0.0.1\` 随机或指定端口，启动生成一次性随机 Token，校验 \`X-SM-Token\` 与 \`Origin\`
- [x] 提供 \`/api/conversations\`（keyset 分页）、\`/api/conversations/:id\`（从 \`item.blocks_json\` 直接返回视图树）、\`/api/search\`、\`/api/batches/:id/report\` 与 \`/blobs/:sha256\`（Range 流）`,
  },
  {
    milestone: 'M5',
    title: '[M5][app:ui-win] 搭建 Flutter Windows 桌面端骨架、进程托管（自动拉起 sm serve）与虚拟化会话列表',
    labels: ['app:ui-win', 'P1-core'],
    body: `### 任务拆解
- [ ] 基于 Flutter Windows 端消费 \`sm serve\` 提供的轻量化 \`ConversationViewModel\` JSON DTO，并与 \`Chatea\` 复用视觉风格
- [ ] 启动时自动拉起 \`sm serve\` 子进程并读取一次性 Token
- [ ] 实现虚拟化高帧率会话列表（支持按来源徽标、项目、时间、星标过滤）`,
  },
  {
    milestone: 'M5',
    title: '[M5][app:ui-win] 实现会话分支树阅读器、Agent 轨迹折叠视图与查重差异报告面板，完成 Windows 便携版打包',
    labels: ['app:ui-win', 'P1-core'],
    body: `### 任务拆解
- [ ] 实现会话树分支切换器（可视化切换 regenerate 旁支）与 \`is_synthetic\` 注入节点默认折叠
- [ ] 实现 Agent 工具调用、代码高亮、LaTeX 与本地媒体预览渲染
- [ ] 实现「查重与批次差异报告」视图（一键高亮展示「内容缩短」会话与疑似重复双栏对比）
- [ ] 编写 Windows 便携版打包脚本`,
  },
];

function parseArgs(argv) {
  const opts = { repo: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i] ?? null;
    else if (a === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

function runGh(args, dryRun = false) {
  if (dryRun) {
    console.log(`[dry-run] gh ${args.join(' ')}`);
    return '';
  }
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function canUseGh() {
  try {
    execFileSync('gh', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function resolveGitHubToken() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken && envToken.trim()) {
    return envToken.trim();
  }
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('password=')) {
        const token = line.slice('password='.length).trim();
        if (token) return token;
      }
    }
  } catch {
    // ignore credential helper errors
  }
  throw new Error(
    'Unable to authenticate with GitHub: `gh auth status` failed and no token found via GITHUB_TOKEN/GH_TOKEN or `git credential fill`.'
  );
}

async function githubRest(token, method, apiPath, body) {
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'SessionManager-SyncScript',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  if (!res.ok) {
    const err = new Error(`GitHub API ${method} ${apiPath} failed (${res.status}): ${text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function syncViaRest(repo, token) {
  // 1. Sync Labels (rename legacy pkg:oca -> arch:polymorphic if present)
  const existingLabels = (await githubRest(token, 'GET', `/repos/${repo}/labels?per_page=100`)) ?? [];
  const labelNames = new Set(existingLabels.map((l) => l.name));

  if (labelNames.has('pkg:oca') && !labelNames.has('arch:polymorphic')) {
    const target = LABELS.find((l) => l.name === 'arch:polymorphic');
    if (target) {
      await githubRest(token, 'PATCH', `/repos/${repo}/labels/${encodeURIComponent('pkg:oca')}`, {
        new_name: target.name,
        color: target.color,
        description: target.description,
      });
      labelNames.delete('pkg:oca');
      labelNames.add('arch:polymorphic');
      console.log('  ✓ Label renamed: pkg:oca -> arch:polymorphic');
    }
  }

  for (const label of LABELS) {
    if (labelNames.has(label.name)) {
      await githubRest(token, 'PATCH', `/repos/${repo}/labels/${encodeURIComponent(label.name)}`, {
        new_name: label.name,
        color: label.color,
        description: label.description,
      });
      console.log(`  ✓ Label updated: ${label.name}`);
    } else {
      try {
        await githubRest(token, 'POST', `/repos/${repo}/labels`, {
          name: label.name,
          color: label.color,
          description: label.description,
        });
        console.log(`  ✓ Label: ${label.name}`);
      } catch (e) {
        if (e.status === 422) {
          await githubRest(token, 'PATCH', `/repos/${repo}/labels/${encodeURIComponent(label.name)}`, {
            new_name: label.name,
            color: label.color,
            description: label.description,
          });
          console.log(`  ✓ Label updated: ${label.name}`);
        } else {
          throw e;
        }
      }
    }
  }

  // 2. Sync Milestones (update in place when matching key prefix like "M0")
  const existingMilestones = (await githubRest(token, 'GET', `/repos/${repo}/milestones?state=all&per_page=100`)) ?? [];
  const milestoneNumbers = new Map();

  for (const m of MILESTONES) {
    const found = existingMilestones.find(
      (em) => em.title === m.title || em.title.startsWith(`${m.key} `) || em.title.startsWith(`${m.key}·`)
    );
    if (found) {
      await githubRest(token, 'PATCH', `/repos/${repo}/milestones/${found.number}`, {
        title: m.title,
        description: m.description,
        state: 'open',
      });
      milestoneNumbers.set(m.key, found.number);
      console.log(`  ✓ Updated milestone: ${m.title} (#${found.number})`);
      continue;
    }
    const created = await githubRest(token, 'POST', `/repos/${repo}/milestones`, {
      title: m.title,
      description: m.description,
      state: 'open',
    });
    milestoneNumbers.set(m.key, created.number);
    console.log(`  ✓ Created milestone: ${m.title} (#${created.number})`);
  }

  // 3. Sync Issues (update existing #1..#24 in place by exact title or milestone-scoped ordinal fallback)
  const existingIssues = (await githubRest(token, 'GET', `/repos/${repo}/issues?state=all&per_page=100`)) ?? [];
  const nonPrIssues = existingIssues.filter((ei) => !ei.pull_request).sort((a, b) => a.number - b.number);

  for (let idx = 0; idx < ISSUES.length; idx++) {
    const issue = ISSUES[idx];
    const targetNumber = idx + 1;
    const found =
      nonPrIssues.find((ei) => ei.title === issue.title) ??
      nonPrIssues.find(
        (ei) => ei.number === targetNumber && ei.title.startsWith(`[${issue.milestone}]`)
      );
    const milestoneNum = milestoneNumbers.get(issue.milestone);
    if (found) {
      await githubRest(token, 'PATCH', `/repos/${repo}/issues/${found.number}`, {
        title: issue.title,
        body: issue.body,
        milestone: milestoneNum,
        labels: issue.labels,
      });
      console.log(`  ✓ Updated issue #${found.number}: ${issue.title}`);
      continue;
    }
    const created = await githubRest(token, 'POST', `/repos/${repo}/issues`, {
      title: issue.title,
      body: issue.body,
      milestone: milestoneNum,
      labels: issue.labels,
    });
    console.log(`  ✓ Created issue: ${issue.title} (#${created.number} - ${created.html_url})`);
  }
}

async function main() {
  const { repo, dryRun } = parseArgs(process.argv.slice(2));
  if (!repo) {
    console.error('Usage: node scripts/sync-github-plan.mjs --repo <owner/repo> [--dry-run]');
    process.exit(1);
  }

  console.log(`Syncing ${LABELS.length} labels, ${MILESTONES.length} milestones, and ${ISSUES.length} issues to ${repo}...`);

  if (!dryRun && !canUseGh()) {
    console.log('gh CLI not authenticated; falling back to GitHub REST API via git credential fill / env token...');
    const token = resolveGitHubToken();
    await syncViaRest(repo, token);
    console.log('Done!');
    return;
  }

  // 1. Sync Labels
  if (!dryRun) {
    try {
      runGh(['api', '--method', 'PATCH', `repos/${repo}/labels/pkg%3Aoca`, '-f', 'new_name=arch:polymorphic']);
      console.log('  ✓ Label renamed: pkg:oca -> arch:polymorphic');
    } catch {
      // ignore if pkg:oca does not exist or arch:polymorphic already exists
    }
  }
  for (const label of LABELS) {
    try {
      runGh(
        ['label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description, '--force'],
        dryRun
      );
      console.log(`  ✓ Label: ${label.name}`);
    } catch (e) {
      console.warn(`  ⚠ Label ${label.name}: ${e.message}`);
    }
  }

  // 2. Sync Milestones via GitHub API
  const milestoneNumbers = new Map();
  let existingMilestones = [];
  if (!dryRun) {
    try {
      const raw = runGh(['api', `repos/${repo}/milestones?state=all&per_page=100`]);
      existingMilestones = JSON.parse(raw);
    } catch {
      existingMilestones = [];
    }
  }

  for (const m of MILESTONES) {
    const found = existingMilestones.find(
      (em) => em.title === m.title || em.title.startsWith(`${m.key} `) || em.title.startsWith(`${m.key}·`)
    );
    if (found) {
      if (!dryRun) {
        runGh([
          'api',
          '--method',
          'PATCH',
          `repos/${repo}/milestones/${found.number}`,
          '-f',
          `title=${m.title}`,
          '-f',
          `description=${m.description}`,
          '-f',
          'state=open',
        ]);
      }
      milestoneNumbers.set(m.key, found.number);
      console.log(`  ✓ Updated milestone: ${m.title} (#${found.number})`);
      continue;
    }
    if (dryRun) {
      milestoneNumbers.set(m.key, m.title);
      console.log(`  [dry-run] Create milestone: ${m.title}`);
    } else {
      const createdRaw = runGh([
        'api',
        '--method',
        'POST',
        `repos/${repo}/milestones`,
        '-f',
        `title=${m.title}`,
        '-f',
        `description=${m.description}`,
      ]);
      const created = JSON.parse(createdRaw);
      milestoneNumbers.set(m.key, created.number);
      console.log(`  ✓ Created milestone: ${m.title} (#${created.number})`);
    }
  }

  // 3. Sync Issues
  let existingIssues = [];
  if (!dryRun) {
    try {
      const raw = runGh(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--json', 'title,number']);
      existingIssues = JSON.parse(raw);
    } catch {
      existingIssues = [];
    }
  }

  for (let idx = 0; idx < ISSUES.length; idx++) {
    const issue = ISSUES[idx];
    const targetNumber = idx + 1;
    const found =
      existingIssues.find((ei) => ei.title === issue.title) ??
      existingIssues.find(
        (ei) => ei.number === targetNumber && ei.title.startsWith(`[${issue.milestone}]`)
      );
    const milestoneNum = milestoneNumbers.get(issue.milestone);
    if (found) {
      if (!dryRun) {
        const patchPayload = JSON.stringify({
          title: issue.title,
          body: issue.body,
          ...(typeof milestoneNum === 'number' ? { milestone: milestoneNum } : {}),
          labels: issue.labels,
        });
        execFileSync(
          'gh',
          ['api', '--method', 'PATCH', `repos/${repo}/issues/${found.number}`, '--input', '-'],
          { input: patchPayload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
      }
      console.log(`  ✓ Updated issue #${found.number}: ${issue.title}`);
      continue;
    }
    const milestoneTitle = MILESTONES.find((m) => m.key === issue.milestone)?.title;
    const args = ['issue', 'create', '--repo', repo, '--title', issue.title, '--body', issue.body];
    if (milestoneTitle) {
      args.push('--milestone', milestoneTitle);
    }
    for (const l of issue.labels) {
      args.push('--label', l);
    }
    const out = runGh(args, dryRun);
    console.log(`  ✓ Created issue: ${issue.title} ${out ? `(${out})` : ''}`);
  }

  console.log('Done!');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
