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
  String get navSettings => isZh ? '设置' : 'Settings';

  // Top Bar & Status
  String get statusDirectConnected => isZh ? 'SQLite WAL 直连' : 'SQLite WAL Direct';
  String get statusNotInitialized => isZh ? '就绪 · 等待首次导入' : 'Ready · No Archive Yet';
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

  // Window controls (custom title bar)
  String get windowMinimize => isZh ? '最小化' : 'Minimize';
  String get windowMaximize => isZh ? '最大化' : 'Maximize';
  String get windowRestore => isZh ? '还原' : 'Restore';
  String get windowClose => isZh ? '关闭' : 'Close';
  String get windowDragHint =>
      isZh ? '拖动标题栏移动窗口 · 双击最大化' : 'Drag to move · double-click to maximize';

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
  String get expandAll => isZh ? '展开树形' : 'Expand All';
  String get collapseAll => isZh ? '折叠树形' : 'Collapse All';
  String get uncategorizedProject => isZh ? '未归类工作区' : 'Uncategorized';
  String subagentsBadge(int n) => isZh ? '$n 子代理' : '$n sub';
  String projectCountBadge(int n) => isZh ? '$n 项目' : '$n proj';

  // Branch Reader
  String get selectSessionHint => isZh ? '从左侧列表选择一个会话开始阅读' : 'Select a conversation from the list to read';
  String get conversationNotFound => isZh ? '未找到该会话' : 'Conversation not found.';
  String get activeBranchOnly => isZh ? '仅看主分支' : 'Active Branch';
  String get foldSyntheticLogs => isZh ? '折叠过程节点' : 'Fold Process';
  String get conversationViewTab => isZh ? '对话视图' : 'Conversation';
  String get branchViewTab => isZh ? '分支视图' : 'Branches';
  String branchLabel(int current, int total) => isZh ? '分支 $current / $total' : 'Branch $current / $total';
  String syntheticCollapsedBanner(int count) => isZh
      ? '已折叠 $count 条系统/合成轨迹节点（点击展开）'
      : '$count synthetic / system node(s) collapsed (click to expand)';
  String processCollapsedSummary({
    required int thinkingCount,
    required int toolCallCount,
    required int toolResultCount,
    required int systemCount,
    required int noteCount,
  }) {
    final parts = <String>[];
    if (thinkingCount > 0) parts.add(isZh ? '$thinkingCount 思考' : '$thinkingCount thinking');
    if (toolCallCount > 0) parts.add(isZh ? '$toolCallCount 调用' : '$toolCallCount tool call(s)');
    if (toolResultCount > 0) parts.add(isZh ? '$toolResultCount 回执' : '$toolResultCount result(s)');
    if (noteCount > 0) parts.add(isZh ? '$noteCount 过程说明' : '$noteCount step(s)');
    if (systemCount > 0) parts.add(isZh ? '$systemCount 系统' : '$systemCount sys');
    final detail = parts.join(' · ');
    return isZh ? '思考与调用过程（$detail）' : 'Thinking & tool process ($detail)';
  }
  String get collapseProcessGroup => isZh ? '收起过程详情' : 'Collapse process';
  String get hideSyntheticGroup => isZh ? '收起过程节点' : 'Collapse group';
  String get backToMainSession => isZh ? '返回所属主会话' : 'Back to Parent Session';
  String attachedSubagentsLabel(int n) => isZh ? '关联子代理会话 ($n)' : 'Subagent Sessions ($n)';
  String get forkPointsTitle => isZh ? '分支与修订拓扑' : 'Branch & Revision Topology';
  String get switchToBranch => isZh ? '切换到此分支阅读' : 'Read This Branch';
  String get currentBranchBadge => isZh ? '当前激活分支' : 'Active Branch';
  String get historicalBranchBadge => isZh ? '历史旁支' : 'Alternative Branch';
  String get noBranchForksHint => isZh
      ? '当前会话为单一线性主干，无历史分叉。若同一会话发生多版本修订或 edit/regenerate 分叉，可在此对比切换。'
      : 'This session has a single linear timeline with no divergent forks yet.';
  String get turnJumpTooltip => isZh ? '快速跳转目录（悬停预览 · 点击定位）' : 'Turn Directory Rail (hover to preview, click to jump)';
  String get contextCompacted => isZh ? '上下文已压缩' : 'Context compacted';
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
  String get shareLongImage => isZh ? '生成分享长图' : 'Share Long Image';
  String get shareSheetTitle => isZh ? '生成会话分享长图 (PNG)' : 'Export Shareable Long Image (PNG)';
  String get sharePreviewTitle => isZh ? '实时效果预览' : 'Live Image Preview';
  String get shareModeFull => isZh ? '全程对话' : 'Full Conversation';
  String get shareModeSingleTurn => isZh ? '单次 Agent 回复（含提问）' : 'Single Agent Reply';
  String get shareSelectTurn => isZh ? '选择要导出的 Agent 回复' : 'Select Agent Reply Turn';
  String get shareIncludeToolDetails => isZh ? '展示思考与工具调用细节' : 'Include Thinking & Tool Call Details';
  String get shareColorStyleLabel => isZh ? '卡片配色样式' : 'Color Style';
  String get shareShowAuthorLabel => isZh ? '显示署名' : 'Show Signature';
  String get shareAuthorInputLabel => isZh ? '署名用户名' : 'Signature / Username';
  String get shareWatermarkToggle => isZh ? '添加斜向水印' : 'Add Watermark Overlay';
  String get shareWatermarkTextLabel => isZh ? '自定义水印文案' : 'Watermark Text';
  String get shareBrandToggle => isZh ? '显示“由 SessionManager 分享”标识' : 'Show "Shared by SessionManager" Badge';
  String get shareBrandTextLabel => isZh ? '品牌分享文案' : 'Brand Attribution Text';
  String get shareOutputDirLabel => isZh ? '保存目录' : 'Output Directory';
  String get shareGenerateBtn => isZh ? '生成 PNG 长图' : 'Generate PNG';
  String get shareGenerating => isZh ? '正在渲染并分片导出...' : 'Rendering & slicing PNG...';
  String get shareOpenFolder => isZh ? '打开保存目录' : 'Open Output Folder';
  String shareSavedCount(int n, String folder) =>
      isZh ? '已生成 $n 张分享图到 $folder' : 'Saved $n PNG image(s) to $folder';
  String get shareNoTurns => isZh ? '当前分支暂无可分享的消息节点' : 'No shareable messages in current view.';
  String get copyTurn => isZh ? '复制内容' : 'Copy';
  String get starAction => isZh ? '收藏会话' : 'Star';
  String get unstarAction => isZh ? '取消收藏' : 'Unstar';
  String get tagAction => isZh ? '添加标签' : 'Add Tag';
  String get deleteAction => isZh ? '移入回收站' : 'Move to Trash';
  String get addTagHint => isZh ? '输入标签名后按确认...' : 'Enter tag name...';
  String get openMediaFile => isZh ? '打开本地文件' : 'Open File';

  // Settings View
  String get settingsTitle => isZh ? '应用设置与性能日志' : 'Settings & Diagnostics';
  String get settingsSubtitle => isZh
      ? '配置分享水印/署名默认值、外观语言、查看打开耗时 Profile 日志及版本仓库信息。'
      : 'Configure share defaults, watermark, username, theme, language, performance logs, and project info.';
  String get settingsShareSection => isZh ? '分享与水印默认配置' : 'Share, Signature & Watermark Defaults';
  String get settingsAppearanceSection => isZh ? '外观与语言' : 'Appearance & Language';
  String get settingsPerfSection => isZh ? '性能 Profile 与耗时日志' : 'Performance Profiling & Latency Logs';
  String get settingsAboutSection => isZh ? '版本信息与 GitHub 仓库' : 'Version & GitHub Repository';
  String get settingsResetUsername => isZh ? '恢复本机用户名' : 'Use OS Username';
  String get settingsPerfToggle => isZh ? '开启会话加载耗时 Profile 与 JSONL 日志记录' : 'Enable Latency Profiling & JSONL Logging';
  String get settingsClearPerfLogs => isZh ? '清空内存记录' : 'Clear Logs';
  String get settingsOpenGithub => isZh ? '在浏览器打开' : 'Open in Browser';
  String get settingsCopyUrl => isZh ? '复制地址' : 'Copy URL';

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
  String get noSessionDataBadge => isZh ? '暂无会话数据' : 'No Sessions Found';
  String get stageProbeLabel => isZh ? '扫描数据源 / 计算指纹...' : 'Probing source & digest...';
  String get stagePlanLabel => isZh ? '规划并行导入任务...' : 'Planning parallel tasks...';
  String get stageParseLabel => isZh ? '并发解析会话...' : 'Parsing sessions in parallel...';
  String get stageCommitLabel => isZh ? '写入 SQLite 与构建 FTS5 索引...' : 'Committing SQLite & FTS5 index...';
  String get stageDoneLabel => isZh ? '导入完成' : 'Import Complete';
  String get etaCalculating => isZh ? '计算中...' : 'Calculating...';
  String get noLocalAgentsFound => isZh
      ? '未在常见路径（用户目录、Env、AppData、Scoop、WSL）探测到 Codex / DSH / Claude Code / OpenCode / ZCode 实例。'
      : 'No local Codex / DSH / Claude Code / OpenCode / ZCode instances detected in standard paths, env vars, Scoop, or WSL.';
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
  String get cancel => isZh ? '取消' : 'Cancel';
  String get resetArchiveAction => isZh ? '删除旧库记录' : 'Delete Archive DB';
  String get resetArchiveDialogTitle => isZh ? '确认删除当前归档库记录？' : 'Delete Current Archive Database?';
  String get resetArchiveWarning => isZh
      ? '将删除当前归档 SQLite 数据库中的所有导入记录、修订历史与全文索引，不影响原有 Codex / DSH / OpenCode / ZCode 本地聊天源文件。删除后可随时点击「一键同步」干净重建。'
      : 'This permanently deletes all imported conversations, revisions, and search indexes in this archive DB. Original Codex / DSH / OpenCode / ZCode files remain untouched and can be re-synced anytime.';
  String get resetArchiveIncludeCache => isZh
      ? '同时清理同目录下的 blobs / raw / reports 缓存（保留 shares 分享长图）'
      : 'Also delete blobs / raw / reports caches in this folder (keeps shares images)';
  String get resetArchiveNoData => isZh ? '当前路径下暂无归档库文件。' : 'No archive files found at current path.';
  String get resetArchiveConfirmBtn => isZh ? '确认删除归档库' : 'Delete Archive';
  String resetArchiveDone(String freed) => isZh
      ? '已清理旧归档库（释放 $freed），现在可以重新一键同步导入。'
      : 'Archive cleared ($freed freed). Ready for a clean re-import.';

  // Source Guides
  String get sourceOpenAi => 'ChatGPT / OpenAI';
  String get sourceAnthropic => 'Claude Web';
  String get sourceDeepSeek => 'DeepSeek';
  String get sourceSmNative => 'SessionManager';
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
            '2. 专有适配器（Issue #9）尚未启用；可先用「格式探测」查看结构或使用通用 JSON 兼容导入。',
          ],
        'deepseek-web' => const [
            '1. 在 DeepSeek 网页端导出对话 JSON / 压缩包后，选择 .zip 或解压目录。',
            '2. 完整支持 mapping 分支树、fragments (THINK / REQUEST / RESPONSE / SEARCH) 与大负载外置落盘。',
          ],
        'sm-native' => const [
            '1. 选择此前通过 SessionManager「native」格式导出的目录（含 native-manifest.json）或压缩包 (.zip)。',
            '2. 自动恢复原平台来源（openai-web / codex-local / dsh-local 等）与媒体/大负载 blobs，并执行 L0–L4 无损去重合库。',
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
          '2. Dedicated Anthropic Web adapter (#9) is intentionally deferred; generic JSON fallback works today.',
        ],
      'deepseek-web' => const [
          '1. Export your DeepSeek chat archive and select the .zip, JSON, or extracted folder.',
          '2. Supports mapping branch trees, fragments (THINK/REQUEST/RESPONSE/SEARCH), and large payload spilling.',
        ],
      'sm-native' => const [
          '1. Pick a native export directory (native-manifest.json) or .zip package created by SessionManager.',
          '2. Restores original providers, media/spill blobs, and runs full L0-L4 deduplication into this archive.',
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

  // Pinning, Project Starring & Message Timestamps
  String get pinInProvider => isZh ? '在当前来源中置顶' : 'Pin in provider';
  String get unpinInProvider => isZh ? '取消来源置顶' : 'Unpin in provider';
  String get starProjectGlobal => isZh ? '全局星标项目' : 'Star project globally';
  String get unstarProjectGlobal => isZh ? '取消项目星标' : 'Unstar project';
  String get sentAtLabel => isZh ? '发送时间' : 'Sent at';
  String expandAllSubagents(int n) => isZh ? '展开全部 ($n)' : 'Show all ($n)';
  String get collapseSubagents => isZh ? '收起子代理' : 'Collapse';
}
