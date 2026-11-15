import fs from 'node:fs';
import path from 'node:path';
import {
  SPILL_THRESHOLD_BYTES,
  decompressZstd,
  isZstdBuffer,
  iterJsonLines,
  sha256Hex,
  type BlobAsset,
  type IntegrityIssue,
  type ProviderId,
  type ViewBlock,
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

export interface DshNativeEvent {
  type?: string;
  seq?: number;
  time?: number;
  data?: unknown;
  [key: string]: unknown;
}

export interface DshAttachmentRef {
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  rel_path: string;
  source_path: string;
}

export interface DshSpillRef {
  sha256: string;
  bytes: number;
  preview: string;
}

export interface DshNativeSession {
  session_id: string;
  source_file: string;
  title?: string | null;
  cwd?: string | null;
  default_model?: string | null;
  parent_session?: string | null;
  origin?: string | null;
  agent_preset?: string | null;
  delegation_depth?: number | null;
  permission_preset?: string | null;
  sandbox_mode?: string | null;
  attachments?: DshAttachmentRef[];
  spills?: Record<string, DshSpillRef>;
  events: DshNativeEvent[];
}

function readBufferMaybeZstd(filePath: string): Buffer {
  const buf = fs.readFileSync(filePath);
  if (isZstdBuffer(buf)) {
    return decompressZstd(buf);
  }
  return buf;
}

function inferMimeFromFilename(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.json') return 'application/json';
  if (ext === '.txt' || ext === '.log' || ext === '.md') return 'text/plain';
  return 'application/octet-stream';
}

function extractChunkDeltaText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj['delta'] === 'string') return obj['delta'];
    if (typeof obj['text'] === 'string') return obj['text'];
    if (typeof obj['content'] === 'string') return obj['content'];
    if (typeof obj['chunk'] === 'string') return obj['chunk'];
  }
  return '';
}

function extractContentPartsText(parts: unknown[]): {
  text: string;
  reasoning: string;
  toolCalls: Array<{ id?: string; name?: string; arguments?: string }>;
  attachments: string[];
} {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: Array<{ id?: string; name?: string; arguments?: string }> = [];
  const attachments: string[] = [];

  for (const part of parts) {
    if (typeof part === 'string') {
      if (part.trim().length > 0) textParts.push(part);
      continue;
    }
    if (!part || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    const pType = typeof p['type'] === 'string' ? p['type'] : '';

    if (pType === 'reasoning' || pType === 'thinking') {
      const rText =
        typeof p['text'] === 'string'
          ? p['text']
          : typeof p['thinking'] === 'string'
            ? p['thinking']
            : '';
      if (rText) reasoningParts.push(rText);
    } else if (pType === 'tool-call' || pType === 'tool_use') {
      toolCalls.push({
        id: typeof p['id'] === 'string' ? p['id'] : typeof p['callId'] === 'string' ? p['callId'] : undefined,
        name: typeof p['name'] === 'string' ? p['name'] : undefined,
        arguments:
          typeof p['arguments'] === 'string'
            ? p['arguments']
            : p['arguments'] !== undefined
              ? JSON.stringify(p['arguments'])
              : p['input'] !== undefined
                ? JSON.stringify(p['input'])
                : undefined,
      });
    } else if (pType === 'attachment' || pType === 'image' || pType === 'file') {
      const attName =
        typeof p['name'] === 'string'
          ? p['name']
          : typeof p['file'] === 'string'
            ? p['file']
            : typeof p['path'] === 'string'
              ? p['path']
              : '';
      if (attName) attachments.push(attName);
    } else if (typeof p['text'] === 'string') {
      if (p['text'].length > 0) textParts.push(p['text']);
    } else if (typeof p['content'] === 'string') {
      if (p['content'].length > 0) textParts.push(p['content']);
    } else {
      textParts.push(JSON.stringify(p));
    }
  }

  return {
    text: textParts.join('\n\n'),
    reasoning: reasoningParts.join('\n\n'),
    toolCalls,
    attachments,
  };
}

function asObj(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

const KNOWN_EVENT_KEYS = ['type', 'seq', 'time', 'data'] as const;

export class DshSessionDocument extends BaseSessionDocument<DshNativeSession> {
  constructor(
    nativeData: DshNativeSession,
    createdAt: number | null,
    updatedAt: number | null,
    parseIssues: IntegrityIssue[] = [],
    blobs: BlobAsset[] = []
  ) {
    const isSubagent = Boolean(
      nativeData.parent_session ||
        (typeof nativeData.delegation_depth === 'number' && nativeData.delegation_depth > 0) ||
        nativeData.origin === 'subagent'
    );
    super({
      provider: 'dsh-local',
      rawFormat: 'dsh-session/v4',
      nativeData,
      external_id: nativeData.session_id,
      parent_external_id: nativeData.parent_session ?? null,
      is_subagent: isSubagent,
      subagent_name:
        nativeData.agent_preset ?? (isSubagent ? nativeData.origin ?? 'subagent' : null),
      title: nativeData.title ?? null,
      title_source: nativeData.title ? 'provider' : null,
      created_at: createdAt,
      updated_at: updatedAt,
      cwd: nativeData.cwd ?? null,
      default_model: nativeData.default_model ?? null,
      blobs,
      parseIssues,
    });
  }

  protected projectTurns(): RawTurnProjection[] {
    const turns: RawTurnProjection[] = [];
    let ordinal = 0;
    let prevId: string | null = null;
    let latestTime: number | null = this.init.created_at ?? null;
    const spills = this.nativeData.spills ?? {};
    const emittedToolCallIds = new Set<string>();
    const toolNameByCallId = new Map<string, string>();

    const attachmentsByName = new Map<string, DshAttachmentRef>();
    for (const att of this.nativeData.attachments ?? []) {
      attachmentsByName.set(att.name, att);
      attachmentsByName.set(path.basename(att.source_path), att);
    }

function isSyntheticDshUserMessage(sourceKind: string | null, text: string): boolean {
  if (sourceKind) {
    const sk = sourceKind.toLowerCase().trim();
    if (sk.length > 0 && sk !== 'user' && sk !== 'human' && sk !== 'user-input' && sk !== 'user_input') {
      return true;
    }
  }

  const trimmed = text.trimStart();
  if (!trimmed) return false;
  return /^(?:<(?:goal_round|goal_complete|system-reminder|system_reminder|system-notification|system_notification|system-time|time_reminder|permission_hint|permission-hint|subagent_reply|subagent-reply|agent_reply|task-notification|inbox|environment_context|permissions instructions|collaboration_mode|skills_instructions|turn_aborted|subagent_notification|local-command-[a-z-]+)\b|\[(?:model\s+changed:|system\b|system\s+time|current\s+time|time\s+hint|permission\b|user-approval|approval\b|inbox\b|subagent\b|agent\s+reply|inter-agent)|(?:system\s+time|current\s+time|permission\s+(?:hint|notice|prompt|mode)|subagent\s+(?:reply|response|report)|reply\s+from\s+(?:sub)?agent|browser\s+time\s+zone\s+for\s+this\s+request|elapsed\s+since\s+the\s+preceding\s+step\s+context)\s*[:：]|time\s+sampled\s+while\b|background\s+job\s+\S+|(?:background\s+)?subagent\s+\S+\s+(?:finished|completed|failed|stopped|canceled|cancelled)\b|background\s+subagent\b|agent\s+\S+\s+sent\s+a\s+message:|current\s+runtime\s+context\.\s+this\s+snapshot\s+supersedes|this\s+is\s+an\s+automatically\s+generated\s+checkpoint\s+condensing|the\s+(?:user\s+changed\s+the\s+)?approval\s+policy\s+(?:changed|was\s+changed)\b|the\s+working\s+directory\s+changed\s+from\b|(?:系统时间|当前时间|系统权限|权限提示|子代理回复|来自子代理)\s*[:：]?)/i.test(
    trimmed
  );
}

    const pushSpillable = (
      spillKey: string,
      rawText: string
    ): { text: string; payload_ref: string | null } => {
      const s = spills[spillKey];
      if (s) {
        return { text: s.preview, payload_ref: s.sha256 };
      }
      return { text: rawText, payload_ref: null };
    };

    for (const record of this.nativeData.events) {
      const evtType = typeof record.type === 'string' ? record.type : '';
      const seq = typeof record.seq === 'number' ? record.seq : ordinal;
      if (typeof record.time === 'number') {
        latestTime = record.time < 10000000000 ? record.time * 1000 : record.time;
      }
      const data = record.data;
      const dObj = asObj(data);

      if (evtType === 'user/message') {
        let text = '';
        const attachedRefs: string[] = [];

        if (typeof data === 'string') {
          text = data;
        } else if (dObj) {
          if (typeof dObj['text'] === 'string') {
            text = dObj['text'];
          } else if (Array.isArray(dObj['content'])) {
            const parsed = extractContentPartsText(dObj['content'] as unknown[]);
            text = parsed.text;
            attachedRefs.push(...parsed.attachments);
          } else if (asObj(dObj['message']) && Array.isArray(asObj(dObj['message'])!['content'])) {
            const parsed = extractContentPartsText(asObj(dObj['message'])!['content'] as unknown[]);
            text = parsed.text;
            attachedRefs.push(...parsed.attachments);
          } else {
            text = JSON.stringify(dObj);
          }
          if (Array.isArray(dObj['attachments'])) {
            for (const rawAtt of dObj['attachments'] as unknown[]) {
              if (typeof rawAtt === 'string') {
                attachedRefs.push(rawAtt);
              } else if (asObj(rawAtt)) {
                attachedRefs.push(String(asObj(rawAtt)!['name'] ?? asObj(rawAtt)!['file'] ?? ''));
              }
            }
          }
        }

        const sourceObj =
          (dObj ? asObj(dObj['source']) ?? asObj(asObj(dObj['message'])?.['source']) : null) ??
          asObj((record as Record<string, unknown>)['source']);
        const sourceKind = typeof sourceObj?.['kind'] === 'string' ? sourceObj['kind'] : null;
        const isSynthetic = isSyntheticDshUserMessage(sourceKind, text);
        const spilled = pushSpillable(`user:${seq}`, text);
        const blocks: ViewBlock[] = [];
        if (spilled.text.length > 0 || spilled.payload_ref) {
          blocks.push({
            idx: 0,
            type: 'text',
            text: spilled.text,
            blob_sha256: spilled.payload_ref,
            ...(sourceKind ? { meta: { dsh_source_kind: sourceKind } } : {}),
          });
        }

        for (const rawAtt of attachedRefs) {
          const attName = rawAtt ? path.basename(rawAtt) : '';
          const matched = attName ? attachmentsByName.get(attName) : undefined;
          if (matched) {
            blocks.push({
              idx: blocks.length,
              type: matched.mime.startsWith('image/') ? 'image' : 'file',
              text: matched.name,
              blob_sha256: matched.sha256,
              availability: 'full',
              meta: { file_name: matched.name, mime: matched.mime },
            });
          }
        }

        if (blocks.length === 0) {
          blocks.push({ idx: 0, type: 'text', text: '' });
        }

        const id = `dsh-${seq}`;
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: isSynthetic ? 'system' : 'user',
          kind: isSynthetic ? 'system_note' : 'message',
          created_at: latestTime,
          text: spilled.text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: isSynthetic,
          payload_ref: spilled.payload_ref,
          blocks,
        });
        prevId = id;
      } else if (evtType === 'assistant/message') {
        const msgObj = dObj ? asObj(dObj['message']) : null;
        const srcObj = dObj ? asObj(dObj['source']) : null;
        const model =
          typeof srcObj?.['model'] === 'string'
            ? srcObj['model']
            : typeof msgObj?.['model'] === 'string'
              ? msgObj['model']
              : (this.nativeData.default_model ?? null);

        if (typeof data === 'string') {
          const id = `dsh-${seq}`;
          turns.push({
            external_id: id,
            parent_external_id: prevId,
            ordinal: ordinal++,
            role: 'assistant',
            kind: 'message',
            created_at: latestTime,
            model,
            text: data,
            is_active_branch: true,
            is_hidden: false,
            is_synthetic: false,
            blocks: [{ idx: 0, type: 'text', text: data }],
          });
          prevId = id;
        } else if (msgObj && Array.isArray(msgObj['content'])) {
          const parsed = extractContentPartsText(msgObj['content'] as unknown[]);
          if (parsed.reasoning.trim().length > 0) {
            const rId = `dsh-${seq}-r`;
            const rSpill = pushSpillable(`asst-r:${seq}`, parsed.reasoning);
            turns.push({
              external_id: rId,
              parent_external_id: prevId,
              ordinal: ordinal++,
              role: 'assistant',
              kind: 'reasoning',
              created_at: latestTime,
              model,
              text: rSpill.text,
              is_active_branch: true,
              is_hidden: false,
              is_synthetic: false,
              payload_ref: rSpill.payload_ref,
              blocks: [{ idx: 0, type: 'thinking', text: rSpill.text, blob_sha256: rSpill.payload_ref }],
            });
            prevId = rId;
          }

          if (parsed.text.trim().length > 0 || parsed.toolCalls.length === 0) {
            const mId = `dsh-${seq}`;
            const tSpill = pushSpillable(`asst-t:${seq}`, parsed.text);
            if (tSpill.text.length > 0 || parsed.toolCalls.length === 0) {
              turns.push({
                external_id: mId,
                parent_external_id: prevId,
                ordinal: ordinal++,
                role: 'assistant',
                kind: 'message',
                created_at: latestTime,
                model,
                text: tSpill.text,
                is_active_branch: true,
                is_hidden: false,
                is_synthetic: false,
                payload_ref: tSpill.payload_ref,
                blocks: [{ idx: 0, type: 'text', text: tSpill.text, blob_sha256: tSpill.payload_ref }],
              });
              prevId = mId;
            }
          }

          for (let tIdx = 0; tIdx < parsed.toolCalls.length; tIdx++) {
            const tc = parsed.toolCalls[tIdx]!;
            if (tc.id) emittedToolCallIds.add(tc.id);
            const tcId = `dsh-${seq}-tc-${tIdx}`;
            const toolName = tc.name ?? 'tool';
            if (tc.id && toolName) {
              toolNameByCallId.set(tc.id, toolName);
            }
            const inputStr = tc.arguments ?? '';
            const tcSpill = pushSpillable(`asst-tc:${seq}:${tIdx}`, inputStr);
            const summary = `${toolName}${tcSpill.text ? ` ${tcSpill.text.slice(0, 120)}` : ''}`;
            turns.push({
              external_id: tcId,
              parent_external_id: prevId,
              ordinal: ordinal++,
              role: 'assistant',
              kind: 'tool_call',
              created_at: latestTime,
              model,
              text: summary,
              is_active_branch: true,
              is_hidden: false,
              is_synthetic: false,
              payload_ref: tcSpill.payload_ref,
              blocks: [
                {
                  idx: 0,
                  type: 'tool_use',
                  tool_name: toolName,
                  tool_call_id: tc.id ?? null,
                  tool_input: tcSpill.text,
                  blob_sha256: tcSpill.payload_ref,
                },
              ],
            });
            prevId = tcId;
          }
        } else if (dObj) {
          const fallbackText =
            typeof dObj['text'] === 'string' ? dObj['text'] : JSON.stringify(dObj);
          const id = `dsh-${seq}`;
          turns.push({
            external_id: id,
            parent_external_id: prevId,
            ordinal: ordinal++,
            role: 'assistant',
            kind: 'message',
            created_at: latestTime,
            model,
            text: fallbackText,
            is_active_branch: true,
            is_hidden: false,
            is_synthetic: false,
            blocks: [{ idx: 0, type: 'text', text: fallbackText }],
          });
          prevId = id;
        }
      } else if (evtType === 'assistant/reasoning') {
        const text =
          typeof data === 'string'
            ? data
            : dObj && typeof dObj['text'] === 'string'
              ? dObj['text']
              : JSON.stringify(data ?? '');
        const id = `dsh-${seq}`;
        const rSpill = pushSpillable(`reas:${seq}`, text);
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'assistant',
          kind: 'reasoning',
          created_at: latestTime,
          text: rSpill.text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          payload_ref: rSpill.payload_ref,
          blocks: [{ idx: 0, type: 'thinking', text: rSpill.text, blob_sha256: rSpill.payload_ref }],
        });
        prevId = id;
      } else if (evtType === 'tool/call') {
        const callId = dObj && typeof dObj['callId'] === 'string' ? dObj['callId'] : null;
        const toolName = dObj && typeof dObj['name'] === 'string' ? dObj['name'] : null;
        if (callId && toolName) {
          toolNameByCallId.set(callId, toolName);
        }
        if (callId && emittedToolCallIds.has(callId)) {
          continue;
        }
        let inputStr = '';
        if (typeof data === 'string') {
          inputStr = data;
        } else if (dObj) {
          if (typeof dObj['arguments'] === 'string') {
            inputStr = dObj['arguments'];
          } else if (dObj['arguments'] !== undefined) {
            inputStr = JSON.stringify(dObj['arguments']);
          } else if (dObj['input'] !== undefined) {
            inputStr = typeof dObj['input'] === 'string' ? dObj['input'] : JSON.stringify(dObj['input']);
          } else {
            inputStr = JSON.stringify(dObj);
          }
        }
        const tcSpill = pushSpillable(`tcall:${seq}`, inputStr);
        const id = `dsh-${seq}`;
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'assistant',
          kind: 'tool_call',
          created_at: latestTime,
          text: toolName ? `${toolName}: ${tcSpill.text.slice(0, 140)}` : tcSpill.text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          payload_ref: tcSpill.payload_ref,
          blocks: [
            {
              idx: 0,
              type: 'tool_use',
              tool_name: toolName,
              tool_call_id: callId,
              tool_input: tcSpill.text,
              blob_sha256: tcSpill.payload_ref,
            },
          ],
        });
        prevId = id;
      } else if (evtType === 'tool/result') {
        let resText = '';
        let callId: string | null = null;
        let resolvedToolName: string | null = null;
        if (typeof data === 'string') {
          resText = data;
        } else if (dObj) {
          const msgObj = asObj(dObj['message']);
          const srcObj = msgObj ? asObj(msgObj['source']) : null;
          callId =
            (typeof dObj['toolCallId'] === 'string' ? dObj['toolCallId'] : null) ??
            (typeof msgObj?.['toolCallId'] === 'string' ? (msgObj['toolCallId'] as string) : null) ??
            (typeof srcObj?.['callId'] === 'string' ? (srcObj['callId'] as string) : null);
          resolvedToolName =
            (typeof dObj['toolName'] === 'string' ? dObj['toolName'] : null) ??
            (typeof dObj['name'] === 'string' ? dObj['name'] : null) ??
            (typeof dObj['tool'] === 'string' ? dObj['tool'] : null) ??
            (typeof msgObj?.['toolName'] === 'string' ? (msgObj['toolName'] as string) : null) ??
            (typeof srcObj?.['toolName'] === 'string' ? (srcObj['toolName'] as string) : null);
          if (msgObj && Array.isArray(msgObj['content'])) {
            resText = extractContentPartsText(msgObj['content'] as unknown[]).text;
          } else if (typeof dObj['output'] === 'string') {
            resText = dObj['output'];
          } else if (typeof dObj['text'] === 'string') {
            resText = dObj['text'];
          } else {
            resText = JSON.stringify(dObj);
          }
        }
        if (!resolvedToolName && callId) {
          resolvedToolName = toolNameByCallId.get(callId) ?? null;
        }
        const trSpill = pushSpillable(`tres:${seq}`, resText);
        const id = `dsh-${seq}`;
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'tool',
          kind: 'tool_result',
          created_at: latestTime,
          text: trSpill.text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: false,
          payload_ref: trSpill.payload_ref,
          blocks: [
            {
              idx: 0,
              type: 'tool_result',
              tool_name: resolvedToolName,
              tool_call_id: callId,
              text: trSpill.text,
              blob_sha256: trSpill.payload_ref,
            },
          ],
        });
        prevId = id;
      } else if (evtType === 'system/message') {
        let sysText = '';
        const msgObj = dObj ? asObj(dObj['message']) : null;
        if (msgObj && Array.isArray(msgObj['content'])) {
          sysText = extractContentPartsText(msgObj['content'] as unknown[]).text;
        } else if (dObj && Array.isArray(dObj['content'])) {
          sysText = extractContentPartsText(dObj['content'] as unknown[]).text;
        } else if (typeof data === 'string') {
          sysText = data;
        }
        if (sysText.trim().length > 0) {
          const sSpill = pushSpillable(`sys:${seq}`, sysText);
          const id = `dsh-${seq}`;
          turns.push({
            external_id: id,
            parent_external_id: prevId,
            ordinal: ordinal++,
            role: 'system',
            kind: 'system_note',
            created_at: latestTime,
            text: sSpill.text,
            is_active_branch: true,
            is_hidden: false,
            is_synthetic: true,
            payload_ref: sSpill.payload_ref,
            blocks: [{ idx: 0, type: 'text', text: sSpill.text, blob_sha256: sSpill.payload_ref }],
          });
          prevId = id;
        }
      } else if (evtType === 'agent/inbox/spliced' || evtType === 'command/run') {
        let text = '';
        if (evtType === 'agent/inbox/spliced' && dObj && Array.isArray(dObj['inserted'])) {
          const parts: string[] = [];
          for (const item of dObj['inserted'] as unknown[]) {
            const obj = asObj(item);
            if (obj && Array.isArray(obj['content'])) {
              const extracted = extractContentPartsText(obj['content'] as unknown[]).text;
              if (extracted) parts.push(extracted);
            } else if (typeof item === 'string') {
              parts.push(item);
            }
          }
          text = parts.length > 0 ? `[inbox spliced] ${parts.join('\n')}` : JSON.stringify(data ?? '');
        } else {
          text = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        }
        const nSpill = pushSpillable(`note:${seq}`, text);
        const id = `dsh-${seq}`;
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'system_note',
          created_at: latestTime,
          text: nSpill.text,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          payload_ref: nSpill.payload_ref,
          blocks: [{ idx: 0, type: 'text', text: nSpill.text, blob_sha256: nSpill.payload_ref }],
        });
        prevId = id;
      } else if (evtType.startsWith('compaction/')) {
        const id = `dsh-${seq}`;
        const summary = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        turns.push({
          external_id: id,
          parent_external_id: prevId,
          ordinal: ordinal++,
          role: 'system',
          kind: 'compaction',
          created_at: latestTime,
          text: summary,
          is_active_branch: true,
          is_hidden: false,
          is_synthetic: true,
          blocks: [{ idx: 0, type: 'text', text: summary }],
        });
        prevId = id;
      }
    }

    // Attach orphan session-level attachments if any were not referenced inline
    if ((this.nativeData.attachments?.length ?? 0) > 0 && turns.length > 0) {
      const referencedShas = new Set<string>();
      for (const t of turns) {
        for (const b of t.blocks) {
          if (b.blob_sha256) referencedShas.add(b.blob_sha256);
        }
      }
      const unreferenced = (this.nativeData.attachments ?? []).filter((a) => !referencedShas.has(a.sha256));
      if (unreferenced.length > 0) {
        const targetTurn = turns.find((t) => t.role === 'user') ?? turns[0]!;
        for (const att of unreferenced) {
          targetTurn.blocks.push({
            idx: targetTurn.blocks.length,
            type: att.mime.startsWith('image/') ? 'image' : 'file',
            text: att.name,
            blob_sha256: att.sha256,
            availability: 'full',
            meta: { file_name: att.name, mime: att.mime },
          });
        }
      }
    }

    return turns;
  }
}

export class DshLocalAdapter implements Adapter<DshNativeSession> {
  readonly id: ProviderId = 'dsh-local';

  async probe(src: SourceRef): Promise<ProbeResult | null> {
    const evidence: string[] = [];
    const entries: string[] = [];
    const warnings: string[] = [];
    let confidence = 0;

    if (src.kind === 'dir') {
      const base = path.basename(src.path).toLowerCase();
      if (base === '.dsh' || fs.existsSync(path.join(src.path, 'sessions'))) {
        confidence = 0.95;
        evidence.push(`Found DSH sessions directory in: ${src.path}`);
        this.collectSessionFiles(path.join(src.path, 'sessions'), entries, 5000);
      } else {
        this.collectSessionFiles(src.path, entries, 5000);
        if (entries.length > 0) {
          confidence = 0.9;
          evidence.push(`Found ${entries.length} DSH session file(s) in: ${src.path}`);
        }
      }
    } else if (src.kind === 'file') {
      const base = path.basename(src.path);
      if (/^session(\.v\d+)?\.jsonl(\.zst|\.zstd)?$/i.test(base)) {
        confidence = 0.98;
        evidence.push(`Matched DSH session file pattern: ${base}`);
        entries.push(src.path);
      }
    }

    if (confidence <= 0) return null;

    return {
      adapterId: this.id,
      version: 'v4',
      confidence,
      evidence,
      entries,
      warnings,
    };
  }

  private collectSessionFiles(dir: string, out: string[], limit: number, depth = 0): void {
    if (depth > 5 || out.length >= limit) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this.collectSessionFiles(full, out, limit, depth + 1);
        } else if (/^session(\.v\d+)?\.jsonl(\.zst|\.zstd)?$/i.test(entry.name)) {
          out.push(full);
          if (out.length >= limit) break;
        }
      }
    } catch {
      // ignore
    }
  }

  private discoverAttachments(filePath: string, sessionId: string | null): string[] {
    const found = new Set<string>();
    const sessionDir = path.dirname(filePath);
    const candidates: string[] = [path.join(sessionDir, 'attachments')];

    // Traverse upwards looking for sibling .dsh/attachments/<sessionId> or .dsh/attachments/v1/<sessionId>
    let cur = sessionDir;
    for (let i = 0; i < 4; i++) {
      const attRoot = path.join(cur, 'attachments');
      if (fs.existsSync(attRoot) && sessionId) {
        const scoped = path.join(attRoot, sessionId);
        if (fs.existsSync(scoped)) candidates.push(scoped);
        const scopedV1 = path.join(attRoot, 'v1', sessionId);
        if (fs.existsSync(scopedV1)) candidates.push(scopedV1);
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }

    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      try {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (ent.isFile()) {
            found.add(path.join(dir, ent.name));
          }
        }
      } catch {
        // ignore
      }
    }

    return [...found];
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

  async parse(task: ImportTask, ctx: ParseCtx): Promise<SessionDocument<DshNativeSession>[]> {
    const filePath = task.entry ?? task.src.path;
    ctx.log('info', `DshLocalAdapter parsing: ${filePath}`);

    let buf: Buffer;
    try {
      buf = readBufferMaybeZstd(filePath);
    } catch (err) {
      ctx.log('error', `Failed reading DSH session file: ${(err as Error).message}`);
      return [];
    }

    let sessionId: string | null = null;
    let title: string | null = null;
    let cwd: string | null = null;
    let defaultModel: string | null = null;
    let parentSession: string | null = null;
    let origin: string | null = null;
    let createdAt: number | null = null;
    let updatedAt: number | null = null;
    let agentPreset: string | null = null;
    let delegationDepth: number | null = null;
    let permissionPreset: string | null = null;
    let sandboxMode: string | null = null;

    const events: DshNativeEvent[] = [];
    const parseIssues: IntegrityIssue[] = [];
    const spills: Record<string, DshSpillRef> = {};

    const maybeSpillText = async (key: string, text: string): Promise<void> => {
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes <= SPILL_THRESHOLD_BYTES) return;
      const sha256 = await ctx.spill(text);
      spills[key] = { sha256, bytes, preview: text.slice(0, 512) };
    };

    let pendingAssistantText = '';
    let pendingAssistantSeq: number | undefined;
    let pendingAssistantTime: number | undefined;
    let pendingReasoningText = '';
    let pendingReasoningSeq: number | undefined;
    let pendingReasoningTime: number | undefined;
    let pendingToolCallText = '';
    let pendingToolCallSeq: number | undefined;
    let pendingToolCallTime: number | undefined;

    const flushPendingChunks = () => {
      if (pendingReasoningText.length > 0) {
        events.push({
          type: 'assistant/reasoning',
          seq: pendingReasoningSeq,
          time: pendingReasoningTime,
          data: pendingReasoningText,
        });
        pendingReasoningText = '';
        pendingReasoningSeq = undefined;
        pendingReasoningTime = undefined;
      }
      if (pendingToolCallText.length > 0) {
        events.push({
          type: 'tool/call',
          seq: pendingToolCallSeq,
          time: pendingToolCallTime,
          data: pendingToolCallText,
        });
        pendingToolCallText = '';
        pendingToolCallSeq = undefined;
        pendingToolCallTime = undefined;
      }
      if (pendingAssistantText.length > 0) {
        events.push({
          type: 'assistant/message',
          seq: pendingAssistantSeq,
          time: pendingAssistantTime,
          data: pendingAssistantText,
        });
        pendingAssistantText = '';
        pendingAssistantSeq = undefined;
        pendingAssistantTime = undefined;
      }
    };

    let fallbackSeq = 0;
    for (const line of iterJsonLines(buf)) {
      let record: DshNativeEvent;
      try {
        record = JSON.parse(line) as DshNativeEvent;
      } catch {
        parseIssues.push({
          code: 'truncated_stream',
          severity: 'warn',
          message: `Malformed or truncated DSH event line skipped in ${path.basename(filePath)}`,
        });
        continue;
      }

      const evtType = typeof record.type === 'string' ? record.type : '';
      const rawTime =
        typeof record.time === 'number'
          ? record.time
          : typeof record['createdAt'] === 'number'
            ? (record['createdAt'] as number)
            : undefined;
      if (typeof rawTime === 'number') {
        const ms = rawTime < 10000000000 ? rawTime * 1000 : rawTime;
        if (!createdAt) createdAt = ms;
        updatedAt = ms;
      }

      if (evtType === 'assistant/chunk' || evtType === 'text-chunks') {
        pendingAssistantText += extractChunkDeltaText(record.data);
        pendingAssistantSeq = pendingAssistantSeq ?? record.seq;
        pendingAssistantTime = rawTime ?? pendingAssistantTime;
        continue;
      }
      if (evtType === 'reasoning-chunks') {
        pendingReasoningText += extractChunkDeltaText(record.data);
        pendingReasoningSeq = pendingReasoningSeq ?? record.seq;
        pendingReasoningTime = rawTime ?? pendingReasoningTime;
        continue;
      }
      if (evtType === 'tool-call-chunks') {
        pendingToolCallText += extractChunkDeltaText(record.data);
        pendingToolCallSeq = pendingToolCallSeq ?? record.seq;
        pendingToolCallTime = rawTime ?? pendingToolCallTime;
        continue;
      }

      if (evtType === 'assistant/message') {
        pendingAssistantText = '';
        pendingAssistantSeq = undefined;
        pendingAssistantTime = undefined;
      } else if (evtType === 'assistant/reasoning') {
        pendingReasoningText = '';
        pendingReasoningSeq = undefined;
        pendingReasoningTime = undefined;
      } else if (evtType === 'tool/call') {
        pendingToolCallText = '';
        pendingToolCallSeq = undefined;
        pendingToolCallTime = undefined;
      } else {
        flushPendingChunks();
      }

      const data = record.data as Record<string, unknown> | string | undefined;
      const dObj = asObj(data);
      const seq = typeof record.seq === 'number' ? record.seq : fallbackSeq++;
      partitionVendorFields(record, KNOWN_EVENT_KEYS, ctx);

      if (evtType === 'session') {
        // Real DSH v4 stores `id`, `cwd`, `parentSession`, `origin`, etc. on the top-level object;
        // legacy/fixture tests may nest them under `data`. Support both.
        const metaObj = dObj ?? (record as Record<string, unknown>);
        sessionId = typeof metaObj['id'] === 'string' ? metaObj['id'] : sessionId;
        cwd = typeof metaObj['cwd'] === 'string' ? metaObj['cwd'] : cwd;
        parentSession =
          typeof metaObj['parentSession'] === 'string' ? metaObj['parentSession'] : parentSession;
        origin = typeof metaObj['origin'] === 'string' ? metaObj['origin'] : origin;
        agentPreset =
          typeof metaObj['agentPreset'] === 'string' ? metaObj['agentPreset'] : agentPreset;
        delegationDepth =
          typeof metaObj['delegationDepth'] === 'number'
            ? metaObj['delegationDepth']
            : delegationDepth;
      } else if (evtType === 'session/title') {
        if (typeof data === 'string') {
          title = data;
        } else if (dObj && typeof dObj['title'] === 'string') {
          title = dObj['title'];
        }
      } else if (evtType === 'request/header' && dObj) {
        const hdr = asObj(dObj['header']);
        const cfg = hdr ? asObj(hdr['config']) : null;
        if (!defaultModel && typeof cfg?.['model'] === 'string') {
          defaultModel = cfg['model'];
        }
      } else if (evtType === 'request/context' && dObj) {
        if (!defaultModel && typeof dObj['model'] === 'string') {
          defaultModel = dObj['model'];
        }
      } else if (evtType === 'permission/preset' && typeof data === 'string') {
        permissionPreset = data;
      } else if (evtType === 'permission/preset' && dObj && typeof dObj['preset'] === 'string') {
        permissionPreset = dObj['preset'];
      } else if (evtType === 'sandbox/mode' && typeof data === 'string') {
        sandboxMode = data;
      } else if (evtType === 'sandbox/mode' && dObj && typeof dObj['mode'] === 'string') {
        sandboxMode = dObj['mode'];
      } else if (evtType === 'user/message' && dObj) {
        const t =
          typeof dObj['text'] === 'string'
            ? dObj['text']
            : Array.isArray(dObj['content'])
              ? extractContentPartsText(dObj['content'] as unknown[]).text
              : '';
        if (t) await maybeSpillText(`user:${seq}`, t);
      } else if (evtType === 'assistant/message' && dObj) {
        const msgObj = asObj(dObj['message']);
        const srcObj = asObj(dObj['source']);
        if (!defaultModel && typeof srcObj?.['model'] === 'string') {
          defaultModel = srcObj['model'];
        }
        if (msgObj && Array.isArray(msgObj['content'])) {
          const parsed = extractContentPartsText(msgObj['content'] as unknown[]);
          if (parsed.reasoning) await maybeSpillText(`asst-r:${seq}`, parsed.reasoning);
          if (parsed.text) await maybeSpillText(`asst-t:${seq}`, parsed.text);
          for (let tIdx = 0; tIdx < parsed.toolCalls.length; tIdx++) {
            const args = parsed.toolCalls[tIdx]!.arguments;
            if (args) await maybeSpillText(`asst-tc:${seq}:${tIdx}`, args);
          }
        }
      } else if (evtType === 'assistant/reasoning') {
        const t =
          typeof data === 'string'
            ? data
            : dObj && typeof dObj['text'] === 'string'
              ? dObj['text']
              : '';
        if (t) await maybeSpillText(`reas:${seq}`, t);
      } else if (evtType === 'tool/call' && dObj) {
        const args =
          typeof dObj['arguments'] === 'string'
            ? dObj['arguments']
            : dObj['arguments'] !== undefined
              ? JSON.stringify(dObj['arguments'])
              : '';
        if (args) await maybeSpillText(`tcall:${seq}`, args);
      } else if (evtType === 'tool/result' && dObj) {
        const msgObj = asObj(dObj['message']);
        const t =
          msgObj && Array.isArray(msgObj['content'])
            ? extractContentPartsText(msgObj['content'] as unknown[]).text
            : typeof dObj['output'] === 'string'
              ? dObj['output']
              : typeof dObj['text'] === 'string'
                ? dObj['text']
                : '';
        if (t) await maybeSpillText(`tres:${seq}`, t);
      } else if (evtType === 'system/message' && dObj) {
        const msgObj = asObj(dObj['message']);
        const t =
          msgObj && Array.isArray(msgObj['content'])
            ? extractContentPartsText(msgObj['content'] as unknown[]).text
            : '';
        if (t) await maybeSpillText(`sys:${seq}`, t);
      }

      events.push(record);
    }

    flushPendingChunks();

    // Never fall back to `path.basename(filePath)` (which is always `session.v4.jsonl.zstd` across sessions!);
    // use parent directory name (`session-<uuid>` / `<uuid>`) when the header lacked an `id`.
    const effectiveSessionId = sessionId ?? path.basename(path.dirname(filePath));
    if (events.length === 0) return [];

    const attachmentFiles = this.discoverAttachments(filePath, effectiveSessionId);
    const attachments: DshAttachmentRef[] = [];
    const blobs: BlobAsset[] = [];

    for (const attPath of attachmentFiles) {
      try {
        const rawBytes = fs.readFileSync(attPath);
        const name = path.basename(attPath);
        const mime = inferMimeFromFilename(name);
        await ctx.persistRaw(`dsh-attachments/${effectiveSessionId}/${name}`, rawBytes);
        const sha = await ctx.spill(rawBytes);
        const ext = path.extname(name) || '.bin';
        const sniffedExt =
          rawBytes.length >= 8 && rawBytes[0] === 0x89 && rawBytes[1] === 0x50 ? '.png'
            : rawBytes.length >= 3 && rawBytes[0] === 0xff && rawBytes[1] === 0xd8 ? '.jpg'
              : rawBytes.length >= 4 && rawBytes[0] === 0x25 && rawBytes[1] === 0x50 ? '.pdf'
                : '.bin';
        const relPath = `blobs/${sha.slice(0, 2)}/${sha}${sniffedExt}`;

        attachments.push({
          name,
          mime,
          bytes: rawBytes.byteLength,
          sha256: sha,
          rel_path: relPath,
          source_path: attPath,
        });
        blobs.push({
          sha256: sha,
          mime,
          bytes: rawBytes.byteLength,
          ext: ext ?? sniffedExt,
          rel_path: relPath,
          origin_kind: 'attachment',
          created_at: Date.now(),
        });
      } catch (err) {
        parseIssues.push({
          code: 'parse_error',
          severity: 'warn',
          message: `Failed reading DSH attachment ${attPath}: ${(err as Error).message}`,
        });
      }
    }

    const nativeSession: DshNativeSession = {
      session_id: effectiveSessionId,
      source_file: filePath,
      title,
      cwd,
      default_model: defaultModel,
      parent_session: parentSession,
      origin,
      agent_preset: agentPreset,
      delegation_depth: delegationDepth,
      permission_preset: permissionPreset,
      sandbox_mode: sandboxMode,
      attachments: attachments.length > 0 ? attachments : undefined,
      spills: Object.keys(spills).length > 0 ? spills : undefined,
      events,
    };

    return [new DshSessionDocument(nativeSession, createdAt, updatedAt, parseIssues, blobs)];
  }
}

export const dshLocalAdapter = new DshLocalAdapter();
