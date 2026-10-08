import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../config';
import { model } from '../test/fixtures';
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
    thinkingByProfile: {},
    lastDecision: undefined,
    debugHistory: [],
    currentModelRegistry: {
      find: (provider: string, id: string) => model(id, { provider }),
      getModelsOfType: (() => [
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
      ]) as unknown as ExtensionContext['modelRegistry']['getModelsOfType'],
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
        phase: 'implementation',
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
