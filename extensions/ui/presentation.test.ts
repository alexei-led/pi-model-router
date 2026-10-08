import { describe, expect, it } from 'vitest';
import type { RouterUISnapshot } from '../types';
import {
  advisorName,
  budgetLines,
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
      ).toContain(Math.round(ratio * 100) + '%');
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
