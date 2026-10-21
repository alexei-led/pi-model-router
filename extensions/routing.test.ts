import {
  type Context,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Message,
  type UserMessage,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { normalizeConfig } from './config';
import { extractTextFromContent, hasImageAttachment } from './context';
import { THINKING_LEVELS } from './domain';
import {
  availableRoutePairs,
  BASELINE_TIER_ORDER,
  buildRouteMatrix,
  clampEffort,
  currentPlanPairs,
  decisionForPair,
  effortAdjustments,
  fitContextRoutes,
  preservesRouteCoverage,
  primaryRoutePairs,
  resolveRoutePair,
  routeThinking,
  selectBaselinePlan,
  selectBaselineRoute,
} from './routing';
import { model, required } from './test/fixtures';
import type { RouterProfile, RouterTier } from './types';
import { ROUTER_TIERS } from './types';

const context = (content: string): Context => ({
  messages: [{ role: 'user', content, timestamp: 1 }],
});

const allTierProfile = (baselineTier?: RouterTier): RouterProfile => ({
  ...(baselineTier ? { baselineTier } : {}),
  high: { model: 'test/high' },
  medium: { model: 'test/medium' },
  low: { model: 'test/low' },
  micro: { model: 'test/micro' },
});

const findFixtureModel = (_provider: string, id: string) => model(id);

describe('routing context helpers', () => {
  it('extracts text and tool-call parts without classifying their meaning', () => {
    const parts: Message['content'] = [
      { type: 'text', text: 'some text' },
      { type: 'thinking', thinking: 'some thought' },
      {
        type: 'toolCall',
        id: 'call_1',
        name: 'read_file',
        arguments: { path: 'file.txt' },
      },
    ];
    const extracted = extractTextFromContent(parts);
    expect(extracted).toContain('some text');
    expect(extracted).toContain('some thought');
    expect(extracted).toContain('read_file {"path":"file.txt"}');
  });

  it('detects images while keeping ordinary text separate', () => {
    const imageContext: Context = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image' }] as unknown as UserMessage['content'],
          timestamp: 1,
        },
      ],
    };
    expect(hasImageAttachment(imageContext)).toBe(true);
    expect(hasImageAttachment(context('text only'))).toBe(false);
  });
});

describe('eligible baseline routing', () => {
  it('uses the fixed medium, high, low, micro order', () => {
    const profile = allTierProfile();
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(BASELINE_TIER_ORDER).toEqual(['medium', 'high', 'low', 'micro']);
    expect(selectBaselineRoute('p', profile, pairs).pair.tier).toBe('medium');
  });

  it.each([
    ['medium', 'medium'],
    ['high', 'high'],
    ['low', 'low'],
    ['micro', 'micro'],
  ] as const)(
    'honors an explicit baselineTier %s',
    (baselineTier, expected) => {
      const profile = allTierProfile(baselineTier);
      const pairs = availableRoutePairs(profile, findFixtureModel, false);
      expect(selectBaselineRoute('p', profile, pairs).pair.tier).toBe(expected);
    },
  );

  it('falls through the fixed order for partial profiles', () => {
    const profile: RouterProfile = {
      high: { model: 'test/high' },
      low: { model: 'test/low' },
    };
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(selectBaselineRoute('p', profile, pairs).pair.tier).toBe('high');
  });

  it('pins the configured tier without lifting or lowering it', () => {
    const profile = allTierProfile('high');
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(selectBaselineRoute('p', profile, pairs, 'low')).toMatchObject({
      pair: { tier: 'low' },
      reasonCode: 'pinned',
      isBudgetForced: false,
    });
  });

  it('reports a deterministic error for an unavailable pin or profile', () => {
    const profile: RouterProfile = { high: { model: 'test/high' } };
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(() => selectBaselineRoute('p', profile, pairs, 'micro')).toThrow(
      'Pinned tier "micro" for profile "p" has no eligible model',
    );
    expect(() =>
      selectBaselineRoute(
        'p',
        { low: { model: 'test/missing' } },
        [],
        undefined,
      ),
    ).toThrow('No eligible route for profile "p"');
  });

  it('applies the soft budget policy only to unpinned requests', () => {
    const profile = allTierProfile();
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(
      selectBaselineRoute('p', profile, pairs, undefined, true),
    ).toMatchObject({
      pair: { tier: 'medium' },
      reasonCode: 'budget',
      isBudgetForced: true,
    });
    expect(
      selectBaselineRoute('p', profile, pairs, 'high', true),
    ).toMatchObject({
      pair: { tier: 'high' },
      reasonCode: 'pinned',
    });
  });

  it('uses the best eligible lower tier when medium is absent above budget', () => {
    const profile: RouterProfile = {
      high: { model: 'test/high' },
      low: { model: 'test/low' },
    };
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(
      selectBaselineRoute('p', profile, pairs, undefined, true),
    ).toMatchObject({
      pair: { tier: 'low' },
      reasonCode: 'budget',
      isBudgetForced: true,
    });
  });

  it('retains an eligible high baseline with a fixed budget diagnostic if no lower route exists', () => {
    const profile: RouterProfile = { high: { model: 'test/high' } };
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(
      selectBaselineRoute('p', profile, pairs, undefined, true),
    ).toMatchObject({
      pair: { tier: 'high' },
      reasonCode: 'budget',
      isBudgetForced: false,
    });
  });
});

describe('context-window fit', () => {
  const pair = (tier: RouterTier, ref: string) => ({
    tier,
    model: ref,
    thinking: 'medium' as const,
  });
  const small = pair('low', 'test/small');
  const large = pair('high', 'test/large');
  const alsoLarge = pair('medium', 'test/also-large');
  const unknown = pair('micro', 'test/unknown');
  const windows: Record<string, number | undefined> = {
    'test/small': 1000,
    'test/large': 10_000,
    'test/also-large': 10_000,
  };
  const windowOf = (entry: { model: string }) => windows[entry.model];

  it.each([
    ['keeps every route that fits', 900, [small, large], [small, large]],
    ['fits exactly at the fill limit', 900, [small], [small]],
    [
      'drops a route one token past the fill limit',
      901,
      [small, large],
      [large],
    ],
    [
      'keeps every largest window when none fits',
      50_000,
      [small, large, alsoLarge],
      [large, alsoLarge],
    ],
    [
      'treats an unknown window as fitting',
      50_000,
      [small, unknown],
      [unknown],
    ],
    ['returns nothing for no routes', 10, [], []],
  ])('%s', (_name, tokens, pairs, expected) => {
    expect(fitContextRoutes(pairs, windowOf, tokens)).toEqual(expected);
  });
});

describe('route capability validation', () => {
  it('filters input capabilities and maps unsupported effort before baseline selection', () => {
    const imageOnly = {
      high: { model: 'test/image', thinking: 'off' as const },
    };
    const imageModel = () =>
      model('image', { input: ['image'], reasoning: false });
    expect(availableRoutePairs(imageOnly, imageModel, false)).toEqual([]);
    expect(availableRoutePairs(imageOnly, imageModel, true)).toEqual([
      { tier: 'high', model: 'test/image', thinking: 'off' },
    ]);

    const effort = {
      medium: { model: 'test/worker', thinking: 'high' as const },
    };
    expect(
      availableRoutePairs(
        effort,
        () => model('worker', { thinkingLevelMap: { high: null } }),
        false,
      ),
    ).toEqual([{ tier: 'medium', model: 'test/worker', thinking: 'medium' }]);
  });

  it('defaults non-reasoning routes to off and maps explicit effort to off', () => {
    const profile: RouterProfile = {
      medium: { model: 'test/worker' },
    };
    expect(
      availableRoutePairs(
        profile,
        () => model('worker', { reasoning: false }),
        false,
      ),
    ).toEqual([{ tier: 'medium', model: 'test/worker', thinking: 'off' }]);
    expect(
      routeThinking(
        { tier: 'medium', model: 'test/worker', thinking: 'medium' },
        () => model('worker', { reasoning: false }),
        false,
      ),
    ).toBe('off');
  });

  const astra = model('astra', {
    thinkingLevelMap: {
      off: null,
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
  });
  const opus = model('opus', {
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    },
  });
  const haiku = model('haiku');

  it.each([
    [astra, 'off', 'minimal'],
    [opus, 'off', 'low'],
    [opus, 'minimal', 'low'],
    [haiku, 'max', 'high'],
    [haiku, 'xhigh', 'high'],
    [astra, 'high', 'high'],
  ] as const)(
    'runs %s at pi’s equivalent of %s: %s',
    (target, requested, expected) => {
      expect(
        availableRoutePairs(
          { high: { model: `test/${target.id}` } },
          () => target,
          false,
          {
            high: requested,
          },
        ),
      ).toEqual([
        { tier: 'high', model: `test/${target.id}`, thinking: expected },
      ]);
    },
  );

  it.each([astra, opus, haiku, model('plain', { reasoning: false })])(
    'matches pi’s clampThinkingLevel for every level: %s',
    (target) => {
      for (const level of THINKING_LEVELS)
        expect(clampEffort(level, getSupportedThinkingLevels(target))).toBe(
          clampThinkingLevel(target, level),
        );
    },
  );

  it('keeps declared effort restrictive and rejects routes with no allowed level', () => {
    expect(
      availableRoutePairs(
        {
          high: {
            model: 'test/haiku',
            thinking: 'high',
            thinkingLevels: ['low'],
          },
        },
        () => haiku,
        false,
      ),
    ).toEqual([{ tier: 'high', model: 'test/haiku', thinking: 'low' }]);
    expect(
      availableRoutePairs(
        { high: { model: 'test/opus', reasoning: false } },
        () => opus,
        false,
      ),
    ).toEqual([]);
  });

  it('narrows normalized routes only by declared levels, never by the router defaults', () => {
    const { config } = normalizeConfig({
      models: {
        frontier: { model: 'test/astra' },
        capped: { model: 'test/opus', thinkingLevels: ['low', 'medium'] },
      },
      profiles: {
        p: {
          high: { model: 'frontier', thinking: 'high' },
          low: { model: 'capped', thinking: 'low' },
        },
      },
    });
    const profile = required(config.profiles.p);
    const find = (_provider: string, id: string) =>
      id === 'astra' ? astra : opus;
    expect(
      availableRoutePairs(profile, find, false, { high: 'off', low: 'max' }),
    ).toEqual([
      { tier: 'high', model: 'test/astra', thinking: 'minimal' },
      { tier: 'low', model: 'test/opus', thinking: 'medium' },
    ]);
    expect(
      availableRoutePairs(profile, find, false, { high: 'max' })[0]?.thinking,
    ).toBe('max');
  });

  it.each([
    ['off', ['high runs at minimal', 'medium runs at low']],
    ['max', ['micro runs at high']],
    ['medium', []],
  ] as const)(
    'names tiers that run a %s override at another level',
    (level, expected) => {
      const models = { astra, opus, haiku };
      const profile: RouterProfile = {
        high: { model: 'test/astra' },
        medium: { model: 'test/opus' },
        micro: { model: 'test/haiku' },
      };
      expect(
        effortAdjustments(
          profile,
          (_provider, id) => models[id as keyof typeof models],
          level,
        ),
      ).toEqual(expected);
    },
  );

  it('retains each configured tier in thinking coverage checks', () => {
    const profile = allTierProfile();
    expect(
      preservesRouteCoverage(profile, findFixtureModel, { low: 'high' }),
    ).toBe(true);
    expect(
      preservesRouteCoverage(profile, findFixtureModel, { medium: 'medium' }),
    ).toBe(true);
  });

  it('keeps a route when its configured or overridden effort is unsupported', () => {
    const profile: RouterProfile = {
      medium: { model: 'test/worker', thinking: 'high' },
    };
    const findModel = () => model('worker', { reasoning: false });
    expect(availableRoutePairs(profile, findModel, false)).toEqual([
      { tier: 'medium', model: 'test/worker', thinking: 'off' },
    ]);
    expect(preservesRouteCoverage(profile, findModel, { medium: 'low' })).toBe(
      true,
    );
  });

  it('keeps image coverage when an unsupported override clamps its effort to off', () => {
    const profile: RouterProfile = {
      medium: { model: 'test/text' },
      low: { model: 'test/image', thinking: 'off' },
    };
    const findModel = (_provider: string, id: string) =>
      model(id, {
        input: id === 'image' ? ['image'] : ['text'],
        reasoning: id !== 'image',
      });
    expect(preservesRouteCoverage(profile, findModel, { low: 'high' })).toBe(
      true,
    );
    expect(
      availableRoutePairs(profile, findModel, true, { low: 'high' }),
    ).toEqual([{ tier: 'low', model: 'test/image', thinking: 'off' }]);
  });

  it('empties coverage only when a declared reasoning:false excludes every level the live model allows', () => {
    const alwaysThinks = model('image', {
      input: ['image'],
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
      },
    });
    const profile: RouterProfile = {
      low: { model: 'test/image', reasoning: false },
    };
    const findModel = () => alwaysThinks;
    expect(availableRoutePairs(profile, findModel, true)).toEqual([]);
    expect(preservesRouteCoverage(profile, findModel, { low: 'high' })).toBe(
      false,
    );
  });

  it.each(ROUTER_TIERS)(
    'offers the validated effective effort for a non-reasoning %s primary',
    (tier) => {
      const profile = required(
        normalizeConfig({
          profiles: { p: { [tier]: { model: 'test/worker' } } },
        }).config.profiles.p,
      );
      const pairs = availableRoutePairs(
        profile,
        () => model('worker', { reasoning: false }),
        false,
      );
      expect(primaryRoutePairs(profile, pairs)).toEqual([
        { tier, model: 'test/worker', thinking: 'off' },
      ]);
    },
  );

  it('offers only primary candidates to advisors', () => {
    const profile: RouterProfile = {
      medium: { model: 'test/medium', fallbacks: ['test/backup'] },
      low: { model: 'test/low' },
    };
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(primaryRoutePairs(profile, pairs)).toEqual([
      { tier: 'medium', model: 'test/medium', thinking: 'medium' },
      { tier: 'low', model: 'test/low', thinking: 'low' },
    ]);
  });

  it('offers a tier via its eligible fallback instead of dropping it when the primary is ineligible', () => {
    const profile: RouterProfile = {
      medium: { model: 'test/gone', fallbacks: ['test/present'] },
      low: { model: 'test/low' },
    };
    const findModel = (_provider: string, id: string) =>
      id === 'present' || id === 'low' ? model(id) : undefined;
    const pairs = availableRoutePairs(profile, findModel, false);
    expect(pairs).toEqual([
      { tier: 'medium', model: 'test/present', thinking: 'medium' },
      { tier: 'low', model: 'test/low', thinking: 'low' },
    ]);
    expect(primaryRoutePairs(profile, pairs)).toEqual([
      { tier: 'medium', model: 'test/present', thinking: 'medium' },
      { tier: 'low', model: 'test/low', thinking: 'low' },
    ]);
  });

  it('keeps the first deduplicated fallback after clamping to its declared effort', () => {
    const config = normalizeConfig({
      models: {
        primary: { model: 'test/model-a' },
        'test/model-a': { model: 'other/model-b' },
        restricted: { model: 'test/fallback', thinkingLevels: ['high'] },
        backup: { model: 'test/fallback', thinkingLevels: ['medium'] },
      },
      profiles: {
        p: {
          medium: {
            model: 'primary',
            fallbacks: ['restricted', 'backup'],
          },
        },
      },
    }).config;
    const profile = required(config.profiles.p);
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(pairs).toEqual([
      { tier: 'medium', model: 'test/model-a', thinking: 'medium' },
      { tier: 'medium', model: 'test/fallback', thinking: 'high' },
    ]);
    expect(profile.medium?.resolvedFallbacks).toEqual([
      { model: 'test/fallback', thinkingLevels: ['high'] },
      { model: 'test/fallback', thinkingLevels: ['medium'] },
    ]);
    expect(resolveRoutePair(profile, 'medium').model).toBe('test/model-a');
  });
});

describe('routing decisions', () => {
  it('constructs continuation and fallback decisions without prompt data', () => {
    expect(
      decisionForPair(
        'p',
        { tier: 'micro', model: 'test/micro', thinking: 'off' },
        'continuation',
      ).reasonCode,
    ).toBe('continuation');
    expect(
      decisionForPair(
        'p',
        { tier: 'low', model: 'test/low', thinking: 'low' },
        'fallback',
      ).reasonCode,
    ).toBe('fallback');
  });
});

describe('immutable activity route matrix', () => {
  it('uses stable activity order, generic-first preference and off exclusion', () => {
    const profile = required(
      normalizeConfig({
        profiles: {
          auto: {
            high: { model: 'test/high' },
            medium: { model: 'missing/generic' },
            activities: {
              docs: { medium: { model: 'test/docs' } },
              code: { medium: { model: 'test/code' } },
            },
          },
        },
      }).config.profiles.auto,
    );
    const find = (provider: string, id: string) =>
      provider === 'test' ? model(id) : undefined;
    const matrix = buildRouteMatrix(profile, find, false, 1);
    expect(
      matrix.representatives.map((plan) => [plan.tier, plan.cell]),
    ).toEqual([
      ['medium', 'code'],
      ['high', undefined],
    ]);
    expect(selectBaselinePlan('auto', profile, matrix).plan.tier).toBe('high');
    expect(
      selectBaselinePlan('auto', profile, matrix, undefined, true).plan.cell,
    ).toBe('code');
    const off = buildRouteMatrix(profile, find, false, 1, undefined, false);
    expect(off.plans).toHaveLength(1);
    expect(off.meaningfulActivities).toBe(false);
    expect(() => selectBaselinePlan('auto', profile, matrix, 'medium')).toThrow(
      /Pinned tier/,
    );
  });

  it('freezes declarations and attempts, preserving only the selected cell chain on live revalidation', () => {
    const profile = required(
      normalizeConfig({
        models: {
          fallback: { model: 'test/fallback', thinkingLevels: ['medium'] },
        },
        profiles: {
          auto: {
            medium: {
              model: 'test/base',
              thinking: 'medium',
              thinkingLevels: ['medium'],
              fallbacks: ['fallback'],
            },
            activities: {
              code: { medium: { model: 'test/code', fallbacks: ['fallback'] } },
            },
          },
        },
      }).config.profiles.auto,
    );
    const matrix = buildRouteMatrix(profile, findFixtureModel, false, 1);
    const plan = required(matrix.plans.find((entry) => entry.cell === 'code'));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.attempts)).toBe(true);
    expect(Object.isFrozen(plan.config.fallbacks)).toBe(true);
    expect(
      Object.isFrozen(plan.config.resolvedFallbacks?.[0]?.thinkingLevels),
    ).toBe(true);
    required(profile.activities?.code?.medium).fallbacks = ['test/new'];
    expect(
      currentPlanPairs(plan, findFixtureModel, false).map((pair) => pair.model),
    ).toEqual(['test/code', 'test/fallback']);
    expect(
      currentPlanPairs(
        plan,
        (_provider, id) => (id === 'fallback' ? undefined : model(id)),
        false,
      ).map((pair) => pair.model),
    ).toEqual(['test/code']);
  });

  it('sees fallback-only behavioral differences and respects image/context eligibility', () => {
    const profile = required(
      normalizeConfig({
        profiles: {
          auto: {
            medium: { model: 'test/base' },
            activities: {
              code: { medium: { fallbacks: ['test/backup'] } },
              docs: { medium: { model: 'test/small', fallbacks: [] } },
            },
          },
        },
      }).config.profiles.auto,
    );
    const find = (_provider: string, id: string) =>
      model(id, {
        input: id === 'small' ? ['text'] : ['text', 'image'],
        contextWindow: id === 'small' ? 100 : 8192,
      });
    expect(buildRouteMatrix(profile, find, false, 1).meaningfulActivities).toBe(
      true,
    );
    expect(
      buildRouteMatrix(profile, find, true, 1).plans.some(
        (plan) => plan.cell === 'docs',
      ),
    ).toBe(false);
    expect(
      buildRouteMatrix(profile, find, false, 1000).plans.some(
        (plan) => plan.cell === 'docs',
      ),
    ).toBe(false);
  });
});

describe('activity-aware effort controls', () => {
  it('validates coverage including enabled cells and reports their actual effort', () => {
    const profile: RouterProfile = {
      activities: {
        code: { medium: { model: 'test/code', reasoning: false } },
      },
    };
    const find = () => model('code', { reasoning: false });
    expect(preservesRouteCoverage(profile, find, { medium: 'high' })).toBe(
      true,
    );
    expect(
      preservesRouteCoverage(profile, find, { medium: 'high' }, false),
    ).toBe(false);
    expect(effortAdjustments(profile, find, 'high')).toEqual([
      'medium/code runs at off',
    ]);
    expect(effortAdjustments(profile, find, 'high', false)).toEqual([]);
  });
});

describe('mode transform in the route matrix', () => {
  const extended = { xhigh: 'xhigh', max: 'max' } as const;
  const catalog = {
    opus: model('opus', {
      cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
      thinkingLevelMap: extended,
    }),
    sonnet: model('sonnet', {
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      thinkingLevelMap: extended,
    }),
    haiku: model('haiku', {
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    }),
    backup: model('backup', {
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    }),
  };
  const find = (provider: string, id: string) =>
    provider === 'test' ? catalog[id as keyof typeof catalog] : undefined;
  const profile = required(
    normalizeConfig({
      profiles: {
        auto: {
          high: { model: 'test/opus', thinking: 'xhigh' },
          medium: { model: 'test/opus', thinking: 'medium' },
          low: {
            model: 'test/haiku',
            thinking: 'high',
            fallbacks: ['test/backup'],
          },
          micro: { model: 'test/haiku', thinking: 'off' },
          activities: {
            code: { medium: { model: 'test/sonnet', thinking: 'high' } },
          },
        },
      },
    }).config.profiles.auto,
  );
  const matrix = (
    mode: 'cost' | 'balanced' | 'quality' | undefined,
    options: {
      pinned?: RouterTier;
      overrides?: Partial<Record<RouterTier, 'low'>>;
      budgetExceeded?: boolean;
      profile?: RouterProfile;
    } = {},
  ) =>
    buildRouteMatrix(
      options.profile ?? profile,
      find,
      false,
      1,
      options.overrides,
      true,
      options.pinned,
      mode
        ? { mode, budgetExceeded: options.budgetExceeded ?? false }
        : undefined,
    );
  const plan = (
    built: ReturnType<typeof matrix>,
    tier: RouterTier,
    cell?: 'code',
  ) =>
    required(
      built.plans.find((entry) => entry.tier === tier && entry.cell === cell),
    );
  const route = (entry: ReturnType<typeof plan>) =>
    entry.attempts.map(({ model: ref, thinking }) => `${ref}/${thinking}`);
  const revalidated = (entry: ReturnType<typeof plan>) =>
    currentPlanPairs(entry, find, false).map(
      ({ model: ref, thinking }) => `${ref}/${thinking}`,
    );

  it('uses the cheaper lower tier with its own fallbacks and keeps the classified tier', () => {
    const medium = plan(matrix('cost'), 'medium');
    expect(medium.tier).toBe('medium');
    expect(medium.mode).toEqual({
      mode: 'cost',
      lever: 'model',
      sourceTier: 'low',
    });
    expect(route(medium)).toEqual(['test/haiku/high', 'test/backup/high']);
    expect(revalidated(medium)).toEqual(route(medium));
  });

  it('lowers effort one step when the lower tier uses the same model', () => {
    const high = plan(matrix('cost'), 'high');
    expect(high.mode?.lever).toBe('effort');
    expect(route(high)).toEqual(['test/opus/high']);
    expect(revalidated(high)).toEqual(['test/opus/high']);
  });

  it('lowers every attempt of the low tier, fallbacks included', () => {
    const low = plan(matrix('cost'), 'low');
    expect(route(low)).toEqual(['test/haiku/medium', 'test/backup/medium']);
    expect(revalidated(low)).toEqual(route(low));
  });

  it('resolves an activity cell against the generic lower tier', () => {
    const code = plan(matrix('cost'), 'medium', 'code');
    expect(code.mode).toEqual({
      mode: 'cost',
      lever: 'model',
      sourceTier: 'low',
    });
    expect(route(code)).toEqual(['test/haiku/high', 'test/backup/high']);
  });

  it('raises effort in quality mode and keeps micro', () => {
    const built = matrix('quality');
    expect(route(plan(built, 'high'))).toEqual(['test/opus/max']);
    expect(route(plan(built, 'medium'))).toEqual(['test/opus/high']);
    expect(route(plan(built, 'micro'))).toEqual(['test/haiku/off']);
  });

  it('keeps balanced identical to the configured matrix', () => {
    const plain = matrix(undefined);
    const balanced = matrix('balanced');
    expect(balanced.plans.map((entry) => entry.id)).toEqual(
      plain.plans.map((entry) => entry.id),
    );
    expect(balanced.plans.every((entry) => entry.mode?.lever === 'none')).toBe(
      true,
    );
  });

  it('gives transformed plans new identities so stale advice cannot match', () => {
    const balanced = new Set(matrix('balanced').plans.map((entry) => entry.id));
    expect(balanced.has(plan(matrix('cost'), 'medium').id)).toBe(false);
    expect(balanced.has(plan(matrix('cost'), 'high').id)).toBe(false);
    expect(balanced.has(plan(matrix('cost'), 'micro').id)).toBe(true);
  });

  it('bypasses the mode for a pin', () => {
    const pinned = plan(matrix('cost', { pinned: 'medium' }), 'medium');
    expect(route(pinned)).toEqual(['test/opus/medium']);
    expect(pinned.mode).toBeUndefined();
  });

  it('bypasses the mode for a tier with an effort override', () => {
    const built = matrix('cost', { overrides: { medium: 'low' } });
    expect(route(plan(built, 'medium'))).toEqual(['test/opus/low']);
    expect(plan(built, 'medium').mode).toBeUndefined();
    expect(plan(built, 'high').mode?.lever).toBe('effort');
  });

  it('never moves quality onto the high route over the soft budget', () => {
    const capped = required(
      normalizeConfig({
        profiles: {
          auto: {
            high: { model: 'test/opus', thinking: 'high' },
            medium: { model: 'test/haiku', thinking: 'high' },
          },
        },
      }).config.profiles.auto,
    );
    expect(
      route(plan(matrix('quality', { profile: capped }), 'medium')),
    ).toEqual(['test/opus/high']);
    expect(
      route(
        plan(
          matrix('quality', { profile: capped, budgetExceeded: true }),
          'medium',
        ),
      ),
    ).toEqual(['test/haiku/high']);
  });
});

describe('mode transform regressions from past routing fixes', () => {
  const priced = (
    id: string,
    input: number,
    overrides: Parameters<typeof model>[1] = {},
  ) =>
    model(id, {
      cost: {
        input,
        output: input * 5,
        cacheRead: input / 10,
        cacheWrite: input,
      },
      ...overrides,
    });
  const twoTier = (low: string) =>
    required(
      normalizeConfig({
        profiles: {
          auto: {
            high: { model: 'test/big', thinking: 'high' },
            medium: { model: 'test/big', thinking: 'medium' },
            low: { model: `test/${low}`, thinking: 'medium' },
          },
        },
      }).config.profiles.auto,
    );
  const routeOf = (
    catalog: ReturnType<typeof model>[],
    profile: RouterProfile,
    options: { image?: boolean; tokens?: number } = {},
  ) => {
    const find = (provider: string, id: string) =>
      provider === 'test'
        ? catalog.find((entry) => entry.id === id)
        : undefined;
    const built = buildRouteMatrix(
      profile,
      find,
      options.image ?? false,
      options.tokens ?? 1,
      undefined,
      true,
      undefined,
      { mode: 'cost', budgetExceeded: false },
    );
    const plan = selectBaselinePlan('auto', profile, built).plan;
    return `${plan.tier} ${plan.attempts[0].model}/${plan.attempts[0].thinking}`;
  };

  // 0a9fcd5b: context windows are per model, not ordered by tier.
  it('keeps the effort lever when the cheaper model cannot hold the context', () => {
    const catalog = [
      priced('big', 2, { contextWindow: 200_000 }),
      priced('small', 1, { contextWindow: 8_000 }),
    ];
    expect(routeOf(catalog, twoTier('small'))).toBe('medium test/small/medium');
    expect(routeOf(catalog, twoTier('small'), { tokens: 50_000 })).toBe(
      'medium test/big/low',
    );
  });

  // Image input: a text-only lower model is not a candidate for the model lever.
  it('keeps the effort lever when the cheaper model cannot read an image', () => {
    const catalog = [priced('big', 2), priced('text', 1, { input: ['text'] })];
    expect(routeOf(catalog, twoTier('text'))).toBe('medium test/text/medium');
    expect(routeOf(catalog, twoTier('text'), { image: true })).toBe(
      'medium test/big/low',
    );
  });

  // 788b28f8: an ineligible primary still offers its first eligible fallback.
  it('transforms a tier served by its fallback', () => {
    const profile = required(
      normalizeConfig({
        profiles: {
          auto: {
            medium: {
              model: 'test/missing',
              thinking: 'medium',
              fallbacks: ['test/big'],
            },
            low: { model: 'test/small', thinking: 'medium' },
          },
        },
      }).config.profiles.auto,
    );
    expect(routeOf([priced('big', 2), priced('small', 1)], profile)).toBe(
      'medium test/small/medium',
    );
  });
});
