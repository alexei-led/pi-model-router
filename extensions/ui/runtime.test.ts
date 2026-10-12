import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from '../config';
import { model, required } from '../test/fixtures';
import type { RouterThinkingByProfile } from '../types';
import { createRouterUIRuntime } from './runtime';

const setup = () => {
  const state = {
    currentConfig: normalizeConfig({
      profiles: {
        auto: {
          medium: { model: 'openai/medium' },
          high: { model: 'openai/high' },
        },
      },
    }).config,
    selectedProfile: 'auto',
    routerEnabled: true,
    pinnedTierByProfile: {},
    thinkingByProfile: {} as RouterThinkingByProfile,
    lastDecision: undefined,
    debugHistory: [],
    currentModelRegistry: {
      find: (
        provider: string,
        id: string,
      ): ReturnType<ExtensionContext['modelRegistry']['find']> =>
        model(id, { provider }),
      getModelsOfType: ((type: string) =>
        type === 'classifier'
          ? [
              {
                type: 'classifier',
                provider: 'typesafe',
                id: 'jev-latest',
                name: 'Jev',
                api: 'typesafe-system-one',
                baseUrl: 'https://fixture.invalid',
                input: ['text'],
                contextWindow: 64000,
                cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              },
            ]
          : []) as unknown as ExtensionContext['modelRegistry']['getModelsOfType'],
    },
  };
  const runtime = createRouterUIRuntime(state, () => undefined);
  return { state, runtime };
};
describe('router UI runtime boundary', () => {
  it('projects the Pi classifier path without pretending it made an HTTP request', () => {
    const { runtime } = setup();
    runtime.beginRequest()({
      stage: 'selected',
      decision: {
        profile: 'auto',
        tier: 'medium',
        targetProvider: 'openai',
        targetModelId: 'medium',
        targetLabel: 'openai/medium',
        reasonCode: 'classifier',
        advisor: 'classifier',
        thinking: 'medium',
        routingLatencyMs: 27,
        timestamp: 1,
      },
    });
    expect(runtime.adapters.getSnapshot().advice).toMatchObject({
      advisor: 'Classifier',
      outcome: 'selected',
      latencyMs: 27,
    });
    expect(runtime.adapters.getSnapshot().advice?.requestId).toBeUndefined();
  });

  it('queues controls without changing routing and activates on the explicit user boundary', async () => {
    const { state, runtime } = setup();
    expect(
      await runtime.adapters.applyControls({
        profile: 'auto',
        action: 'apply',
        changes: [
          { key: 'advisor', before: undefined, after: 'typesafe/jev-latest' },
          { key: 'pin', before: 'auto', after: 'high' },
        ],
      }),
    ).toBe('applied');
    expect(state.currentConfig.advisor?.model).toBeUndefined();
    expect(state.pinnedTierByProfile).toEqual({});
    expect(runtime.adapters.getSnapshot().pendingControls?.advisor).toBe(
      'typesafe/jev-latest',
    );
    runtime.activatePending();
    expect(state.currentConfig.advisor?.model).toBe('typesafe/jev-latest');
    expect(state.pinnedTierByProfile).toEqual({ auto: 'high' });
    expect(Object.values(state.thinkingByProfile)).toStrictEqual([{}]);
  });
  it('removes a fully undone pending patch without touching the active config', async () => {
    const { state, runtime } = setup();
    const original = state.currentConfig;
    await runtime.adapters.applyControls({
      profile: 'auto',
      action: 'apply',
      changes: [
        { key: 'advisor', before: undefined, after: 'typesafe/jev-latest' },
      ],
    });
    await runtime.adapters.applyControls({
      profile: 'auto',
      action: 'undo',
      changes: [
        { key: 'advisor', before: 'typesafe/jev-latest', after: undefined },
      ],
    });
    expect(runtime.adapters.getSnapshot().pendingControls).toBeUndefined();
    runtime.activatePending();
    expect(state.currentConfig).toBe(original);
  });
  it('activates session-wide settings across profile switches but retains profile-scoped pins', async () => {
    const { state, runtime } = setup();
    state.currentConfig.profiles.other = {
      ...state.currentConfig.profiles.auto,
    };
    await runtime.adapters.applyControls({
      profile: 'auto',
      action: 'apply',
      changes: [
        { key: 'advisor', before: undefined, after: 'typesafe/jev-latest' },
        { key: 'budget', before: undefined, after: 5 },
        { key: 'pin', before: 'auto', after: 'high' },
      ],
    });
    state.selectedProfile = 'other';
    expect(runtime.adapters.getSnapshot().pendingControls).toMatchObject({
      advisor: 'typesafe/jev-latest',
      budget: 5,
      pin: 'auto',
    });
    expect(runtime.activatePending()).toBe(true);
    expect(state.currentConfig.advisor?.model).toBe('typesafe/jev-latest');
    expect(state.currentConfig.maxSessionBudget).toBe(5);
    expect(state.pinnedTierByProfile).toEqual({});
    state.selectedProfile = 'auto';
    expect(runtime.activatePending()).toBe(true);
    expect(state.pinnedTierByProfile).toEqual({ auto: 'high' });
    expect(state.currentConfig.advisor?.model).toBe('typesafe/jev-latest');
  });
  it('refreshes unrelated pending fields from current effective settings', async () => {
    const { state, runtime } = setup();
    await runtime.adapters.applyControls({
      profile: 'auto',
      action: 'apply',
      changes: [{ key: 'pin', before: 'auto', after: 'high' }],
    });
    state.currentConfig.maxSessionBudget = 20;
    expect(runtime.adapters.getSnapshot().pendingControls?.budget).toBe(20);
    expect(
      await runtime.adapters.applyControls({
        profile: 'auto',
        action: 'apply',
        changes: [{ key: 'budget', before: 20, after: 10 }],
      }),
    ).toBe('applied');
    expect(runtime.activatePending()).toBe(true);
    expect(state.currentConfig.maxSessionBudget).toBe(10);
  });
  it('preserves a failed request as a failure, not idle', () => {
    const { runtime } = setup();
    runtime.beginRequest()({ stage: 'failed' });
    expect(runtime.adapters.getSnapshot()).toMatchObject({
      lifecycle: 'failed',
      failure: 'request-failed',
    });
  });
  it('rejects stale transactions and invalid pins without partial writes', async () => {
    const { runtime } = setup();
    expect(
      await runtime.adapters.applyControls({
        profile: 'auto',
        action: 'apply',
        changes: [
          { key: 'budget', before: undefined, after: 10 },
          { key: 'pin', before: 'auto', after: 'micro' },
        ],
      }),
    ).toBe('conflict');
    expect(runtime.adapters.getSnapshot().pendingControls).toBeUndefined();
    expect(
      await runtime.adapters.applyControls({
        profile: 'auto',
        action: 'apply',
        changes: [
          { key: 'advisor', before: 'typesafe/jev-latest', after: undefined },
        ],
      }),
    ).toBe('conflict');
  });
  it('preserves unrelated external changes and refuses overlapping changes at activation', async () => {
    const { state, runtime } = setup();
    await runtime.adapters.applyControls({
      profile: 'auto',
      action: 'apply',
      changes: [{ key: 'pin', before: 'auto', after: 'high' }],
    });
    state.currentConfig = { ...state.currentConfig, maxSessionBudget: 20 };
    runtime.activatePending();
    expect(state.currentConfig.maxSessionBudget).toBe(20);
    expect(state.pinnedTierByProfile).toEqual({ auto: 'high' });
    await runtime.adapters.applyControls({
      profile: 'auto',
      action: 'apply',
      changes: [{ key: 'budget', before: 20, after: 10 }],
    });
    state.currentConfig = { ...state.currentConfig, maxSessionBudget: 30 };
    expect(runtime.activatePending()).toBe(false);
    expect(state.currentConfig.maxSessionBudget).toBe(30);
  });
  it('ignores late request observations after a session reset', () => {
    const { runtime } = setup();
    const observe = runtime.beginRequest();
    runtime.reset();
    observe({ stage: 'cancelled' });
    expect(runtime.adapters.getSnapshot().lifecycle).toBe('idle');
  });
  it('keeps credentials out of the presentation projection', () => {
    const { state, runtime } = setup();
    state.currentConfig = normalizeConfig({
      ...state.currentConfig,
      advisor: { enabled: true, model: 'typesafe/jev-latest' },
    }).config;
    const serialized = JSON.stringify(runtime.adapters.getSnapshot());
    expect(serialized).not.toContain('secret-sentinel');
    expect(serialized).not.toContain('secret.example');
    expect(runtime.adapters.getSnapshot().privacy.auth).toBe('unknown');
  });
  it('rejects nonfinite budgets and out-of-range timeouts', async () => {
    const { runtime } = setup();
    for (const after of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(
        await runtime.adapters.applyControls({
          profile: 'auto',
          action: 'apply',
          changes: [{ key: 'budget', before: undefined, after }],
        }),
      ).toBe('conflict');
    }
    expect(
      await runtime.adapters.applyControls({
        profile: 'auto',
        action: 'apply',
        changes: [{ key: 'timeout', before: 1500, after: 2147483648 }],
      }),
    ).toBe('conflict');
  });
});

it('queues adaptive-review and switch-policy controls until the next user boundary', async () => {
  const { state, runtime } = setup();
  const before = runtime.adapters.getSnapshot().controls;
  expect(
    await runtime.adapters.applyControls({
      profile: 'auto',
      action: 'apply',
      changes: [
        {
          key: 'advisor',
          before: before.advisor,
          after: 'typesafe/jev-latest',
        },
        { key: 'reviewEveryRequests', before: 4, after: 2 },
        { key: 'costHorizon', before: 5, after: 10 },
        { key: 'costSensitivity', before: 0.5, after: 0.25 },
        { key: 'strongAdviceConfidence', before: 0.9, after: 0.95 },
      ],
    }),
  ).toBe('applied');
  expect(state.currentConfig.switchPolicy).toMatchObject({
    horizonRequests: 5,
    costSensitivity: 0.5,
  });
  expect(runtime.activatePending()).toBe(true);
  expect(state.currentConfig.advisor?.reviewEveryRequests).toBe(2);
  expect(state.currentConfig.switchPolicy).toMatchObject({
    horizonRequests: 10,
    costSensitivity: 0.25,
    strongAdviceConfidence: 0.95,
  });
});

describe('configured activity-cell presentation boundary', () => {
  it('projects normalized sparse overrides in fixed order, including inherited/replaced fallbacks and mapped effort', () => {
    const { state, runtime } = setup();
    state.currentConfig = normalizeConfig({
      models: { fast: { model: 'openai/fast' } },
      profiles: {
        auto: {
          medium: {
            model: 'openai/base',
            thinking: 'medium',
            fallbacks: ['openai/backup', 'openai/third'],
          },
          activities: {
            docs: {
              medium: { model: 'fast', thinking: 'high', fallbacks: [] },
            },
            debug: { low: { model: 'missing/no-text' } },
            code: {
              medium: { thinking: 'high' },
              high: { model: 'openai/code-high', thinking: 'low' },
            },
          },
        },
      },
    }).config;
    state.currentModelRegistry.find = (provider, id) =>
      provider === 'missing' || id === 'base'
        ? undefined
        : model(id, { provider, reasoning: id !== 'fast' });
    const snapshot = runtime.adapters.getSnapshot();
    expect(snapshot.activityRouting).toBe('on');
    expect(
      snapshot.activityCells.map((cell) => [
        cell.activity,
        cell.configured.tier,
      ]),
    ).toEqual([
      ['code', 'high'],
      ['code', 'medium'],
      ['debug', 'low'],
      ['docs', 'medium'],
    ]);
    expect(snapshot.activityCells[1]).toEqual({
      activity: 'code',
      configured: { tier: 'medium', model: 'openai/base', thinking: 'high' },
      fallbacks: ['openai/backup', 'openai/third'],
      availability: 'eligible',
      eligible: {
        tier: 'medium',
        provider: 'openai',
        model: 'backup',
        thinking: 'high',
      },
    });
    expect(snapshot.activityCells[2]).toMatchObject({
      availability: 'unavailable',
      configured: { model: 'missing/no-text' },
    });
    expect(snapshot.activityCells[3]).toEqual({
      activity: 'docs',
      configured: { tier: 'medium', model: 'openai/fast', thinking: 'high' },
      fallbacks: [],
      availability: 'eligible',
      eligible: {
        tier: 'medium',
        provider: 'openai',
        model: 'fast',
        thinking: 'off',
      },
    });
    expect(snapshot.actual).toBeUndefined();
    expect(snapshot.advised).toBeUndefined();
    expect(snapshot.eligible.medium?.model).toBe('backup');
  });

  it('retains disabled declarations without checking activity targets or offering them as generic routes', () => {
    const { state, runtime } = setup();
    state.currentConfig = normalizeConfig({
      activityRouting: 'off',
      profiles: {
        auto: { activities: { code: { medium: { model: 'openai/code' } } } },
      },
    }).config;
    const find = vi.spyOn(state.currentModelRegistry, 'find');
    expect(runtime.adapters.getSnapshot()).toMatchObject({
      activityRouting: 'off',
      eligible: {},
      activityCells: [
        {
          activity: 'code',
          configured: { model: 'openai/code' },
          availability: 'disabled',
        },
      ],
    });
    expect(find).not.toHaveBeenCalled();
    state.currentConfig.activityRouting = 'on';
    expect(runtime.adapters.getSnapshot()).toMatchObject({
      eligible: {},
      activityCells: [
        { availability: 'eligible', eligible: { model: 'code' } },
      ],
    });
  });

  it('labels missing registry as unknown and image-only targets as text-unavailable', () => {
    const { state, runtime } = setup();
    state.currentConfig = normalizeConfig({
      profiles: {
        auto: { activities: { docs: { micro: { model: 'openai/images' } } } },
      },
    }).config;
    state.currentModelRegistry.find = (provider, id) =>
      model(id, { provider, input: ['image'] });
    expect(runtime.adapters.getSnapshot().activityCells[0]?.availability).toBe(
      'unavailable',
    );
    const withoutRegistry = createRouterUIRuntime(
      { ...state, currentModelRegistry: undefined },
      () => undefined,
    );
    expect(
      withoutRegistry.adapters.getSnapshot().activityCells[0],
    ).toMatchObject({
      availability: 'unknown',
      configured: { model: 'openai/images' },
    });
  });

  it('uses active session effort only and does not leak mutable config/fallback metadata into presentation', async () => {
    const { state, runtime } = setup();
    state.currentConfig = normalizeConfig({
      profiles: {
        auto: {
          medium: { model: 'openai/base', fallbacks: ['openai/backup'] },
          activities: { code: { medium: { thinking: 'low' } } },
        },
      },
    }).config;
    const snapshot = runtime.adapters.getSnapshot();
    await runtime.adapters.applyControls({
      profile: 'auto',
      action: 'apply',
      changes: [{ key: 'thinkingMedium', before: undefined, after: 'high' }],
    });
    expect(
      runtime.adapters.getSnapshot().activityCells[0]?.configured.thinking,
    ).toBe('low');
    expect(runtime.activatePending()).toBe(true);
    expect(runtime.adapters.getSnapshot().activityCells[0]).toMatchObject({
      configured: { thinking: 'high' },
      eligible: { thinking: 'high' },
    });
    Object.assign(required(snapshot.activityCells[0]).configured, {
      model: 'changed',
    });
    required(
      state.currentConfig.profiles.auto?.activities?.code?.medium?.fallbacks,
    ).push('openai/new');
    expect(required(snapshot.activityCells[0]).fallbacks).toEqual([
      'openai/backup',
    ]);
    expect(
      runtime.adapters.getSnapshot().activityCells[0]?.configured.model,
    ).toBe('openai/base');
    expect(JSON.stringify(snapshot.activityCells)).not.toMatch(
      /baseUrl|resolvedFallbacks|contextWindow|apiKey/,
    );
  });
});

describe('native per-cell route transactions', () => {
  const target = model('chat', { provider: 'openai', name: 'Physical chat' });
  const getCell = (
    runtime: ReturnType<typeof createRouterUIRuntime>,
    activity: 'code' | 'debug' | 'explore' | 'plan' | 'review' | 'ops' | 'docs',
    tier: 'high' | 'medium' | 'low' | 'micro',
  ) =>
    required(
      runtime.adapters
        .getSnapshot()
        .routeCells.find(
          (cell) => cell.activity === activity && cell.tier === tier,
        ),
      `${activity}/${tier}`,
    );

  it('queues a valid cell edit until the next user boundary without changing actual generation', async () => {
    const { state, runtime } = setup();
    state.currentModelRegistry.getModelsOfType = ((type: string) =>
      type === 'chat'
        ? [target, model('auto', { provider: 'router' })]
        : []) as unknown as ExtensionContext['modelRegistry']['getModelsOfType'];
    state.currentConfig.profiles.auto = {
      ...state.currentConfig.profiles.auto,
      medium: {
        ...required(state.currentConfig.profiles.auto?.medium),
        reasoning: false,
        thinkingLevels: ['off'],
      },
    };
    state.currentConfig.models = {
      'openai/chat': {
        model: 'evil/redirected-chat',
        reasoning: false,
        thinkingLevels: ['off'],
      },
      'openai/medium': { model: 'evil/redirected-generic' },
    };
    expect(
      runtime.adapters.getSnapshot().chatModels.map((entry) => entry.model),
    ).toEqual(['openai/chat']);
    runtime.beginRequest()({
      stage: 'generating',
      decision: {
        profile: 'auto',
        tier: 'medium',
        targetProvider: 'openai',
        targetModelId: 'medium',
        targetLabel: 'openai/medium',
        thinking: 'medium',
        reasonCode: 'baseline',
        timestamp: 1,
      },
    });
    const actual = runtime.adapters.getSnapshot().actual;
    const cell = getCell(runtime, 'code', 'medium');
    expect(cell.current.state).toBe('inherited');
    expect(cell.current.model).toBe('openai/medium');
    expect(runtime.adapters.applyRoutes).toBeDefined();
    expect(
      await runtime.adapters.applyRoutes({
        profile: 'auto',
        changes: [
          {
            activity: 'code',
            tier: 'medium',
            before: cell.current,
            after: { model: 'openai/chat', thinking: 'low' },
          },
        ],
      }),
    ).toBe('applied');
    expect(state.currentConfig.profiles.auto?.activities?.code).toBeUndefined();
    expect(runtime.adapters.getSnapshot().actual).toEqual(actual);
    expect(getCell(runtime, 'code', 'medium').pending).toMatchObject({
      state: 'override',
      model: 'openai/chat',
      thinking: 'low',
    });
    expect(runtime.activatePending()).toBe(true);
    expect(
      state.currentConfig.profiles.auto?.activities?.code?.medium,
    ).toMatchObject({
      model: 'openai/chat',
      thinking: 'low',
      reasoning: true,
    });
    expect(
      state.currentConfig.profiles.auto?.activities?.code?.medium
        ?.thinkingLevels,
    ).toBeUndefined();
    expect(getCell(runtime, 'code', 'medium')).toMatchObject({
      current: { model: 'openai/chat', thinking: 'low' },
      effectiveThinking: 'low',
    });
    expect(state.currentConfig.profiles.auto?.medium?.model).toBe(
      'openai/medium',
    );
    const snapshot = runtime.adapters.getSnapshot();
    expect(snapshot.actual).toEqual(actual);
    expect(JSON.stringify(snapshot.routeCells)).not.toMatch(
      /baseUrl|resolvedFallbacks|contextWindow|apiKey|transcript/,
    );
    expect(JSON.stringify(snapshot.chatModels)).not.toMatch(
      /baseUrl|apiKey|contextWindow|transcript/,
    );
  });

  it('resets an override to generic inheritance and rejects clearing the only route', async () => {
    const { state, runtime } = setup();
    state.currentModelRegistry.getModelsOfType = ((type: string) =>
      type === 'chat'
        ? [target]
        : []) as unknown as ExtensionContext['modelRegistry']['getModelsOfType'];
    state.currentConfig.profiles.auto = {
      ...state.currentConfig.profiles.auto,
      activities: {
        code: { medium: { model: 'openai/chat', thinking: 'low' } },
      },
    };
    const cell = getCell(runtime, 'code', 'medium');
    expect(cell.current.state).toBe('override');
    expect(
      await runtime.adapters.applyRoutes({
        profile: 'auto',
        changes: [
          {
            activity: 'code',
            tier: 'medium',
            before: cell.current,
            after: undefined,
          },
        ],
      }),
    ).toBe('applied');
    expect(runtime.activatePending()).toBe(true);
    expect(state.currentConfig.profiles.auto?.activities?.code).toBeUndefined();
    expect(getCell(runtime, 'code', 'medium').current).toMatchObject({
      state: 'inherited',
      model: 'openai/medium',
    });

    state.currentConfig.profiles.auto = {
      activities: { code: { medium: { model: 'openai/chat' } } },
    };
    const onlyCell = getCell(runtime, 'code', 'medium');
    expect(
      await runtime.adapters.applyRoutes({
        profile: 'auto',
        changes: [
          {
            activity: 'code',
            tier: 'medium',
            before: onlyCell.current,
            after: undefined,
          },
        ],
      }),
    ).toBe('invalid');
    expect(
      state.currentConfig.profiles.auto?.activities?.code?.medium?.model,
    ).toBe('openai/chat');
  });

  it('rejects stale transactions, recursive/unknown/ineligible targets and unsupported effort', async () => {
    const { state, runtime } = setup();
    state.currentModelRegistry.getModelsOfType = ((type: string) =>
      type === 'chat'
        ? [
            target,
            model('images', { provider: 'openai', input: ['image'] }),
            model('off-only', {
              provider: 'openai',
              reasoning: false,
              thinkingLevelMap: { off: 'none' },
            }),
          ]
        : []) as unknown as ExtensionContext['modelRegistry']['getModelsOfType'];
    const cell = getCell(runtime, 'code', 'medium');
    expect(
      await runtime.adapters.applyRoutes({
        profile: 'auto',
        changes: [
          {
            activity: 'code',
            tier: 'medium',
            before: { ...cell.current, model: 'openai/stale' },
            after: { model: 'openai/chat', thinking: 'low' },
          },
        ],
      }),
    ).toBe('conflict');
    state.currentConfig.profiles.auto = {
      ...state.currentConfig.profiles.auto,
      medium: {
        ...required(state.currentConfig.profiles.auto?.medium),
        reasoning: false,
        thinkingLevels: ['off'],
      },
    };
    expect(
      await runtime.adapters.applyRoutes({
        profile: 'auto',
        changes: [
          {
            activity: 'code',
            tier: 'medium',
            before: cell.current,
            after: { model: 'openai/chat', thinking: 'low' },
          },
        ],
      }),
    ).toBe('conflict');
    const currentCell = getCell(runtime, 'code', 'medium');
    for (const modelRef of ['router/auto', 'missing/model', 'openai/images'])
      expect(
        await runtime.adapters.applyRoutes({
          profile: 'auto',
          changes: [
            {
              activity: 'code',
              tier: 'medium',
              before: currentCell.current,
              after: { model: modelRef, thinking: 'low' },
            },
          ],
        }),
      ).toBe('invalid');
    expect(
      await runtime.adapters.applyRoutes({
        profile: 'auto',
        changes: [
          {
            activity: 'code',
            tier: 'medium',
            before: currentCell.current,
            after: { model: 'openai/off-only', thinking: 'high' },
          },
        ],
      }),
    ).toBe('invalid');
    expect(
      runtime.adapters
        .getSnapshot()
        .routeCells.find(
          (item) => item.activity === 'code' && item.tier === 'medium',
        )?.pending,
    ).toBeUndefined();
  });

  it('preserves tier-wide effort precedence and exposes configured versus effective effort', async () => {
    const { state, runtime } = setup();
    state.currentModelRegistry.getModelsOfType = ((type: string) =>
      type === 'chat'
        ? [target]
        : []) as unknown as ExtensionContext['modelRegistry']['getModelsOfType'];
    state.thinkingByProfile.auto = { medium: 'high' };
    runtime.beginRequest()({
      stage: 'generating',
      decision: {
        profile: 'auto',
        tier: 'medium',
        targetProvider: 'openai',
        targetModelId: 'medium',
        targetLabel: 'openai/medium',
        thinking: 'high',
        reasonCode: 'baseline',
        timestamp: 1,
      },
    });
    const actual = runtime.adapters.getSnapshot().actual;
    const cell = getCell(runtime, 'code', 'medium');
    expect(cell.effectiveThinking).toBe('high');
    expect(cell.tierEffortOverride).toBe('high');
    expect(
      await runtime.adapters.applyRoutes({
        profile: 'auto',
        changes: [
          {
            activity: 'code',
            tier: 'medium',
            before: cell.current,
            after: { model: 'openai/chat', thinking: 'low' },
          },
        ],
      }),
    ).toBe('applied');
    expect(getCell(runtime, 'code', 'medium').pending).toMatchObject({
      state: 'override',
      thinking: 'low',
    });
    expect(getCell(runtime, 'code', 'medium').pendingEffectiveThinking).toBe(
      'high',
    );
    expect(state.thinkingByProfile.auto?.medium).toBe('high');
    expect(runtime.adapters.getSnapshot().actual).toEqual(actual);
    expect(runtime.activatePending()).toBe(true);
    expect(runtime.adapters.getSnapshot().actual).toEqual(actual);
    expect(getCell(runtime, 'code', 'medium')).toMatchObject({
      current: { thinking: 'low' },
      effectiveThinking: 'high',
      tierEffortOverride: 'high',
    });
    const controls = runtime.adapters.getSnapshot().controls;
    expect(
      await runtime.adapters.applyControls({
        profile: 'auto',
        action: 'apply',
        changes: [{ key: 'thinkingMedium', before: 'high', after: undefined }],
      }),
    ).toBe('applied');
    expect(getCell(runtime, 'code', 'medium').effectiveThinking).toBe('high');
    expect(getCell(runtime, 'code', 'medium').pendingEffectiveThinking).toBe(
      'low',
    );
    expect(runtime.adapters.getSnapshot().actual).toEqual(actual);
    expect(runtime.activatePending()).toBe(true);
    expect(state.thinkingByProfile.auto?.medium).toBeUndefined();
    expect(getCell(runtime, 'code', 'medium').effectiveThinking).toBe('low');
    expect(controls.thinkingMedium).toBe('high');
  });

  it('drops pending routes on reset and route conflicts at activation', async () => {
    const { state, runtime } = setup();
    state.currentModelRegistry.getModelsOfType = ((type: string) =>
      type === 'chat'
        ? [target]
        : []) as unknown as ExtensionContext['modelRegistry']['getModelsOfType'];
    const cell = getCell(runtime, 'code', 'medium');
    expect(
      await runtime.adapters.applyRoutes({
        profile: 'auto',
        changes: [
          {
            activity: 'code',
            tier: 'medium',
            before: cell.current,
            after: { model: 'openai/chat', thinking: 'low' },
          },
        ],
      }),
    ).toBe('applied');
    runtime.reset();
    expect(getCell(runtime, 'code', 'medium').pending).toBeUndefined();

    const next = getCell(runtime, 'code', 'medium');
    expect(
      await runtime.adapters.applyRoutes({
        profile: 'auto',
        changes: [
          {
            activity: 'code',
            tier: 'medium',
            before: next.current,
            after: { model: 'openai/chat', thinking: 'low' },
          },
        ],
      }),
    ).toBe('applied');
    state.currentConfig.profiles.auto = {
      ...state.currentConfig.profiles.auto,
      activities: { code: { medium: { model: 'openai/external' } } },
    };
    expect(runtime.activatePending()).toBe(false);
    expect(
      state.currentConfig.profiles.auto?.activities?.code?.medium?.model,
    ).toBe('openai/external');
  });
});

describe('activity-aware UI capability validation', () => {
  it('accepts effort/baseline edits for activity-only routes but never pins them as generic tiers', async () => {
    const { state, runtime } = setup();
    state.currentConfig = normalizeConfig({
      profiles: {
        auto: {
          activities: { code: { medium: { model: 'openai/medium' } } },
          baselineTier: 'medium',
        },
      },
    }).config;
    expect(
      await runtime.adapters.applyControls({
        profile: 'auto',
        action: 'apply',
        changes: [{ key: 'thinkingMedium', before: undefined, after: 'high' }],
      }),
    ).toBe('applied');
    expect(runtime.activatePending()).toBe(true);
    expect(state.thinkingByProfile).toEqual({ auto: { medium: 'high' } });
    expect(
      await runtime.adapters.applyControls({
        profile: 'auto',
        action: 'apply',
        changes: [{ key: 'pin', before: 'auto', after: 'medium' }],
      }),
    ).toBe('conflict');
    state.currentConfig.activityRouting = 'off';
    expect(
      await runtime.adapters.applyControls({
        profile: 'auto',
        action: 'apply',
        changes: [{ key: 'thinkingMedium', before: 'high', after: 'off' }],
      }),
    ).toBe('conflict');
  });
});
