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
    advisor: 'jev',
    timeout: 1500,
    thinkingHigh: undefined,
    thinkingMedium: undefined,
    thinkingLow: undefined,
    thinkingMicro: undefined,
  },
  eligible: {},
  history: [],
  privacy: { jevApproved: true, cloudflareApproved: false, auth: 'unknown' },
};

describe('Signal Panel presentation', () => {
  it.each([
    ['jev', 'Jev'],
    ['clef', 'Clef'],
    ['clef-flash', 'Clef Flash'],
    ['classifier', 'Pi classifier'],
  ] as const)(
    'names %s without branding the panel after it',
    (advisor, label) => {
      expect(advisorName(advisor)).toBe(label);
      expect(
        routeReason({
          ...snapshot,
          advice: { advisor, outcome: 'selected', latencyMs: 42 },
        }),
      ).toBe(label + ' advice accepted · 42 ms');
    },
  );
  it.each(['jev', 'clef', 'clef-flash', 'classifier'] as const)(
    'honestly explains all outcomes for %s',
    (advisor) => {
      for (const [outcome, expected] of [
        ['deadline', 'timed out → baseline'],
        ['uncertain', 'abstained → baseline'],
        ['invalid-response', 'invalid advice → baseline'],
        ['network-error', 'network error → baseline'],
        ['http-error', 'HTTP error → baseline'],
        ['unavailable', 'unavailable → baseline'],
        ['input-too-large', 'input too large → baseline'],
        ['cancelled', 'cancelled'],
      ] as const) {
        expect(routeReason({ ...snapshot, advice: { advisor, outcome } })).toBe(
          advisorName(advisor) + ' ' + expected,
        );
      }
    },
  );
  it.each([
    ['choosing', 'Choosing route'],
    ['continuation', 'Tool route reused'],
    ['failed', 'Generation failed'],
    ['cancelled', 'Cancelled'],
    ['budget', 'Over soft budget'],
    ['fallback', 'Explicit generation fallback'],
    ['off', 'Router off'],
  ] as const)('gives %s precedence over old advice', (lifecycle, expected) => {
    const state = {
      ...snapshot,
      lifecycle,
      advice: {
        advisor: 'jev' as const,
        outcome: 'selected' as const,
        latencyMs: 99,
      },
    };
    expect(routeReason(state)).toContain(expected);
    expect(routeReason(state)).not.toContain('99 ms');
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
