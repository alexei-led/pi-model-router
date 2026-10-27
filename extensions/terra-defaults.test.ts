import { readFileSync } from 'node:fs';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';
import { normalizeConfig } from './config';
import { buildRouteMatrix, selectBaselinePlan } from './routing';
import { events, failure, message, model, required } from './test/fixtures';
import { terraHarness } from './test/terra-harness';
import type { RouterActivity, RouterMode, RouterTier } from './types';
import { formatDecision, updateRouterUIStrip } from './ui';
import { formatRoute } from './ui/presentation';
import { routePreferences } from './ui/preview';

const expected: {
  mode: RouterMode;
  tier: RouterTier;
  activity: RouterActivity | 'generic';
  model: string;
  effort: string;
}[] = JSON.parse(
  readFileSync(new URL('./test/terra-defaults.json', import.meta.url), 'utf8'),
);
const ladder = (provider: string) => ({
  micro: { model: `${provider}/gpt-6-luna`, thinking: 'off' },
  low: { model: `${provider}/gpt-6-luna`, thinking: 'high' },
  medium: { model: `${provider}/gpt-6.1-terra`, thinking: 'medium' },
  high: { model: `${provider}/gpt-6.1-sol`, thinking: 'high' },
});
const find = (provider: string, id: string) =>
  ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'].includes(id)
    ? model(id, {
        provider,
        contextWindow: 500_000,
        thinkingLevelMap: { xhigh: 'xhigh' },
        cost: {
          input: id === 'gpt-6-luna' ? 0.1 : id === 'gpt-6.1-terra' ? 1 : 2,
          output: 5,
          cacheRead: 0.05,
          cacheWrite: 1.25,
        },
      })
    : undefined;

it.each(['openai', 'openai-codex', 'openai-personal', 'openai-work', 'custom'])(
  'prevalidates the exact mode/activity targets and preview for %s',
  (provider) => {
    const profile = required(
      normalizeConfig({ profiles: { p: ladder(provider) } }).config.profiles.p,
    );
    for (const cell of expected) {
      const matrix = buildRouteMatrix(
        profile,
        find,
        false,
        0,
        undefined,
        true,
        undefined,
        { mode: cell.mode, budgetExceeded: false },
      );
      const plan = required(
        matrix.plans.find(
          (plan) =>
            plan.tier === cell.tier &&
            plan.cell ===
              (cell.activity === 'generic' ? undefined : cell.activity),
        ),
        JSON.stringify(cell),
      );
      const pair = {
        tier: cell.tier,
        model: `${provider}/${cell.model}`,
        thinking: cell.effort,
      };
      expect(plan.attempts[0], JSON.stringify(cell)).toEqual(pair);
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.config)).toBe(true);
      if (cell.activity !== 'generic') {
        const preview = routePreferences({
          profile,
          find,
          mode: { mode: cell.mode, source: 'session' },
          pin: 'auto',
          thinkingOverrides: {},
          activityRouting: true,
          budgetExceeded: false,
        })(cell.activity, cell.tier);
        expect(preview.route, JSON.stringify(cell)).toEqual(pair);
      }
    }
  },
);

it('resolves aliased default ladders and ignores raw attempts to inject internal mode metadata', () => {
  const profile = required(
    normalizeConfig({
      models: {
        cheap: { model: 'work/gpt-6-luna' },
        worker: { model: 'work/gpt-6.1-terra' },
        strong: { model: 'work/gpt-6.1-sol' },
      },
      profiles: {
        p: {
          low: { model: 'cheap', thinking: 'high' },
          medium: { model: 'worker', thinking: 'medium' },
          high: { model: 'strong', thinking: 'high' },
        },
      },
    }).config.profiles.p,
  );
  expect(profile.low?.builtinModes?.quality?.model).toBe('work/gpt-6.1-terra');
  const arbitrary = required(
    normalizeConfig({
      profiles: {
        p: {
          medium: {
            model: 'custom/arbitrary',
            thinking: 'high',
            builtinModes: {
              quality: { model: 'other/injected', thinking: 'high' },
            },
          },
        },
      },
    }).config.profiles.p,
  );
  expect(arbitrary.medium?.builtinModes).toBeUndefined();
  expect(arbitrary.activities).toBeUndefined();
  const plan = required(
    buildRouteMatrix(
      arbitrary,
      (provider, id) => model(id, { provider }),
      false,
      0,
      undefined,
      true,
      undefined,
      { mode: 'quality', budgetExceeded: false },
    ).plans[0],
  );
  expect(plan.attempts[0]).toMatchObject({
    model: 'custom/arbitrary',
    thinking: 'high',
  });
});

it('invalidates a same-turn Terra tool plan after a mode change instead of reusing its route ID', async () => {
  const f = terraHarness(advisedConfig(), find);
  const user = {
    role: 'user' as const,
    content: 'Controlled task.',
    timestamp: 55,
  };
  f.delegate.mockImplementationOnce((target) =>
    events({
      type: 'done',
      reason: 'toolUse',
      message: message({
        provider: target.provider,
        model: target.id,
        api: target.api,
        stopReason: 'toolUse',
        content: [
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} },
        ],
      }),
    }),
  );
  const first = await f.run('balanced', 'medium', 'code', { messages: [user] });
  expect(f.state.lastDecision).toMatchObject({
    targetModelId: 'gpt-6.1-terra',
    thinking: 'xhigh',
  });
  const result = await f.run('quality', 'medium', 'code', {
    messages: [
      user,
      first,
      {
        role: 'toolResult',
        toolCallId: 'read-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'safe evidence' }],
        isError: false,
        timestamp: 56,
      },
    ],
  });
  expect(result.stopReason).toBe('stop');
  expect(f.state.lastDecision).toMatchObject({
    targetModelId: 'gpt-6.1-sol',
    thinking: 'medium',
    mode: 'quality',
  });
  expect(f.classify).toHaveBeenCalledOnce();
});

it('keeps router Now, strip and recorded effort physical when the host message stamps a logical level', async () => {
  const f = terraHarness(advisedConfig(), find);
  f.delegate.mockImplementationOnce((target) => {
    const hostStamped = {
      ...message({
        provider: target.provider,
        model: target.id,
        api: target.api,
      }),
      thinkingLevel: 'medium' as const,
    };
    return events({ type: 'done', reason: 'stop', message: hostStamped });
  });
  const result = await f.run('balanced', 'medium', 'code');
  expect(result).toHaveProperty('thinkingLevel', 'medium');
  expect(f.delegate.mock.calls[0]?.[2]?.reasoning).toBe('xhigh');
  const decision = required(f.state.lastDecision);
  expect(decision.thinking).toBe('xhigh');
  expect(formatDecision(decision)).toContain('[xhigh]');
  const snapshot = f.ui.adapters.getSnapshot();
  expect(snapshot.actual).toMatchObject({
    model: 'gpt-6.1-terra',
    thinking: 'xhigh',
  });
  expect(formatRoute(snapshot.actual)).toContain('effort xhigh');
  const ctx = {
    mode: 'tui',
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      theme: { fg: (_color: string, value: string) => value },
    },
  } as unknown as ExtensionContext;
  updateRouterUIStrip(ctx, snapshot, { widgetEnabled: true });
  const content = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1];
  expect(typeof content).toBe('function');
  if (typeof content === 'function')
    expect(
      content({} as TUI, ctx.ui.theme)
        .render(120)
        .join(' '),
    ).toContain('effort xhigh');
});

const advisedConfig = (profile: object = ladder('scope')) => ({
  advisor: { enabled: true, model: 'fixture/choice', reviewEveryRequests: 0 },
  profiles: { p: { ...profile, advisor: { models: ['fixture/choice'] } } },
});

it.each(['openai', 'openai-codex', 'personal', 'work', 'custom'])(
  'delegates all 96 exact preferred cells through the public registry under %s',
  async (provider) => {
    const f = terraHarness(advisedConfig(ladder(provider)), find);
    for (const cell of expected) {
      const result = await f.run(cell.mode, cell.tier, cell.activity);
      expect(result.stopReason, JSON.stringify(cell)).toBe('stop');
      const [target, , options] = required(f.delegate.mock.calls.at(-1));
      expect(
        [target.provider, target.id, options?.reasoning ?? 'off'],
        JSON.stringify(cell),
      ).toEqual([provider, cell.model, cell.effort]);
      expect(f.state.lastDecision?.tier).toBe(cell.tier);
    }
  },
);

it('keeps logical-medium Sol and skips advice over the soft budget, even when high also uses Sol', async () => {
  const f = terraHarness({ ...advisedConfig(), maxSessionBudget: 1 }, find);
  f.state.accumulatedCost = 2;
  await f.run('quality', 'high', 'debug');
  expect(f.classify).not.toHaveBeenCalled();
  expect(f.state.lastDecision).toMatchObject({
    tier: 'medium',
    targetModelId: 'gpt-6.1-sol',
    thinking: 'medium',
    reasonCode: 'budget',
  });
  const profile = required(f.state.currentConfig.profiles.p);
  const matrix = buildRouteMatrix(
    profile,
    find,
    false,
    0,
    undefined,
    true,
    undefined,
    { mode: 'quality', budgetExceeded: true },
  );
  expect(
    matrix.plans.find((p) => p.cell === 'debug' && p.tier === 'medium')
      ?.attempts[0],
  ).toMatchObject({ model: 'scope/gpt-6.1-sol', thinking: 'high' });
  expect(
    selectBaselinePlan('p', profile, matrix, undefined, true).plan.tier,
  ).toBe('medium');
});

it('retains only the declared fallback order when a mode-preferred primary fails before visible content', async () => {
  const profile = ladder('scope');
  const f = terraHarness(
    advisedConfig({
      ...profile,
      medium: { ...profile.medium, fallbacks: ['other/first', 'other/second'] },
    }),
    (provider, id) =>
      provider === 'other' ? model(id, { provider }) : find(provider, id),
  );
  f.delegate.mockImplementationOnce(() => failure());
  await f.run('quality', 'medium', 'generic');
  expect(
    f.delegate.mock.calls.map(([target]) => `${target.provider}/${target.id}`),
  ).toEqual(['scope/gpt-6.1-sol', 'other/first']);
  expect(f.state.lastDecision).toMatchObject({
    targetProvider: 'other',
    targetModelId: 'first',
    thinking: 'medium',
  });
});

it('does not rewrite old generic declarations or explicit activity overrides', () => {
  const profile = required(
    normalizeConfig({
      profiles: {
        p: {
          ...ladder('scope'),
          medium: { model: 'scope/gpt-6.1-sol', thinking: 'medium' },
          activities: {
            code: { medium: { thinking: 'high' } },
            docs: { medium: null },
          },
        },
      },
    }).config.profiles.p,
  );
  expect(profile.medium).toMatchObject({
    model: 'scope/gpt-6.1-sol',
    thinking: 'medium',
  });
  expect(profile.medium?.builtinModes).toBeUndefined();
  expect(profile.activities?.code?.medium).toMatchObject({
    model: 'scope/gpt-6.1-sol',
    thinking: 'high',
  });
  expect(profile.activities?.code?.medium?.builtinModes).toBeUndefined();
  expect(profile.activities?.docs?.medium).toBeUndefined();
  expect(profile.activities?.debug?.medium).toMatchObject({
    model: 'scope/gpt-6.1-terra',
    thinking: 'xhigh',
  });
});

it('keeps opt-out legacy transforms, pins and effort overrides ahead of defaults', () => {
  const normalize = (extra: object = {}) =>
    required(
      normalizeConfig({ profiles: { p: { ...ladder('scope'), ...extra } } })
        .config.profiles.p,
    );
  const profile = normalize();
  const off = normalize({ activityPreset: 'off' });
  expect(off.low?.builtinModes).toBeUndefined();
  expect(off.activities).toBeUndefined();
  const build = (
    p = profile,
    overrides?: { low: 'low' },
    pin?: RouterTier,
    activities = true,
  ) =>
    buildRouteMatrix(p, find, false, 0, overrides, activities, pin, {
      mode: 'quality',
      budgetExceeded: false,
    });
  expect(
    build(off).plans.find((p) => p.tier === 'low')?.attempts[0],
  ).toMatchObject({ model: 'scope/gpt-6-luna', thinking: 'xhigh' });
  expect(
    build(profile, undefined, 'low').plans.find((p) => p.tier === 'low')
      ?.attempts[0],
  ).toMatchObject({
    model: 'scope/gpt-6-luna',
    thinking: 'high',
  });
  expect(
    build(profile, { low: 'low' }).plans.find((p) => p.tier === 'low')
      ?.attempts[0],
  ).toMatchObject({ model: 'scope/gpt-6-luna', thinking: 'low' });
  const activityOff = build(profile, undefined, undefined, false);
  expect(activityOff.plans.every((p) => !p.cell)).toBe(true);
  expect(
    activityOff.plans.find((p) => p.tier === 'low')?.attempts[0],
  ).toMatchObject({ model: 'scope/gpt-6.1-terra', thinking: 'medium' });
});

it.each(['missing', 'price', 'context', 'image'] as const)(
  'uses the eligible legacy transform when a preferred target fails %s validation',
  (failure) => {
    const profile = required(
      normalizeConfig({ profiles: { p: ladder('scope') } }).config.profiles.p,
    );
    const constrained = (provider: string, id: string) => {
      const target = find(provider, id);
      if (!target || (failure === 'missing' && id === 'gpt-6.1-terra'))
        return undefined;
      if (failure === 'price')
        return { ...target, cost: { ...target.cost, input: 0 } };
      if (failure === 'context' && id === 'gpt-6.1-terra')
        return { ...target, contextWindow: 100 };
      if (failure === 'image' && id === 'gpt-6.1-terra')
        return { ...target, input: ['text'] as ['text'] };
      return target;
    };
    const matrix = buildRouteMatrix(
      profile,
      constrained,
      failure === 'image',
      100,
      undefined,
      true,
      undefined,
      { mode: 'cost', budgetExceeded: false },
    );
    const high = required(
      matrix.plans.find((p) => !p.cell && p.tier === 'high'),
    );
    expect(high.attempts[0]).toMatchObject({
      model: 'scope/gpt-6.1-sol',
      thinking: 'medium',
    });
    expect(high.attempts).toHaveLength(1);
  },
);

it('uses target alias metadata, maps effort and never borrows another provider catalog', () => {
  const config = normalizeConfig({
    profiles: {
      p: {
        ...ladder('work'),
        medium: { model: 'work/gpt-6.1-sol', thinking: 'medium' },
      },
    },
    models: {
      terra: {
        model: 'work/gpt-6.1-terra',
        thinkingLevels: ['low'],
        contextWindow: 999,
      },
      sol: { model: 'work/gpt-6.1-sol', thinkingLevels: ['high'] },
      'work/gpt-6.1-terra': { model: 'personal/gpt-6.1-sol' },
    },
  }).config;
  // Generated Terra targets cannot be redirected by a canonical-looking alias.
  const profile = required(config.profiles.p);
  const low = required(profile.activities?.code?.low?.builtinModes?.quality);
  expect(low).toMatchObject({
    model: 'work/gpt-6.1-terra',
    thinkingLevels: ['low'],
    resolvedContextWindow: 999,
  });
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
  expect(
    matrix.plans.find((p) => p.cell === 'code' && p.tier === 'low')
      ?.attempts[0],
  ).toMatchObject({ model: 'work/gpt-6.1-terra', thinking: 'low' });
  const onlyPersonalTerra = (provider: string, id: string) =>
    id === 'gpt-6.1-terra' && provider !== 'personal'
      ? undefined
      : find(provider, id);
  const scoped = buildRouteMatrix(
    profile,
    onlyPersonalTerra,
    false,
    0,
    undefined,
    true,
    undefined,
    { mode: 'quality', budgetExceeded: false },
  );
  expect(
    scoped.plans.some((p) =>
      p.attempts.some((a) => a.model === 'personal/gpt-6.1-terra'),
    ),
  ).toBe(false);
});

it('uses the new generic baseline on classifier failure and observes immediate mode/config changes', async () => {
  const f = terraHarness(advisedConfig(), find);
  f.failClassifier();
  await f.run('balanced');
  expect(f.state.lastDecision).toMatchObject({
    targetModelId: 'gpt-6.1-terra',
    thinking: 'medium',
  });
  await f.run('quality');
  expect(f.state.lastDecision).toMatchObject({
    targetModelId: 'gpt-6.1-sol',
    thinking: 'medium',
  });
  f.state.currentConfig = normalizeConfig(
    advisedConfig({ ...ladder('scope'), activityPreset: 'off' }),
  ).config;
  await f.run('quality');
  expect(f.state.lastDecision).toMatchObject({
    targetModelId: 'gpt-6.1-terra',
    thinking: 'high',
  });
});
