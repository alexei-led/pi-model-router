import { getModel } from '@earendil-works/pi-ai/compat';
import { expect, it } from 'vitest';
import { normalizeConfig } from './config';
import { repriceTokens } from './economics';
import { buildRouteMatrix } from './routing';
import { model, required } from './test/fixtures';
import { runtimeCosts } from './test/runtime-catalog';

it('keeps current-runtime Sonnet list estimates separate from the supported SDK catalog', () => {
  const current = model('claude-sonnet-5-5', {
    cost: required(runtimeCosts['claude-sonnet-5-5']),
  });
  expect(
    repriceTokens(current, {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
    }),
  ).toBe(14.6);
  const sdk = getModel('anthropic', 'claude-sonnet-5-5');
  expect(
    repriceTokens(sdk, {
      input: 100,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ).toBeCloseTo(((sdk.cost.input + sdk.cost.output) * 100) / 1e6);
});

it.each([2, 3, 10])(
  'tariff %s does not reverse a declared quality upgrade edge',
  (input) => {
    const profile = required(
      normalizeConfig({
        profiles: {
          p: {
            activityPreset: 'off',
            medium: {
              model: 'anthropic/claude-sonnet-5-5',
              thinking: 'high',
              thinkingLevels: ['high'],
            },
            high: { model: 'anthropic/claude-opus-5-5', thinking: 'high' },
          },
        },
      }).config.profiles.p,
    );
    const matrix = buildRouteMatrix(
      profile,
      (provider, id) =>
        model(id, {
          provider,
          cost: {
            ...required(runtimeCosts[id]),
            ...(id === 'claude-sonnet-5-5' ? { input } : {}),
          },
          thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
        }),
      false,
      0,
      undefined,
      true,
      undefined,
      { mode: 'quality', budgetExceeded: false },
    );
    expect(
      matrix.plans.find((p) => p.tier === 'medium')?.attempts[0],
    ).toMatchObject({ model: 'anthropic/claude-opus-5-5', thinking: 'high' });
  },
);

it.each([100_000, 100_001])(
  'uses current Haiku long-input pricing at %s without changing route capability',
  (input) => {
    const target = model('claude-haiku-5-5', {
      cost: required(runtimeCosts['claude-haiku-5-5']),
    });
    expect(
      repriceTokens(target, { input, output: 0, cacheRead: 0, cacheWrite: 0 }),
    ).toBeCloseTo((input * (input > 100_000 ? 0.5 : 0.1)) / 1e6);
  },
);
