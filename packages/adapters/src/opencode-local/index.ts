import fs from 'node:fs';
import path from 'node:path';
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

function resolveOpenCodeDbPath(src: SourceRef): string | null {
  if (src.kind === 'sqlite' || src.kind === 'file') {
    if (/\.(db|sqlite|sqlite3)$/i.test(src.path) && fs.existsSync(src.path)) {
      return src.path;
    }
    return null;
  }

  const candidates = [
    path.join(src.path, 'opencode.db'),
    path.join(src.path, 'data', 'opencode.db'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export class OpenCodeLocalAdapter implements Adapter<OpenCodeFamilyNativeSession> {
  readonly id: ProviderId = 'opencode-local';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const dbPath = resolveOpenCodeDbPath(src);
    if (!dbPath) return null;

    const info = inspectOpenCodeSqliteDb(dbPath);
    if (!info || (!info.hasV1 && !info.hasV2)) return null;

    // Defer to zcode-local if ZCode-specific columns/tables dominate without opencode v2 tables
    if (info.hasZcodeSignals && !info.hasV2 && !path.basename(dbPath).toLowerCase().includes('opencode')) {
      return null;
    }

    return {
      adapterId: this.id,
      version: info.hasV2 ? 'v2' : 'v1',
      confidence: path.basename(dbPath).toLowerCase() === 'opencode.db' ? 0.97 : 0.93,
      evidence: [
        `Found OpenCode SQLite archive (${info.hasV2 ? 'v2+v1' : 'v1'}): ${dbPath}`,
      ],
      entries: [dbPath],
      warnings: [],
    };
  }

  async *plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask> {
    const dbPath = resolveOpenCodeDbPath(src) ?? probe.entries[0];
    if (!dbPath || !fs.existsSync(dbPath)) return;

    const tasks = loadOpenCodeFamilyTasks(src, dbPath);
    for (const task of tasks) {
      yield task;
    }
  }

  async parse(
    task: ImportTask,
    ctx: ParseCtx
  ): Promise<SessionDocument<OpenCodeFamilyNativeSession>[]> {
    return parseOpenCodeFamilyTask('opencode-local', 'opencode-sqlite/v2', task, ctx);
  }
}

export const opencodeLocalAdapter = new OpenCodeLocalAdapter();
