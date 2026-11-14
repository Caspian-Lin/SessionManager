import fs from 'node:fs';
import path from 'node:path';
import {
  sha256Hex,
  type IntegrityIssue,
  type ProviderId,
  type SessionRole,
} from '@sm/shared';
import {
  BaseSessionDocument,
  partitionVendorFields,
  type Adapter,
  type ImportTask,
  type ParseCtx,
  type ProbeResult,
  type RawTurnProjection,
  type SessionDocument,
  type SourceRef,
} from '../contract.js';

export interface GenericNativeSession {
  source_file: string;
  format: 'json' | 'markdown';
  raw_payload: unknown;
}

export class GenericJsonSessionDocument extends BaseSessionDocument<GenericNativeSession> {
  private readonly messageList: unknown[];

  constructor(
    nativeData: GenericNativeSession,
    messageList: unknown[],
    title: string,
    parseIssues: IntegrityIssue[] = []
  ) {
    super({
      provider: 'generic-json',
      rawFormat: 'generic-json/v1',
      nativeData,
      external_id: title,
      title,
      title_source: 'filename',
      parseIssues,
    });
    this.messageList = messageList;
  }

  protected projectTurns(): RawTurnProjection[] {
    const turns: RawTurnProjection[] = [];
    let ordinal = 0;
    let prevId: string | null = null;

    for (const msg of this.messageList) {
      if (!msg || typeof msg !== 'object') continue;
      const mObj = msg as Record<string, unknown>;

      const id = typeof mObj['id'] === 'string' ? mObj['id'] : `gen-${ordinal}`;
      const rawRole =
        typeof mObj['role'] === 'string'
          ? mObj['role'].toLowerCase()
          : typeof mObj['sender'] === 'string'
            ? mObj['sender'].toLowerCase()
            : 'user';

      const role: SessionRole =
        rawRole === 'assistant' || rawRole === 'bot' || rawRole === 'model'
          ? 'assistant'
          : rawRole === 'system'
            ? 'system'
            : rawRole === 'tool'
              ? 'tool'
              : 'user';

      const content =
        typeof mObj['content'] === 'string'
          ? mObj['content']
          : typeof mObj['text'] === 'string'
            ? mObj['text']
            : JSON.stringify(mObj['content'] ?? mObj['text'] ?? '');

      turns.push({
        external_id: id,
        parent_external_id: prevId,
        ordinal: ordinal++,
        role,
        kind: 'message',
        text: content,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks: [{ idx: 0, type: 'text', text: content }],
      });
      prevId = id;
    }

    return turns;
  }
}

export class GenericMdSessionDocument extends BaseSessionDocument<GenericNativeSession> {
  constructor(nativeData: GenericNativeSession, title: string, parseIssues: IntegrityIssue[] = []) {
    super({
      provider: 'generic-md',
      rawFormat: 'generic-md/v1',
      nativeData,
      external_id: title,
      title,
      title_source: 'filename',
      parseIssues,
    });
  }

  protected projectTurns(): RawTurnProjection[] {
    const raw = typeof this.nativeData.raw_payload === 'string' ? this.nativeData.raw_payload : '';
    const turns: RawTurnProjection[] = [];
    const lines = raw.split('\n');

    let currentRole: SessionRole = 'user';
    let currentBlocks: string[] = [];
    let ordinal = 0;
    let prevId: string | null = null;

    const flushTurn = () => {
      if (currentBlocks.length === 0) return;
      const text = currentBlocks.join('\n').trim();
      if (!text) return;

      const id = `md-item-${ordinal}`;
      turns.push({
        external_id: id,
        parent_external_id: prevId,
        ordinal: ordinal++,
        role: currentRole,
        kind: 'message',
        text,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks: [{ idx: 0, type: 'text', text }],
      });
      prevId = id;
      currentBlocks = [];
    };

    const TURN_HEADER_RE = /^(?:#{1,4}\s+|\*\*)(User|Human|Assistant|AI|System)(?:\*\*|:)?/i;

    for (const line of lines) {
      const match = line.match(TURN_HEADER_RE);
      if (match && match[1]) {
        flushTurn();
        const roleLabel = match[1].toLowerCase();
        if (roleLabel === 'assistant' || roleLabel === 'ai') {
          currentRole = 'assistant';
        } else if (roleLabel === 'system') {
          currentRole = 'system';
        } else {
          currentRole = 'user';
        }
      } else {
        currentBlocks.push(line);
      }
    }
    flushTurn();

    if (turns.length === 0 && raw.trim().length > 0) {
      turns.push({
        external_id: 'md-0',
        ordinal: 0,
        role: 'user',
        kind: 'message',
        text: raw.trim(),
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks: [{ idx: 0, type: 'text', text: raw.trim() }],
      });
    }

    return turns;
  }
}

export class GenericJsonAdapter implements Adapter<GenericNativeSession> {
  readonly id: ProviderId = 'generic-json';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    if (src.kind !== 'file' || !src.path.toLowerCase().endsWith('.json')) {
      return null;
    }

    try {
      const sample = fs.readFileSync(src.path, { encoding: 'utf8', flag: 'r' }).slice(0, 8192);
      const isJsonArray = /^\s*\[/.test(sample);
      const hasMessages = sample.includes('"messages"') || sample.includes('"conversations"');
      const hasRole = sample.includes('"role"') || sample.includes('"sender"');

      if (isJsonArray || hasMessages || hasRole) {
        return {
          adapterId: this.id,
          version: 'generic-v1',
          confidence: 0.35,
          evidence: ['JSON file with heuristic conversational array markers'],
          entries: [src.path],
          warnings: ['Generic JSON heuristic adapter: field completeness unverified'],
        };
      }
    } catch {
      // ignore
    }
    return null;
  }

  async *plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask> {
    for (const entry of probe.entries) {
      let size = 0;
      try {
        size = fs.statSync(entry).size;
      } catch {
        // ignore
      }
      yield {
        id: sha256Hex(`${src.path}#${entry}#0`),
        src,
        entry,
        estimatedBytes: size,
      };
    }
  }

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<GenericNativeSession>[]> {
    const filePath = task.entry ?? task.src.path;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      ctx.log('error', `GenericJson read error: ${(err as Error).message}`);
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      ctx.log('error', `GenericJson parse error: ${(err as Error).message}`);
      return [];
    }

    let messageList: unknown[] = [];
    if (Array.isArray(parsed)) {
      messageList = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj['messages'])) messageList = obj['messages'] as unknown[];
      else if (Array.isArray(obj['conversations'])) messageList = obj['conversations'] as unknown[];
    }

    for (const msg of messageList) {
      if (msg && typeof msg === 'object') {
        partitionVendorFields(msg as Record<string, unknown>, ['id', 'role', 'sender', 'content', 'text'], ctx);
      }
    }

    const title = path.basename(filePath, '.json');
    return [
      new GenericJsonSessionDocument(
        { source_file: filePath, format: 'json', raw_payload: parsed },
        messageList,
        title
      ),
    ];
  }
}

export class GenericMdAdapter implements Adapter<GenericNativeSession> {
  readonly id: ProviderId = 'generic-md';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    if (src.kind !== 'file') return null;
    const base = path.basename(src.path).toLowerCase();
    if (base.endsWith('.md') || base.endsWith('.markdown')) {
      return {
        adapterId: this.id,
        version: 'generic-md-v1',
        confidence: 0.4,
        evidence: ['Markdown document candidate'],
        entries: [src.path],
        warnings: ['Generic Markdown adapter: conversation turns inferred from headers'],
      };
    }
    return null;
  }

  async *plan(src: SourceRef, probe: ProbeResult): AsyncIterable<ImportTask> {
    for (const entry of probe.entries) {
      let size = 0;
      try {
        size = fs.statSync(entry).size;
      } catch {
        // ignore
      }
      yield {
        id: sha256Hex(`${src.path}#${entry}#0`),
        src,
        entry,
        estimatedBytes: size,
      };
    }
  }

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<GenericNativeSession>[]> {
    const filePath = task.entry ?? task.src.path;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      ctx.log('error', `GenericMd read error: ${(err as Error).message}`);
      return [];
    }

    const title = path.basename(filePath, path.extname(filePath));
    return [
      new GenericMdSessionDocument(
        { source_file: filePath, format: 'markdown', raw_payload: raw },
        title
      ),
    ];
  }
}

export const genericJsonAdapter = new GenericJsonAdapter();
export const genericMdAdapter = new GenericMdAdapter();
