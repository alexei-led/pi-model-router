import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODES,
  DEFAULT_SWITCH_POLICY,
  normalizeConfig,
} from './config';
import { effectivePolicy, resolveMode, transformRoute } from './modes';
import { clampEffort } from './routing';
import { required } from './test/fixtures';
import type {
  ModeLever,
  RoutePair,
  RouterConfig,
  RouterMode,
  RouterTier,
} from './types';

const catalog: Record<
  string,
  { levels: readonly ThinkingLevel[]; price: number | undefined }
> = {
  opus: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], price: 4 },
  sonnet: {
    levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
    price: 2,
  },
  haiku: { levels: ['off', 'low', 'medium', 'high'], price: 1 },
  sol: { levels: ['off', 'low', 'medium', 'high', 'xhigh'], price: 2 },
  luna: { levels: ['off', 'low', 'medium', 'high'], price: 0.1 },
  free: { levels: ['off', 'low', 'medium', 'high'], price: 0 },
  freeToo: { levels: ['off', 'low', 'medium', 'high'], price: 0 },
  unpriced: { levels: ['off', 'low', 'medium', 'high'], price: undefined },
};

type Shape = Partial<Record<RouterTier, [model: string, ThinkingLevel]>>;
const shapes: Record<string, Shape> = {
  // design §2 expectation for built-in Claude defaults
  claudeDefaults: {
    high: ['opus', 'xhigh'],
    medium: ['opus', 'medium'],
    low: ['haiku', 'high'],
    micro: ['haiku', 'off'],
  },
  // the user's claude-* and openai-* profiles
  claudeUser: {
    high: ['opus', 'high'],
    medium: ['sonnet', 'medium'],
    low: ['sonnet', 'low'],
    micro: ['haiku', 'off'],
  },
  openaiUser: {
    high: ['sol', 'xhigh'],
    medium: ['sol', 'medium'],
    low: ['luna', 'medium'],
    micro: ['luna', 'off'],
  },
  zeroPrices: { medium: ['free', 'medium'], low: ['freeToo', 'medium'] },
  lowerFree: { medium: ['sonnet', 'medium'], low: ['free', 'medium'] },
  unknownPrice: { medium: ['unpriced', 'medium'], low: ['luna', 'medium'] },
  noLow: { high: ['opus', 'high'], medium: ['sonnet', 'medium'] },
};

const run = (
  shape: Shape,
  mode: RouterMode,
  tier: RouterTier,
  allowHigh = true,
) =>
  transformRoute({
    mode,
    tier,
    allowHigh,
    routeAt: (t) => {
      const entry = shape[t];
      return entry
        ? { tier: t, model: entry[0], thinking: entry[1] }
        : undefined;
    },
    project: (pair: RoutePair, level) =>
      clampEffort(level, catalog[pair.model]?.levels ?? []),
    inputPrice: (model) => catalog[model]?.price,
  });

type Row = [
  shape: string,
  mode: RouterMode,
  tier: RouterTier,
  expected: [source: RouterTier, thinking: ThinkingLevel, lever: ModeLever],
];

describe('mode transform', () => {
  it.each<Row>([
    ['claudeDefaults', 'cost', 'high', ['high', 'high', 'effort']],
    ['claudeDefaults', 'cost', 'medium', ['low', 'high', 'model']],
    ['claudeDefaults', 'cost', 'low', ['low', 'medium', 'effort']],
    ['claudeDefaults', 'cost', 'micro', ['micro', 'off', 'none']],
    ['claudeDefaults', 'quality', 'high', ['high', 'max', 'effort']],
    ['claudeDefaults', 'quality', 'medium', ['medium', 'high', 'effort']],
    ['claudeDefaults', 'quality', 'low', ['medium', 'medium', 'model']],
    ['claudeDefaults', 'quality', 'micro', ['micro', 'off', 'none']],
    ['claudeUser', 'cost', 'high', ['medium', 'medium', 'model']],
    ['claudeUser', 'cost', 'medium', ['medium', 'low', 'effort']],
    ['claudeUser', 'cost', 'low', ['low', 'low', 'none']],
    ['claudeUser', 'quality', 'high', ['high', 'xhigh', 'effort']],
    ['claudeUser', 'quality', 'medium', ['medium', 'high', 'effort']],
    ['claudeUser', 'quality', 'low', ['low', 'medium', 'effort']],
    ['openaiUser', 'cost', 'high', ['high', 'high', 'effort']],
    ['openaiUser', 'cost', 'medium', ['low', 'medium', 'model']],
    ['openaiUser', 'cost', 'low', ['low', 'low', 'effort']],
    ['openaiUser', 'quality', 'high', ['high', 'xhigh', 'none']],
    ['openaiUser', 'quality', 'medium', ['medium', 'high', 'effort']],
    ['openaiUser', 'quality', 'low', ['low', 'high', 'effort']],
    ['zeroPrices', 'cost', 'medium', ['medium', 'low', 'effort']],
    ['lowerFree', 'cost', 'medium', ['medium', 'low', 'effort']],
    ['unknownPrice', 'cost', 'medium', ['medium', 'low', 'effort']],
    ['noLow', 'cost', 'medium', ['medium', 'low', 'effort']],
  ])('%s %s %s', (shape, mode, tier, [sourceTier, thinking, lever]) => {
    expect(run(required(shapes[shape]), mode, tier)).toEqual({
      sourceTier,
      thinking,
      lever,
    });
  });

  it.each(Object.keys(shapes))('balanced keeps every %s pair', (name) => {
    const shape = required(shapes[name]);
    for (const tier of Object.keys(shape) as RouterTier[])
      expect(run(shape, 'balanced', tier)).toEqual({
        sourceTier: tier,
        thinking: shape[tier]?.[1],
        lever: 'none',
      });
  });

  it('never produces micro or thinking below low above micro', () => {
    for (const shape of Object.values(shapes))
      for (const tier of ['low', 'medium', 'high'] as const)
        for (const mode of ['cost', 'quality'] as const) {
          const result = run(shape, mode, tier);
          if (!result) continue;
          expect(result.sourceTier).not.toBe('micro');
          expect(['off', 'minimal']).not.toContain(result.thinking);
        }
  });

  it('caps the quality model lever below high over budget', () => {
    expect(
      run(required(shapes.openaiUser), 'quality', 'medium', false),
    ).toEqual({ sourceTier: 'medium', thinking: 'high', lever: 'effort' });
    const maxed: Shape = { high: ['opus', 'high'], medium: ['luna', 'high'] };
    expect(run(maxed, 'quality', 'medium', true)?.sourceTier).toBe('high');
    expect(run(maxed, 'quality', 'medium', false)).toEqual({
      sourceTier: 'medium',
      thinking: 'high',
      lever: 'none',
    });
  });

  it('returns nothing for an unconfigured tier', () => {
    expect(run(required(shapes.noLow), 'cost', 'low')).toBeUndefined();
  });
});

describe('mode resolution', () => {
  it.each([
    [
      { session: 'cost', project: 'quality', profile: 'balanced' },
      'cost',
      'session',
    ],
    [{ project: 'quality', profile: 'cost' }, 'quality', 'project'],
    [{ profile: 'cost' }, 'cost', 'profile'],
    [{}, 'balanced', 'default'],
  ] as const)('%j resolves to %s from %s', (layers, mode, source) => {
    expect(resolveMode(layers)).toEqual({ mode, source });
  });
});

describe('effective switch policy', () => {
  it('scopes profile patches below mode and session edits', () => {
    const personal = {
      switchPolicy: { strongAdviceConfidence: 0.8, costSensitivity: 0.4 },
    };
    const config = { profiles: { personal, work: {} } };
    expect(effectivePolicy(config, 'balanced', personal)).toMatchObject({
      strongAdviceConfidence: 0.8,
      costSensitivity: 0.4,
      horizonRequests: 5,
    });
    expect(effectivePolicy(config, 'cost', personal).costSensitivity).toBe(0.8);
    expect(
      effectivePolicy(config, 'balanced', config.profiles.work)
        .strongAdviceConfidence,
    ).toBe(0.9);
    expect(
      effectivePolicy(
        { ...config, sessionPolicy: { strongAdviceConfidence: 0.95 } },
        'balanced',
        personal,
      ).strongAdviceConfidence,
    ).toBe(0.95);
  });

  const config: RouterConfig = {
    profiles: {},
    switchPolicy: { ...DEFAULT_SWITCH_POLICY, costSensitivity: 0.3 },
    modes: structuredClone(DEFAULT_MODES),
  };

  it('keeps the configured policy in balanced mode', () => {
    expect(effectivePolicy(config, 'balanced').costSensitivity).toBe(0.3);
  });

  it('lets the mode patch beat the configured policy', () => {
    expect(effectivePolicy(config, 'cost')).toMatchObject({
      costSensitivity: 0.8,
      escalationHoldTurns: 1,
    });
  });

  it('lets a Settings-tab edit beat the mode patch', () => {
    expect(
      effectivePolicy(
        { ...config, sessionPolicy: { costSensitivity: 0.1 } },
        'cost',
      ),
    ).toMatchObject({ costSensitivity: 0.1, escalationHoldTurns: 1 });
  });

  it('limits escalation to the failing turn in every mode when configured', () => {
    const { config: limited } = normalizeConfig({
      switchPolicy: { escalationHoldTurns: 0 },
      modes: {
        cost: { policy: { escalationHoldTurns: 0 } },
        quality: { policy: { escalationHoldTurns: 0 } },
      },
    });
    for (const mode of ['cost', 'balanced', 'quality'] as const)
      expect(effectivePolicy(limited, mode).escalationHoldTurns).toBe(0);
  });

  it('falls back to defaults without configured policy', () => {
    expect(effectivePolicy({ profiles: {} }, 'quality')).toEqual({
      ...DEFAULT_SWITCH_POLICY,
      ...DEFAULT_MODES.quality.policy,
    });
  });
});
