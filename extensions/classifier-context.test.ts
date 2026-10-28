import type { Context, Message } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  buildClassifierContext,
  estimateClassifierTextTokens,
  notificationMessageIndices,
} from './context';
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
  currentLoopMessages: 8,
};

describe('buildClassifierContext', () => {
  it('keeps the task goal and bounded notification progress separate', () => {
    const result = buildClassifierContext(
      {
        messages: [
          user('diagnose the original failure'),
          tool('checks passed'),
          user('worker finished checking'),
        ],
      },
      3000,
      { ...options, toolResults: 'recent' },
      [2],
    );
    expect(result.state.currentRequest.text).toBe(
      'diagnose the original failure',
    );
    expect(result.state.recentDialogue).toContainEqual({
      role: 'user',
      text: 'worker finished checking',
      truncated: false,
    });
    expect(result.state.recentToolEvidence).toEqual([
      { text: 'checks passed', isError: false, truncated: false },
    ]);
  });

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
    const result = buildClassifierContext(context, 12000);
    expect(result.state.recentDialogue.map((entry) => entry.text)).toEqual([
      'previous task',
      'previous answer',
      'recent task',
      'recent answer',
    ]);
    expect(result.state.recentToolEvidence).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('OLD_');
    const failed = buildClassifierContext(
      { messages: [user('task'), tool('nonzero exit', true), user('fix')] },
      12000,
    );
    expect(failed.state.recentToolEvidence).toEqual([
      { text: 'nonzero exit', isError: true, truncated: false },
    ]);
  });

  it('does not resurrect an old failure after a successful binary-only tool result', () => {
    const result = buildClassifierContext(
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
    const result = buildClassifierContext(context, 12000, options);
    expect(result.state.currentRequest.text).toBe('Сделай второй вариант');
    expect(result.state.recentDialogue.map((entry) => entry.text)).toEqual([
      'Design a parser',
      'Option 1: recursive descent. Option 2: Pratt parser.',
    ]);
    expect(
      estimateClassifierTextTokens(
        result.state.recentToolEvidence[0]?.text ?? '',
      ),
    ).toBeLessThanOrEqual(250);
    expect(result.state.recentToolEvidence[0]?.truncated).toBe(true);
    expect(result.metrics.historyTurns).toBe(1);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('preserves the end of a long current request before allocating older history', () => {
    const result = buildClassifierContext(
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
      estimateClassifierTextTokens(result.state.currentRequest.text),
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
    const minimal = buildClassifierContext(context, 1000, {
      ...options,
      previousTurns: 0,
      toolResults: 'none',
    });
    expect(minimal.state.recentDialogue).toEqual([]);
    expect(minimal.state.recentToolEvidence).toEqual([]);
    const evidence = buildClassifierContext(context, 1000, {
      ...options,
      previousTurns: 0,
    });
    expect(evidence.state.recentToolEvidence[0]?.text).toBe('evidence');
  });

  it('includes bounded current-loop assistant and configured tool evidence', () => {
    const context: Context = {
      messages: [
        user('Implement retry handling, then update docs.'),
        message({
          content: [
            { type: 'text', text: 'I am tracing the request lifecycle.' },
          ],
        }),
        tool('One transient failure', true),
        message({
          content: [
            {
              type: 'text',
              text: 'The retry now passes; I am moving to documentation.',
            },
          ],
        }),
        message({
          content: [
            { type: 'thinking', thinking: 'PRIVATE_THINKING' },
            {
              type: 'toolCall',
              id: 'edit',
              name: 'edit',
              arguments: { secret: 'PRIVATE_ARGUMENT' },
            },
          ],
        }),
        tool('Changed extensions/provider.ts', false),
      ],
    };
    const result = buildClassifierContext(context, 2000, {
      ...options,
      toolResults: 'recent',
    });
    expect(result.state.currentRequest.text).toBe(
      'Implement retry handling, then update docs.',
    );
    expect(result.state.recentDialogue.map((entry) => entry.text)).toEqual([
      'I am tracing the request lifecycle.',
      'The retry now passes; I am moving to documentation.',
    ]);
    expect(result.state.recentToolEvidence.map((entry) => entry.text)).toEqual([
      'One transient failure',
      'Changed extensions/provider.ts',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_THINKING|PRIVATE_ARGUMENT/,
    );
    expect(
      result.metrics.historyTokens + result.metrics.toolTokens,
    ).toBeLessThanOrEqual(2000);
  });

  it('bounds current-loop messages and keeps the newest evidence within the shared budget', () => {
    const context: Context = {
      messages: [
        user('Fix the failure.'),
        ...Array.from({ length: 12 }, (_, index) =>
          message({
            content: [
              {
                type: 'text',
                text: `PROGRESS_${index} ${'x'.repeat(400)}`,
              },
            ],
          }),
        ),
        tool(`LATEST_RESULT ${'y'.repeat(400)}`, true),
      ],
    };
    const result = buildClassifierContext(context, 500, {
      ...options,
      maxHistoryTokens: 300,
      maxToolTokens: 250,
      currentLoopMessages: 4,
    });
    const visible = JSON.stringify(result.state);
    expect(visible).toContain('PROGRESS_11');
    expect(visible).toContain('LATEST_RESULT');
    expect(visible).not.toContain('PROGRESS_0');
    expect(
      result.metrics.currentRequestTokens +
        result.metrics.historyTokens +
        result.metrics.toolTokens,
    ).toBeLessThanOrEqual(500);
  });

  it('bounds multiple recent tool results and keeps the newest evidence', () => {
    const result = buildClassifierContext(
      {
        messages: [
          user('Check the current work.'),
          ...Array.from({ length: 4 }, (_, index) =>
            tool(`RESULT_${index} ${'x'.repeat(4000)}`),
          ),
        ],
      },
      500,
      { ...options, toolResults: 'recent', maxToolTokens: 250 },
    );
    expect(result.metrics.toolTokens).toBeLessThanOrEqual(250);
    expect(
      result.metrics.currentRequestTokens +
        result.metrics.historyTokens +
        result.metrics.toolTokens,
    ).toBeLessThanOrEqual(500);
    expect(JSON.stringify(result.state)).toContain('RESULT_3');
  });

  it('does not revive prior-task errors after a successful current-loop result', () => {
    const result = buildClassifierContext(
      {
        messages: [
          user('Old task'),
          tool('OLD_PRIVATE_FAILURE', true),
          user('New task'),
          message({ content: [{ type: 'text', text: 'Current work' }] }),
          tool('Current success'),
        ],
      },
      1000,
    );
    expect(result.state.recentToolEvidence).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('OLD_PRIVATE_FAILURE');
  });

  it.each([
    ['none', 0],
    ['last', 1],
    ['last-error', 0],
    ['recent', 2],
  ] as const)('keeps the %s tool-evidence exposure contract', (mode, count) => {
    const result = buildClassifierContext(
      {
        messages: [
          user('Current task'),
          tool('First error', true),
          tool('Last success'),
        ],
      },
      1000,
      { ...options, toolResults: mode },
    );
    expect(result.state.recentToolEvidence).toHaveLength(count);
  });

  it('reserves bounded progress context when the original goal is long', () => {
    const result = buildClassifierContext(
      {
        messages: [
          user(`GOAL ${'x'.repeat(20000)}`),
          message({
            content: [{ type: 'text', text: 'CURRENT_PROGRESS' }],
          }),
          tool('CURRENT_RESULT'),
        ],
      },
      500,
      { ...options, toolResults: 'last' },
    );
    expect(result.state.currentRequest.truncated).toBe(true);
    expect(JSON.stringify(result.state)).toContain('CURRENT_PROGRESS');
    expect(JSON.stringify(result.state)).toContain('CURRENT_RESULT');
    expect(
      result.metrics.currentRequestTokens +
        result.metrics.historyTokens +
        result.metrics.toolTokens,
    ).toBeLessThanOrEqual(500);
  });

  it('never carries an old failed result into a later unrelated turn', () => {
    const result = buildClassifierContext(
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
    expect(result.state.recentToolEvidence).toEqual([
      { text: 'FUTURE_RESULT', isError: true, truncated: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('OLD_FAILURE');
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
    const result = buildClassifierContext(context, 12000, options);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(result.state.recentToolEvidence[0]?.isError).toBe(true);
  });

  it.each([1, 3, 4, 5])(
    'does not split Unicode surrogate pairs at budget %s',
    (budget) => {
      const result = buildClassifierContext(
        { messages: [user('😀reference😄')] },
        budget,
        options,
      );
      const text = result.state.currentRequest.text;
      expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(
        text,
      );
      expect(estimateClassifierTextTokens(text)).toBeLessThanOrEqual(budget);
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
      const result = buildClassifierContext(context, budget, options);
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

describe('native notification provenance', () => {
  const entry = (
    details: unknown,
    customType = 'fixture-status',
  ): SessionEntry => ({
    type: 'custom_message',
    customType,
    details,
    id: 'notice',
    parentId: null,
    timestamp: new Date(1).toISOString(),
    content: 'worker finished',
    display: true,
  });
  const context: Context = { messages: [user('worker finished')] };
  it.each([
    [
      'explicit notification',
      { router: { intent: 'notification' } },
      'fixture-status',
      [0],
    ],
    ['known completion', undefined, 'subagent-notify', [0]],
    [
      'explicit steering',
      { router: { intent: 'steering' } },
      'subagent-notify',
      [],
    ],
    [
      'invalid completion intent',
      { router: { intent: 'invalid' } },
      'subagent-notify',
      [],
    ],
    ['unknown type', undefined, 'intercom_message', []],
    ['malformed details', { router: null }, 'fixture-status', []],
  ])(
    '%s uses provenance, not message wording',
    (_name, details, type, expected) => {
      expect(
        notificationMessageIndices(context, [entry(details, type)]),
      ).toEqual(expected);
    },
  );
  it('requires exact content and timestamp on the current native branch', () => {
    const native = entry({ router: { intent: 'notification' } });
    expect(notificationMessageIndices(context, [])).toEqual([]);
    expect(
      notificationMessageIndices(
        { messages: [{ ...user('worker finished'), timestamp: 2 }] },
        [native],
      ),
    ).toEqual([]);
    expect(
      notificationMessageIndices({ messages: [user('change the goal')] }, [
        native,
      ]),
    ).toEqual([]);
  });
  it.each([false, true])(
    'does not hide a real user with a colliding notification, reverse=%s',
    (reverse) => {
      const notification = entry({ router: { intent: 'notification' } });
      const human: SessionEntry = {
        type: 'message',
        id: 'human',
        parentId: 'notice',
        timestamp: new Date(1).toISOString(),
        message: user('worker finished'),
      };
      expect(
        notificationMessageIndices(
          context,
          reverse ? [human, notification] : [notification, human],
        ),
      ).toEqual([]);
    },
  );
});
