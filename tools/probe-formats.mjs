#!/usr/bin/env node
/**
 * probe-formats.mjs — 只读格式探针
 *
 * 用途：在不写任何文件、不上传任何内容的前提下，扫描本地 AI 会话数据源或导出包，
 *      输出结构画像（文件数、会话数、事件类型分布、文本体量、内联二进制占比）。
 *      用于校验 docs/02-数据格式规范.md 中的适配器假设，并估算索引体积。
 *
 * 用法：
 *   node probe-formats.mjs --root "%USERPROFILE%\.codex"
 *   node probe-formats.mjs --root "%USERPROFILE%\.dsh" --kind dsh
 *   node probe-formats.mjs --root "%USERPROFILE%\.claude" --kind claude
 *   node probe-formats.mjs --zip "D:\downloads\chatgpt-export.zip"
 *   node probe-formats.mjs --root ... --json > report.json
 *
 * 依赖：fzstd（纯 JS，用于解多帧拼接的 zstd）。未安装时自动降级为 Node 内置 zstd（仅单帧）。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let fzstd = null;
try { fzstd = require('fzstd'); } catch { /* 降级为内置 zstd */ }

// ────────────────────────────────────────────────────────── CLI ──
const argv = process.argv.slice(2);
const opt = { root: null, zip: null, kind: 'auto', json: false, maxFiles: 2000, limit: 15 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') opt.root = argv[++i];
  else if (a === '--zip') opt.zip = argv[++i];
  else if (a === '--kind') opt.kind = argv[++i];
  else if (a === '--json') opt.json = true;
  else if (a === '--max-files') opt.maxFiles = Number(argv[++i]);
  else if (a === '--limit') opt.limit = Number(argv[++i]);
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else { console.error(`未知参数: ${a}`); usage(); process.exit(1); }
}
if (!opt.root && !opt.zip) { usage(); process.exit(1); }

function usage() {
  console.log(`probe-formats.mjs — 只读会话格式探针

  --root <dir>    扫描目录（.codex / .dsh / .claude 或导出包解压目录）
  --zip  <file>   扫描 ZIP 导出包（只读中央目录 + 抽样 JSON）
  --kind <k>      codex | dsh | claude | auto（默认 auto 按目录特征判断）
  --json          输出机器可读 JSON
  --max-files n   单个源最多扫描文件数（默认 2000）
  --limit n       类型分布展示条数（默认 15）`);
}

// ───────────────────────────────────────────────── 通用工具 ──
const MB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const KB = (n) => `${(n / 1024).toFixed(1)} KB`;
const human = (n) => (n >= 1048576 ? MB(n) : n >= 1024 ? KB(n) : `${n} B`);

const ZSTD_MAGIC = 0xfd2fb528; // 小端读取

function readMaybeZstd(file) {
  const buf = fs.readFileSync(file);
  if (buf.length >= 4 && buf.readUInt32LE(0) === ZSTD_MAGIC) {
    if (fzstd) return Buffer.from(fzstd.decompress(buf));
    try {
      return zlib.zstdDecompressSync(buf); // 仅第一帧
    } catch (e) {
      throw new Error(`zstd 解码失败（可能是多帧，需安装 fzstd）: ${e.message}`);
    }
  }
  return buf;
}

function* iterLines(buf) {
  let start = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(10, start);
    if (nl < 0) nl = buf.length;
    if (nl > start) yield buf.toString('utf8', start, nl);
    start = nl + 1;
  }
}

function walk(dir, filter, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, filter, out, depth + 1);
    else if (filter(e.name)) out.push(full);
    if (out.length >= opt.maxFiles) return out;
  }
  return out;
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '0%');
const top = (obj, n = opt.limit) =>
  Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

function bump(map, key) { map[key] = (map[key] || 0) + 1; return map[key]; }

/** 估算内联 base64 的字节数：只统计 `data:*;base64,` 出现的片段长度 */
function scanInlineBase64(str) {
  let bytes = 0, hits = 0, idx = 0;
  while (true) {
    const at = str.indexOf('base64,', idx);
    if (at < 0) break;
    hits++;
    // 回退到 data: 起始位置，向后找到引号结束
    let start = at + 7, end = start;
    while (end < str.length) {
      const c = str.charCodeAt(end);
      if (c === 34 || c === 39 || c === 10 || c === 125) break; // " ' \n }
      end++;
    }
    bytes += Math.ceil((end - start) * 0.75);
    idx = end;
  }
  return { hits, bytes };
}

// ──────────────────────────────────────────────── Codex 探测 ──
function probeCodex(root) {
  const res = {
    kind: 'codex',
    root,
    rollouts: { files: 0, bytes: 0, records: {}, sessions: new Set(), textChars: 0,
                userMsgs: 0, assistantMsgs: 0, errors: 0, inline: { hits: 0, bytes: 0 } },
    sqlite: null,
    titles: { count: 0, sample: [] },
    history: { lines: 0 },
    warnings: [],
  };

  const files = [
    ...walk(path.join(root, 'sessions'), (n) => n.endsWith('.jsonl.zst') || n.endsWith('.jsonl')),
    ...walk(path.join(root, 'archived_sessions'), (n) => n.endsWith('.jsonl.zst') || n.endsWith('.jsonl')),
  ];
  res.rollouts.files = files.length;

  for (const f of files) {
    try {
      const buf = readMaybeZstd(f);
      res.rollouts.bytes += fs.statSync(f).size;
      for (const line of iterLines(buf)) {
        let o;
        try { o = JSON.parse(line); } catch { res.rollouts.errors++; continue; }
        const t = o.type || '?';
        bump(res.rollouts.records, t);
        if (o.ordinal === 0 && o.payload?.id) res.rollouts.sessions.add(o.payload.id);
        if (t === 'response_item' && o.payload?.type === 'message') {
          const role = o.payload.role;
          if (role === 'user') res.rollouts.userMsgs++;
          else if (role === 'assistant') res.rollouts.assistantMsgs++;
          for (const c of o.payload.content || []) {
            if (typeof c?.text === 'string') {
              res.rollouts.textChars += c.text.length;
              const s = scanInlineBase64(c.text);
              res.rollouts.inline.hits += s.hits;
              res.rollouts.inline.bytes += s.bytes;
            }
          }
        }
      }
    } catch (e) { res.rollouts.errors++; res.warnings.push(`${path.basename(f)}: ${e.message}`); }
  }

  // session_index.jsonl → 标题
  const idx = path.join(root, 'session_index.jsonl');
  if (fs.existsSync(idx)) {
    for (const line of iterLines(fs.readFileSync(idx))) {
      try {
        const o = JSON.parse(line);
        res.titles.count++;
        if (res.titles.sample.length < 5) res.titles.sample.push(o.thread_name ?? o.title ?? '(untitled)');
      } catch { /* ignore */ }
    }
  }

  const hist = path.join(root, 'history.jsonl');
  if (fs.existsSync(hist)) {
    res.history.lines = iterLines(fs.readFileSync(hist)).reduce((a) => a + 1, 0);
  }

  // thread_history_*.sqlite（只读）
  const dbFiles = fs.readdirSync(root).filter((n) => /^thread_history_\d+\.sqlite$/.test(n));
  if (dbFiles.length) {
    try {
      // node:sqlite 目前会打印 ExperimentalWarning；这里静音，避免污染报告
      const emitWarning = process.emitWarning;
      process.emitWarning = () => {};
      let DatabaseSync;
      try { ({ DatabaseSync } = require('node:sqlite')); }
      finally { process.emitWarning = emitWarning; }
      const db = new DatabaseSync(path.join(root, dbFiles[0]), { readOnly: true });
      const byType = db.prepare(
        `SELECT item_type, COUNT(*) c, CAST(AVG(LENGTH(item_json)) AS INTEGER) avg_len,
                MAX(LENGTH(item_json)) max_len
           FROM thread_items GROUP BY item_type ORDER BY c DESC`).all();
      const totals = db.prepare(
        `SELECT COUNT(*) items, COUNT(DISTINCT thread_id) threads, COUNT(DISTINCT turn_id) turns
           FROM thread_items`).get();
      const oversized = db.prepare(
        `SELECT COUNT(*) c FROM thread_items WHERE LENGTH(item_json) > 32768`).get().c;
      res.sqlite = {
        file: dbFiles[0],
        size_bytes: fs.statSync(path.join(root, dbFiles[0])).size,
        threads: totals.threads, turns: totals.turns, items: totals.items,
        oversized_items: oversized,
        by_type: byType.map((r) => ({ item_type: r.item_type, count: r.c, avg: r.avg_len, max: r.max_len })),
      };
      db.close();
    } catch (e) { res.warnings.push(`sqlite: ${e.message}`); }
  }
  res.rollouts.sessions = res.rollouts.sessions.size;
  return res;
}

// ────────────────────────────────────────────────── DSH 探测 ──
function probeDsh(root) {
  const res = {
    kind: 'dsh',
    root,
    files: 0, bytes: 0, sessions: 0,
    records: {}, generated: {},
    textChars: 0, userMsgs: 0, assistantMsgs: 0, toolCalls: 0,
    synthetic: 0, chunkEvents: 0, errors: 0, inline: { hits: 0, bytes: 0 },
    warnings: [],
  };
  const dirs = walk(path.join(root, 'sessions'), (n) => /^session(\.v\d+)?\.jsonl\.(zst|zstd)$/.test(n));
  const bySession = new Map();

  for (const f of dirs) {
    try {
      const buf = readMaybeZstd(f);
      res.files++;
      res.bytes += fs.statSync(f).size;
      const sid = path.basename(path.dirname(f));
      bySession.set(sid, (bySession.get(sid) || 0) + 1);
      for (const line of iterLines(buf)) {
        let o;
        try { o = JSON.parse(line); } catch { res.errors++; continue; }
        const t = o.type || '?';
        bump(res.records, t);
        if (t === 'session') res.sessions++;
        if (t === 'user/message') {
          res.userMsgs++;
          res.textChars += JSON.stringify(o.data ?? '').length;
        }
        if (t === 'agent/inbox/spliced') res.synthetic++;
        if (t === 'assistant/message') { res.assistantMsgs++; res.textChars += JSON.stringify(o.data ?? '').length; }
        if (t === 'tool/call') res.toolCalls++;
        if (/(chunks|chunk)$/.test(t)) res.chunkEvents++;
        if (/generated|image/i.test(t)) bump(res.generated, t);
        const s = JSON.stringify(o.data ?? '');
        if (s.includes('base64,')) { const r = scanInlineBase64(s); res.inline.hits += r.hits; res.inline.bytes += r.bytes; }
      }
    } catch (e) { res.errors++; res.warnings.push(`${path.basename(f)}: ${e.message}`); }
  }
  res.sessions = Math.max(res.sessions, bySession.size);
  res.filesWithBothGenerations = [...bySession.values()].filter((v) => v > 1).length;
  const att = path.join(root, 'attachments');
  res.attachments = fs.existsSync(att) ? walk(att, () => true).length : 0;
  return res;
}

// ─────────────────────────────────────────────── Claude Code 探测 ──
function probeClaude(root) {
  const res = {
    kind: 'claude-code', root,
    files: 0, bytes: 0, records: {}, sessions: new Set(),
    projectDirs: 0, userMsgs: 0, toolResults: 0, sidechain: 0,
    textChars: 0, errors: 0, truncatedTail: 0, warnings: [],
  };
  const projRoot = path.join(root, 'projects');
  const files = walk(projRoot, (n) => n.endsWith('.jsonl'));
  const dirs = new Set(files.map((f) => path.dirname(f)));
  res.projectDirs = dirs.size;
  res.files = files.length;

  for (const f of files) {
    res.bytes += fs.statSync(f).size;
    const raw = fs.readFileSync(f, 'utf8');
    const lines = raw.split('\n');
    if (lines[lines.length - 1] && !raw.endsWith('\n')) res.truncatedTail++;
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { res.errors++; continue; }
      bump(res.records, o.type || '?');
      if (o.sessionId) res.sessions.add(o.sessionId);
      if (o.isSidechain) res.sidechain++;
      if (o.type === 'user') res.userMsgs++;
      const content = o.message?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === 'tool_result') res.toolResults++;
          if (typeof c?.text === 'string') res.textChars += c.text.length;
        }
      } else if (typeof content === 'string') res.textChars += content.length;
    }
  }
  res.sessions = res.sessions.size;
  res.projectDirsSample = [...dirs].slice(0, 5).map((d) => path.basename(d));
  return res;
}

// ───────────────────────────────────────────────── ZIP 探测 ──
function listZip(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 中央目录（不是 ZIP 或使用了 ZIP64）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    entries.push({ name: buf.toString('utf8', off + 46, off + 46 + nameLen), method, csize, usize, lho });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

function readZipEntry(buf, e, maxBytes = 1 << 20) {
  if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error(`坏本地头: ${e.name}`);
  const nameLen = buf.readUInt16LE(e.lho + 26);
  const extraLen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.csize);
  const raw = e.method === 0 ? data : zlib.inflateRawSync(data);
  return raw.subarray(0, Math.min(raw.length, maxBytes));
}

function probeZip(file) {
  const buf = fs.readFileSync(file);
  const entries = listZip(buf);
  const names = entries.map((e) => e.name);
  const lower = names.map((n) => n.toLowerCase());

  const has = (re) => lower.some((n) => re.test(n));
  const provider =
    has(/^conversations(-\d+)?\.json$/) || has(/^mapping/) ? 'openai-web'
    : has(/chat_messages/) ? 'anthropic-web'
    : has(/^memories\.json$/) || has(/^projects\.json$/) ? 'anthropic-web'
    : 'unknown';

  const res = {
    kind: 'zip-export', file, provider,
    size_bytes: buf.length, entryCount: entries.length,
    topLevel: [...new Set(names.filter((n) => !n.includes('/')))].slice(0, 30),
    media: { images: 0, dat: 0, audio: 0, video: 0, pdf: 0, json: 0, other: 0 },
    conversations: { files: [], estimatedCount: null, sampleKeys: [], detectedFields: [] },
    warnings: [],
  };

  for (const n of lower) {
    if (/\.(png|jpe?g|webp|gif|heic)$/.test(n)) res.media.images++;
    else if (/\.dat$/.test(n)) res.media.dat++;
    else if (/\.(mp3|wav|m4a|ogg|webm|flac)$/.test(n)) res.media.audio++;
    else if (/\.(mp4|mov|mkv)$/.test(n)) res.media.video++;
    else if (/\.pdf$/.test(n)) res.media.pdf++;
    else if (/\.json$/.test(n)) res.media.json++;
    else res.media.other++;
  }

  const convFiles = entries.filter((e) => /^conversations(-\d+)?\.json$/i.test(e.name));
  res.conversations.files = convFiles.map((e) => ({ name: e.name, size: e.usize }));

  if (convFiles.length) {
    try {
      const prefix = readZipEntry(buf, convFiles[0], 512 * 1024).toString('utf8');
      // 粗估会话数：只数样本区间内的 beginObject 特征字段
      const marks = (prefix.match(/"conversation_id"/g) || []).length
                 || (prefix.match(/"create_time"/g) || []).length
                 || (prefix.match(/"uuid"/g) || []).length;
      res.conversations.estimatedCount = `${marks}+ (前 512 KB 样本)`;
      const keys = new Set();
      for (const m of prefix.matchAll(/"([A-Za-z_][A-Za-z0-9_]{1,40})"\s*:/g)) keys.add(m[1]);
      res.conversations.sampleKeys = [...keys].slice(0, 60);
      const probes = {
        'openai: mapping 图': /"mapping"\s*:/,
        'openai: current_node': /"current_node"/,
        'openai: 隐藏消息标记': /is_visually_hidden_from_conversation/,
        'openai: 记忆(about_user_message)': /about_user_message/,
        'openai: content_type': /"content_type"\s*:/,
        'anthropic: chat_messages': /"chat_messages"/,
        'anthropic: sender=human': /"sender"\s*:\s*"human"/,
        'anthropic: content 块数组': /"content"\s*:\s*\[\s*\{/,
        'deepseek 可能: role/content 扁平': /"role"\s*:\s*"(user|assistant)"/,
        'deepseek 可能: messages 数组': /"messages"\s*:\s*\[/,
      };
      res.conversations.detectedFields = Object.entries(probes)
        .filter(([, re]) => re.test(prefix)).map(([k]) => k)
        // 已知 provider 时不再报「其他 provider 的可能特征」，避免噪声
        .filter((k) => !(res.provider === 'openai-web' && k.startsWith('deepseek')))
        .filter((k) => !(res.provider === 'anthropic-web' && k.startsWith('openai')));
    } catch (e) { res.warnings.push(`抽样解析失败: ${e.message}`); }
  } else {
    res.warnings.push('包内未发现 conversations*.json —— 可能是解压目录、或非标准导出');
  }
  return res;
}

// ────────────────────────────────────────────────────── 输出 ──
function printCodex(r) {
  console.log(`\n■ Codex  ${r.root}`);
  console.log(`  rollout 文件      ${r.rollouts.files}  (${human(r.rollouts.bytes)} 压缩后)`);
  console.log(`  唯一会话          ${r.rollouts.sessions}`);
  console.log(`  用户/助手消息     ${r.rollouts.userMsgs} / ${r.rollouts.assistantMsgs}`);
  console.log(`  文本体量          ${(r.rollouts.textChars / 1048576).toFixed(2)} M 字符`);
  console.log(`  解析错误          ${r.rollouts.errors}`);
  console.log(`  标题索引          ${r.titles.count} 条  输入历史 ${r.history.lines} 行`);
  if (r.rollouts.inline.hits) {
    console.log(`  内联 base64       ${r.rollouts.inline.hits} 处 ≈ ${human(r.rollouts.inline.bytes)}`);
  }
  if (r.sqlite) {
    const s = r.sqlite;
    console.log(`  主存储            ${s.file}  ${human(s.size_bytes)}`);
    console.log(`  会话/轮次/items   ${s.threads} / ${s.turns} / ${s.items}`);
    console.log(`  >32KB 的 item     ${s.oversized_items} 条  ← 必须外置到 blob`);
    console.log(`  item 类型分布:`);
    for (const t of s.by_type.slice(0, opt.limit)) {
      console.log(`    ${t.item_type.padEnd(20)} ${String(t.count).padStart(7)}  avg ${String(t.avg).padStart(8)} B  max ${human(t.max)}`);
    }
  }
  for (const w of r.warnings.slice(0, 5)) console.log(`  ⚠ ${w}`);
}

function printDsh(r) {
  console.log(`\n■ DSH  ${r.root}`);
  console.log(`  会话日志文件      ${r.files}  (${human(r.bytes)} 压缩后)`);
  console.log(`  会话数            ${r.sessions}   同会话多代文件 ${r.filesWithBothGenerations}`);
  console.log(`  用户/助手消息     ${r.userMsgs} / ${r.assistantMsgs}`);
  console.log(`  工具调用          ${r.toolCalls}   流式 chunk 事件 ${r.chunkEvents}`);
  console.log(`  注入(非用户)消息  ${r.synthetic}`);
  console.log(`  文本体量          ${(r.textChars / 1048576).toFixed(2)} M 字符`);
  console.log(`  附件文件          ${r.attachments}`);
  if (r.inline.hits) console.log(`  内联 base64       ${r.inline.hits} 处 ≈ ${human(r.inline.bytes)}`);
  console.log(`  事件类型分布:`);
  for (const [k, v] of top(r.records)) console.log(`    ${k.padEnd(30)} ${String(v).padStart(7)}`);
  for (const w of r.warnings.slice(0, 5)) console.log(`  ⚠ ${w}`);
}

function printClaude(r) {
  console.log(`\n■ Claude Code  ${r.root}`);
  console.log(`  项目目录/文件     ${r.projectDirs} / ${r.files}  (${human(r.bytes)})`);
  console.log(`  会话数            ${r.sessions}`);
  console.log(`  用户消息          ${r.userMsgs}   工具结果 ${r.toolResults}`);
  console.log(`  子 Agent 行       ${r.sidechain}`);
  console.log(`  文本体量          ${(r.textChars / 1048576).toFixed(2)} M 字符`);
  console.log(`  解析错误/截断尾巴 ${r.errors} / ${r.truncatedTail}`);
  console.log(`  记录类型分布:`);
  for (const [k, v] of top(r.records)) console.log(`    ${k.padEnd(20)} ${String(v).padStart(7)}`);
  for (const w of r.warnings.slice(0, 5)) console.log(`  ⚠ ${w}`);
}

function printZip(r) {
  console.log(`\n■ ZIP 导出包  ${r.file}`);
  console.log(`  体积/条目数       ${human(r.size_bytes)} / ${r.entryCount}`);
  console.log(`  推断 provider     ${r.provider}`);
  console.log(`  conversations     ${r.conversations.files.map((f) => `${f.name}(${human(f.size)})`).join(', ') || '(无)'}`);
  if (r.conversations.estimatedCount) console.log(`  会话数(粗估)      ${r.conversations.estimatedCount}`);
  console.log(`  媒体              ` + Object.entries(r.media).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join('  '));
  if (r.conversations.detectedFields.length) {
    console.log(`  命中特征:`);
    for (const f of r.conversations.detectedFields) console.log(`    ✓ ${f}`);
  }
  if (r.conversations.sampleKeys.length) {
    console.log(`  样本字段          ${r.conversations.sampleKeys.slice(0, 24).join(', ')}`);
  }
  console.log(`  顶层条目          ${r.topLevel.slice(0, 12).join(', ')}`);
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);
}

// ─────────────────────────────────────────────────────── main ──
function detectKind(root) {
  const p = (n) => fs.existsSync(path.join(root, n));
  if (p('sessions') && (p('thread_history_1.sqlite') || p('session_index.jsonl'))) return 'codex';
  if (p('sessions') && p('storages')) return 'dsh';
  if (p('projects') || p('todos')) return 'claude';
  if (p('sessions')) {
    const hasV4 = walk(path.join(root, 'sessions'), (n) => n.startsWith('session.')).length > 0;
    return hasV4 ? 'dsh' : 'codex';
  }
  return 'unknown';
}

let report;
try {
  if (opt.zip) {
    report = probeZip(opt.zip);
    if (!opt.json) printZip(report);
  } else {
    const root = path.resolve(opt.root);
    const kind = opt.kind === 'auto' ? detectKind(root) : opt.kind;
    if (kind === 'unknown') {
      console.error(`无法判断 ${root} 的类型；请用 --kind codex|dsh|claude 指定`);
      process.exit(2);
    }
    report = kind === 'codex' ? probeCodex(root)
      : kind === 'dsh' ? probeDsh(root)
      : kind === 'claude' ? probeClaude(root)
      : (() => { throw new Error(`不支持的 kind: ${kind}`); })();
    if (!opt.json) {
      if (kind === 'codex') printCodex(report);
      else if (kind === 'dsh') printDsh(report);
      else printClaude(report);
      console.log('');
    }
  }
  if (opt.json) {
    console.log(JSON.stringify(report, (k, v) => (v instanceof Set ? [...v] : v), 2));
  }
} catch (e) {
  console.error(`探针失败: ${e.message}`);
  process.exit(1);
}
