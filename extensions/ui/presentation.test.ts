import { describe, expect, it } from 'vitest';

import type {
  RouterUIHistoryEntry,
  RouterUIRoute,
  RouterUISnapshot,
} from '../types';
import {
  activityLabel,
  activityRouteLines,
  activityRoutingSummary,
  budgetLines,
  classifierLines,
  classifierStatus,
  formatRoute,
  historyStatus,
  observedRouteChanges,
  preferenceLine,
  routeReason,
  routerTone,
  routeTimeline,
  shortReason,
  textBar,
  usageSummary,
} from './presentation';

it('labels a default-owned model preference without claiming another configured tier supplied it', () => {
  expect(
    preferenceLine({
      status: 'eligible',
      mode: { mode: 'quality', source: 'session' },
      route: { tier: 'low', model: 'work/gpt-6.1-terra', thinking: 'medium' },
      lever: 'model',
      sourceTier: 'low',
    }),
  ).toContain('mode model preference');
});

const snapshot: RouterUISnapshot = {
  profile: 'auto',
  lifecycle: 'generating',
  accumulatedCost: 1,
  mode: { mode: 'balanced', source: 'default' },
  policySources: {
    costHorizon: 'config',
    costSensitivity: 'config',
    strongAdviceConfidence: 'config',
  },
  controls: {
    pin: 'auto',
    baseline: 'medium',
    budget: 2,
    advisor: undefined,
    timeout: 1500,
    reviewEveryRequests: 4,
    costHorizon: 5,
    costSensitivity: 0.5,
    strongAdviceConfidence: 0.9,
    thinkingHigh: undefined,
    thinkingMedium: undefined,
    thinkingLow: undefined,
    thinkingMicro: undefined,
  },
  eligible: {},
  activityRouting: 'on',
  activityCells: [],
  routeCells: [],
  history: [],
  loggingEnabled: false,
  classifiers: [],
  chatModels: [],
  privacy: { advisorEnabled: false, approvedModels: [], auth: 'unknown' },
};

describe('Signal Panel presentation', () => {
  it('marks high tier as ordinary, actual failure as error and recovered problems as warnings', () => {
    expect(routerTone(snapshot)).toBe('accent');
    expect(routerTone({ ...snapshot, lifecycle: 'failed' })).toBe('error');
    expect(routerTone({ ...snapshot, lifecycle: 'timeout' })).toBe('warning');
  });
  it('distinguishes a consumed review failure from reused initial diagnostics', () => {
    const state = {
      ...snapshot,
      lifecycle: 'continuation' as const,
      reuse: 'continuation' as const,
      advice: {
        advisor: 'fixture',
        outcome: 'deadline' as const,
        source: 'initial' as const,
      },
    };
    expect(routeReason(state)).toBe('Tool route reused · no new advice');
    expect(
      routeReason({ ...state, advice: { ...state.advice, source: 'review' } }),
    ).toContain('Background review deadline · current route retained');
  });

  it('marks reused advice without presenting its old latency as a new request', () => {
    expect(
      routeReason({
        ...snapshot,
        reuse: 'same-turn',
        advice: { advisor: 'clef', outcome: 'selected', latencyMs: 99 },
      }),
    ).toBe('Route reused · no new advice');
  });
  it('does not display pending pins as the reason for the actual generation', () => {
    const state = {
      ...snapshot,
      pendingControls: { ...snapshot.controls, pin: 'high' as const },
    };
    expect(routeReason(state)).toBe('Baseline route');
    expect(routeReason({ ...state, bypassReason: 'pinned' })).toBe(
      'Pinned route · advice skipped',
    );
  });
  it('explains held model proposals and effort-cache compatibility', () => {
    const held = routeReason({
      ...snapshot,
      advised: {
        tier: 'medium',
        activity: 'docs',
        provider: 'test',
        model: 'docs',
        thinking: 'low',
      },
      switchCost: {
        reason: 'cost-held',
        horizonRequests: 5,
        stayUsd: 0.02,
        switchUsd: 0.08,
        incrementalUsd: 0.06,
        confidenceOverride: false,
      },
    });
    expect(held).toContain('held: $0.08 vs $0.02 over 5 requests');
    expect(
      routerTone({
        ...snapshot,
        switchCost: {
          reason: 'cost-held',
          horizonRequests: 5,
          confidenceOverride: false,
        },
      }),
    ).toBe('warning');
    expect(
      routeReason({
        ...snapshot,
        switchCost: {
          reason: 'effort-cache-shared',
          horizonRequests: 5,
          stayUsd: 0,
          switchUsd: 0,
          incrementalUsd: 0,
          confidenceOverride: false,
        },
      }),
    ).toContain('cache-compatible');
  });
  it.each([0, 0.5, 1, 1.08])(
    'bounds bar fill but preserves the true budget ratio %s',
    (ratio) => {
      expect(textBar(ratio)).toHaveLength(12);
      expect(
        budgetLines({ ...snapshot, accumulatedCost: ratio * 2 }).join('\n'),
      ).toContain(`${Math.round(ratio * 100)}%`);
    },
  );
  it.each([undefined, NaN, Infinity, -1])(
    'does not turn unknown cost %s into zero',
    (accumulatedCost) => {
      expect(
        budgetLines({ ...snapshot, accumulatedCost }).join('\n'),
      ).toContain('unknown');
      expect(
        budgetLines({ ...snapshot, accumulatedCost }).join('\n'),
      ).not.toContain('0%');
    },
  );
  it('omits a gauge without a budget and labels it as catalog, not a hard cap', () => {
    const text = budgetLines({
      ...snapshot,
      controls: { ...snapshot.controls, budget: undefined },
    }).join('\n');
    expect(text).toContain('Budget unset');
    expect(text).not.toContain('%');
    expect(text).toContain(
      'Catalog prices. Not a bill or cap. Advice excluded.',
    );
  });
  it('bounds the history window, includes unknown routes in denominators and handles empty histories', () => {
    const actual = {
      tier: 'medium' as const,
      provider: 'test',
      model: 'm',
      thinking: 'off' as const,
    };
    const collecting = { ...snapshot, loggingEnabled: true };
    const lines = usageSummary({
      ...collecting,
      history: [...Array.from({ length: 50 }, () => ({ actual })), {}],
    }).join('\n');
    expect(lines).toContain('49 replies');
    expect(lines).toContain('1 unknown route');
    expect(usageSummary({ ...collecting, history: [] }).join('\n')).toContain(
      'Send a new request with history on',
    );
  });
});

it('distinguishes classified activity from local availability-cell provenance', () => {
  const route = {
    tier: 'medium' as const,
    provider: 'test',
    model: 'code',
    thinking: 'off' as const,
  };
  expect(
    formatRoute({ ...route, activity: 'code', routeCell: 'code' }),
  ).toContain('activity code');
  expect(formatRoute({ ...route, routeCell: 'code' })).toContain(
    'availability cell code',
  );
});

describe('activity override presentation', () => {
  it('shows mode, generic inheritance and an explicit empty state', () => {
    expect(activityRoutingSummary(snapshot)).toBe(
      'Activity routing: on · 0 activity cells · session Routes editor',
    );
    expect(activityRouteLines(snapshot)).toEqual([
      'Unlisted cells use generic tiers, if configured.',
      'No configured activity overrides.',
    ]);
    expect(
      activityRoutingSummary({ ...snapshot, activityRouting: 'off' }),
    ).toContain('Activity routing: off');
  });

  it('keeps configured primary/fallback order distinct from the first text-eligible attempt and mapped effort', () => {
    const lines = activityRouteLines({
      ...snapshot,
      activityCells: [
        {
          activity: 'code',
          configured: {
            tier: 'medium',
            model: 'test/missing',
            thinking: 'high',
          },
          fallbacks: ['test/backup', 'test/last'],
          availability: 'eligible',
          eligible: {
            tier: 'medium',
            provider: 'test',
            model: 'backup',
            thinking: 'off',
          },
        },
      ],
    });
    expect(lines[1]).toBe(
      'code/medium: configured test/missing · requested effort high',
    );
    expect(lines[2]).toBe(
      '  Text eligible: test/backup · effort off · configured fallbacks: test/backup → test/last',
    );
    expect(lines.join('\n')).not.toMatch(/Actual|Advised|activity code/);
  });

  it.each([
    ['disabled', 'Excluded (activity routing off)'],
    ['unknown', 'Text eligibility unknown (no registry)'],
    ['unavailable', 'No text-eligible attempt'],
  ] as const)(
    'labels %s without claiming an observed route',
    (availability, label) => {
      const text = activityRouteLines({
        ...snapshot,
        activityCells: [
          {
            activity: 'docs',
            configured: { tier: 'micro', model: 'test/docs', thinking: 'off' },
            fallbacks: [],
            availability,
          },
        ],
      }).join('\n');
      expect(text).toContain(label);
      expect(text).toContain('configured fallbacks: none');
      expect(text).not.toContain('undefined');
    },
  );
});

describe('routing observability', () => {
  const actual = (
    model: string,
    thinking: RouterUIRoute['thinking'] = 'low',
  ): RouterUIRoute => ({
    tier: 'low',
    provider: 'fixture',
    model,
    thinking,
  });
  const enabled: RouterUISnapshot = {
    ...snapshot,
    loggingEnabled: true,
    controls: { ...snapshot.controls, advisor: 'typesafe/jev-1.14.0' },
    classifiers: [
      { model: 'typesafe/jev-1.14.0', name: 'Jev 1.14', textInput: true },
    ],
    privacy: {
      advisorEnabled: true,
      approvedModels: ['typesafe/jev-1.14.0'],
      auth: 'unknown',
    },
  };
  it.each([
    [
      'disabled',
      { ...enabled, privacy: { ...enabled.privacy, advisorEnabled: false } },
      'Disabled',
    ],
    [
      'unselected',
      { ...enabled, controls: { ...enabled.controls, advisor: undefined } },
      'Not configured',
    ],
    ['unregistered', { ...enabled, classifiers: [] }, 'Not registered'],
    [
      'unapproved',
      { ...enabled, privacy: { ...enabled.privacy, approvedModels: [] } },
      'Not approved',
    ],
    [
      'non-text',
      {
        ...enabled,
        classifiers: [
          { model: 'typesafe/jev-1.14.0', name: 'Non-text', textInput: false },
        ],
      },
      'Unsupported input',
    ],
    ['approved', enabled, 'Eligible to ask'],
  ])(
    'explains %s without claiming authentication',
    (_name, value, expected) => {
      expect(classifierStatus(value)).toContain(expected);
      expect(classifierStatus(value)).not.toContain('authenticated');
    },
  );
  it('labels the actual operation model/profile separately from the selected model', () => {
    const lines = classifierLines({
      ...enabled,
      lastAdvice: {
        advisor: 'fixture/previous',
        profile: 'previous-profile',
        outcome: 'deadline',
        latencyMs: 12.7,
        source: 'review',
      },
    }).join('\n');
    expect(lines).toContain('Active model: typesafe/jev-1.14.0');
    expect(lines).toContain('Last observed advice: deadline · 13 ms');
    expect(lines).toContain(
      'Operation model: fixture/previous · review · profile previous-profile',
    );
    expect(lines).toContain('read-only');
    expect(
      classifierLines({
        ...snapshot,
        advice: { advisor: 'fixture/legacy', outcome: 'unavailable' },
      }).join('\n'),
    ).toContain('source unreported');
  });
  it('distinguishes initial observations, physical switches and effort changes', () => {
    const history: RouterUIHistoryEntry[] = [
      { actual: actual('a'), reason: 'baseline' },
      { actual: { ...actual('a'), tier: 'high' } },
      { reviewOnly: true, actual: actual('never-generated') },
      { actual: actual('a', 'high'), reason: 'classifier' },
      { actual: actual('b', 'high'), reason: 'pinned' },
      {},
      { actual: actual('a') },
    ];
    expect(observedRouteChanges(history).map((change) => change.kind)).toEqual([
      'observed',
      'effort',
      'model',
      'observed',
    ]);
    const lines = routeTimeline(history);
    expect(lines).toContain(
      'Effort change: ▂▄▆█ A · low → ▂▄ A · high · classifier',
    );
    expect(lines).toContain('Model switch: ▂▄ A · high → ▂▄ B · high · pinned');
    expect(lines.at(-1)).toBe('Observed: ▂▄ A · low');
    expect(lines.join('\n')).not.toContain('never-generated');
    expect(routeTimeline([])).toEqual(['No retained generation targets.']);
  });
  it('does not invent a switch across the retained-history boundary', () => {
    const history: RouterUIHistoryEntry[] = [
      { actual: actual('old') },
      ...Array.from({ length: 50 }, () => ({ actual: actual('current') })),
    ];
    expect(observedRouteChanges(history).map((change) => change.kind)).toEqual([
      'observed',
    ]);
    const changes = Array.from({ length: 8 }, (_, index) => ({
      actual: actual(String(index)),
    }));
    expect(routeTimeline(changes)).toHaveLength(4);
  });
  it('keeps partial costs unknown and separates model changes from effort changes', () => {
    const value: RouterUISnapshot = {
      ...enabled,
      history: [
        { actual: actual('a'), generationCostUsd: 0.1 },
        { actual: actual('b') },
        { actual: actual('b', 'high') },
      ],
    };
    const lines = usageSummary(value).join('\n');
    expect(lines).toContain('$0.10 catalog · 3 replies');
    expect(lines).toContain('1 switch · 1 effort change');
    expect(lines).toContain('2 replies unpriced: unknown, not free');
    expect(
      usageSummary({ ...value, history: [{ actual: actual('a') }] }).join('\n'),
    ).toContain('unknown catalog · 1 reply');
    expect(usageSummary(snapshot).join('\n')).toContain(
      'History collection is off',
    );
    expect(historyStatus(enabled)).toContain('no decisions retained yet');
    expect(historyStatus(value)).toContain('last 50 observations');
  });
});

it.each([
  [{}, 'base'],
  [{ routeCell: 'code' as const }, 'available code'],
  [{ activity: 'debug' as const, routeCell: 'debug' as const }, 'debug'],
])('labels activity provenance %j as %s', (route, label) => {
  expect(activityLabel(route)).toBe(label);
});

describe('usageSummary tiers and comparison', () => {
  const route = (
    tier: RouterUIRoute['tier'],
    model: string,
  ): RouterUIRoute => ({ tier, provider: 'fixture', model, thinking: 'low' });
  const value: RouterUISnapshot = {
    ...snapshot,
    loggingEnabled: true,
    history: [
      { actual: route('micro', 'a'), generationCostUsd: 0.5 },
      { actual: route('high', 'b'), generationCostUsd: 0.75 },
      { actual: route('high', 'b'), generationCostUsd: 0.75 },
    ],
  };

  it('lists tiers micro to high with replies and cost', () => {
    const lines = usageSummary(value);
    const micro = lines.findIndex((line) => line.startsWith('▂ '));
    const high = lines.findIndex((line) => line.startsWith('▂▄▆█ '));
    expect(lines[micro]).toMatch(/micro +\[.*\] 1 reply \$0\.50$/u);
    expect(lines[high]).toMatch(/high +\[.*\] 2 replies \$1\.50$/u);
    expect(micro).toBeGreaterThanOrEqual(0);
    expect(micro).toBeLessThan(high);
    expect(lines.some((line) => line.includes(' low '))).toBe(false);
  });

  it('shows the same-token comparison only when the snapshot carries one', () => {
    expect(usageSummary(value).join('\n')).not.toContain('Same tokens');
    const lines = usageSummary({
      ...value,
      comparison: {
        model: 'claude-opus-5-5',
        yourUsd: 5,
        routedUsd: 2,
        replies: 3,
      },
    });
    expect(lines).toContain('Same tokens on Opus 5.5: $5.00 vs $2.00 routed');
    expect(lines).toContain('−$3.00 (−60%) · estimate over 3 replies');
    expect(lines.at(-1)).toBe('Catalog prices, not a bill. Advice excluded.');
  });

  it('leaves the comparison out when both sides are below half a cent', () => {
    const lines = usageSummary({
      ...value,
      comparison: {
        model: 'claude-opus-5-5',
        yourUsd: 0.004,
        routedUsd: 0.001,
        replies: 3,
      },
    });
    expect(lines.join('\n')).not.toContain('Same tokens');
  });
});

describe('classifier outcome wording', () => {
  const state = (
    outcome: NonNullable<RouterUISnapshot['advice']>['outcome'],
    latencyMs?: number,
  ): RouterUISnapshot => ({
    ...snapshot,
    lifecycle: 'idle',
    advice: { advisor: 'c', outcome, latencyMs },
  });
  it.each([
    ['selected', 'Classifier advice accepted · 412 ms', '= fits'],
    ['deadline', 'Classifier timed out · baseline kept', '! timed out'],
    ['uncertain', 'Classifier abstained · baseline kept', '= unsure'],
    ['cancelled', 'Classifier cancelled', '= cancelled'],
    ['unavailable', 'Classifier unavailable · baseline kept', '! unavailable'],
    [
      'invalid-response',
      'Classifier answer invalid · baseline kept',
      '! bad answer',
    ],
    [
      'input-too-large',
      'Classifier input too large · baseline kept',
      '! input too large',
    ],
    [
      'network-error',
      'Classifier network error · baseline kept',
      '! network error',
    ],
    ['http-error', 'Classifier HTTP error · baseline kept', '! http error'],
  ] as const)(
    '%s reads as a sentence and a short reason',
    (outcome, sentence, short) => {
      expect(routeReason(state(outcome, 412))).toBe(sentence);
      expect(shortReason(state(outcome, 412))).toBe(short);
    },
  );
});

describe('shortReason', () => {
  const route = (tier: RouterUIRoute['tier']): RouterUIRoute => ({
    tier,
    provider: 'p',
    model: 'm',
    thinking: 'low',
  });
  const moved = (from: RouterUIRoute['tier'], to: RouterUIRoute['tier']) => [
    { actual: { ...route(from), model: 'x' } },
    { actual: { ...route(to), model: 'y' } },
  ];
  const stay: RouterUISnapshot = { ...snapshot, lifecycle: 'idle' };
  const cost = (
    reason:
      | 'cost-held'
      | 'strong-advice'
      | 'effort-cache-shared'
      | 'within-policy',
  ) => ({
    reason,
    horizonRequests: 5,
    confidenceOverride: reason === 'strong-advice',
  });
  const advice = (outcome: 'selected' | 'deadline' | 'uncertain') => ({
    advisor: 'c',
    outcome,
  });
  it.each<[string, Partial<RouterUISnapshot>, string]>([
    ['choosing', { lifecycle: 'choosing' }, '… choosing'],
    ['cancelled', { lifecycle: 'cancelled' }, '= cancelled'],
    ['failed', { lifecycle: 'failed' }, '! failed · /router log'],
    ['fallback', { lifecycle: 'fallback' }, '! fallback'],
    ['budget', { lifecycle: 'budget' }, '↓ over budget'],
    ['escalation', { reason: 'escalation' }, '↑ tool errors'],
    ['pinned', { reason: 'pinned' }, '⏵ pinned'],
    ['bypass pin', { bypassReason: 'pinned' }, '⏵ pinned'],
    ['reuse', { reuse: 'continuation' }, '= reused'],
    ['no advice', {}, '= baseline'],
    [
      'held stronger',
      {
        switchCost: cost('cost-held'),
        advised: route('high'),
        actual: route('low'),
      },
      '… stronger, waiting',
    ],
    [
      'held cheaper',
      {
        switchCost: cost('cost-held'),
        advised: route('low'),
        actual: route('high'),
      },
      '… cheaper, waiting',
    ],
    [
      'strong advice up',
      { switchCost: cost('strong-advice'), history: moved('low', 'high') },
      '↑ clearly stronger',
    ],
    [
      'strong advice down',
      { switchCost: cost('strong-advice'), history: moved('high', 'low') },
      '↓ clearly cheaper',
    ],
    [
      'effort changed',
      { switchCost: cost('effort-cache-shared') },
      '= effort changed',
    ],
    [
      'within policy up',
      { switchCost: cost('within-policy'), history: moved('low', 'medium') },
      '↑ stronger',
    ],
    [
      'within policy down',
      { switchCost: cost('within-policy'), history: moved('medium', 'low') },
      '↓ cheaper',
    ],
    ['accepted, no move', { advice: advice('selected') }, '= fits'],
    ['deadline', { advice: advice('deadline') }, '! timed out'],
    ['uncertain', { advice: advice('uncertain') }, '= unsure'],
  ])('%s', (_name, patch, expected) => {
    expect(shortReason({ ...stay, ...patch })).toBe(expected);
  });
});
