import { describe, expect, it } from 'vitest';
import {
  mergeConfig,
  normalizeConfig,
  resolveModelRef,
  resolveProfileName,
} from './config';
import { buildPersistedState, isRouterPersistedState } from './state';
import type { RouterConfig } from './types';

const base: RouterConfig = {
  profiles: { balanced: { medium: { model: 'test/primary' } } },
};

describe('configuration boundaries', () => {
  it('does not auto-enable thinking on a tier declared non-reasoning', () => {
    const result = normalizeConfig({
      profiles: {
        local: { medium: { model: 'test/local', reasoning: false } },
      },
    });
    expect(
      result.config.profiles.local?.medium?.resolvedThinkingLevels,
    ).toEqual([]);
  });
  it.each([null, [], 'wrong'])(
    'ignores malformed profile entries %j while preserving valid config',
    (value) => {
      const override = {
        profiles: { broken: value },
      } as unknown as RouterConfig;
      expect(
        normalizeConfig(mergeConfig(base, override)).config.profiles,
      ).toEqual(normalizeConfig(base).config.profiles);
    },
  );
  it.each([[], [''], ['ok', 42], [null], ''])(
    'rejects invalid rule keywords %j',
    (matches) => {
      const input = {
        ...base,
        rules: [{ matches, tier: 'high' }],
      } as unknown as RouterConfig;
      const result = normalizeConfig(input);
      expect(result.config.rules).toBeUndefined();
      expect(result.warnings).toHaveLength(1);
    },
  );
  it('does not resolve inherited property names as models or profiles', () => {
    expect(resolveModelRef('toString', {})).toEqual({
      canonicalRef: 'toString',
    });
    expect(resolveProfileName(base, 'constructor')).toBeUndefined();
  });
});

describe('persisted state boundary', () => {
  const valid = { enabled: true, selectedProfile: 'balanced', timestamp: 1 };
  it.each([
    { accumulatedCost: -1 },
    { accumulatedCost: 'broken' },
    { accumulatedCost: Number.NaN },
    { pinByProfile: { balanced: 'ultra' } },
    { thinkingByProfile: { balanced: null } },
    { thinkingByProfile: { balanced: { high: 'invalid' } } },
    { debugHistory: [null] },
    { lastDecision: { tier: 'high' } },
    { lastNonRouterModel: 'invalid' },
    { debugEnabled: 'yes' },
  ])('rejects corrupted optional fields %j', (invalid) => {
    expect(isRouterPersistedState({ ...valid, ...invalid })).toBe(false);
  });
  it('snapshots nested maps independently of live state', () => {
    const thinking = { balanced: { high: 'high' as const } };
    const state = buildPersistedState({
      routerEnabled: true,
      selectedProfile: 'balanced',
      pinnedTierByProfile: {},
      thinkingByProfile: thinking,
      debugEnabled: false,
      widgetEnabled: false,
      debugHistory: [],
      lastDecision: undefined,
      lastNonRouterModel: undefined,
      accumulatedCost: 0,
    });
    delete state.thinkingByProfile?.balanced?.high;
    expect(thinking.balanced?.high).toBe('high');
    expect(isRouterPersistedState(state)).toBe(true);
  });
});
