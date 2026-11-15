import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProviderId } from '@sm/shared';
import type {
  Adapter,
  ImportTask,
  ParseCtx,
  ProbeResult,
  SessionDocument,
  SourceRef,
} from '../contract.js';
import {
  inspectOpenCodeSqliteDb,
  loadOpenCodeFamilyTasks,
  parseOpenCodeFamilyTask,
  type OpenCodeFamilyNativeSession,
} from '../opencode-common/index.js';

function resolveZCodeDbPaths(src: SourceRef): { dbPath: string | null; v2IndexPath: string | null } {
  if (src.kind === 'sqlite' || src.kind === 'file') {
    if (/\.(sqlite|sqlite3|db)$/i.test(src.path) && fs.existsSync(src.path)) {
      return { dbPath: src.path, v2IndexPath: null };
    }
    return { dbPath: null, v2IndexPath: null };
  }

  const candidates = [
    path.join(src.path, 'cli', 'db', 'db.sqlite'),
    path.join(src.path, 'db', 'db.sqlite'),
    path.join(src.path, 'db.sqlite'),
  ];
  const dbPath = candidates.find((c) => fs.existsSync(c)) ?? null;
  const v2Cand = path.join(src.path, 'v2', 'tasks-index.sqlite');
  const v2IndexPath = fs.existsSync(v2Cand) ? v2Cand : null;
  return { dbPath, v2IndexPath };
}

function loadZCodeExtraTitles(v2IndexPath: string | null): Map<string, string> {
  const titles = new Map<string, string>();
  if (!v2IndexPath || !fs.existsSync(v2IndexPath)) return titles;
  try {
    const db = new DatabaseSync(v2IndexPath, { readOnly: true });
    try {
      const hasTasks = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'`)
        .get();
      if (!hasTasks) return titles;
      const rows = db
        .prepare(`SELECT task_id, title FROM tasks WHERE title IS NOT NULL AND title != ''`)
        .all() as { task_id: string; title: string }[];
      for (const r of rows) {
        titles.set(r.task_id, r.title);
      }
    } finally {
      db.close();
    }
  } catch {
    // Ignore corrupt or locked auxiliary v2 index
  }
  return titles;
}

export class ZCodeLocalAdapter implements Adapter<OpenCodeFamilyNativeSession> {
  readonly id: ProviderId = 'zcode-local';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const { dbPath, v2IndexPath } = resolveZCodeDbPaths(src);
    if (!dbPath) return null;

    const info = inspectOpenCodeSqliteDb(dbPath);
    if (!info || !info.hasV1) return null;

    const lowerPath = src.path.toLowerCase();
    const isZCodeDir =
      lowerPath.includes('.zcode') ||
      path.basename(lowerPath) === 'zcode' ||
      Boolean(v2IndexPath);

    if (!isZCodeDir && !info.hasZcodeSignals) {
      return null;
    }

    const entries = [dbPath];
    if (v2IndexPath) entries.push(v2IndexPath);

    return {
      adapterId: this.id,
      version: 'v1',
      confidence: isZCodeDir || info.hasZcodeSignals ? 0.97 : 0.91,
      evidence: [
        `Found ZCode SQLite session store: ${dbPath}`,
        ...(v2IndexPath ? [`Found ZCode v2 task index: ${v2IndexPath}`] : []),
      ],
      entries,
      warnings: [],
    };
  }

  async *plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask> {
    const { dbPath, v2IndexPath } = resolveZCodeDbPaths(src);
    const targetDb = dbPath ?? probe.entries.find((e) => e.toLowerCase().endsWith('.sqlite'));
    if (!targetDb || !fs.existsSync(targetDb)) return;

    const extraTitles = loadZCodeExtraTitles(v2IndexPath);
    const tasks = loadOpenCodeFamilyTasks(src, targetDb, { extraTitles });
    for (const task of tasks) {
      yield task;
    }
  }

  async parse(
    task: ImportTask,
    ctx: ParseCtx
  ): Promise<SessionDocument<OpenCodeFamilyNativeSession>[]> {
    return parseOpenCodeFamilyTask('zcode-local', 'zcode-sqlite/v1', task, ctx);
  }
}

export const zcodeLocalAdapter = new ZCodeLocalAdapter();
