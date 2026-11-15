import { describe, expect, it } from 'vitest';
import { normalizeConfig } from './config';
import { buildRouteMatrix } from './routing';
import { model, required } from './test/fixtures';
import type { RouterActivity, RouterMode, RouterTier } from './types';

const ladder = {
  micro: { model: 'work/gpt-6-luna', thinking: 'off' },
  low: { model: 'work/gpt-6-luna', thinking: 'high' },
  medium: { model: 'work/gpt-6.1-terra', thinking: 'medium' },
  high: { model: 'work/gpt-6.1-sol', thinking: 'high' },
};
const find = (provider: string, id: string) =>
  model(id, {
    provider,
    contextWindow: 500_000,
    thinkingLevelMap: { xhigh: 'xhigh' },
    cost: {
      input: id === 'gpt-6-luna' ? 0.5 : id === 'gpt-6.1-terra' ? 2 : 5,
      output: 15,
      cacheRead: 0.2,
      cacheWrite: 0,
    },
  });
const pair = (
  mode: RouterMode,
  tier: RouterTier,
  activity?: RouterActivity,
  overrides?: { medium: 'xhigh' },
  pin?: RouterTier,
) => {
  const profile = required(
    normalizeConfig({ profiles: { p: ladder } }).config.profiles.p,
  );
  return required(
    buildRouteMatrix(profile, find, false, 0, overrides, true, pin, {
      mode,
      budgetExceeded: false,
    }).plans.find((p) => p.tier === tier && p.cell === activity),
  ).attempts[0];
};

describe('provider-aware OpenAI targets', () => {
  it.each(['balanced', 'cost'] as const)(
    '%s preserves medium capability roles',
    (mode) => {
      expect(pair(mode, 'medium', 'code')).toMatchObject({
        model: 'work/gpt-6.1-terra',
        thinking: 'high',
      });
      for (const activity of ['debug', 'plan', 'review'] as const)
        expect(pair(mode, 'medium', activity)).toMatchObject({
          model: 'work/gpt-6.1-sol',
          thinking: 'medium',
        });
      for (const activity of ['explore', 'docs', 'ops'] as const)
        expect(pair(mode, 'medium', activity)).toMatchObject({
          model: 'work/gpt-6.1-terra',
          thinking: 'medium',
        });
    },
  );
  it('keeps cost high reasoning on Sol and bounded workers on Terra', () => {
    for (const activity of [
      undefined,
      'code',
      'debug',
      'plan',
      'review',
    ] as const)
      expect(pair('cost', 'high', activity)).toMatchObject({
        model: 'work/gpt-6.1-sol',
        thinking: 'high',
      });
    for (const activity of ['explore', 'docs', 'ops'] as const)
      expect(pair('cost', 'high', activity)).toMatchObject({
        model: 'work/gpt-6.1-terra',
        thinking: 'medium',
      });
    expect(pair('cost', 'medium')).toMatchObject({
      model: 'work/gpt-6.1-terra',
      thinking: 'medium',
    });
    expect(pair('cost', 'low')).toMatchObject({
      model: 'work/gpt-6-luna',
      thinking: 'medium',
    });
  });
  it('preserves deliberate overrides and pins', () => {
    expect(pair('cost', 'medium', 'code', { medium: 'xhigh' }).thinking).toBe(
      'xhigh',
    );
    expect(
      pair('cost', 'medium', undefined, undefined, 'medium'),
    ).toMatchObject({ model: 'work/gpt-6.1-terra', thinking: 'medium' });
  });
});

describe('Haiku automatic quality effort', () => {
  it.each(['claude-haiku-5-5', 'vendor/claude-haiku-5-5'])(
    'prefers high except bounded medium ops for exact ID %s',
    (id) => {
      const ref = `anthropic/${id}`;
      const profile = required(
        normalizeConfig({
          profiles: {
            p: {
              activityPreset: 'off',
              low: { model: ref, thinking: 'high' },
              medium: { model: ref, thinking: 'high' },
              high: { model: ref, thinking: 'xhigh' },
              activities: { ops: { medium: { model: ref, thinking: 'high' } } },
            },
          },
        }).config.profiles.p,
      );
      const matrix = buildRouteMatrix(
        profile,
        find,
        false,
        0,
        undefined,
        true,
        undefined,
        { mode: 'quality', budgetExceeded: false },
      );
      const exactHaiku = id === 'claude-haiku-5-5';
      expect(
        matrix.plans.find((p) => p.tier === 'low' && !p.cell)?.attempts[0]
          .thinking,
      ).toBe(exactHaiku ? 'high' : 'xhigh');
      expect(
        matrix.plans.find((p) => p.tier === 'medium' && !p.cell)?.attempts[0]
          .thinking,
      ).toBe(exactHaiku ? 'high' : 'xhigh');
      expect(
        matrix.plans.find((p) => p.tier === 'medium' && p.cell === 'ops')
          ?.attempts[0].thinking,
      ).toBe('xhigh');
      expect(
        matrix.plans.find((p) => p.tier === 'high' && !p.cell)?.attempts[0]
          .thinking,
      ).toBe('xhigh');
      const manual = buildRouteMatrix(
        profile,
        find,
        false,
        0,
        { medium: 'xhigh' },
        true,
        undefined,
        { mode: 'quality', budgetExceeded: false },
      );
      expect(
        manual.plans
          .filter((p) => p.tier === 'medium')
          .every((p) => p.attempts[0].thinking === 'xhigh'),
      ).toBe(true);
    },
  );
});
