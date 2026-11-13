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
  { name: 'pkg:oca', color: '0052CC', description: 'Open Conversation Archive standard & schema (@sm/oca)' },
  { name: 'pkg:shared', color: '5319E7', description: 'Shared streaming, zstd, and CJK utilities (@sm/shared)' },
  { name: 'pkg:store', color: '006B75', description: 'SQLite schema, FTS5, raw layer, and blob store (@sm/store)' },
  { name: 'pkg:adapters', color: '1D76DB', description: 'Provider export and local agent adapters (@sm/adapters)' },
  { name: 'pkg:core', color: '0E8A16', description: 'Validation, deduplication, merge, and diff pipeline (@sm/core)' },
  { name: 'app:cli', color: 'FBCA04', description: 'sm CLI commands and terminal reporting (@sm/cli)' },
  { name: 'app:server', color: 'D93F0B', description: 'Local 127.0.0.1 HTTP API and media streaming (@sm/server)' },
  { name: 'app:ui-win', color: 'C2E0C6', description: 'Flutter Windows lightweight desktop reader (apps/ui-win)' },
  { name: 'testing', color: 'BFD4F2', description: 'Synthetic fixtures and golden snapshot tests' },
  { name: 'P0-blocker', color: 'B60205', description: 'Critical path blocker for milestone completion' },
  { name: 'P1-core', color: 'D93F0B', description: 'Core MVP deliverable' },
  { name: 'P2-enhancement', color: '0E8A16', description: 'Quality of life or post-core enhancement' },
];

export const MILESTONES = [
  {
    key: 'M0',
    title: 'M0 · 骨架、OCA 标准与存储底座',
    description:
      '跑通 Monorepo 构建、@sm/oca v1 JSON Schema 与 TS/Dart/Go 类型生成、五级哈希算法、SQLite Schema + Raw/Blob 存储层、以及 sm probe 格式探针命令。',
  },
  {
    key: 'M1',
    title: 'M1 · 网页导出包适配器（Web Exports）',
    description:
      '完成 Adapter SDK 及 OpenAI、Anthropic、DeepSeek 三家网页导出包与通用兜底适配器；支持流式大 JSON、分片、无扩展名 .dat 嗅探与未知格式结构学习器。',
  },
  {
    key: 'M2',
    title: 'M2 · 本地 Agent 会话适配器与增量同步',
    description:
      '打通本机 ~/.codex、~/.claude、~/.dsh 三大本地 Agent 会话源，支持 >32KB 大负载外置、多帧 zstd 解码、流式 chunk 聚合与增量水位同步。',
  },
  {
    key: 'M3',
    title: 'M3 · 查重、校验、修订合并与 OCA 导出（核心差异化）',
    description:
      '完成 validate -> dedupe -> merge 治理流水线、四级查重 + MinHash(128) LSH 候选、12 项完整性校验、跨批次增量差异报告（捕获内容缩短）与 Chatea 互通导出。',
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
      '提供绑定 127.0.0.1 的本地安全 HTTP API 与 Flutter (Dart) 原生编译 Windows 桌面端（与 Chatea 共用视觉外壳与消息分支树组件）。',
  },
];

export const ISSUES = [
  // M0
  {
    milestone: 'M0',
    title: '[M0][pkg:oca] 制定 OCA v1 JSON Schema 规范与多语言类型生成器 (TS/Dart/Go)',
    labels: ['pkg:oca', 'P0-blocker'],
    body: `### 背景与目标
定义 \`@sm/oca\`（Open Conversation Archive v1）唯一真源 Schema，通过三级扩展机制（Level 1 核心强类型列 + Level 2 \`ext.<provider>\` 命名空间 + Level 3 \`ext._unmapped\` / \`payload_ref\` 兜底）兼容各家异构字段且零数据丢失。

### 任务拆解
- [x] 编写 \`packages/oca/schemas/v1/oca.schema.json\`（覆盖 \`OcaConversation\`, \`OcaItem\`, \`OcaBlock\`, \`OcaBlob\`, \`OcaIntegrityReport\`）
- [x] 定义正交 \`role\` × \`kind\` 枚举与 \`is_synthetic\` / \`is_hidden\` / \`is_active_branch\` 标记
- [x] 编写 \`scripts/codegen-oca.mjs\` 生成 Dart（供 \`apps/ui-win\` 与 \`Chatea\` 复用）与 Go（供 \`Chatea\` 服务端消费）模型代码

### 验收标准
- \`node scripts/codegen-oca.mjs\` 成功生成无语法错误的 Dart 与 Go 模型定义`,
  },
  {
    milestone: 'M0',
    title: '[M0][pkg:oca] 实现 OCA 确定性文本归一化、Item 语义哈希、Merkle 根与 MinHash(128) 算法',
    labels: ['pkg:oca', 'P0-blocker'],
    body: `### 背景与目标
查重准确率取决于哈希规范。需在 \`@sm/oca\` 中实现无副作用的确定性五级哈希与树拓扑校验修复器。

### 任务拆解
- [x] 实现 \`normalizeText\`（CRLF 统一、空行折叠、剥离 ANSI 转义序列、Unicode NFC、剔除易变时间戳前缀）
- [x] 实现 \`computeItemSemanticHash\` 与 \`computeConversationMerkleRoot\`
- [x] 实现 \`computeMinHash128\`（128 维 FNV-1a 多随机种子签名）、\`estimateMinHashSimilarity\` 与 \`computeLshBands\`
- [x] 实现 \`validateAndNormalizeDraft\`（孤儿节点挂根、环检测断边、>32KB 未外置告警、首条用户消息生成默认标题）`,
  },
  {
    milestone: 'M0',
    title: '[M0][pkg:shared] 实现流式工具集：单帧/多帧自适应 Zstd 解码器、大 JSON 数组流式 Splitter 与 CJK 检测',
    labels: ['pkg:shared', 'P1-core'],
    body: `### 背景与目标
本机实测 DSH 日志为多帧拼接 zstd（Node 内置 \`zlib.zstdDecompressSync\` 仅能解单帧），OpenAI 导出单 JSON 可达 300MB+。

### 任务拆解
- [ ] 实现 \`decompressZstd\`：检测魔数 \`0xFD2FB528\`，优先使用 \`fzstd\` 解码多帧流，兼容单帧回退
- [ ] 实现顶层 JSON 数组流式分片器 \`streamTopLevelJsonArray\` 与 JSONL 行迭代器 \`iterJsonLines\`
- [ ] 实现 CJK 字符检测与查询分类器 \`classifySearchQuery\`（\`cjk_short\` / \`cjk_trigram\` / \`latin\` / \`mixed\`）`,
  },
  {
    milestone: 'M0',
    title: '[M0][pkg:store] 实现 SQLite 连接层、001_init Schema 迁移与 DAO 仓储基类',
    labels: ['pkg:store', 'P0-blocker'],
    body: `### 背景与目标
落地 \`docs/03-架构设计.md\` §5 定义的 SQLite 数据库 Schema，支持 WAL 模式与外部数据库只读安全访问。

### 任务拆解
- [ ] 编写 \`001_init.sql\` 迁移脚本（\`meta\`, \`account\`, \`import_batch\`, \`import_file\`, \`project\`, \`tag\`, \`conversation\`, \`conversation_revision\`, \`item\`, \`block\`, \`blob\`, \`item_blob\`, \`dedupe_candidate\`）
- [ ] 编写双 FTS5 虚拟表（\`item_fts_uni\`, \`item_fts_tri\`, \`conv_fts_tri\`）及同步触发器
- [ ] 实现 \`ArchiveDatabase\` 连接管理与外部 SQLite 只读打开策略（供 \`codex-local\` 读取正在写入的 \`thread_history_*.sqlite\`）`,
  },
  {
    milestone: 'M0',
    title: '[M0][pkg:store] 实现只读原始层 (raw/) 与内容寻址媒体库 (blobs/ + >32KB Spill + 魔数嗅探)',
    labels: ['pkg:store', 'P1-core'],
    body: `### 背景与目标
确保原始导出文件不可变（按 SHA-256 落盘），并将 >32KB 大对象与内联 Base64 媒体剥离到内容寻址 \`blobs/\` 目录。

### 任务拆解
- [ ] 实现 \`RawStore.persistRaw\`：落盘至 \`raw/<provider>/<sha256前缀>/<文件名>\` 并计算 SHA-256
- [ ] 实现 \`BlobStore\`：按 \`blobs/<2位前缀>/<sha256><ext>\` 去重存储
- [ ] 实现魔数嗅探器 \`sniffMimeAndExt\`（识别 PNG/JPEG/WebP/GIF/PDF/MP4/JSON，解决 OpenAI \`.dat\` 无扩展名问题）
- [ ] 实现 \`spillPayload\`：将 >32KB 工具输出或内联 base64 自动外置为 \`OcaBlob\``,
  },
  {
    milestone: 'M0',
    title: '[M0][app:cli] 搭建 sm CLI 骨架并收编产品化 sm probe 格式探针命令',
    labels: ['app:cli', 'P1-core'],
    body: `### 背景与目标
将 \`tools/probe-formats.mjs\` 的探测能力整合进核心 CLI \`sm probe\`，搭建完整子命令路由。

### 任务拆解
- [ ] 搭建 \`apps/cli\` 入口，支持 \`sm probe|import|ls|show|search|verify|dedupe|export|reindex|serve\`
- [ ] 对接 \`AdapterRegistry.probeSource\`，支持本地目录与导出 ZIP 包格式嗅探与置信度报告`,
  },

  // M1
  {
    milestone: 'M1',
    title: '[M1][pkg:adapters] 实现 Adapter SDK（Registry、流式 ZIP 读取、ParseCtx 与未知格式结构学习器）',
    labels: ['pkg:adapters', 'P0-blocker'],
    body: `### 背景与目标
统一所有适配器的 \`probe -> plan -> parse\` 生命周期，并提供三级字段分发器与未知 JSON 结构学习器。

### 任务拆解
- [ ] 定义 \`Adapter\`, \`ProbeResult\`, \`ImportTask\`, \`ParseCtx\` 契约
- [ ] 实现 \`partitionVendorFields\`：自动将已知扩展归入 \`ext.<provider>\`，未知字段归入 \`ext._unmapped\` 并统计出现率
- [ ] 实现 \`learnJsonSchemaSummary\`：抽样未知 JSON 数组前 50 项推断候选 \`role/content\` 键，生成脱敏 \`probe-report.json\``,
  },
  {
    milestone: 'M1',
    title: '[M1][pkg:adapters] 实现 openai-web 适配器（分片 conversations-*.json、mapping 图建树、.dat 资产对齐）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [ ] 支持 \`conversations.json\` 及 \`conversations-000.json\` 多分片流式读取
- [ ] 解析 \`mapping\` 图结构，从 \`current_node\` 回溯标记 \`is_active_branch = true\`，保留全部 regenerate 旁支
- [ ] 映射 10+ 种 \`content_type\`（\`multimodal_text\`, \`code\`, \`execution_output\`, \`thoughts\`, \`tether_quote\`, \`canvas\`）
- [ ] 对齐 \`file-service://file-xxx\` 与包内 \`.dat\` / 图片文件；提取 \`about_user_message\` 记忆候选`,
  },
  {
    milestone: 'M1',
    title: '[M1][pkg:adapters] 实现 anthropic-web 适配器（content[] 多态块解析、sender 转换、memories/projects 归档）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [ ] 强制解析 \`chat_messages[].content[]\`（\`text\`, \`thinking\`, \`tool_use\`, \`tool_result\`），与降级 \`text\` 比对并在不一致时记录告警
- [ ] 将 \`sender: "human"\` 映射为 \`role: "user"\`，合成线性父指针链
- [ ] 处理 \`attachments[].extracted_content\`（标记 \`availability: "extracted_only"\`）与 \`memories.json\` / \`projects.json\``,
  },
  {
    milestone: 'M1',
    title: '[M1][pkg:adapters] 实现 deepseek-web 适配器与 generic-json / generic-md 兜底适配器',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [ ] 实现 \`deepseek-web\` 探针与解析器（支持官方导出包及含 \`reasoning_content\` 的消息结构）
- [ ] 实现启发式 \`generic-json\` 与 \`generic-md\` 适配器，将无法识别的字段完整保留至 \`ext._unmapped\` / \`payload_ref\``,
  },
  {
    milestone: 'M1',
    title: '[M1][testing] 构建网页导出合成夹具（Fixtures）与黄金输出快照回归测试',
    labels: ['testing', 'P1-core'],
    body: `### 任务拆解
- [ ] 在 \`packages/fixtures\` 中构建 OpenAI（含旁支、孤儿节点、隐藏消息）、Anthropic（含 thinking/tool_use）、DeepSeek 合成样本
- [ ] 编写黄金快照回归测试，验证归一化后的 \`OcaConversation\` 结构与哈希稳定性`,
  },

  // M2
  {
    milestone: 'M2',
    title: '[M2][pkg:adapters] 实现 codex-local 适配器（thread_history SQLite + rollout.jsonl.zst 双源对齐）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [ ] 只读方式打开 \`~/.codex/thread_history_*.sqlite\`，结合 \`session_index.jsonl\` 补全会话标题
- [ ] 支持解析 \`sessions/YYYY/MM/DD/rollout-*.jsonl.zst\`，对 \`base_instructions\` 仅存 SHA-256 哈希
- [ ] 将 \`commandExecution\`、\`mcpToolCall\`、\`fileChange\`、\`imageGeneration\`（内联 base64 >32KB）自动外置到 \`blobs/\``,
  },
  {
    milestone: 'M2',
    title: '[M2][pkg:adapters] 实现 claude-code-local 适配器（parentUuid 树、isSidechain 子线程、跨文件续写与坏尾行容错）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [ ] 扫描 \`~/.claude/projects/<encoded-cwd>/*.jsonl\`，按 \`sessionId\` 合并跨文件续写会话
- [ ] 还原 \`parentUuid\` 树结构，标记 \`isSidechain: true\` 到 \`ext.claude_code.sidechain\`
- [ ] 将仅含 \`tool_result\` 的 \`type: "user"\` 行修正为 \`role: "tool"\`；容忍崩溃导致的尾行 JSON 截断`,
  },
  {
    milestone: 'M2',
    title: '[M2][pkg:adapters] 实现 dsh-local 适配器（多帧 zstd 解码、流式 chunk 事件聚合与 synthetic 注入过滤）',
    labels: ['pkg:adapters', 'P1-core'],
    body: `### 任务拆解
- [ ] 使用 \`fzstd\` 解码 \`~/.dsh/sessions/<cwd>/<id>/session.v4.jsonl.zstd\` 连续多帧流
- [ ] 聚合流式 \`assistant/chunk\`、\`reasoning-chunks\`、\`tool-call-chunks\` 事件，提取最终态消息与工具调用
- [ ] 将 \`agent/inbox/spliced\`、\`compaction/*\`、\`command/run\` 标记为 \`is_synthetic = true\`，关联 \`~/.dsh/attachments/\``,
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
    title: '[M3][pkg:core] 实现四级查重引擎（Batch SHA256 → External ID → Merkle Root → MinHash LSH 近似候选）',
    labels: ['pkg:core', 'P0-blocker'],
    body: `### 任务拆解
- [ ] L0 文件/批次 SHA-256 幂等拦截
- [ ] L1 \`(provider, external_id)\` 精确对齐
- [ ] L2 \`head_hash\` + \`content_hash\`（Merkle Root）全等判定
- [ ] L3/L4 MinHash(128) LSH 分带检索：相似度 ≥ 0.90 自动合并，0.75–0.90 写入 \`dedupe_candidate\` 表待人工裁决`,
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
    title: '[M3][pkg:core] 实现 12 项结构完整性校验器与跨批次增量差异报告（重点捕获「内容缩短」与「上游已删除」）',
    labels: ['pkg:core', 'P1-core'],
    body: `### 任务拆解
- [ ] 实现 12 项结构校验（JSON 坏行、孤儿节点、环、重复 ID、缺失 Blob、时间异常、尾行截断、manifest 数量核对等）
- [ ] 实现跨批次差异对比 \`buildBatchDiffStats\`：输出新增会话、内容增长、**内容缩短（\`shrunk_conversations\`）**、上游消失会话统计
- [ ] 支持导出 \`verify-report.json\` 与 \`verify-report.md\``,
  },
  {
    milestone: 'M3',
    title: '[M3][app:cli] 实现 sm export（支持 OCA 标准归档包、Markdown Vault、JSONL 导出）',
    labels: ['app:cli', 'pkg:core', 'P1-core'],
    body: `### 任务拆解
- [ ] 实现 \`sm export --format oca\`：输出 \`manifest.json\` + \`conversations.jsonl\` + \`blobs/\`，供兄弟项目 \`Chatea\` 直接导入续聊
- [ ] 实现 \`sm export --format md\`（Markdown 逃生舱）与 \`--format jsonl\``,
  },

  // M4
  {
    milestone: 'M4',
    title: '[M4][pkg:store] 实现 FTS5 双索引（unicode61 + trigram）、查询路由器与 BM25 加权排序',
    labels: ['pkg:store', 'pkg:core', 'P1-core'],
    body: `### 任务拆解
- [ ] 实现查询路由：纯拉丁词走 \`item_fts_uni\`，≥3 字中文走 \`item_fts_tri\`，1–2 字中文走受限 \`LIKE\`，混合查询双表融合
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
- [ ] 严格绑定 \`127.0.0.1\` 随机或指定端口，启动生成一次性随机 Token，校验 \`X-SM-Token\` 与 \`Origin\`
- [ ] 提供 \`/api/conversations\`（keyset 分页）、\`/api/conversations/:id\`（全树节点）、\`/api/search\`、\`/api/batches/:id/report\` 与 \`/blobs/:sha256\`（支持 HTTP Range 音视频流）`,
  },
  {
    milestone: 'M5',
    title: '[M5][app:ui-win] 搭建 Flutter Windows 桌面端骨架、进程托管（自动拉起/连接 sm serve）与虚拟化会话列表',
    labels: ['app:ui-win', 'P1-core'],
    body: `### 任务拆解
- [ ] 基于 Flutter Windows 端（与 \`Chatea\` 共用设计风格与 \`packages/oca/codegen/dart/oca_models.dart\`）搭建桌面外壳
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
  // 1. Sync Labels
  const existingLabels = (await githubRest(token, 'GET', `/repos/${repo}/labels?per_page=100`)) ?? [];
  const labelNames = new Set(existingLabels.map((l) => l.name));

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

  // 2. Sync Milestones
  const existingMilestones = (await githubRest(token, 'GET', `/repos/${repo}/milestones?state=all&per_page=100`)) ?? [];
  const milestoneNumbers = new Map();

  for (const m of MILESTONES) {
    const found = existingMilestones.find((em) => em.title === m.title);
    if (found) {
      milestoneNumbers.set(m.key, found.number);
      console.log(`  ✓ Milestone exists: ${m.title} (#${found.number})`);
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

  // 3. Sync Issues
  const existingIssues = (await githubRest(token, 'GET', `/repos/${repo}/issues?state=all&per_page=100`)) ?? [];
  for (const issue of ISSUES) {
    const found = existingIssues.find((ei) => !ei.pull_request && ei.title === issue.title);
    if (found) {
      console.log(`  ✓ Issue exists: ${issue.title} (#${found.number})`);
      continue;
    }
    const created = await githubRest(token, 'POST', `/repos/${repo}/issues`, {
      title: issue.title,
      body: issue.body,
      milestone: milestoneNumbers.get(issue.milestone),
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
    const found = existingMilestones.find((em) => em.title === m.title);
    if (found) {
      milestoneNumbers.set(m.key, found.number);
      console.log(`  ✓ Milestone exists: ${m.title} (#${found.number})`);
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

  for (const issue of ISSUES) {
    const found = existingIssues.find((ei) => ei.title === issue.title);
    if (found) {
      console.log(`  ✓ Issue exists: ${issue.title} (#${found.number})`);
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
