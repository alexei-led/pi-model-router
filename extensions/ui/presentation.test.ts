import { describe, expect, it } from 'vitest';
import type { RouterUISnapshot } from '../types';
import {
  activityRouteLines,
  activityRoutingSummary,
  advisorName,
  budgetLines,
  formatRoute,
  routeMix,
  routeReason,
  routerTone,
  textBar,
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
    thinkingHigh: undefined,
    thinkingMedium: undefined,
    thinkingLow: undefined,
    thinkingMicro: undefined,
  },
  eligible: {},
  activityRouting: 'on',
  activityCells: [],
  history: [],
  classifiers: [],
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
      'Activity routing: on · 0 override cells · read-only',
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
