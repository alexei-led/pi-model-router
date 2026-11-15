import type { ClassifierContext, Context } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';
import { normalizeConfig } from './config';
import { prepareRouterRequest } from './provider-request';
import { createProviderTurnCache } from './provider-turns';
import { message, model, required } from './test/fixtures';

const scenario = (
  phase: string | undefined,
  mode: 'balanced' | 'cost' = 'balanced',
  floor: 'explicit' | 'inherited' | 'reset' | 'explicit-generic' = 'explicit',
) => {
  const config = normalizeConfig({
    advisor: { enabled: true, model: 'fixture/choice', reviewEveryRequests: 1 },
    profiles: {
      p: {
        activityPreset: 'off',
        advisor: { models: ['fixture/choice'] },
        medium: { model: 'work/glm-flash', thinking: 'high' },
        activities: {
          ops: { medium: { model: 'work/deepseek', thinking: 'high' } },
          ...(floor === 'inherited'
            ? {}
            : {
                debug: {
                  medium:
                    floor === 'reset'
                      ? null
                      : {
                          model:
                            floor === 'explicit-generic'
                              ? 'work/glm-flash'
                              : 'work/deepseek',
                          thinking: 'high',
                        },
                },
                code: {
                  medium:
                    floor === 'reset'
                      ? null
                      : {
                          model:
                            floor === 'explicit-generic'
                              ? 'work/glm-flash'
                              : 'work/implementation',
                          thinking: 'high',
                        },
                },
              }),
        },
      },
    },
  }).config;
  const cache = createProviderTurnCache();
  const context: Context = {
    messages: [{ role: 'user', content: 'Controlled ops goal.', timestamp: 1 }],
  };
  const classify = vi.fn(
    async (
      target: { api: string; provider: string; id: string },
      _context: ClassifierContext,
    ) => ({
      api: target.api,
      provider: target.provider,
      model: target.id,
      timestamp: 1,
      stopReason: 'stop' as const,
      answers: {
        activity: {
          type: 'choice' as const,
          choice: 'ops',
          confidence: 1,
          probabilities: { ops: 1 },
        },
        ...(phase
          ? {
              phase: {
                type: 'choice' as const,
                choice: phase,
                confidence: 1,
                probabilities: { [phase]: 1 },
              },
            }
          : {}),
      },
    }),
  );
  const registry = {
    find: (provider: string, id: string) =>
      model(id, {
        provider,
        contextWindow: 128000,
        thinkingLevelMap: { xhigh: 'xhigh' },
      }),
    classify,
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
  } as unknown as Parameters<typeof prepareRouterRequest>[0]['registry'];
  const reviews = vi.fn();
  const run = () =>
    prepareRouterRequest({
      profileName: 'p',
      profile: required(config.profiles.p),
      config,
      getCurrentConfig: () => config,
      context,
      registry,
      identity: { turn: 'turn', branch: ['root'] },
      mode: { mode, source: 'profile' },
      getCurrentMode: () => ({ mode, source: 'profile' }),
      onReview: reviews,
      accumulatedCost: 0,
      lastDecision: undefined,
      cache,
    });
  return {
    run,
    cache,
    context,
    classify,
    reviews,
    setPhase: (value: string | undefined) => {
      phase = value;
    },
  };
};

it.each(['balanced', 'cost'] as const)(
  'ops reasoning uses the eligible same-tier debug cell, never generic GLM (%s)',
  async (mode) => {
    const f = scenario('reason', mode);
    const selected = await f.run();
    expect(selected.decision).toMatchObject({
      tier: 'medium',
      activity: 'debug',
      targetModelId: 'deepseek',
      classification: { activity: 'ops', phase: 'reason' },
    });
    expect(selected.plan.cell).toBe('debug');
    expect(Object.isFrozen(selected.plan)).toBe(true);
  },
);

it.each(['reason', 'produce'])(
  'ops %s never replaces its specialization with unknown inherited generic',
  async (phase) => {
    const selected = await scenario(phase, 'balanced', 'inherited').run();
    expect(selected.decision).toMatchObject({
      targetModelId: 'deepseek',
      activity: 'ops',
      routeCell: 'ops',
      classification: { activity: 'ops', phase },
    });
  },
);

it.each(['reset', 'explicit-generic'] as const)(
  'explicit %s remains authoritative for an ops reasoning floor',
  async (floor) => {
    const selected = await scenario('reason', 'balanced', floor).run();
    expect(selected.decision).toMatchObject({
      targetModelId: 'glm-flash',
      activity: 'debug',
      classification: { activity: 'ops' },
    });
  },
);

it('ops production selects the declared implementation cell', async () => {
  const selected = await scenario('produce').run();
  expect(selected.decision).toMatchObject({
    activity: 'code',
    targetModelId: 'implementation',
    classification: { activity: 'ops' },
  });
});

it.each(['report', 'uncertain', undefined])(
  'fresh ops %s uses conservative baseline',
  async (phase) => {
    const selected = await scenario(phase).run();
    expect(selected.decision).toMatchObject({
      targetModelId: 'glm-flash',
      advisor: 'classifier-fallback',
    });
  },
);

it.each(['report', 'uncertain', undefined])(
  'ops %s review retains a validated continuation without a cold hop',
  async (phase) => {
    const f = scenario('reason');
    const first = await f.run();
    f.cache.rememberContinuation({
      turn: 'turn',
      plan: first.plan,
      decision: first.decision,
      policy: first.policy,
      config: first.config,
      branch: ['root'],
      toolCalls: new Set(['check']),
    });
    f.context.messages.push(
      message({
        provider: 'work',
        model: 'deepseek',
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'check', name: 'read', arguments: {} },
        ],
      }),
      {
        role: 'toolResult',
        toolCallId: 'check',
        toolName: 'read',
        content: [{ type: 'text', text: 'Controlled evidence' }],
        isError: false,
        timestamp: 2,
      },
    );
    f.setPhase(phase);
    await f.run();
    await vi.waitFor(() => expect(f.reviews).toHaveBeenCalledOnce());
    const continued = await f.run();
    expect(continued.decision).toMatchObject({
      targetModelId: 'deepseek',
      reuse: 'continuation',
      classification: { outcome: 'uncertain', activity: 'ops' },
    });
    expect(continued.plan.id).toBe(first.plan.id);
  },
);
