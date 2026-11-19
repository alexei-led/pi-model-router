import type { Api, Context, Message } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { normalizeConfig } from './config';
import { snapshotDecision } from './state';
import { consume, events, message, model, required } from './test/fixtures';
import {
  classifierResponse,
  enableAdvisors,
  setup,
  userContext,
} from './test/provider-harness';
import { formatDecision } from './ui';

const configured = () => {
  const s = setup();
  s.state.pinnedTierByProfile = {};
  s.models.push(model('deep'), model('tiny'));
  const configure = (input: Parameters<typeof normalizeConfig>[0]) => {
    s.state.currentConfig = normalizeConfig(input).config;
  };
  configure({
    profiles: {
      balanced: {
        high: { model: 'test/deep', thinking: 'high' },
        medium: {
          model: 'test/primary',
          thinking: 'medium',
          fallbacks: ['test/fallback'],
        },
        low: { model: 'test/small', thinking: 'low' },
        micro: { model: 'test/tiny', thinking: 'off' },
      },
    },
  });
  return { ...s, configure };
};

type Fixture = ReturnType<typeof configured>;
const run = async (s: Fixture, prompt: string) => {
  expect((await consume(s.stream(userContext(prompt)))).result.stopReason).toBe(
    'stop',
  );
  return required(s.state.lastDecision);
};

it.each([
  [' \n\tMoReThInK? go', 'morethink', 'medium', 'primary', 'high'],
  ['lessthink.', 'lessthink', 'medium', 'primary', 'low'],
  ['HIGHthink, now', 'highthink', 'high', 'deep', 'high'],
  ['lowthink', 'lowthink', 'low', 'small', 'low'],
  [' maxthink: go', 'maxthink', 'high', 'deep', 'high'],
  ['nothink/go', 'nothink', 'micro', 'tiny', undefined],
  ['nothink—go', 'nothink', 'micro', 'tiny', undefined],
])(
  'implements %j as a first-word control without removing it',
  async (prompt, keyword, tier, id, effort) => {
    const s = configured();
    const decision = await run(s, prompt);
    expect(decision).toMatchObject({
      tier,
      promptControl: { keyword, outcome: 'applied' },
    });
    const [target, context, options] = required(s.delegate.mock.calls[0]);
    expect(target.id).toBe(id);
    expect(options?.reasoning).toBe(effort);
    expect(JSON.stringify(context.messages)).toContain(JSON.stringify(prompt));
  },
);

it.each([
  'please maxthink',
  'maxthink-ish',
  'maxthink_ok',
  'maxthink2',
  'maxthinking',
  '`maxthink`',
  '"maxthink"',
  '!maxthink',
  'just review this',
  'URGENT debug',
  '',
])('does not infer a control from %j', async (prompt) => {
  const s = configured();
  expect(await run(s, prompt)).toMatchObject({
    tier: 'medium',
    thinking: 'medium',
  });
  expect(s.state.lastDecision?.promptControl).toBeUndefined();
});

it.each([
  ['highthink', 'low', 'high'],
  ['lowthink', 'high', 'low'],
  ['maxthink', 'high', 'high'],
  ['nothink', 'low', 'low'],
])(
  '%s respects sparse tiers and reports when it cannot move',
  async (keyword, baselineTier, tier) => {
    const s = configured();
    s.configure({
      profiles: {
        balanced: {
          baselineTier,
          high: { model: 'test/deep' },
          low: { model: 'test/small' },
        },
      },
    });
    const decision = await run(s, `${keyword} work`);
    expect(decision.tier).toBe(tier);
    const outcome = baselineTier === tier ? 'no-eligible-tier' : 'applied';
    expect(formatDecision(snapshotDecision(decision))).toContain(
      `${keyword}=${outcome}`,
    );
  },
);

it('does not backfill a missing route with an unrelated activity', async () => {
  const s = configured();
  s.configure({
    profiles: {
      balanced: {
        medium: { model: 'test/primary' },
        activities: { debug: { high: { model: 'test/deep' } } },
      },
    },
  });
  expect(await run(s, 'maxthink investigate')).toMatchObject({
    tier: 'medium',
    promptControl: { outcome: 'no-eligible-tier' },
  });
});

it.each([
  ['highthink', 'code-high', 'high'],
  ['maxthink', 'code-high', 'high'],
  ['lowthink', 'test/small', 'low'],
])(
  '%s uses the accepted activity and destination tier mode (generic when missing)',
  async (keyword, target, tier) => {
    const s = configured();
    for (const id of ['code-high', 'code-plain', 'wrong-high'])
      s.models.push(model(id));
    s.configure({
      mode: 'cost',
      profiles: {
        balanced: {
          low: {
            model: 'test/small',
            thinking: 'low',
            modeRoutes: { cost: { model: 'test/small', thinking: 'medium' } },
          },
          medium: { model: 'test/primary' },
          high: { model: 'test/deep' },
          activities: {
            code: {
              medium: { model: 'test/primary', thinking: 'high' },
              high: {
                model: 'test/code-plain',
                thinking: 'high',
                modeRoutes: {
                  cost: { model: 'test/code-high', thinking: 'low' },
                },
              },
            },
            debug: { high: { model: 'test/wrong-high' } },
          },
        },
      },
    });
    enableAdvisors(s, 'medium');
    vi.mocked(s.registry.classify).mockImplementation(async (m, context) => {
      const result = classifierResponse(m, context, 'medium');
      expect(JSON.stringify(context.state)).toContain(keyword);
      return {
        ...result,
        answers: {
          ...result.answers,
          activity: {
            type: 'choice',
            choice: 'code',
            confidence: 1,
            probabilities: { code: 1 },
          },
        },
      };
    });
    // Replaying the same initial request must not step again from a shifted tier.
    for (let i = 0; i < 2; i++) {
      expect(await run(s, `${keyword} implement`)).toMatchObject({
        tier,
        activity: 'code',
        targetLabel: target.includes('/') ? target : `test/${target}`,
        thinking: tier === 'low' ? 'medium' : 'low',
        mode: 'cost',
      });
    }
    expect(s.registry.classify).toHaveBeenCalledTimes(1);
  },
);

it('steps from the effective mode effort; declaration gaps and nonreasoning are respected', async () => {
  const s = configured();
  required(s.models[0]).thinkingLevelMap = { max: 'max', high: null };
  s.configure({
    mode: 'quality',
    models: {
      primary: {
        model: 'test/primary',
        thinkingLevels: ['low', 'high', 'max'],
      },
    },
    profiles: {
      balanced: {
        medium: {
          model: 'primary',
          thinking: 'max',
          modeRoutes: { quality: { model: 'primary', thinking: 'low' } },
        },
      },
    },
  });
  expect(await run(s, 'morethink now')).toMatchObject({
    tier: 'medium',
    thinking: 'max',
    mode: 'quality',
  });
  expect(await run(s, 'lessthink now')).toMatchObject({
    tier: 'medium',
    thinking: 'off',
  });
  required(s.models[0]).reasoning = false;
  expect(await run(s, 'morethink now')).toMatchObject({
    thinking: 'off',
    promptControl: { outcome: 'no-supported-effort' },
  });
});

it.each([
  ['pin', true],
  ['budget', false],
])(
  'obeys the %s even when a keyword requests a different route',
  async (_kind, pin) => {
    const s = configured();
    if (!pin) s.state.currentConfig.maxSessionBudget = 1;
    s.state.accumulatedCost = 1;
    enableAdvisors(s, 'high');
    if (pin) s.state.pinnedTierByProfile = { balanced: 'low' };
    expect(await run(s, 'maxthink fix')).toMatchObject({
      tier: pin ? 'low' : 'medium',
      reasonCode: pin ? 'pinned' : 'budget',
      promptControl: { outcome: pin ? 'pinned' : 'budget' },
    });
    expect(s.registry.classify).not.toHaveBeenCalled();
  },
);

it('keeps the budget high-only escape without letting an effort control act on it', async () => {
  const s = configured();
  s.configure({
    maxSessionBudget: 1,
    profiles: { balanced: { high: { model: 'test/deep', thinking: 'low' } } },
  });
  s.state.accumulatedCost = 1;
  expect(await run(s, 'morethink work')).toMatchObject({
    tier: 'high',
    thinking: 'low',
    reasonCode: 'budget',
    isBudgetForced: false,
    promptControl: { outcome: 'budget' },
  });
});

it('steps only through registry-, input- and context-eligible cells', async () => {
  const s = configured();
  required(s.models[2]).input = ['text']; // low cannot see the image
  const [deep] = s.models.splice(3, 1);
  expect(deep?.id).toBe('deep'); // high is missing from live registry
  required(s.models.find(({ id }) => id === 'tiny')).contextWindow = 128;
  const context: Context = {
    messages: [
      {
        role: 'user',
        timestamp: 1,
        content: [
          { type: 'text', text: `nothink ${'word '.repeat(150)}` },
          { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
        ],
      },
    ],
  };
  expect((await consume(s.stream(context))).result.stopReason).toBe('stop');
  expect(s.state.lastDecision).toMatchObject({
    tier: 'medium',
    promptControl: { outcome: 'no-eligible-tier' },
  });
  expect(await run(s, 'highthink go')).toMatchObject({
    tier: 'medium',
    promptControl: { outcome: 'no-eligible-tier' },
  });
  s.models.length = 0;
  expect(
    (await consume(s.stream(userContext('maxthink go')))).result.errorMessage,
  ).toMatch(/No eligible route/);
});

const tool = (
  id: string,
  modelId = 'primary',
  api: Api = 'openai-completions',
) =>
  message({
    model: modelId,
    api,
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', id, name: 'read', arguments: {} }],
  });
const result = (id: string): Extract<Message, { role: 'toolResult' }> => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: 'read',
  content: [{ type: 'text', text: 'nothink is tool output only' }],
  isError: false,
  timestamp: Date.now(),
});

it('keeps one effort step through valid native tool requests, ignores notification text and reviews, and honors fresh steering', async () => {
  const s = configured();
  enableAdvisors(s, 'medium');
  required(s.state.currentConfig.advisor).reviewEveryRequests = 1;
  const manager = SessionManager.inMemory();
  s.state.lastExtensionContext = {
    ...required(s.state.lastExtensionContext),
    sessionManager: manager,
  };
  const goal: Message = {
    role: 'user',
    content: 'morethink: first',
    timestamp: 100,
  };
  manager.appendMessage(goal);
  const messages: Message[] = [goal];
  for (const id of ['one', 'two']) {
    const assistant = tool(id);
    s.delegate.mockReturnValueOnce(
      events({ type: 'done', reason: 'toolUse', message: assistant }),
    );
    expect((await consume(s.stream({ messages }))).result.stopReason).toBe(
      'toolUse',
    );
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      thinking: 'high',
      promptControl: { keyword: 'morethink', outcome: 'applied' },
    });
    const output = result(id);
    manager.appendMessage(assistant);
    manager.appendMessage(output);
    messages.push(assistant, output);
  }
  manager.appendCustomMessageEntry(
    'subagent-notify',
    'nothink: notification',
    true,
  );
  messages.push({
    role: 'user',
    content: 'nothink: notification',
    timestamp: Date.parse(required(manager.getBranch().at(-1)).timestamp),
  });
  expect((await consume(s.stream({ messages }))).result.stopReason).toBe(
    'stop',
  );
  expect(s.state.lastDecision).toMatchObject({
    thinking: 'high',
    reuse: 'continuation',
  });
  expect(s.registry.classify).toHaveBeenCalledTimes(1);
  const steer: Message = {
    role: 'user',
    content: 'nothink: steering',
    timestamp: Date.now() + 10,
  };
  manager.appendMessage(steer);
  messages.push(steer);
  const steered = await consume(s.stream({ messages }));
  expect(s.state.lastDecision).toMatchObject({
    tier: 'micro',
    thinking: 'off',
  });
  manager.appendMessage(steered.result);
  const next: Message = {
    role: 'user',
    content: 'now review the previous work',
    timestamp: Date.now() + 11,
  };
  manager.appendMessage(next);
  expect(
    (await consume(s.stream({ messages: [...messages, steered.result, next] })))
      .result.stopReason,
  ).toBe('stop');
  expect(s.state.lastDecision).toMatchObject({
    tier: 'medium',
    thinking: 'medium',
  });
  expect(s.state.lastDecision?.promptControl).toBeUndefined();
  expect(s.registry.classify).toHaveBeenCalledTimes(3);
});

it.each([
  'branch',
  'tool ID',
  'policy',
  'config',
  'context',
  'live effort',
  'session',
])(
  'does not reapply an old keyword when %s invalidates a continuation',
  async (change) => {
    const s = configured();
    const goal: Message = {
      role: 'user',
      content: `${change === 'live effort' ? 'morethink' : 'maxthink'} now`,
      timestamp: 1,
    };
    const assistant = tool(
      'call',
      change === 'live effort' ? 'primary' : 'deep',
    );
    s.delegate.mockReturnValueOnce(
      events({ type: 'done', reason: 'toolUse', message: assistant }),
    );
    await consume(s.stream({ messages: [goal] }, undefined, 'one'));
    expect(s.state.lastDecision?.promptControl?.outcome).toBe('applied');
    if (change === 'branch') {
      const sibling = SessionManager.inMemory();
      sibling.appendMessage(goal);
      vi.spyOn(
        required(s.state.lastExtensionContext).sessionManager,
        'getBranch',
      ).mockReturnValue(sibling.getBranch());
    }
    if (change === 'policy')
      s.state.pinnedTierByProfile = { balanced: 'medium' };
    if (change === 'config')
      s.state.currentConfig = structuredClone(s.state.currentConfig);
    if (change === 'live effort')
      required(s.models[0]).thinkingLevelMap = { high: null };
    if (change === 'context')
      required(s.models.find((m) => m.id === 'deep')).contextWindow = 1;
    const continuation = {
      messages: [
        goal,
        assistant,
        result(change === 'tool ID' ? 'wrong' : 'call'),
      ],
    };
    expect(
      (
        await consume(
          s.stream(
            continuation,
            undefined,
            change === 'session' ? 'two' : 'one',
          ),
        )
      ).result.stopReason,
    ).toBe('stop');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      thinking: 'medium',
    });
    expect(s.state.lastDecision?.promptControl).toBeUndefined();
  },
);

it('preserves Google signed tool compatibility when a keyed plan is invalidated', async () => {
  const s = configured();
  required(s.models.find((m) => m.id === 'deep')).api = 'google-generative-ai';
  const goal: Message = { role: 'user', content: 'maxthink now', timestamp: 1 };
  const assistant = tool('google', 'deep', 'google-generative-ai');
  assistant.content.push({
    type: 'thinking',
    thinking: 'signed',
    thinkingSignature: 'fixture',
  });
  s.delegate.mockReturnValueOnce(
    events({ type: 'done', reason: 'toolUse', message: assistant }),
  );
  await consume(s.stream({ messages: [goal] }));
  s.state.currentConfig = structuredClone(s.state.currentConfig);
  expect(
    (await consume(s.stream({ messages: [goal, assistant, result('google')] })))
      .result.stopReason,
  ).toBe('stop');
  expect(s.state.lastDecision).toMatchObject({
    targetLabel: 'test/deep',
    reasonCode: 'continuation',
  });
  expect(s.state.lastDecision?.promptControl).toBeUndefined();
});

it('lets an explicit session effort override win and honors it at the destination tier', async () => {
  const s = configured();
  s.state.thinkingByProfile = { balanced: { medium: 'minimal', high: 'low' } };
  expect(await run(s, 'morethink go')).toMatchObject({
    thinking: 'minimal',
    promptControl: { outcome: 'effort-override' },
  });
  expect(await run(s, 'maxthink go')).toMatchObject({
    tier: 'high',
    thinking: 'low',
    promptControl: { outcome: 'applied' },
  });
});

it('uses the lowest tier’s own effort for nothink and allows lessthink to reach off', async () => {
  const s = configured();
  s.configure({
    profiles: {
      balanced: {
        medium: { model: 'test/primary', thinking: 'medium' },
        low: { model: 'test/small', thinking: 'low' },
        micro: { model: 'test/tiny', thinking: 'minimal' },
      },
    },
  });
  expect(await run(s, 'nothink go')).toMatchObject({
    tier: 'micro',
    thinking: 'minimal',
  });
  required(s.state.currentConfig.profiles.balanced).baselineTier = 'micro';
  expect(await run(s, 'lessthink go')).toMatchObject({
    tier: 'micro',
    thinking: 'off',
  });
  required(required(s.state.currentConfig.profiles.balanced).micro).thinking =
    'off';
  expect(await run(s, 'lessthink go')).toMatchObject({
    thinking: 'off',
    promptControl: { outcome: 'no-supported-effort' },
  });
});

it('adjusts each frozen attempt once, preserving quota holds, fallback order and actual fallback continuation', async () => {
  const s = configured();
  required(s.models[1]).thinkingLevelMap = { high: null, xhigh: 'xhigh' };
  s.configure({
    models: {
      primary: { model: 'test/primary', quotaGroup: 'one' },
      shared: { model: 'test/small', quotaGroup: 'one' },
      alternate: {
        model: 'test/fallback',
        thinkingLevels: ['medium', 'xhigh'],
      },
    },
    profiles: {
      balanced: {
        medium: {
          model: 'primary',
          thinking: 'medium',
          fallbacks: ['shared', 'alternate'],
        },
        high: { model: 'test/deep' },
      },
    },
  });
  const failed = message({
    stopReason: 'error',
    errorMessage:
      '429 {"error":{"code":"subscription_sharing_usage_limit_exceeded"}}',
  });
  const assistant = tool('fallback-call', 'fallback');
  s.delegate.mockReturnValueOnce(
    events({ type: 'error', reason: 'error', error: failed }),
  );
  s.delegate.mockReturnValueOnce(
    events({ type: 'done', reason: 'toolUse', message: assistant }),
  );
  const initial = userContext('morethink work');
  expect((await consume(s.stream(initial))).result.stopReason).toBe('toolUse');
  expect(
    (
      await consume(
        s.stream({
          messages: [...initial.messages, assistant, result('fallback-call')],
        }),
      )
    ).result.stopReason,
  ).toBe('stop');
  expect(s.state.lastDecision).toMatchObject({
    targetLabel: 'test/fallback',
    reasonCode: 'continuation',
    thinking: 'xhigh',
  });
  expect(
    (await consume(s.stream(userContext('next work', 2)))).result.stopReason,
  ).toBe('stop');
  expect(
    s.delegate.mock.calls.map(([m, , options]) => [m.id, options?.reasoning]),
  ).toEqual([
    ['primary', 'high'],
    ['fallback', 'xhigh'],
    ['fallback', 'xhigh'],
    ['fallback', 'medium'],
  ]);
});

it('never widens a keyed retry chain or retries after visible output', async () => {
  const s = configured();
  const high = required(required(s.state.currentConfig.profiles.balanced).high);
  high.fallbacks = ['test/fallback'];
  const failed = message({
    model: 'deep',
    stopReason: 'error',
    errorMessage: 'fixture failure',
  });
  s.delegate.mockImplementationOnce(() => {
    high.fallbacks = ['test/tiny'];
    return events({ type: 'error', reason: 'error', error: failed });
  });
  expect((await run(s, 'maxthink work')).targetLabel).toBe('test/fallback');
  s.delegate.mockReturnValueOnce(
    events(
      {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'visible',
        partial: failed,
      },
      { type: 'error', reason: 'error', error: failed },
    ),
  );
  expect(
    (await consume(s.stream(userContext('maxthink again', 2)))).result
      .stopReason,
  ).toBe('error');
  expect(s.delegate.mock.calls.map(([m]) => m.id)).toEqual([
    'deep',
    'fallback',
    'deep',
  ]);
});

it('cancels during initial advice without delegating the keyword or a baseline', async () => {
  const s = configured();
  enableAdvisors(s, 'low');
  const controller = new AbortController();
  vi.mocked(s.registry.classify).mockImplementation(async (m, context) => {
    controller.abort();
    return classifierResponse(m, context, 'low');
  });
  expect(
    (await consume(s.stream(userContext('maxthink: work'), controller.signal)))
      .result.stopReason,
  ).toBe('aborted');
  expect(s.delegate).not.toHaveBeenCalled();
  expect(await run(s, 'plain work')).toMatchObject({ tier: 'low' });
});

it('uses the eligible local baseline as the reference on an advisor failure', async () => {
  const s = configured();
  enableAdvisors(s, 'low');
  vi.mocked(s.registry.classify).mockRejectedValue(new Error('unavailable'));
  expect(await run(s, 'lowthink: work')).toMatchObject({
    tier: 'low',
    advisor: 'classifier-fallback',
    promptControl: { outcome: 'applied' },
  });
});

it('keeps the failure floor ahead of a lower keyword and distinguishes the safeguard', async () => {
  const s = configured();
  required(s.state.currentConfig.profiles.balanced).baselineTier = 'medium';
  const first = userContext('nothink work');
  const failingTurn = async (id: string, toolName: string, error: boolean) => {
    const assistant = tool(id, 'tiny');
    s.delegate.mockReturnValueOnce(
      events({ type: 'done', reason: 'toolUse', message: assistant }),
    );
    expect((await consume(s.stream(first))).result.stopReason).toBe('toolUse');
    first.messages.push(assistant, { ...result(id), toolName, isError: error });
  };
  await failingTurn('one', 'read', true);
  await failingTurn('edit', 'edit', false);
  await failingTurn('two', 'read', true);
  expect((await consume(s.stream(first))).result.stopReason).toBe('stop');
  expect(s.state.lastDecision).toMatchObject({
    tier: 'low',
    reasonCode: 'escalation',
    promptControl: { outcome: 'safeguard' },
  });
  expect(
    (
      await consume(
        s.stream({
          messages: [
            ...first.messages,
            { role: 'user', content: 'nothink next', timestamp: 2 },
          ],
        }),
      )
    ).result.stopReason,
  ).toBe('stop');
  expect(s.state.lastDecision).toMatchObject({
    tier: 'low',
    reasonCode: 'escalation',
    promptControl: { outcome: 'safeguard' },
  });
});

it('drops a pending keyed request when its native provider is disposed', async () => {
  const s = configured();
  enableAdvisors(s, 'low');
  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  vi.mocked(s.registry.classify).mockImplementation(async (m, context) => {
    started.resolve();
    await complete.promise;
    return classifierResponse(m, context, 'low');
  });
  const pending = consume(s.stream(userContext('maxthink work')));
  await started.promise;
  required(s.state.disposeProvider)();
  complete.resolve();
  expect((await pending).result.stopReason).toBe('aborted');
  expect(s.delegate).not.toHaveBeenCalled();
  expect(s.state.lastDecision).toBeUndefined();
});
