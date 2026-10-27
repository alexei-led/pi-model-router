import type { ClassifierContext, Context } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from './config';
import { prepareRouterRequest } from './provider-request';
import { createProviderTurnCache } from './provider-turns';
import { message, model, required } from './test/fixtures';
import type {
  RouterActivity,
  RouterMode,
  RouterThinkingByTier,
  RouterTier,
} from './types';

const scenario = async (openai = false, activity: RouterActivity = 'ops') => {
  let config = normalizeConfig({
    advisor: { enabled: true, model: 'fixture/choice', reviewEveryRequests: 0 },
    maxSessionBudget: 1,
    profiles: {
      p: {
        advisor: { models: ['fixture/choice'] },
        baselineTier: 'high',
        high: {
          model: openai ? 'scope/gpt-6.1-sol' : 'scope/claude-opus-5-5',
          thinking: 'high',
        },
        medium: {
          model: openai ? 'scope/gpt-6.1-terra' : 'scope/claude-sonnet-5-5',
          thinking: 'medium',
        },
        low: {
          model: openai ? 'scope/gpt-6-luna' : 'scope/claude-sonnet-5-5',
          thinking: openai ? 'high' : 'low',
        },
      },
    },
  }).config;
  let mode: RouterMode = 'cost';
  let budget = 0;
  let pin: RouterTier | undefined;
  let thinking: RouterThinkingByTier | undefined;
  let branch = ['root'];
  let turn = 'turn';
  let opusWindow = 128000;
  const cache = createProviderTurnCache();
  const messages: Context['messages'] = [
    { role: 'user', content: 'Run the checks.', timestamp: 1 },
  ];
  const classify = vi.fn(
    async (
      target: { api: string; provider: string; id: string },
      context: ClassifierContext,
    ) => {
      const question = context.questions.route;
      const choice =
        question?.type === 'choice'
          ? Object.keys(question.criteria).find((id) => id.startsWith('high|'))
          : undefined;
      return {
        api: target.api,
        provider: target.provider,
        model: target.id,
        timestamp: 1,
        stopReason: 'stop' as const,
        answers: {
          ...(choice
            ? {
                route: {
                  type: 'choice' as const,
                  choice,
                  confidence: 1,
                  probabilities: { [choice]: 1 },
                },
              }
            : {}),
          activity: {
            type: 'choice' as const,
            choice: activity,
            confidence: 1,
            probabilities: { [activity]: 1 },
          },
        },
      };
    },
  );
  const registry = {
    find: (provider: string, id: string) =>
      model(id, {
        provider,
        contextWindow:
          id === (openai ? 'gpt-6.1-sol' : 'claude-opus-5-5')
            ? opusWindow
            : 128000,
        thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
        cost: {
          input: openai
            ? id === 'gpt-6-luna'
              ? 0.1
              : id === 'gpt-6.1-terra'
                ? 1
                : 2
            : id.includes('haiku')
              ? 0.1
              : id.includes('sonnet')
                ? 2
                : 4,
          output: 10,
          cacheRead: 0.1,
          cacheWrite: 1,
        },
      }),
    findOfType: () => ({
      type: 'classifier' as const,
      provider: 'fixture',
      id: 'choice',
      name: 'Fixture',
      api: 'fixture-choice',
      baseUrl: 'fixture://local',
      input: ['text'] as ['text'],
      contextWindow: 64000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    classify,
  } as unknown as Parameters<typeof prepareRouterRequest>[0]['registry'];
  const prepare = () =>
    prepareRouterRequest({
      profileName: 'p',
      profile: required(config.profiles.p),
      config,
      getCurrentConfig: () => config,
      context: { messages },
      registry,
      identity: { turn, branch },
      mode: { mode, source: 'session' },
      getCurrentMode: () => ({ mode, source: 'session' }),
      accumulatedCost: budget,
      ...(pin ? { pinnedTier: pin } : {}),
      ...(thinking ? { thinkingOverrides: thinking } : {}),
      lastDecision: undefined,
      cache,
    });
  let selected = await prepare();
  let calls = 0;
  const next = async (toolName: string, isError = false, google = false) => {
    const id = `tool-${++calls}`;
    cache.rememberContinuation({
      turn,
      policy: selected.policy,
      plan: selected.plan,
      decision: selected.decision,
      config: selected.config,
      branch: ['root'],
      toolCalls: new Set([id]),
    });
    messages.push(
      message({
        provider: selected.decision.targetProvider,
        model: selected.decision.targetModelId,
        stopReason: 'toolUse',
        ...(google ? { api: 'google-generative-ai' as const } : {}),
        content: [
          {
            type: 'toolCall',
            id,
            name: toolName,
            arguments: {},
            ...(google ? { thoughtSignature: 'fixture-signature' } : {}),
          },
        ],
      }),
      {
        role: 'toolResult',
        toolCallId: id,
        toolName,
        content: [
          {
            type: 'text',
            text: isError ? 'FAIL assertion expected A got B' : 'Applied',
          },
        ],
        isError,
        timestamp: 2 + calls,
      },
    );
    selected = await prepare();
    return selected;
  };
  await next('bash', true);
  await next('edit');
  return {
    next,
    cache,
    classify,
    current: () => selected,
    prepare,
    messages,
    restrictContext: () => {
      opusWindow = 2000;
      messages.push(
        message({
          provider: 'scope',
          model: selected.decision.targetModelId,
          content: [{ type: 'text', text: 'evidence '.repeat(3000) }],
        }),
      );
    },
    budget: () => {
      budget = 2;
    },
    pin: () => {
      pin = 'high';
    },
    override: () => {
      thinking = { high: 'low' };
    },
    fork: () => {
      branch = ['fork'];
    },
    reload: () => {
      config = { ...config };
    },
    user: async (text: string) => {
      turn = text;
      messages.push({ role: 'user', content: text, timestamp: 100 + calls++ });
      selected = await prepare();
      return selected;
    },
    mode: (value: RouterMode) => {
      mode = value;
    },
  };
};

describe('cost-mode failure recovery', () => {
  it.each([
    'code',
    'debug',
    'review',
    'plan',
    'explore',
    'ops',
    'docs',
  ] as const)(
    'recovers Terra cost/high %s to its immutable balanced Sol cell without renewing indefinitely',
    async (activity) => {
      const f = await scenario(true, activity);
      expect(f.current().decision).toMatchObject({
        targetModelId: 'gpt-6.1-terra',
        thinking:
          activity === 'code' || activity === 'debug' ? 'xhigh' : 'medium',
        tier: 'high',
      });
      const recovered = await f.next('bash', true);
      expect(recovered.decision).toMatchObject({
        targetModelId: 'gpt-6.1-sol',
        thinking: ['debug', 'plan', 'review'].includes(activity)
          ? 'xhigh'
          : 'high',
        costRecovery: true,
        tier: 'high',
      });
      expect((await f.next('read')).plan.id).toBe(recovered.plan.id);
      await f.next('edit');
      await f.next('bash', true);
      expect((await f.user('first held task')).decision.costRecovery).toBe(
        true,
      );
      const expired = await f.user('expired hold');
      expect(expired.decision.targetModelId).toBe('gpt-6.1-terra');
      expect(expired.decision.costRecovery).not.toBe(true);
    },
  );
  it.each(['budget', 'pin', 'override', 'fork', 'reload'] as const)(
    'does not arm Terra recovery after %s changes',
    async (change) => {
      const f = await scenario(true);
      f[change]();
      expect((await f.next('bash', true)).decision.costRecovery).not.toBe(true);
    },
  );

  it('restores the balanced high cell and keeps native tool continuations on that immutable plan', async () => {
    const f = await scenario();
    expect(f.current().decision).toMatchObject({
      tier: 'high',
      targetModelId: 'claude-haiku-5-5',
      mode: 'cost',
    });
    const recovered = await f.next('bash', true);
    expect(recovered.decision).toMatchObject({
      tier: 'high',
      activity: 'ops',
      routeCell: 'ops',
      targetModelId: 'claude-opus-5-5',
      thinking: 'high',
      mode: 'cost',
      reasonCode: 'cost-recovery',
      costRecovery: true,
    });
    expect(recovered.plan.attempts.map((pair) => pair.model)).toEqual([
      'scope/claude-opus-5-5',
    ]);
    const continued = await f.next('read');
    expect(continued.decision).toMatchObject({
      targetModelId: 'claude-opus-5-5',
      costRecovery: true,
      reuse: 'continuation',
    });
    expect(continued.plan.id).toBe(recovered.plan.id);
    expect(f.classify).toHaveBeenCalledOnce();
  });
  it.each(['budget', 'pin', 'override', 'fork', 'reload'] as const)(
    'does not arm recovery across %s precedence or fence changes',
    async (change) => {
      const f = await scenario();
      f[change]();
      const selected = await f.next('bash', true);
      expect(selected.decision.costRecovery).not.toBe(true);
      if (change === 'budget') expect(selected.decision.tier).not.toBe('high');
    },
  );
  it('does not break a Google thought-signature continuation', async () => {
    const f = await scenario();
    const selected = await f.next('bash', true, true);
    expect(selected.decision.targetModelId).toBe('claude-haiku-5-5');
    expect(selected.decision.costRecovery).not.toBe(true);
  });
  it('expires after the configured cost-mode hold and remains inert in other modes', async () => {
    const f = await scenario();
    await f.next('bash', true);
    expect((await f.user('first next task')).decision.costRecovery).toBe(true);
    const expired = await f.user('second next task');
    expect(expired.decision.targetModelId).toBe('claude-haiku-5-5');
    expect(expired.decision.costRecovery).not.toBe(true);
    const other = await scenario();
    await other.next('bash', true);
    other.mode('quality');
    expect((await other.user('quality task')).decision.costRecovery).not.toBe(
      true,
    );
  });
  it('fences an active recovery hold from a sibling branch or config replacement', async () => {
    for (const change of ['fork', 'reload'] as const) {
      const f = await scenario();
      await f.next('bash', true);
      f[change]();
      expect((await f.prepare()).decision.costRecovery).not.toBe(true);
    }
  });
});

it('keeps the eligible cost incumbent when the balanced recovery target cannot fit', async () => {
  const f = await scenario();
  f.restrictContext();
  const selected = await f.next('bash', true);
  expect(selected.decision.tier).toBe('high');
  expect(selected.decision.targetModelId).toBe('claude-haiku-5-5');
  expect(f.cache.escalation().costRecovery).not.toBe(true);
  expect(selected.decision.costRecovery).not.toBe(true);
  expect(f.classify).toHaveBeenCalledOnce();
});
