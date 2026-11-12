/**
 * Synthetic Sample Builders for OCA Adapters & Pipeline Verification.
 * Dual-licensed under CC0-1.0 and MIT.
 */

export interface SyntheticOpenAiExport {
  conversations: Record<string, unknown>[];
  toJsonString(): string;
}

export interface SyntheticAnthropicExport {
  conversations: Record<string, unknown>[];
  toJsonString(): string;
}

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
              parts: ['How do I normalize conversation archives with OCA?'],
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
                'You normalize them by mapping provider formats into the four core entities: Conversation, Item, Block, and Blob.',
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
              extracted_content: 'OCA Intermediate Representation Specification v1',
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
