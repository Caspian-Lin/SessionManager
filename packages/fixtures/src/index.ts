/**
 * Synthetic Sample Builders for Polymorphic Session Adapters & Pipeline Verification.
 * Dual-licensed under CC0-1.0 and MIT.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { SPILL_THRESHOLD_BYTES, createZipBuffer, type ZipWriteEntry } from '@sm/shared';

export interface SyntheticOpenAiExport {
  conversations: Record<string, unknown>[];
  toJsonString(): string;
}

export interface RichSyntheticOpenAiExport {
  conversations: Record<string, unknown>[];
  shard0: Record<string, unknown>[];
  shard1: Record<string, unknown>[];
  assets: Map<string, Buffer>;
  pngShaInput: Buffer;
  jpgShaInput: Buffer;
  toZipBuffer(): Buffer;
  writeToDir(dirPath: string): void;
}

export interface SyntheticAnthropicExport {
  conversations: Record<string, unknown>[];
  toJsonString(): string;
}

export interface SyntheticDeepSeekExport {
  conversations: Record<string, unknown>[];
  toJsonString(): string;
}

export interface SyntheticCodexDirResult {
  rootDir: string;
  sessionIds: string[];
  sqlitePath: string;
  oversizedBytes: number;
  inlinePngBytes: Buffer;
}

export { createZipBuffer, type ZipWriteEntry };

/** Minimum valid 1x1 PNG binary bytes */
export const SYNTHETIC_PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex'
);

/** Minimum JPEG header + EOI bytes for magic-number sniffing */
export const SYNTHETIC_JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

/**
 * Builds a synthetic OpenAI ChatGPT web export structure adhering to docs/02 §2.
 */
export function createSyntheticOpenAiExport(): SyntheticOpenAiExport {
  const rootNodeId = 'root-node-000';
  const userMsgId = 'msg-user-001';
  const asstMsgId = 'msg-asst-002';
  const hiddenMsgId = 'msg-hidden-003';

  const conversations: Record<string, unknown>[] = [
    {
      id: 'conv-openai-synth-01',
      conversation_id: 'conv-openai-synth-01',
      title: 'Synthetic OpenAI Session',
      create_time: 1712345678.123,
      update_time: 1712345999.456,
      current_node: asstMsgId,
      default_model_slug: 'gpt-4o',
      is_archived: false,
      is_starred: false,
      mapping: {
        [rootNodeId]: {
          id: rootNodeId,
          parent: null,
          children: [userMsgId],
          message: null,
        },
        [userMsgId]: {
          id: userMsgId,
          parent: rootNodeId,
          children: [asstMsgId],
          message: {
            id: userMsgId,
            author: { role: 'user' },
            create_time: 1712345679.0,
            content: {
              content_type: 'text',
              parts: ['How do I validate and deduplicate conversation archives?'],
            },
            metadata: {
              is_visually_hidden_from_conversation: false,
              is_user_system_message: false,
            },
          },
        },
        [asstMsgId]: {
          id: asstMsgId,
          parent: userMsgId,
          children: [hiddenMsgId],
          message: {
            id: asstMsgId,
            author: { role: 'assistant' },
            create_time: 1712345685.0,
            content: {
              content_type: 'text',
              parts: [
                'Keep each provider format intact and implement the unified SessionDocument interface for validation, same-provider diffing, FTS indexing, and UI ViewModels.',
              ],
            },
            metadata: {
              model_slug: 'gpt-4o',
              feedback: 'thumbs_up',
              is_visually_hidden_from_conversation: false,
              is_user_system_message: false,
            },
          },
        },
        [hiddenMsgId]: {
          id: hiddenMsgId,
          parent: asstMsgId,
          children: [],
          message: {
            id: hiddenMsgId,
            author: { role: 'system' },
            create_time: 1712345686.0,
            content: {
              content_type: 'text',
              parts: ['User timezone context update: UTC+8'],
            },
            metadata: {
              is_visually_hidden_from_conversation: true,
              is_user_system_message: true,
            },
          },
        },
      },
    },
  ];

  return {
    conversations,
    toJsonString() {
      return JSON.stringify(conversations, null, 2);
    },
  };
}

/**
 * Rich OpenAI ChatGPT export builder covering:
 * - Multi-shard conversations (`conversations-000.json`, `conversations-001.json`)
 * - Branches / regenerate siblings (`is_active_branch: true` vs `false`)
 * - Orphan node (parent missing from mapping)
 * - Hidden message + noisy runtime timezone context
 * - `user_context_message_data` memory candidates (`about_user_message`, `about_model_message`)
 * - `.dat` binary assets aligned with `image_asset_pointer` (`file-service://`) and `attachments` (`sediment://`)
 * - ZIP archive & directory materialization helpers
 */
export function createRichSyntheticOpenAiExport(): RichSyntheticOpenAiExport {
  const conv1: Record<string, unknown> = {
    id: 'conv-openai-rich-01',
    conversation_id: 'conv-openai-rich-01',
    title: 'Rich OpenAI Multimodal & Branched Session',
    create_time: 1715000000.0,
    update_time: 1715000500.0,
    current_node: 'node-asst-active',
    default_model_slug: 'gpt-4o',
    is_archived: false,
    is_starred: true,
    mapping: {
      'node-root': {
        id: 'node-root',
        parent: null,
        children: ['node-sys-ctx'],
        message: null,
      },
      'node-sys-ctx': {
        id: 'node-sys-ctx',
        parent: 'node-root',
        children: ['node-user-1'],
        message: {
          id: 'node-sys-ctx',
          author: { role: 'system' },
          create_time: 1715000001.0,
          content: {
            content_type: 'user_editable_context',
            parts: [''],
          },
          metadata: {
            is_visually_hidden_from_conversation: true,
            is_user_system_message: true,
            user_context_message_data: {
              about_user_message: 'User timezone context update: UTC+8\nPrefers TypeScript and strict SQLite schemas.',
              about_model_message: 'Current date: 2026-11-14\nAlways verify with unit tests before concluding.',
            },
          },
        },
      },
      'node-noise-only': {
        id: 'node-noise-only',
        parent: 'node-sys-ctx',
        children: [],
        message: {
          id: 'node-noise-only',
          author: { role: 'system' },
          create_time: 1715000002.0,
          content: {
            content_type: 'text',
            parts: ['User timezone context update: UTC+8'],
          },
          metadata: {
            is_visually_hidden_from_conversation: true,
            is_user_system_message: true,
            user_context_message_data: {
              about_user_message: 'Timezone: Asia/Shanghai',
              about_model_message: 'Current time: 2026-11-14 12:00:00',
            },
          },
        },
      },
      'node-user-1': {
        id: 'node-user-1',
        parent: 'node-sys-ctx',
        children: ['node-asst-alt', 'node-asst-active'],
        message: {
          id: 'node-user-1',
          author: { role: 'user' },
          create_time: 1715000010.0,
          content: {
            content_type: 'multimodal_text',
            parts: [
              'Please inspect these two diagrams.',
              {
                content_type: 'image_asset_pointer',
                asset_pointer: 'file-service://file-synth-png-01',
                width: 1,
                height: 1,
              },
            ],
          },
          metadata: {
            is_visually_hidden_from_conversation: false,
            attachments: [
              {
                id: 'file-synth-png-01',
                name: 'diagram.png',
                mimeType: 'image/png',
              },
              {
                id: 'file_synth_jpg_02',
                url: 'sediment://file_synth_jpg_02',
                name: 'photo.jpg',
                mimeType: 'image/jpeg',
              },
            ],
          },
        },
      },
      'node-asst-alt': {
        id: 'node-asst-alt',
        parent: 'node-user-1',
        children: [],
        message: {
          id: 'node-asst-alt',
          author: { role: 'assistant' },
          create_time: 1715000020.0,
          content: {
            content_type: 'text',
            parts: ['First regenerated draft response (inactive branch).'],
          },
          metadata: { model_slug: 'gpt-4o' },
        },
      },
      'node-asst-active': {
        id: 'node-asst-active',
        parent: 'node-user-1',
        children: [],
        message: {
          id: 'node-asst-active',
          author: { role: 'assistant' },
          create_time: 1715000030.0,
          content: {
            content_type: 'text',
            parts: ['Final active branch response describing the two attached images.'],
          },
          metadata: { model_slug: 'gpt-4o' },
        },
      },
      'node-orphan-01': {
        id: 'node-orphan-01',
        parent: 'missing-parent-node-xyz',
        children: [],
        message: {
          id: 'node-orphan-01',
          author: { role: 'assistant' },
          create_time: 1715000040.0,
          content: {
            content_type: 'text',
            parts: ['Orphaned message recovered to root.'],
          },
          metadata: {},
        },
      },
    },
  };

  const conv2: Record<string, unknown> = {
    id: 'conv-openai-rich-02',
    conversation_id: 'conv-openai-rich-02',
    title: 'Second Shard OpenAI Session',
    create_time: 1715100000.0,
    update_time: 1715100100.0,
    current_node: 's2-asst-1',
    default_model_slug: 'o3-mini',
    mapping: {
      's2-user-1': {
        id: 's2-user-1',
        parent: null,
        children: ['s2-asst-1'],
        message: {
          id: 's2-user-1',
          author: { role: 'user' },
          create_time: 1715100010.0,
          content: { content_type: 'text', parts: ['Summarize shard 2'] },
        },
      },
      's2-asst-1': {
        id: 's2-asst-1',
        parent: 's2-user-1',
        children: [],
        message: {
          id: 's2-asst-1',
          author: { role: 'assistant' },
          create_time: 1715100020.0,
          content: { content_type: 'thoughts', parts: ['Thinking about shard 2...'] },
        },
      },
    },
  };

  const shard0 = [conv1];
  const shard1 = [conv2];
  const conversations = [...shard0, ...shard1];

  const assets = new Map<string, Buffer>([
    ['file-synth-png-01.dat', SYNTHETIC_PNG_BYTES],
    ['user-999/file_synth_jpg_02.dat', SYNTHETIC_JPEG_BYTES],
  ]);

  const manifest = {
    export_version: '2',
    shards: ['conversations-000.json', 'conversations-001.json'],
  };

  return {
    conversations,
    shard0,
    shard1,
    assets,
    pngShaInput: SYNTHETIC_PNG_BYTES,
    jpgShaInput: SYNTHETIC_JPEG_BYTES,
    toZipBuffer(): Buffer {
      const entries: ZipWriteEntry[] = [
        { name: 'export_manifest.json', data: JSON.stringify(manifest) },
        { name: 'conversations-000.json', data: JSON.stringify(shard0) },
        { name: 'conversations-001.json', data: JSON.stringify(shard1) },
      ];
      for (const [name, data] of assets.entries()) {
        entries.push({ name, data });
      }
      return createZipBuffer(entries);
    },
    writeToDir(dirPath: string): void {
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, 'export_manifest.json'), JSON.stringify(manifest, null, 2));
      fs.writeFileSync(path.join(dirPath, 'conversations-000.json'), JSON.stringify(shard0, null, 2));
      fs.writeFileSync(path.join(dirPath, 'conversations-001.json'), JSON.stringify(shard1, null, 2));
      for (const [name, data] of assets.entries()) {
        const dest = path.join(dirPath, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data);
      }
    },
  };
}

/**
 * Builds a complete synthetic `~/.codex` directory containing:
 * - `session_index.jsonl` (provider titles)
 * - `sessions/2026/06/13/rollout-*.jsonl.zst` (zstd-compressed rollout)
 * - `archived_sessions/` (duplicate session_id + archived-only rollout)
 * - `thread_history_1.sqlite` (`thread_turns` + `thread_items` covering all 8 `item_type`s,
 *   including >32KB `commandExecution` output & inline `data:image/png;base64,` `imageGeneration`)
 */
export function createSyntheticCodexDir(rootDir: string): SyntheticCodexDirResult {
  fs.mkdirSync(rootDir, { recursive: true });
  const activeDir = path.join(rootDir, 'sessions', '2026', '06', '13');
  const archivedDir = path.join(rootDir, 'archived_sessions');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(archivedDir, { recursive: true });

  const session1 = 'thread-codex-synth-01';
  const session2 = 'thread-codex-synth-02';
  const session3 = 'thread-codex-synth-03';

  // 1. session_index.jsonl
  const indexLines = [
    JSON.stringify({ id: session1, thread_name: 'Codex SQLite & Spill Architecture', updated_at: '2026-06-13T16:50:00Z' }),
    JSON.stringify({ id: session2, thread_name: 'Archived Codex Rollout Session', updated_at: '2026-06-10T10:00:00Z' }),
    JSON.stringify({ id: session3, thread_name: 'SQLite-Only Codex Thread', updated_at: '2026-06-14T08:00:00Z' }),
  ];
  fs.writeFileSync(path.join(rootDir, 'session_index.jsonl'), indexLines.join('\n') + '\n');

  // 2. Rollout for session1 (both in sessions/ and archived_sessions/ to test deduplication)
  const rollout1Lines = [
    JSON.stringify({
      timestamp: '2026-06-13T16:44:08.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: {
        session_id: session1,
        cwd: 'c:\\Users\\Lab\\SessionManager',
        originator: 'Codex Desktop',
        cli_version: '0.140.0',
        model_provider: 'openai',
        base_instructions: 'HUGE_SYSTEM_PROMPT_'.repeat(500),
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-13T16:44:09.000Z',
      ordinal: 1,
      type: 'turn_context',
      payload: { turn_id: 'turn-1' },
    }),
    JSON.stringify({
      timestamp: '2026-06-13T16:44:10.000Z',
      ordinal: 2,
      type: 'response_item',
      payload: {
        role: 'user',
        content: [{ type: 'input_text', text: 'Run tests and generate diagram' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-13T16:45:00.000Z',
      ordinal: 20,
      type: 'response_item',
      payload: {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Trailing unprojected rollout summary.' }],
      },
    }),
  ];
  const rollout1Zst = zlib.zstdCompressSync(Buffer.from(rollout1Lines.join('\n') + '\n', 'utf8'));
  fs.writeFileSync(path.join(activeDir, `rollout-20260613-${session1}.jsonl.zst`), rollout1Zst);
  // Duplicate in archived_sessions with fewer records (active sessions/ should win)
  const rollout1ArchivedZst = zlib.zstdCompressSync(
    Buffer.from(rollout1Lines.slice(0, 2).join('\n') + '\n', 'utf8')
  );
  fs.writeFileSync(path.join(archivedDir, `rollout-20260613-${session1}.jsonl.zst`), rollout1ArchivedZst);

  // 3. Rollout-only archived session2 (plain .jsonl)
  const rollout2Lines = [
    JSON.stringify({
      timestamp: '2026-06-10T09:00:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: {
        session_id: session2,
        cwd: 'c:\\Users\\Lab\\SessionManager',
        model_provider: 'openai',
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-10T09:00:05.000Z',
      ordinal: 1,
      type: 'response_item',
      payload: {
        role: 'user',
        content: [{ type: 'text', text: 'Inspect archived rollout file' }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-10T09:00:10.000Z',
      ordinal: 2,
      type: 'response_item',
      payload: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Archived rollout parsed cleanly.' }],
      },
    }),
  ];
  fs.writeFileSync(path.join(archivedDir, `rollout-20260610-${session2}.jsonl`), rollout2Lines.join('\n') + '\n');

  // 4. SQLite thread_history_1.sqlite
  const sqlitePath = path.join(rootDir, 'thread_history_1.sqlite');
  const oversizedOutput = 'LOG_LINE_OUTPUT_'.repeat(Math.ceil((SPILL_THRESHOLD_BYTES + 4096) / 16));
  const oversizedBytes = Buffer.byteLength(oversizedOutput, 'utf8');
  const inlineDataUri = `data:image/png;base64,${SYNTHETIC_PNG_BYTES.toString('base64')}`;

  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec(`
      CREATE TABLE thread_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        status TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        duration_ms INTEGER,
        first_user_item_id TEXT,
        final_agent_item_id TEXT,
        root_turn_id TEXT
      );
      CREATE TABLE thread_items (
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        item_id TEXT NOT NULL,
        rollout_ordinal INTEGER,
        created_at_ms INTEGER,
        item_json TEXT,
        item_type TEXT,
        updated_at_ordinal INTEGER,
        started_at_ms INTEGER,
        completed_at_ms INTEGER
      );
    `);

    const insertTurn = db.prepare(
      `INSERT INTO thread_turns (thread_id, turn_id, status, started_at, completed_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)`
    );
    insertTurn.run(session1, 'turn-1', 'completed', 1781369050000, 1781369090000, 40000);
    insertTurn.run(session3, 'turn-s3-1', 'completed', 1781424000000, 1781424010000, 10000);

    const insertItem = db.prepare(
      `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const itemsS1: [string, number, number, string, Record<string, unknown>][] = [
      ['item-user-1', 2, 1781369050000, 'userMessage', { content: [{ type: 'input_text', text: 'Run tests and generate diagram' }] }],
      ['item-reason-2', 3, 1781369051000, 'reasoning', { summary: ['Planning test execution and diagram synthesis.'] }],
      [
        'item-cmd-3',
        4,
        1781369052000,
        'commandExecution',
        { command: 'npx vitest run', cwd: 'c:\\Users\\Lab\\SessionManager', exitCode: 0, status: 'completed', aggregatedOutput: oversizedOutput },
      ],
      [
        'item-mcp-4',
        5,
        1781369055000,
        'mcpToolCall',
        { server: 'github', tool: 'list_issues', arguments: { state: 'open' }, result: { count: 3 }, status: 'completed' },
      ],
      [
        'item-fc-5',
        6,
        1781369058000,
        'fileChange',
        { changes: [{ path: 'src/index.ts', diff: '@@ -1,1 +1,2 @@\n+export const ok = true;' }], status: 'completed' },
      ],
      [
        'item-ws-6',
        7,
        1781369060000,
        'webSearch',
        { query: 'node:sqlite DatabaseSync readOnly', results: [{ title: 'Node.js SQLite Docs', url: 'https://nodejs.org/api/sqlite.html' }] },
      ],
      [
        'item-img-7',
        8,
        1781369065000,
        'imageGeneration',
        { prompt: 'Architecture diagram', result: inlineDataUri, status: 'completed' },
      ],
      ['item-agent-8', 9, 1781369070000, 'agentMessage', { text: 'All tests passed and diagram generated.' }],
    ];

    for (const [itemId, ord, ts, itemType, payload] of itemsS1) {
      insertItem.run(session1, 'turn-1', itemId, ord, ts, JSON.stringify(payload), itemType);
    }

    insertItem.run(
      session3,
      'turn-s3-1',
      's3-user-1',
      0,
      1781424000000,
      JSON.stringify({ text: 'Hello from SQLite-only thread' }),
      'userMessage'
    );
    insertItem.run(
      session3,
      'turn-s3-1',
      's3-agent-2',
      1,
      1781424005000,
      JSON.stringify({ text: 'SQLite-only thread reply' }),
      'agentMessage'
    );
  } finally {
    db.close();
  }

  return {
    rootDir,
    sessionIds: [session1, session2, session3],
    sqlitePath,
    oversizedBytes,
    inlinePngBytes: SYNTHETIC_PNG_BYTES,
  };
}

/**
 * Builds a synthetic Anthropic Claude web export structure adhering to docs/02 §3.
 */
export function createSyntheticAnthropicExport(): SyntheticAnthropicExport {
  const conversations: Record<string, unknown>[] = [
    {
      uuid: 'conv-anthropic-synth-01',
      name: 'Synthetic Claude Conversation',
      created_at: '2026-01-15T10:30:00.000Z',
      updated_at: '2026-01-15T10:35:00.000Z',
      account: {
        uuid: 'acct-synth-uuid-999',
      },
      chat_messages: [
        {
          uuid: 'anth-msg-001',
          sender: 'human',
          created_at: '2026-01-15T10:30:01.000Z',
          text: 'Can you analyze this project architecture?',
          content: [
            {
              type: 'text',
              text: 'Can you analyze this project architecture?',
            },
          ],
          attachments: [
            {
              file_name: 'spec.txt',
              file_type: 'text/plain',
              extracted_content: 'Polymorphic SessionDocument Specification v1',
            },
          ],
          files: [],
        },
        {
          uuid: 'anth-msg-002',
          sender: 'assistant',
          created_at: '2026-01-15T10:30:10.000Z',
          text: 'I have analyzed the specification. The four-tier model is clean and extensible.',
          content: [
            {
              type: 'thinking',
              thinking: 'Checking the architectural fit for dual FTS indexing and MinHash deduplication.',
            },
            {
              type: 'tool_use',
              id: 'toolu_synth_01',
              name: 'lookup_spec',
              input: { section: 'hash_spec' },
            },
            {
              type: 'text',
              text: 'I have analyzed the specification. The four-tier model is clean and extensible.',
            },
          ],
          attachments: [],
          files: [],
        },
      ],
    },
  ];

  return {
    conversations,
    toJsonString() {
      return JSON.stringify(conversations, null, 2);
    },
  };
}

/**
 * Builds a synthetic DeepSeek web export with `reasoning_content`.
 */
export function createSyntheticDeepSeekExport(): SyntheticDeepSeekExport {
  const conversations: Record<string, unknown>[] = [
    {
      id: 'conv-deepseek-synth-01',
      title: 'Synthetic DeepSeek Session',
      create_time: 1740000000,
      update_time: 1740000120,
      model: 'deepseek-reasoner',
      messages: [
        {
          id: 'dsk-m1',
          role: 'user',
          create_time: 1740000010,
          content: 'Explain CJK trigram search routing.',
        },
        {
          id: 'dsk-m2',
          role: 'assistant',
          create_time: 1740000020,
          reasoning_content: 'Evaluating 2-char LIKE fallback vs 3+ char FTS5 trigram match.',
          content: 'Short 1-2 character CJK queries route to LIKE while 3+ character queries use FTS5 trigram.',
        },
      ],
    },
  ];

  return {
    conversations,
    toJsonString() {
      return JSON.stringify(conversations, null, 2);
    },
  };
}

/**
 * Builds a synthetic Claude Code JSONL stream adhering to docs/02 §6.
 */
export function createSyntheticClaudeCodeJsonl(): string {
  const sessionId = 'session-claude-code-synth-001';
  const cwd = 'c:\\Users\\Lab\\SessionManager';

  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'cc-user-01',
      parentUuid: null,
      sessionId,
      cwd,
      gitBranch: 'main',
      timestamp: '2026-03-01T12:00:00.000Z',
      isSidechain: false,
      userType: 'external',
      version: '1.0.0',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Refactor search-router to support trigram indexing' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'cc-asst-02',
      parentUuid: 'cc-user-01',
      sessionId,
      cwd,
      gitBranch: 'main',
      timestamp: '2026-03-01T12:00:05.000Z',
      isSidechain: false,
      userType: 'external',
      version: '1.0.0',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Determining CJK query length thresholds for LIKE vs trigram routing.' },
          {
            type: 'tool_use',
            id: 'toolu_cc_01',
            name: 'Bash',
            input: { command: 'node test.mjs' },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'cc-tool-03',
      parentUuid: 'cc-asst-02',
      sessionId,
      cwd,
      gitBranch: 'main',
      timestamp: '2026-03-01T12:00:08.000Z',
      isSidechain: false,
      userType: 'external',
      version: '1.0.0',
      message: {
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_cc_01',
            content: 'Executed test successfully.',
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'summary',
      summary: 'Completed test execution for FTS trigram index routing.',
      leafUuid: 'cc-tool-03',
    }),
  ];

  return lines.join('\n') + '\n';
}

/**
 * Builds a synthetic DSH v4 JSONL stream adhering to docs/02 §7.
 */
export function createSyntheticDshSessionJsonl(): string {
  const lines = [
    JSON.stringify({
      type: 'session',
      seq: 1,
      time: 1742000000,
      data: { id: 'dsh-synth-001', version: 4, cwd: 'c:\\Users\\Lab\\SessionManager', agentPreset: 'coder', delegationDepth: 0 },
    }),
    JSON.stringify({
      type: 'session/title',
      seq: 2,
      time: 1742000001,
      data: { title: 'Synthetic DSH v4 Session' },
    }),
    JSON.stringify({
      type: 'agent/inbox/spliced',
      seq: 3,
      time: 1742000002,
      data: 'Approval policy switched to workspace-write',
    }),
    JSON.stringify({
      type: 'user/message',
      seq: 4,
      time: 1742000005,
      data: 'Check multi-frame zstd decoding.',
    }),
    JSON.stringify({
      type: 'assistant/chunk',
      seq: 5,
      time: 1742000006,
      data: 'Partial chunk...',
    }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 6,
      time: 1742000010,
      data: 'Multi-frame zstd decoding verified via fzstd.',
    }),
    JSON.stringify({
      type: 'compaction/summary',
      seq: 7,
      time: 1742000015,
      data: 'Compacted earlier turns.',
    }),
  ];
  return lines.join('\n') + '\n';
}
