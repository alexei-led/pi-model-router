import { expect, it } from 'vitest';
import { normalizeConfig } from './config';
import { buildRouteMatrix } from './routing';
import { failure, model, required } from './test/fixtures';
import { terraHarness } from './test/terra-harness';
import { ROUTER_ACTIVITIES, ROUTER_MODES, ROUTER_TIERS } from './types';

const find = (provider: string, id: string) =>
  model(id, {
    provider,
    contextWindow: 1_000_000,
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  });
const route = (provider: string, id: string) => ({
  model: `${provider}/${id}`,
  thinking: 'low',
});

it('delegates every explicit mode/activity/tier preference through the public registry', async () => {
  const activities = Object.fromEntries(
    ROUTER_ACTIVITIES.map((activity) => [
      activity,
      Object.fromEntries(
        ROUTER_TIERS.map((tier) => [
          tier,
          {
            ...route('work', `${activity}-${tier}-balanced`),
            modeRoutes: {
              cost: route('valar', `${activity}-${tier}-cost`),
              quality: route('work', `${activity}-${tier}-quality`),
            },
          },
        ]),
      ),
    ]),
  );
  const fixture = terraHarness(
    {
      advisor: {
        enabled: true,
        model: 'fixture/choice',
        reviewEveryRequests: 0,
      },
      profiles: {
        p: {
          activityPreset: 'off',
          advisor: { models: ['fixture/choice'] },
          ...Object.fromEntries(
            ROUTER_TIERS.map((tier) => [tier, route('work', `base-${tier}`)]),
          ),
          activities,
        },
      },
    },
    find,
  );
  for (const activity of ROUTER_ACTIVITIES)
    for (const tier of ROUTER_TIERS)
      for (const mode of ROUTER_MODES) {
        const result = await fixture.run(mode, tier, activity);
        expect(result.stopReason).toBe('stop');
        const [target, , options] = required(
          fixture.delegate.mock.calls.at(-1),
        );
        expect(
          [target.provider, target.id, options?.reasoning],
          `${activity}/${tier}/${mode}`,
        ).toEqual([
          mode === 'cost' ? 'valar' : 'work',
          `${activity}-${tier}-${mode}`,
          'low',
        ]);
      }
});

it('uses only the selected mode target fallback list after a generation failure', async () => {
  const fixture = terraHarness(
    {
      profiles: {
        p: {
          activityPreset: 'off',
          medium: {
            ...route('work', 'base'),
            fallbacks: ['work/base-fallback'],
            modeRoutes: {
              cost: {
                ...route('valar', 'primary'),
                fallbacks: ['valar/first', 'valar/second'],
              },
            },
          },
        },
      },
    },
    find,
  );
  fixture.delegate.mockImplementationOnce(() => failure());
  const result = await fixture.run('cost');
  expect(result.stopReason).toBe('stop');
  expect(
    fixture.delegate.mock.calls.map(
      ([target]) => `${target.provider}/${target.id}`,
    ),
  ).toEqual(['valar/primary', 'valar/first']);
});

it.each(['context', 'image', 'effort', 'pin'] as const)(
  'revalidates explicit mode targets under %s constraints',
  (constraint) => {
    const profile = required(
      normalizeConfig({
        profiles: {
          p: {
            activityPreset: 'off',
            medium: {
              ...route('work', 'base'),
              modeRoutes: { cost: route('valar', 'alternative') },
            },
          },
        },
      }).config.profiles.p,
    );
    const matrix = buildRouteMatrix(
      profile,
      (provider, id) => {
        const target = find(provider, id);
        if (id !== 'alternative') return target;
        return {
          ...target,
          contextWindow: constraint === 'context' ? 100 : 1_000_000,
          input: ['text'],
        };
      },
      constraint === 'image',
      constraint === 'context' ? 1000 : 0,
      constraint === 'effort' ? { medium: 'high' } : undefined,
      true,
      constraint === 'pin' ? 'medium' : undefined,
      { mode: 'cost', budgetExceeded: false },
    );
    expect(matrix.plans[0]?.attempts[0]?.model).toBe('work/base');
  },
);
