import fs from 'node:fs';
import path from 'node:path';
import {
  sha256Hex,
  type OcaBlock,
  type OcaConversationDraft,
  type OcaItemDraft,
  type OcaProviderId,
  type OcaRole,
} from '@sm/oca';
import {
  partitionVendorFields,
  type Adapter,
  type ImportTask,
  type ParseCtx,
  type ProbeResult,
  type SourceRef,
} from '../contract.js';

export class GenericJsonAdapter implements Adapter {
  readonly id: OcaProviderId = 'generic-json';

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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<OcaConversationDraft[]> {
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

    const items: OcaItemDraft[] = [];
    let ordinal = 0;
    let prevId: string | null = null;

    // Search for array of messages
    let messageList: unknown[] = [];
    if (Array.isArray(parsed)) {
      messageList = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj['messages'])) messageList = obj['messages'] as unknown[];
      else if (Array.isArray(obj['conversations'])) messageList = obj['conversations'] as unknown[];
    }

    for (const msg of messageList) {
      if (!msg || typeof msg !== 'object') continue;
      const mObj = msg as Record<string, unknown>;

      const id = typeof mObj['id'] === 'string' ? mObj['id'] : `gen-${ordinal}`;
      const rawRole =
        typeof mObj['role'] === 'string'
          ? mObj['role'].toLowerCase()
          : typeof mObj['sender'] === 'string'
            ? mObj['sender'].toLowerCase()
            : 'user';

      const role: OcaRole =
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

      const unmapped = partitionVendorFields(mObj, ['id', 'role', 'sender', 'content', 'text'], ctx);

      items.push({
        external_id: id,
        parent_external_id: prevId,
        ordinal: ordinal++,
        role,
        kind: 'message',
        text: content,
        text_len: content.length,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks: [{ idx: 0, type: 'text', text: content }],
        ext: unmapped ? { _unmapped: unmapped } : undefined,
      });
      prevId = id;
    }

    return [
      {
        provider: this.id,
        external_id: path.basename(filePath, '.json'),
        title: path.basename(filePath, '.json'),
        title_source: 'filename',
        items,
      },
    ];
  }
}

export class GenericMdAdapter implements Adapter {
  readonly id: OcaProviderId = 'generic-md';

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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<OcaConversationDraft[]> {
    const filePath = task.entry ?? task.src.path;
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      ctx.log('error', `GenericMd read error: ${(err as Error).message}`);
      return [];
    }

    const items: OcaItemDraft[] = [];
    const lines = raw.split('\n');

    let currentRole: OcaRole = 'user';
    let currentBlocks: string[] = [];
    let ordinal = 0;
    let prevId: string | null = null;

    const flushTurn = () => {
      if (currentBlocks.length === 0) return;
      const text = currentBlocks.join('\n').trim();
      if (!text) return;

      const id = `md-item-${ordinal}`;
      items.push({
        external_id: id,
        parent_external_id: prevId,
        ordinal: ordinal++,
        role: currentRole,
        kind: 'message',
        text,
        text_len: text.length,
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

    // If no turns detected by header matching, create one single turn containing the entire text
    if (items.length === 0 && raw.trim().length > 0) {
      items.push({
        external_id: 'md-0',
        ordinal: 0,
        role: 'user',
        kind: 'message',
        text: raw.trim(),
        text_len: raw.trim().length,
        is_active_branch: true,
        is_hidden: false,
        is_synthetic: false,
        blocks: [{ idx: 0, type: 'text', text: raw.trim() }],
      });
    }

    return [
      {
        provider: this.id,
        external_id: path.basename(filePath, path.extname(filePath)),
        title: path.basename(filePath, path.extname(filePath)),
        title_source: 'filename',
        items,
      },
    ];
  }
}

export const genericJsonAdapter = new GenericJsonAdapter();
export const genericMdAdapter = new GenericMdAdapter();
