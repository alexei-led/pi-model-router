import type { Api, Model } from '@earendil-works/pi-ai';

/** Bundled Pi 1.5.2 catalog, read 2026-11-15. Estimates, not gateway tariffs or bills. */
export const runtimeCosts: Readonly<Record<string, Model<Api>['cost']>> = {
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [
      {
        inputTokensAbove: 100_000,
        input: 0.5,
        output: 2.5,
        cacheRead: 0.05,
        cacheWrite: 0.625,
      },
    ],
  },
  'claude-sonnet-5-5': {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
  },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'gpt-6-luna': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: 0.2,
        output: 0.75,
        cacheRead: 0.02,
        cacheWrite: 0.25,
      },
    ],
  },
  'gpt-6.1-terra': {
    input: 1,
    output: 5,
    cacheRead: 0.05,
    cacheWrite: 1.25,
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: 2,
        output: 7.5,
        cacheRead: 0.1,
        cacheWrite: 2.5,
      },
    ],
  },
  'gpt-6.1-sol': {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: 4,
        output: 15,
        cacheRead: 0.2,
        cacheWrite: 5,
      },
    ],
  },
};
