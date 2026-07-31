import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { extractResult } from './anthropic';

function usage() {
  return { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function fakeMessage(content: unknown[], stopReason: string = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage(),
  } as unknown as Anthropic.Message;
}

describe('extractResult (C3: web search results, not just queries)', () => {
  it('attaches result titles/urls to the matching query by tool_use_id', () => {
    const message = fakeMessage([
      { type: 'text', text: 'שלום' },
      { type: 'server_tool_use', id: 'tool_1', name: 'web_search', input: { query: 'תקנות בנייה 2026' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'tool_1',
        content: [
          { type: 'web_search_result', title: 'תקנות בנייה', url: 'https://example.com/a', encrypted_content: 'x', page_age: null },
          { type: 'web_search_result', title: 'עדכון תקנות', url: 'https://example.com/b', encrypted_content: 'y', page_age: null },
        ],
      },
    ]);

    const result = extractResult(message);

    expect(result.webSearches).toHaveLength(1);
    expect(result.webSearches[0].query).toBe('תקנות בנייה 2026');
    expect(result.webSearches[0].error).toBeUndefined();
    expect(result.webSearches[0].results).toEqual([
      { title: 'תקנות בנייה', url: 'https://example.com/a' },
      { title: 'עדכון תקנות', url: 'https://example.com/b' },
    ]);
  });

  it('translates a tool-result error object into Hebrew instead of leaving it unhandled', () => {
    const message = fakeMessage([
      { type: 'server_tool_use', id: 'tool_2', name: 'web_search', input: { query: 'שאילתה' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'tool_2',
        content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' },
      },
    ]);

    const result = extractResult(message);

    expect(result.webSearches).toHaveLength(1);
    expect(result.webSearches[0].results).toBeUndefined();
    expect(result.webSearches[0].error).toBe('מכסת החיפושים למשתתף זה מוצתה');
  });

  it('falls back to a generic Hebrew message for an unmapped error code', () => {
    const message = fakeMessage([
      { type: 'server_tool_use', id: 'tool_3', name: 'web_search', input: { query: 'שאילתה' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'tool_3',
        content: { type: 'web_search_tool_result_error', error_code: 'some_future_code' },
      },
    ]);

    const result = extractResult(message);
    expect(result.webSearches[0].error).toBe('חיפוש הרשת נכשל');
  });

  it('preserves query order across multiple searches in one call', () => {
    const message = fakeMessage([
      { type: 'server_tool_use', id: 'tool_a', name: 'web_search', input: { query: 'ראשון' } },
      { type: 'server_tool_use', id: 'tool_b', name: 'web_search', input: { query: 'שני' } },
      { type: 'web_search_tool_result', tool_use_id: 'tool_b', content: [] },
      { type: 'web_search_tool_result', tool_use_id: 'tool_a', content: [] },
    ]);

    const result = extractResult(message);
    expect(result.webSearches.map((w) => w.query)).toEqual(['ראשון', 'שני']);
  });

  it('returns no web searches when none were made', () => {
    const message = fakeMessage([{ type: 'text', text: 'תשובה רגילה' }]);
    const result = extractResult(message);
    expect(result.webSearches).toEqual([]);
    expect(result.text).toBe('תשובה רגילה');
  });
});
