import { describe, expect, it } from 'vitest';
import { ACTIVITY_PRESETS } from './activity-presets';
import { mergeConfig, normalizeConfig, projectRouterConfig } from './config';
import { buildRouteMatrix, selectBaselinePlan } from './routing';
import { model, required } from './test/fixtures';
import type { RouterActivity, RouterProfile } from './types';
import { ROUTER_ACTIVITIES } from './types';

const generic = (provider = 'work') => ({
  micro: { model: `${provider}/gpt-6-luna`, thinking: 'off' },
  low: { model: `${provider}/gpt-6-luna`, thinking: 'medium' },
  medium: { model: `${provider}/gpt-6.1-sol`, thinking: 'medium' },
  high: { model: `${provider}/gpt-6.1-sol`, thinking: 'xhigh' },
});
const normalize = (profile: object, extra: object = {}) =>
  normalizeConfig({ ...extra, profiles: { p: profile } });
const profileOf = (profile: object, extra: object = {}) =>
  required(normalize(profile, extra).config.profiles.p);
const ordered = (profile: RouterProfile, activity: RouterActivity) =>
  ['micro', 'low', 'medium', 'high'].map((tier) => {
    const cell = profile.activities?.[activity];
    const route =
      tier === 'micro'
        ? cell?.micro
        : tier === 'low'
          ? cell?.low
          : tier === 'medium'
            ? cell?.medium
            : cell?.high;
    return route && [route.model.split('/')[1], route.thinking];
  });

const openaiExpected = {
  code: [
    ['gpt-6-luna', 'low'],
    ['gpt-6-luna', 'high'],
    ['gpt-6.1-sol', 'medium'],
    ['gpt-6.1-sol', 'high'],
  ],
  debug: [
    ['gpt-6-luna', 'medium'],
    ['gpt-6-luna', 'high'],
    ['gpt-6.1-sol', 'high'],
    ['gpt-6.1-sol', 'xhigh'],
  ],
  explore: [
    ['gpt-6-luna', 'low'],
    ['gpt-6-luna', 'medium'],
    ['gpt-6-luna', 'high'],
    ['gpt-6.1-sol', 'high'],
  ],
  plan: [
    ['gpt-6-luna', 'medium'],
    ['gpt-6-luna', 'high'],
    ['gpt-6.1-sol', 'high'],
    ['gpt-6.1-sol', 'xhigh'],
  ],
  review: [
    ['gpt-6-luna', 'medium'],
    ['gpt-6-luna', 'high'],
    ['gpt-6.1-sol', 'high'],
    ['gpt-6.1-sol', 'xhigh'],
  ],
  ops: [
    ['gpt-6-luna', 'low'],
    ['gpt-6-luna', 'medium'],
    ['gpt-6-luna', 'high'],
    ['gpt-6.1-sol', 'high'],
  ],
  docs: [
    ['gpt-6-luna', 'low'],
    ['gpt-6-luna', 'medium'],
    ['gpt-6.1-sol', 'medium'],
    ['gpt-6.1-sol', 'high'],
  ],
};

describe('built-in activity routes', () => {
  it.each(ROUTER_ACTIVITIES)(
    'provides the complete OpenAI %s row without rewriting generic tiers',
    (activity) => {
      const profile = profileOf(generic());
      expect(ordered(profile, activity)).toEqual(openaiExpected[activity]);
      expect(profile.high?.thinking).toBe('xhigh');
    },
  );
  it.each(['work', 'personal', 'custom-proxy'])(
    'preserves the exact %s provider ID for every target',
    (provider) => {
      const profile = profileOf(generic(provider));
      expect(
        Object.values(profile.activities ?? {})
          .flatMap(Object.values)
          .map((r) => r.model.split('/')[0]),
      ).toEqual(Array(28).fill(provider));
    },
  );
  it('resolves aliases before recognizing a family and keeps target alias metadata', () => {
    const profile = profileOf(
      { medium: { model: 'worker' } },
      {
        models: {
          worker: {
            model: 'work/gpt-6.1-sol',
            thinkingLevels: ['medium', 'high'],
          },
          cheap: {
            model: 'work/gpt-6-luna',
            thinkingLevels: ['low', 'high'],
            effortCacheSharing: 'separate',
          },
        },
      },
    );
    expect(profile.activities?.ops?.medium).toMatchObject({
      model: 'work/gpt-6-luna',
      thinkingLevels: ['low', 'high'],
    });
    expect(profile.activities?.ops?.low).toBeUndefined();
  });
  it.each([
    { medium: { model: 'test/unknown' } },
    {
      medium: { model: 'work/gpt-6.1-sol' },
      low: { model: 'personal/gpt-6-luna' },
    },
    {
      medium: { model: 'work/gpt-6.1-sol' },
      low: { model: 'work/claude-sonnet-5-5' },
    },
  ])(
    'does not guess a preset for mixed or unrecognized routes: %j',
    (profile) => {
      expect(profileOf(profile).activities).toBeUndefined();
    },
  );
  it('supports preset opt-out while retaining explicit activity routes', () => {
    const profile = profileOf({
      ...generic(),
      activityPreset: 'off',
      activities: { docs: { low: { thinking: 'low' } } },
    });
    expect(profile.activities?.code).toBeUndefined();
    expect(profile.activities?.docs?.low).toMatchObject({
      model: 'work/gpt-6-luna',
      thinking: 'low',
    });
  });
  it('lets explicit activity fields override defaults and null restore the generic route', () => {
    const profile = profileOf({
      ...generic(),
      activities: {
        debug: { medium: { thinking: 'xhigh' } },
        ops: { medium: null },
      },
    });
    expect(profile.activities?.debug?.medium?.thinking).toBe('xhigh');
    expect(profile.activities?.ops?.medium).toBeUndefined();
    expect(profile.medium?.model).toBe('work/gpt-6.1-sol');
  });
  it('preserves ordered generation fallbacks, including explicit empty replacement', () => {
    const profile = profileOf({
      ...generic(),
      medium: { ...generic().medium, fallbacks: ['work/one', 'work/two'] },
      activities: { docs: { medium: { fallbacks: [] } } },
    });
    expect(profile.activities?.debug?.medium?.fallbacks).toEqual([
      'work/one',
      'work/two',
    ]);
    expect(profile.activities?.docs?.medium?.fallbacks).toEqual([]);
  });
  it('merges project tuning and cell suppression before applying defaults', () => {
    const result = normalizeConfig(
      mergeConfig(
        { profiles: { p: generic() } },
        projectRouterConfig(
          {
            profiles: {
              p: {
                activities: {
                  debug: { medium: { thinking: 'xhigh' } },
                  docs: { low: null },
                },
              },
            },
          },
          [],
        ),
      ),
    );
    expect(result.config.profiles.p?.activities?.debug?.medium?.thinking).toBe(
      'xhigh',
    );
    expect(result.config.profiles.p?.activities?.docs?.low).toBeUndefined();
    expect(result.config.profiles.p?.activities?.code?.low).toBeDefined();
  });
  it('warns without echoing invalid preset values', () => {
    const result = normalize({
      ...generic(),
      activityPreset: 'secret-invalid',
    });
    expect(result.warnings.join()).toContain('activityPreset');
    expect(result.warnings.join()).not.toContain('secret-invalid');
  });
  it('keeps pins generic-only, effort overrides dominant and missing targets ineligible', () => {
    const profile = profileOf({
      medium: { model: 'work/gpt-6.1-sol', thinking: 'medium' },
    });
    const find = (provider: string, id: string) =>
      id === 'gpt-6.1-sol' ? model(id, { provider }) : undefined;
    const matrix = buildRouteMatrix(profile, find, false, 0);
    expect(
      matrix.plans.some((c) => c.attempts[0].model.endsWith('/gpt-6-luna')),
    ).toBe(false);
    expect(selectBaselinePlan('p', profile, matrix).plan.cell).toBeUndefined();
    expect(
      buildRouteMatrix(profile, find, false, 0, undefined, true, 'medium')
        .plans,
    ).toHaveLength(1);
    expect(
      buildRouteMatrix(profile, find, false, 0, { medium: 'low' }).plans.every(
        (c) => c.attempts[0].thinking === 'low',
      ),
    ).toBe(true);
    expect(
      buildRouteMatrix(profile, find, false, 0, undefined, false).plans,
    ).toHaveLength(1);
  });
});

describe('Anthropic activity policy', () => {
  const H = 'claude-haiku-5-5';
  const S = 'claude-sonnet-5-5';
  const O = 'claude-opus-5-5';
  const expected = {
    code: [
      [H, 'medium'],
      [S, 'high'],
      [S, 'high'],
      [O, 'high'],
    ],
    debug: [
      [H, 'high'],
      [S, 'high'],
      [O, 'medium'],
      [O, 'xhigh'],
    ],
    explore: [
      [H, 'medium'],
      [H, 'high'],
      [S, 'medium'],
      [O, 'medium'],
    ],
    plan: [
      [H, 'high'],
      [S, 'high'],
      [O, 'medium'],
      [O, 'xhigh'],
    ],
    review: [
      [H, 'high'],
      [S, 'high'],
      [O, 'medium'],
      [O, 'xhigh'],
    ],
    ops: [
      [H, 'medium'],
      [H, 'high'],
      [H, 'high'],
      [O, 'high'],
    ],
    docs: [
      [H, 'medium'],
      [H, 'high'],
      [S, 'medium'],
      [O, 'medium'],
    ],
  };
  it.each(ROUTER_ACTIVITIES)(
    'provides all four %s cells, including migration from a 4.5 fast tier',
    (activity) => {
      const profile = profileOf({
        micro: { model: 'claude-work/claude-haiku-4-5', thinking: 'off' },
        low: { model: `claude-work/${S}`, thinking: 'low' },
        medium: { model: `claude-work/${S}`, thinking: 'medium' },
        high: { model: `claude-work/${O}`, thinking: 'high' },
      });
      expect(ordered(profile, activity)).toEqual(expected[activity]);
      expect(profile.activities?.[activity]?.micro?.activitySource).toBe(
        'builtin',
      );
    },
  );
});

describe('preset migration boundaries', () => {
  it('keeps the generic model for an existing thinking-only override', () => {
    const profile = profileOf({
      medium: { model: 'work/gpt-6.1-sol' },
      activities: { ops: { medium: { thinking: 'high' } } },
    });
    expect(profile.activities?.ops?.medium).toMatchObject({
      model: 'work/gpt-6.1-sol',
      thinking: 'high',
    });
    expect(profile.activities?.ops?.medium?.activitySource).toBeUndefined();
  });
  it('does not transfer model-specific restrictions to a different built-in target', () => {
    const profile = profileOf({
      medium: {
        model: 'work/gpt-6.1-sol',
        thinkingLevels: ['medium'],
        reasoning: true,
        contextWindow: 1234,
        maxTokens: 120,
        fallbacks: ['work/fallback'],
      },
    });
    const route = required(profile.activities?.ops?.medium);
    expect(route.model).toBe('work/gpt-6-luna');
    expect(route.thinkingLevels).toBeUndefined();
    expect(route.contextWindow).toBeUndefined();
    expect(route.maxTokens).toBeUndefined();
    expect(route.fallbacks).toEqual(['work/fallback']);
    expect(profile.activities?.debug?.medium?.thinkingLevels).toEqual([
      'medium',
    ]);
  });
  it('cannot redirect a built-in canonical target through a canonical-looking alias key', () => {
    const profile = profileOf(
      { medium: { model: 'work/gpt-6.1-sol' } },
      { models: { 'work/gpt-6-luna': { model: 'personal/gpt-6.1-sol' } } },
    );
    expect(profile.activities?.ops?.medium?.model).toBe('work/gpt-6-luna');
  });
  it('keeps preset opt-out user-owned while allowing project cell tuning', () => {
    const warnings: string[] = [];
    const project = projectRouterConfig(
      {
        profiles: {
          p: {
            activityPreset: 'auto',
            activities: { debug: { medium: null } },
          },
        },
      },
      warnings,
    );
    const result = normalizeConfig(
      mergeConfig(
        { profiles: { p: { ...generic(), activityPreset: 'off' } } },
        project,
      ),
    );
    expect(result.config.profiles.p?.activities).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });
  it("retains an unavailable preset primary's explicitly declared fallback before using generic", () => {
    const profile = profileOf({
      medium: {
        model: 'work/gpt-6.1-sol',
        fallbacks: ['personal/authorized-fallback'],
      },
    });
    const matrix = buildRouteMatrix(
      profile,
      (provider, id) =>
        id === 'gpt-6-luna' ? undefined : model(id, { provider }),
      false,
      0,
    );
    expect(matrix.plans.find((p) => p.cell === 'ops')?.attempts[0].model).toBe(
      'personal/authorized-fallback',
    );
  });
  it('uses the generic medium-or-lower baseline over budget despite high preset cells', () => {
    const profile = profileOf(generic());
    const matrix = buildRouteMatrix(
      profile,
      (provider, id) => model(id, { provider }),
      false,
      0,
    );
    const selection = selectBaselinePlan('p', profile, matrix, undefined, true);
    expect(selection.reasonCode).toBe('budget');
    expect(selection.plan.cell).toBeUndefined();
    expect(selection.plan.tier).toBe('medium');
  });
});

it('matches the published complete preset matrices', async () => {
  const lines = [
    '# Built-in activity preset matrices',
    '',
    'Generated by `extensions/activity-presets.test.ts`. Do not edit by hand.',
    'These are requested model/effort pairs before availability checks and routing modes.',
    'See [activity routing](activity-routing.md) for setup, tuning, sources and limits.',
    '',
  ];
  for (const family of ['openai', 'anthropic'] as const) {
    lines.push(
      `## ${family}`,
      '',
      '| Activity | micro | low | medium | high |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const activity of ROUTER_ACTIVITIES) {
      lines.push(
        `| ${activity} | ${ACTIVITY_PRESETS[family][activity].map(([model, effort]) => `${model} / ${effort}`).join(' | ')} |`,
      );
    }
    lines.push('');
  }
  await expect(lines.join('\n')).toMatchFileSnapshot(
    '../docs/activity-presets.md',
  );
});

it.each(['openai', 'anthropic'] as const)(
  'prevalidates every %s preset pair against live capabilities',
  (family) => {
    const ids =
      family === 'openai'
        ? ['gpt-6-luna', 'gpt-6.1-sol']
        : ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
    const profile = profileOf(
      Object.fromEntries(
        ['micro', 'low', 'medium', 'high'].map((tier) => [
          tier,
          { model: `scope/${required(ids.at(-1))}` },
        ]),
      ),
    );
    const find = (provider: string, id: string) =>
      ids.includes(id)
        ? model(id, {
            provider,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              xhigh: 'xhigh',
              max: 'max',
            },
          })
        : undefined;
    const matrix = buildRouteMatrix(profile, find, false, 0);
    for (const activity of ROUTER_ACTIVITIES) {
      for (const [index, tier] of (
        ['micro', 'low', 'medium', 'high'] as const
      ).entries()) {
        const route = matrix.plans.find(
          (plan) => plan.cell === activity && plan.tier === tier,
        )?.attempts[0];
        const expected = required(ACTIVITY_PRESETS[family][activity][index]);
        expect(route).toMatchObject({
          model: `scope/${expected[0]}`,
          thinking: expected[1],
        });
      }
    }
  },
);

it('filters built-in cells for image support and context, without changing generic-first baseline selection', () => {
  const profile = profileOf(generic());
  const find = (provider: string, id: string) =>
    model(id, {
      provider,
      input: id === 'gpt-6-luna' ? ['text'] : ['text', 'image'],
      contextWindow: id === 'gpt-6-luna' ? 2000 : 128000,
    });
  for (const [image, context] of [
    [true, 0],
    [false, 3000],
  ] as const) {
    const matrix = buildRouteMatrix(profile, find, image, context);
    expect(
      matrix.plans.some((plan) =>
        plan.attempts[0].model.endsWith('/gpt-6-luna'),
      ),
    ).toBe(false);
    expect(selectBaselinePlan('p', profile, matrix).plan).toMatchObject({
      tier: 'medium',
      cell: undefined,
    });
    expect(matrix.plans.some((plan) => plan.cell === 'debug')).toBe(true);
  }
});

it('protects generated identity without changing explicitly declared fallback alias resolution', () => {
  const profile = profileOf(
    {
      medium: {
        model: 'work/gpt-6.1-sol',
        fallbacks: ['work/gpt-6-luna', 'work/last'],
      },
    },
    { models: { 'work/gpt-6-luna': { model: 'personal/gpt-6.1-sol' } } },
  );
  expect(profile.activities?.ops?.medium).toMatchObject({
    model: 'work/gpt-6-luna',
    fallbacks: ['personal/gpt-6.1-sol', 'work/last'],
  });
});

it('retains absent preset cells when both user and project files contain sparse activity settings', () => {
  const config = normalizeConfig(
    mergeConfig(
      {
        profiles: {
          p: {
            ...generic(),
            activities: { debug: { medium: { thinking: 'xhigh' } } },
          },
        },
      },
      {
        profiles: {
          p: {
            activities: {
              debug: { high: { thinking: 'high' } },
              ops: { low: null },
            },
          },
        },
      },
    ),
  ).config;
  const profile = required(config.profiles.p);
  expect(
    Object.values(profile.activities ?? {}).flatMap(Object.values),
  ).toHaveLength(27);
  expect(profile.activities?.code?.medium?.activitySource).toBe('builtin');
  expect(profile.activities?.debug?.low?.activitySource).toBe('builtin');
  expect(profile.activities?.debug?.medium?.thinking).toBe('xhigh');
  expect(profile.activities?.debug?.high?.thinking).toBe('high');
  expect(profile.activities?.ops?.low).toBeUndefined();
});

it('preserves explicit canonical-looking alias intent instead of substituting the generic alias', () => {
  const profile = profileOf(
    {
      medium: { model: 'worker' },
      activities: { debug: { medium: { model: 'work/gpt-6.1-sol' } } },
    },
    {
      models: {
        worker: { model: 'work/gpt-6.1-sol' },
        'work/gpt-6.1-sol': { model: 'personal/gpt-6.1-sol' },
      },
    },
  );
  expect(profile.activities?.debug?.medium?.model).toBe('personal/gpt-6.1-sol');
});

it('does not attach a reverse-lookup alias ceiling to an explicit canonical activity target', () => {
  const profile = profileOf(
    {
      medium: { model: 'work/gpt-6.1-sol' },
      activities: {
        ops: { medium: { model: 'work/gpt-6-luna', thinking: 'high' } },
      },
    },
    {
      models: {
        restricted: { model: 'work/gpt-6-luna', thinkingLevels: ['low'] },
      },
    },
  );
  expect(profile.activities?.ops?.medium?.thinkingLevels).toBeUndefined();
});
