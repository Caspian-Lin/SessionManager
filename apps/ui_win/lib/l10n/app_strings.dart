import 'package:flutter/material.dart';

enum AppLocale { zh, en }

/// Inherited scope providing reactive bilingual (中文 / English) strings across the app.
class AppStringsScope extends InheritedNotifier<ValueNotifier<AppLocale>> {
  const AppStringsScope({
    super.key,
    required ValueNotifier<AppLocale> notifier,
    required super.child,
  }) : super(notifier: notifier);

  static AppStrings of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<AppStringsScope>();
    final locale = scope?.notifier?.value ?? AppLocale.zh;
    return AppStrings(locale);
  }

  static ValueNotifier<AppLocale>? notifierOf(BuildContext context) {
    return context.dependOnInheritedWidgetOfExactType<AppStringsScope>()?.notifier;
  }
}

class AppStrings {
  final AppLocale locale;
  const AppStrings(this.locale);

  bool get isZh => locale == AppLocale.zh;

  // App & Navigation
  String get appTitle => 'Session Manager';
  String get appSubtitle => isZh ? '本地 AI 会话归档' : 'Local AI Archive';
  String get navSessions => isZh ? '会话' : 'Sessions';
  String get navImport => isZh ? '导入' : 'Import';
  String get navReader => isZh ? '阅读' : 'Reader';
  String get navSearch => isZh ? '检索' : 'Search';
  String get navIntegrity => isZh ? '校验' : 'Integrity';

  // Top Bar & Status
  String get statusDirectConnected => isZh ? 'SQLite WAL 直连' : 'SQLite WAL Direct';
  String get statusDemoMode => isZh ? '演示数据' : 'Demo Mode';
  String get reloadTooltip => isZh ? '重新加载 SQLite 数据 (F5 / Ctrl+R)' : 'Reload SQLite Store (F5 / Ctrl+R)';
  String get importShortcutTooltip => isZh ? '前往导入与同步中心 (Ctrl+O)' : 'Open Import & Sync Hub (Ctrl+O)';
  String themeTooltip(ThemeMode mode) {
    final name = switch (mode) {
      ThemeMode.light => isZh ? '浅色' : 'Light',
      ThemeMode.dark => isZh ? '深色' : 'Dark',
      ThemeMode.system => isZh ? '跟随系统' : 'System',
    };
    return isZh ? '外观主题：$name（点击切换）' : 'Theme: $name (click to switch)';
  }

  // Session List
  String get archivedSessions => isZh ? '归档会话' : 'Archived Sessions';
  String sessionsCount(int n) => isZh ? '$n 条' : '$n items';
  String get filterHint => isZh ? '筛选标题或摘要...' : 'Filter title or summary...';
  String get allProviders => isZh ? '全部来源' : 'All Providers';
  String get allProjects => isZh ? '全部项目' : 'All Projects';
  String get starredOnly => isZh ? '仅星标' : 'Starred';
  String get shrunkOnly => isZh ? '内容缩短' : 'Shrunk';
  String get sortUpdated => isZh ? '最近更新' : 'Recently Updated';
  String get sortItems => isZh ? '消息最多' : 'Most Messages';
  String get sortChars => isZh ? '字数最多' : 'Most Characters';
  String get noSessionsMatch => isZh ? '没有符合筛选条件的会话' : 'No sessions match current filters.';
  String get noSessionsHint => isZh
      ? '前往「导入」页一键同步本地 Codex / 导出包'
      : 'Go to Import to sync local agents or web exports.';
  String get goToImport => isZh ? '去导入会话' : 'Go to Import';
  String itemsLabel(int n) => isZh ? '$n 条消息' : '$n items';
  String get shrunkBadge => isZh ? '内容缩短' : 'SHRUNK';

  // Branch Reader
  String get selectSessionHint => isZh ? '从左侧列表选择一个会话开始阅读' : 'Select a conversation from the list to read';
  String get conversationNotFound => isZh ? '未找到该会话' : 'Conversation not found.';
  String get activeBranchOnly => isZh ? '仅看主分支' : 'Active Branch';
  String get foldSyntheticLogs => isZh ? '折叠合成节点' : 'Fold Synthetic';
  String branchLabel(int current, int total) => isZh ? '分支 $current / $total' : 'Branch $current / $total';
  String syntheticCollapsedBanner(int count) => isZh
      ? '已折叠 $count 条系统/合成轨迹节点（点击展开）'
      : '$count synthetic / system node(s) collapsed (click to expand)';
  String get hideSyntheticGroup => isZh ? '收起合成节点' : 'Collapse synthetic group';
  String get thinkingProcess => isZh ? '思考过程' : 'Thinking Process';
  String get loadFullPayload => isZh ? '从本地 Blob 加载完整输出' : 'Load full payload from blob';
  String get copyCode => isZh ? '复制代码' : 'Copy code';
  String get codeCopied => isZh ? '已复制到剪贴板' : 'Copied to clipboard';
  String get latexFormula => isZh ? '数学公式 (LaTeX)' : 'LaTeX Formula';
  String get supersededBadge => isZh ? '已被修订替代' : 'Superseded';
  String get syntheticBadge => isZh ? '合成节点' : 'Synthetic';
  String get altBranchBadge => isZh ? '旁支' : 'Alt Branch';
  String get mediaFileMissing => isZh ? '本地媒体文件未找到' : 'Local media file not found on disk';
  String revisionsCount(int n) => isZh ? '$n 个修订版本' : '$n revision(s)';

  // Import & Local Agent Discovery Hub
  String get importHubTitle => isZh ? '导入与本地同步中心' : 'Import & Local Sync Hub';
  String get importHubSubtitle => isZh
      ? '自动识别本机 AI Agent 安装实例并一键增量更新，或按来源引导导入网页导出包。'
      : 'Auto-detect local AI agent installations for one-click incremental sync, or import web exports with guided steps.';
  String get localAgentsSection => isZh ? '本机 AI Agent 实例探测与一键增量更新' : 'Local Agent Discovery & One-Click Incremental Sync';
  String get rescanLocal => isZh ? '重新扫描本机' : 'Rescan Local';
  String get syncAllReady => isZh ? '一键同步全部就绪实例' : 'Sync All Ready';
  String get syncing => isZh ? '正在同步...' : 'Syncing...';
  String get oneClickSync => isZh ? '一键导入 / 增量更新' : 'One-Click Import / Sync';
  String get probeOnly => isZh ? '探测结构' : 'Probe';
  String get adapterReady => isZh ? '已支持 · L0 增量去重' : 'Ready · L0 Incremental';
  String get adapterPending => isZh ? '适配器接入中' : 'Adapter Pending';
  String get noLocalAgentsFound => isZh
      ? '未在常见路径（用户目录、Env、AppData、Scoop、WSL）探测到 Codex / DSH / Claude Code / OpenCode 实例。'
      : 'No local Codex / DSH / Claude Code / OpenCode instances detected in standard paths, env vars, Scoop, or WSL.';
  String get guidedImportSection => isZh ? '网页导出包与自定义路径引导导入' : 'Guided Import for Web Exports & Custom Sources';
  String get browseFile => isZh ? '选择文件' : 'Browse File';
  String get browseFolder => isZh ? '选择文件夹' : 'Browse Folder';
  String get runProbe => isZh ? '格式探测' : 'Probe Format';
  String get runImport => isZh ? '开始导入' : 'Import Now';
  String get sourcePathHint => isZh ? '输入或选择导出 .zip、JSON 文件或本地会话目录路径...' : 'Enter or browse export .zip, JSON file, or local session directory...';
  String get guideTitle => isZh ? '获取与导入引导' : 'Source Guide';
  String get archiveConfigSection => isZh ? '归档数据库位置与快捷维护' : 'Archive Database & Maintenance';
  String get dbPathLabel => isZh ? '归档库路径（archive.db 或目录）' : 'Archive Path (archive.db or directory)';
  String get switchDb => isZh ? '切换并连接' : 'Connect';
  String get exportFormatLabel => isZh ? '导出格式' : 'Export Format';
  String get exportNow => isZh ? '导出归档' : 'Export Archive';

  // Source Guides
  String get sourceOpenAi => 'ChatGPT / OpenAI';
  String get sourceAnthropic => 'Claude Web';
  String get sourceDeepSeek => 'DeepSeek';
  String get sourceGeneric => isZh ? '通用 JSON / MD' : 'Generic JSON / MD';

  List<String> guideSteps(String kind) {
    if (isZh) {
      return switch (kind) {
        'openai-web' => const [
            '1. 登录 ChatGPT 网页版 → 左下角头像 → Settings（设置）→ Data controls（数据控制）→ Export data（导出数据）。',
            '2. 从官方邮件下载 .zip 压缩包（无需手动解压，直接选择该 .zip 文件即可）。',
            '3. 本引擎支持单文件 conversations.json、多分片 conversations-000.json 及无扩展名 .dat 图片附件自动嗅探与对齐，并完整保留 regenerate 分支。',
          ],
        'anthropic-web' => const [
            '1. 登录 Claude.ai → Settings → Privacy / Account → Export Data 下载官方压缩包。',
            '2. 可先点击「格式探测」确认包内 conversations.json 结构；完整专有适配器（Issue #9）持续完善中，也可暂用通用 JSON 导入。',
          ],
        'deepseek-web' => const [
            '1. 在 DeepSeek 网页端导出对话 JSON / 压缩包后，选择文件或目录。',
            '2. 专有适配器（Issue #10）校准中，可先运行「格式探测」查看结构摘要或用通用模式入库。',
          ],
        _ => const [
            '1. 适用于任意自定义的 JSON 对话数组、JSONL 日志或 Markdown 对话目录。',
            '2. 系统会自动启发式识别 role / content / timestamp 字段，并将原始文件不可变保留在 raw/ 目录。',
          ],
      };
    }
    return switch (kind) {
      'openai-web' => const [
          '1. In ChatGPT Web, open Settings -> Data controls -> Export data and download the archive email link.',
          '2. Select the downloaded .zip directly (no manual extraction required).',
          '3. Supports conversations.json, sharded conversations-000.json, extensionless .dat media sniffing, and full regenerate branch trees.',
        ],
      'anthropic-web' => const [
          '1. In Claude.ai, go to Settings -> Account/Privacy -> Export Data to obtain your export archive.',
          '2. Use "Probe Format" to inspect structure; dedicated adapter (Issue #9) is being expanded while generic fallback works today.',
        ],
      'deepseek-web' => const [
          '1. Export your DeepSeek chat archive and select the .zip or extracted folder.',
          '2. Dedicated adapter (Issue #10) is in calibration; run "Probe Format" first to inspect fields.',
        ],
      _ => const [
          '1. Works with custom JSON conversation arrays, JSONL logs, or Markdown session folders.',
          '2. Heuristically detects role/content/timestamp fields while preserving immutable bytes in raw/.',
        ],
    };
  }

  // Search View
  String get searchTitle => isZh ? '全文检索' : 'Full-Text Search';
  String get searchSubtitle => isZh
      ? 'FTS5 双索引智能路由（英文 unicode61 · 中文≥3字 trigram · 1–2字 LIKE · BM25 加权）'
      : 'Dual FTS5 router (unicode61 + trigram + bounded CJK LIKE) with BM25 ranking.';
  String get searchInputHint => isZh ? '输入英文词元或中文关键词，按回车检索 (Ctrl+F)...' : 'Search English tokens or CJK keywords (Ctrl+F)...';
  String get searchAction => isZh ? '检索' : 'Search';
  String get allRoles => isZh ? '全部角色' : 'All Roles';
  String get includeSynthetic => isZh ? '包含合成节点' : 'Include Synthetic';
  String get searchEmptyHint => isZh ? '输入关键词并按回车开始检索本地 SQLite FTS5 索引' : 'Enter keywords and press Enter to search local SQLite FTS5 indexes.';
  String get searchNoHits => isZh ? '未找到匹配内容' : 'No matching items found.';

  // Integrity & Dedupe View
  String get integrityTitle => isZh ? '完整性校验与同源查重' : 'Archive Integrity & Deduplication';
  String get integritySubtitle => isZh
      ? '监控跨批次「内容缩短」高优异常、L1–L4 同源查重候选与导入批次台账。'
      : 'Track cross-batch shrunk conversations, L1–L4 dedupe candidates, and import ledger.';
  String get runVerify => isZh ? '运行校验 (Verify)' : 'Run Verify';
  String get runReindex => isZh ? '重建 FTS5 索引' : 'Reindex FTS5';
  String shrunkAlertTitle(int n) => isZh
      ? '高优预警：检测到 $n 个会话发生「内容缩短」'
      : 'Alert: $n Conversation(s) Shrunk Upstream';
  String get shrunkAlertDesc => isZh
      ? '后续批次中的消息数少于早期导出快照（可能上游已删除消息）。点击下方会话 ID 可直接跳转核对：'
      : 'Later exports contained fewer items than earlier snapshots. Click any ID below to inspect:';
  String get metricBatches => isZh ? '导入批次' : 'Import Batches';
  String get metricShrunk => isZh ? '内容缩短' : 'Shrunk Sessions';
  String get metricCandidates => isZh ? '疑似重复对' : 'Dedupe Candidates';
  String get dedupePairsTitle => isZh ? '疑似重复会话双栏对比' : 'Dedupe Candidate Pairs (Side-by-Side)';
  String get noDedupePairs => isZh ? '暂无待处理的疑似重复候选对' : 'No open dedupe candidate pairs.';
  String get batchLedgerTitle => isZh ? '导入批次台账' : 'Import Batch Ledger';
  String get openInReader => isZh ? '在阅读器中打开' : 'Open in Reader';
}
