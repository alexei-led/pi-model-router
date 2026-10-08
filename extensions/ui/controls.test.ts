import { describe, expect, it } from 'vitest';
import type { RouterUIControls } from '../types';
import { validateRouterUIControls } from './controls';

const controls: RouterUIControls = {
  pin: 'auto',
  baseline: 'medium',
  budget: 5,
  advisor: undefined,
  timeout: 1500,
  thinkingHigh: undefined,
  thinkingMedium: undefined,
  thinkingLow: undefined,
  thinkingMicro: undefined,
};

describe('UI control validation', () => {
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
