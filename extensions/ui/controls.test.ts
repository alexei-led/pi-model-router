import { describe, expect, it } from 'vitest';
import type { RouterUIControls } from '../types';
import { validateRouterUIControls } from './controls';

const controls: RouterUIControls = {
  pin: 'auto',
  baseline: 'medium',
  budget: 5,
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
};

describe('UI control validation', () => {
  it.each([
    {
      field: 'reviewEveryRequests',
      values: [-1, 1001, 0.5, Number.NaN, Number.POSITIVE_INFINITY],
      error: 'Review interval',
    },
    {
      field: 'costSensitivity',
      values: [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY],
      error: 'Switch-cost sensitivity',
    },
    {
      field: 'strongAdviceConfidence',
      values: [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY],
      error: 'Strong-advice threshold',
    },
  ] as const)(
    'rejects invalid $field values with the matching diagnostic',
    ({ field, values, error }) => {
      for (const value of values)
        expect(
          validateRouterUIControls({ ...controls, [field]: value }),
        ).toContain(error);
    },
  );

  it.each([
    { reviewEveryRequests: 0, costSensitivity: 0, strongAdviceConfidence: 0 },
    {
      reviewEveryRequests: 1000,
      costSensitivity: 1,
      strongAdviceConfidence: 1,
    },
    {
      reviewEveryRequests: 1,
      costSensitivity: 0.5,
      strongAdviceConfidence: 0.9,
    },
  ])(
    'accepts inclusive policy boundaries $reviewEveryRequests/$costSensitivity/$strongAdviceConfidence',
    (policy) => {
      expect(
        validateRouterUIControls({ ...controls, ...policy, budget: undefined }),
      ).toBeUndefined();
    },
  );

  it.each([1, 2, 8, 20])(
    'accepts the configured cost horizon %i',
    (costHorizon) => {
      expect(
        validateRouterUIControls({ ...controls, costHorizon }),
      ).toBeUndefined();
    },
  );
  it.each([0, 21, 1.5, Number.NaN])(
    'rejects invalid cost horizon %s',
    (costHorizon) => {
      expect(validateRouterUIControls({ ...controls, costHorizon })).toContain(
        'Cost horizon',
      );
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid budget %s',
    (budget) => {
      expect(validateRouterUIControls({ ...controls, budget })).toContain(
        'Budget',
      );
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147483648])(
    'rejects invalid timeout %s',
    (timeout) => {
      expect(validateRouterUIControls({ ...controls, timeout })).toContain(
        'Timeout',
      );
    },
  );

  it('allows uncapped positive finite budgets and the Node timer maximum', () => {
    expect(
      validateRouterUIControls({
        ...controls,
        budget: 1e100,
        timeout: 2147483647,
      }),
    ).toBeUndefined();
  });
});
