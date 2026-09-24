import {
  type Context,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Message,
  type UserMessage,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { normalizeConfig, THINKING_LEVELS } from './config';
import { extractTextFromContent, hasImageAttachment } from './context';
import {
  availableRoutePairs,
  BASELINE_TIER_ORDER,
  clampEffort,
  decisionForPair,
  effortAdjustments,
  phaseForTier,
  preservesRouteCoverage,
  primaryRoutePairs,
  resolveRoutePair,
  routeThinking,
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
  it('uses the fixed medium, high, low, micro order independently of text', () => {
    const profile = allTierProfile();
    const pairs = availableRoutePairs(profile, findFixtureModel, false);
    expect(BASELINE_TIER_ORDER).toEqual(['medium', 'high', 'low', 'micro']);
    expect(
      ['pwd', 'design a migration', 'да, сделай', '¿Puedes ayudar?', '!!!'].map(
        () => selectBaselineRoute('p', profile, pairs).pair.tier,
      ),
    ).toEqual(['medium', 'medium', 'medium', 'medium', 'medium']);
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

  // Level maps copied from the live pi registry (2026-09-24).
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
    ['off', ['high as minimal', 'medium as low']],
    ['max', ['micro as high']],
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

  it('accepts an unsupported override by clamping instead of dropping input coverage', () => {
    const profile: RouterProfile = {
      medium: { model: 'test/text' },
      low: { model: 'test/image', thinking: 'off' },
    };
    const findModel = (_provider: string, id: string) =>
      model(id, {
        input: id === 'image' ? ['image'] : ['text'],
        reasoning: id !== 'image',
      });
    // 'low' has no allowed level but 'off' (reasoning:false), so overriding
    // its tier to 'high' clamps back down to 'off' instead of dropping the
    // route: image coverage survives the override.
    expect(preservesRouteCoverage(profile, findModel, { low: 'high' })).toBe(
      true,
    );
    expect(
      availableRoutePairs(profile, findModel, true, { low: 'high' }),
    ).toEqual([{ tier: 'low', model: 'test/image', thinking: 'off' }]);
  });

  it('empties coverage only when a declared reasoning:false excludes every level the live model allows', () => {
    // The route declares reasoning:false (only 'off' is ever permitted), but
    // the live model never exposes 'off' (an always-thinking model): no
    // allowed level exists, independent of any override.
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

  it('parses normalized canonical refs directly and keeps fallback alias metadata', () => {
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
    // 'restricted' (declared thinkingLevels: ['high']) now clamps the tier's
    // 'medium' request up to 'high' instead of being dropped, so it wins the
    // per-model dedup ahead of 'backup' (declared ['medium']).
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
  it.each(ROUTER_TIERS)('maps %s to a stable phase', (tier) => {
    expect(phaseForTier(tier)).toBe(
      tier === 'high'
        ? 'planning'
        : tier === 'medium'
          ? 'implementation'
          : 'lightweight',
    );
  });

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
