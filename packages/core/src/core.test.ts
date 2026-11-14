import { describe, expect, it } from 'vitest';
import {
  AnthropicSessionDocument,
  OpenAiSessionDocument,
} from '@sm/adapters';
import { decideConversationMerge } from './deduper.js';
import { buildBatchDiffStats } from './diff-reporter.js';
import { formatConversationMarkdown } from './exporter.js';

describe('@sm/core polymorphic SessionDocument pipeline', () => {
  it('validates OpenAI native mapping tree, repairs orphan nodes, and extracts ViewModel', () => {
    const doc = new OpenAiSessionDocument({
      conversation_id: 'conv-1',
      current_node: 'item-1',
      mapping: {
        'item-1': {
          id: 'item-1',
          parent: 'missing-parent',
          message: {
            id: 'item-1',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['First prompt for title'] },
          },
        },
        'item-a': {
          id: 'item-a',
          parent: 'item-b',
          message: {
            id: 'item-a',
            author: { role: 'assistant' },
            content: { content_type: 'text', parts: ['Cycle A'] },
          },
        },
        'item-b': {
          id: 'item-b',
          parent: 'item-a',
          message: {
            id: 'item-b',
            author: { role: 'user' },
            content: { content_type: 'text', parts: ['Cycle B'] },
          },
        },
      },
    });

    const meta = doc.getMeta();
    const issues = doc.validate();
    const chunks = doc.extractSearchChunks();
    const view = doc.toViewModel();

    expect(meta.title).toBe('First prompt for title');
    expect(meta.title_source).toBe('first_user');
    expect(meta.raw_format).toBe('openai-web/v2');
    expect(issues.some((i) => i.code === 'orphan_node')).toBe(true);
    expect(issues.some((i) => i.code === 'cycle_detected')).toBe(true);
    expect(chunks).toHaveLength(3);
    expect(view.nodes).toHaveLength(3);
    expect(formatConversationMarkdown(doc)).toContain('raw_format: openai-web/v2');
  });

  it('detects Anthropic text vs content[] mismatch and extracted_only attachment', () => {
    const doc = new AnthropicSessionDocument({
      uuid: 'anth-1',
      name: 'Claude Session',
      chat_messages: [
        {
          uuid: 'm1',
          sender: 'human',
          text: 'Outdated fallback text',
          content: [{ type: 'text', text: 'Real content block text' }],
          attachments: [{ file_name: 'notes.pdf', extracted_content: 'PDF body' }],
        },
      ],
    });

    const issues = doc.validate();
    expect(issues.some((i) => i.code === 'text_content_mismatch')).toBe(true);
    expect(issues.some((i) => i.code === 'attachment_extracted_only')).toBe(true);
  });

  it('performs same-provider diffing and detects shrunk sessions', () => {
    const older = new OpenAiSessionDocument({
      conversation_id: 'conv-diff-1',
      title: 'Session',
      mapping: {
        m1: { id: 'm1', parent: null, message: { id: 'm1', author: { role: 'user' }, content: { parts: ['Hello'] } } },
        m2: { id: 'm2', parent: 'm1', message: { id: 'm2', author: { role: 'assistant' }, content: { parts: ['Hi'] } } },
      },
    });

    const shrunkNewer = new OpenAiSessionDocument({
      conversation_id: 'conv-diff-1',
      title: 'Session',
      mapping: {
        m1: { id: 'm1', parent: null, message: { id: 'm1', author: { role: 'user' }, content: { parts: ['Hello'] } } },
      },
    });

    const diff = shrunkNewer.diffWith(older);
    expect(diff.status).toBe('shrunk');

    const batchDiff = buildBatchDiffStats([older], [shrunkNewer], 1);
    expect(batchDiff.shrunk_conversations).toBe(1);
    expect(batchDiff.shrunk_conversation_ids).toEqual(['conv-diff-1']);

    expect(decideConversationMerge(older, older)).toBe('identical');
  });
});
