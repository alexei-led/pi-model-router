import { describe, expect, it } from 'vitest';
import type {
  RouterUIHistoryEntry,
  RouterUIRoute,
  RouterUISnapshot,
} from '../types';
import {
  activityRouteLines,
  activityRoutingSummary,
  advisorName,
  budgetLines,
  classifierLines,
  classifierStatus,
  formatRoute,
  historyStatus,
  observedRouteChanges,
  routeMix,
  routeReason,
  routerTone,
  routeTimeline,
  textBar,
  usageSummary,
} from './presentation';

const snapshot: RouterUISnapshot = {
  profile: 'auto',
  lifecycle: 'generating',
  accumulatedCost: 1,
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
  it('uses the configured classifier name without adding advisor branding', () => {
    expect(advisorName('typesafe/jev-latest')).toBe('typesafe/jev-latest');
    expect(advisorName('Pi classifier')).toBe('Pi classifier');
  });

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
    expect(routeReason(state)).toBe('Local eligible baseline');
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
    expect(held).toContain('held: $0.0800 vs $0.0200 over 5 requests');
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
    expect(text).toContain('not a bill or cap');
  });
  it('bounds the history window, includes unknown routes in denominators and handles empty histories', () => {
    const actual = {
      tier: 'medium' as const,
      provider: 'test',
      model: 'm',
      thinking: 'off' as const,
    };
    const lines = routeMix([
      ...Array.from({ length: 50 }, () => ({ actual })),
      {},
    ]).join('\n');
    expect(lines).toContain('49/50');
    expect(lines).toContain('Unknown routes: 1');
    expect(routeMix([]).join('\n')).toContain('No retained decisions');
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
      'Activity routing: on · 0 override cells · session Routes editor',
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
      'Effort change: fixture/a [low] → fixture/a [high] · classifier',
    );
    expect(lines).toContain(
      'Model switch: fixture/a [high] → fixture/b [high] · pinned',
    );
    expect(lines.at(-1)).toBe('Observed: fixture/a [low]');
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
    expect(lines).toContain('Model switches: 1 · effort changes: 1');
    expect(lines).toContain('$0.1000 · coverage 1/3');
    expect(
      usageSummary({ ...value, history: [{ actual: actual('a') }] }).join('\n'),
    ).toContain('cost: unknown');
    expect(usageSummary(snapshot).join('\n')).toContain(
      'History collection is off',
    );
    expect(historyStatus(enabled)).toContain('no decisions retained yet');
    expect(historyStatus(value)).toContain('last 50 observations');
  });
});
