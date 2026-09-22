import type { Context, Message } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { buildJevContext, estimateJevTextTokens } from './context';
import { message } from './test/fixtures';

const user = (text: string): Message => ({
  role: 'user',
  content: text,
  timestamp: 1,
});
const tool = (
  text: string,
  isError = false,
): Extract<Message, { role: 'toolResult' }> => ({
  role: 'toolResult',
  toolName: 'bash',
  toolCallId: 'call',
  timestamp: 2,
  isError,
  content: [{ type: 'text', text }],
});
const options = {
  previousTurns: 2,
  maxHistoryTokens: 1500,
  toolResults: 'last' as const,
  maxToolTokens: 250,
};

describe('buildJevContext', () => {
  it('defaults to two previous turns and only the last native error', () => {
    const context: Context = {
      messages: [
        user('OLD_TASK'),
        message({ content: [{ type: 'text', text: 'OLD_ANSWER' }] }),
        user('previous task'),
        message({ content: [{ type: 'text', text: 'previous answer' }] }),
        user('recent task'),
        tool('failed once', true),
        tool('ERROR appears in successful output', false),
        message({ content: [{ type: 'text', text: 'recent answer' }] }),
        user('now'),
      ],
    };
    const result = buildJevContext(context, 12000);
    expect(result.state.recentDialogue.map((entry) => entry.text)).toEqual([
      'previous task',
      'previous answer',
      'recent task',
      'recent answer',
    ]);
    expect(result.state.recentToolEvidence).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('OLD_');
    const failed = buildJevContext(
      { messages: [user('task'), tool('nonzero exit', true), user('fix')] },
      12000,
    );
    expect(failed.state.recentToolEvidence).toEqual([
      { text: 'nonzero exit', isError: true, truncated: false },
    ]);
  });

  it('does not resurrect an old failure after a successful binary-only tool result', () => {
    const result = buildJevContext(
      {
        messages: [
          user('task'),
          tool('OLD_FAILURE', true),
          {
            ...tool(''),
            content: [
              { type: 'image', data: 'PRIVATE_IMAGE', mimeType: 'image/png' },
            ],
          },
          user('now'),
        ],
      },
      12000,
    );
    expect(result.state.recentToolEvidence).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/OLD_FAILURE|PRIVATE_IMAGE/);
  });
  it('keeps user-turn anchors and the last text answer despite many tool calls', () => {
    const context: Context = {
      messages: [
        user('Design a parser'),
        message({ content: [{ type: 'text', text: 'I will inspect it' }] }),
        ...Array.from({ length: 10 }, () =>
          message({
            content: [
              {
                type: 'toolCall',
                id: 'call',
                name: 'read',
                arguments: { secret: 'PRIVATE_ARGUMENTS' },
              },
            ],
          }),
        ),
        tool('output '.repeat(2000)),
        message({
          content: [
            {
              type: 'text',
              text: 'Option 1: recursive descent. Option 2: Pratt parser.',
            },
          ],
        }),
        user('Сделай второй вариант'),
      ],
    };
    const result = buildJevContext(context, 12000, options);
    expect(result.state.currentRequest.text).toBe('Сделай второй вариант');
    expect(result.state.recentDialogue.map((entry) => entry.text)).toEqual([
      'Design a parser',
      'Option 1: recursive descent. Option 2: Pratt parser.',
    ]);
    expect(
      estimateJevTextTokens(result.state.recentToolEvidence[0]?.text ?? ''),
    ).toBeLessThanOrEqual(250);
    expect(result.state.recentToolEvidence[0]?.truncated).toBe(true);
    expect(result.metrics.historyTurns).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('preserves the end of a long current request before allocating older history', () => {
    const result = buildJevContext(
      {
        messages: [
          user('old'),
          tool('irrelevant'),
          user(`BEGIN ${'x'.repeat(20000)} END INSTRUCTION`),
        ],
      },
      400,
      options,
    );
    expect(result.state.currentRequest.text).toMatch(
      /^BEGIN .*END INSTRUCTION$/s,
    );
    expect(
      estimateJevTextTokens(result.state.currentRequest.text),
    ).toBeLessThanOrEqual(400);
    expect(result.state.currentRequest.truncated).toBe(true);
    expect(result.state.recentDialogue).toEqual([]);
    expect(result.state.recentToolEvidence).toEqual([]);
    expect(
      result.metrics.currentRequestTokens +
        result.metrics.historyTokens +
        result.metrics.toolTokens,
    ).toBeLessThanOrEqual(400);
  });

  it('can disable dialogue and tools independently', () => {
    const context: Context = {
      messages: [
        user('old'),
        tool('evidence'),
        message({ content: [{ type: 'text', text: 'answer' }] }),
        user('now'),
      ],
    };
    const minimal = buildJevContext(context, 1000, {
      ...options,
      previousTurns: 0,
      toolResults: 'none',
    });
    expect(minimal.state.recentDialogue).toEqual([]);
    expect(minimal.state.recentToolEvidence).toEqual([]);
    const evidence = buildJevContext(context, 1000, {
      ...options,
      previousTurns: 0,
    });
    expect(evidence.state.recentToolEvidence[0]?.text).toBe('evidence');
  });

  it('never carries an old failed result into a later unrelated turn', () => {
    const result = buildJevContext(
      {
        messages: [
          user('old task'),
          tool('OLD_FAILURE', true),
          user('new task'),
          message({ content: [{ type: 'text', text: 'new answer' }] }),
          user('follow up'),
          tool('FUTURE_RESULT', true),
        ],
      },
      12000,
      options,
    );
    expect(result.state.recentToolEvidence).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/OLD_FAILURE|FUTURE_RESULT/);
  });

  it('excludes system prompts, tool schemas, arguments, thinking and binary blocks', () => {
    const context: Context = {
      systemPrompt: 'PRIVATE_SYSTEM',
      tools: [
        { name: 'private', description: 'PRIVATE_SCHEMA', parameters: {} },
      ],
      messages: [
        user('before'),
        message({
          content: [
            { type: 'thinking', thinking: 'PRIVATE_THINKING' },
            {
              type: 'toolCall',
              id: 'call',
              name: 'bash',
              arguments: { secret: 'PRIVATE_ARGS' },
            },
          ],
        }),
        {
          ...tool('public error', true),
          content: [
            { type: 'text', text: 'public error' },
            { type: 'image', data: 'PRIVATE_IMAGE', mimeType: 'image/png' },
          ],
        },
        user('fix it'),
      ],
    };
    const result = buildJevContext(context, 12000, options);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.state.recentToolEvidence[0]?.isError).toBe(true);
  });

  it.each([1, 3, 4, 5])(
    'does not split Unicode surrogate pairs at budget %s',
    (budget) => {
      const result = buildJevContext(
        { messages: [user('😀reference😄')] },
        budget,
        options,
      );
      const text = result.state.currentRequest.text;
      expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(
        text,
      );
      expect(estimateJevTextTokens(text)).toBeLessThanOrEqual(budget);
    },
  );

  it.each([1, 2, 3, 50, 1000, 4000, 12000])(
    'respects the total text budget %s',
    (budget) => {
      const context: Context = {
        messages: [
          user('a'.repeat(4000)),
          message({ content: [{ type: 'text', text: 'b'.repeat(4000) }] }),
          tool('c'.repeat(10000)),
          user('new'),
        ],
      };
      const result = buildJevContext(context, budget, options);
      expect(
        result.metrics.currentRequestTokens +
          result.metrics.historyTokens +
          result.metrics.toolTokens,
      ).toBeLessThanOrEqual(budget);
      expect(result.metrics.historyTokens).toBeLessThanOrEqual(
        options.maxHistoryTokens,
      );
      expect(result.metrics.toolTokens).toBeLessThanOrEqual(
        options.maxToolTokens,
      );
    },
  );
});
