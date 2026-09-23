import { describe, expect, it } from 'vitest';
import { observeGeneration } from './economics';
import { message, model } from './test/fixtures';

const expensive = model('expensive', {
  cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 },
});
const cheap = model('cheap', {
  cost: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
});
const usage = {
  input: 0,
  output: 2000,
  cacheRead: 80000,
  cacheWrite: 20000,
  totalTokens: 102000,
  cost: {
    input: 0,
    output: 0.008,
    cacheRead: 0.016,
    cacheWrite: 0.05,
    total: 0.074,
  },
};
const observe = (target = cheap, previous = expensive) =>
  observeGeneration({
    usage,
    target,
    previous,
    contextTruncated: false,
    attempts: 1,
    reportedCostUsd: usage.cost.total,
  });

describe('generation economics', () => {
  it('uses disjoint Pi input/cache counters and includes output in both scenarios', () => {
    const result = observe();
    expect(result).toMatchObject({
      transition: 'model-switch',
      inputTokens: 0,
      outputTokens: 2000,
      cacheReadTokens: 80000,
      cacheWriteTokens: 20000,
      reportedCostUsd: 0.074,
    });
    expect(result?.shadow).toEqual({
      previousModel: 'test/expensive',
      stayAllReadUsd: 0.14,
      stayAllNewUsd: 1.29,
      switchAllReadUsd: 0.028,
      switchAllNewUsd: 0.258,
    });
    expect(result?.shadow?.switchAllNewUsd).toBeGreaterThan(
      result?.shadow?.stayAllReadUsd ?? 0,
    );
  });

  it('does not claim a cache-preserving effort change for the same model', () => {
    expect(observe(expensive)).toMatchObject({ transition: 'same-model' });
    expect(observe(expensive)?.shadow).toBeUndefined();
  });

  it('does not treat the same model ID on another provider as the same route', () => {
    expect(
      observe(model('expensive', { ...expensive, provider: 'other' })),
    ).toMatchObject({ transition: 'model-switch' });
  });

  it('reports initial when there is no previous model and suppresses truncated comparisons', () => {
    expect(
      observeGeneration({
        usage,
        target: cheap,
        attempts: 1,
        contextTruncated: false,
      }),
    ).toMatchObject({ transition: 'initial', shadow: undefined });
    expect(
      observeGeneration({
        usage,
        target: cheap,
        previous: expensive,
        attempts: 1,
        contextTruncated: true,
      }),
    ).toMatchObject({
      transition: 'model-switch',
      contextTruncated: true,
      shadow: undefined,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'leaves placeholder or invalid price %s unknown',
    (input) => {
      expect(
        observe(model('cheap', { ...cheap, cost: { ...cheap.cost, input } }))
          ?.shadow,
      ).toBeUndefined();
    },
  );

  it('uses ordinary input price when the catalog does not charge cache writes separately', () => {
    const result = observe(
      model('cheap', { ...cheap, cost: { ...cheap.cost, cacheWrite: 0 } }),
    );
    expect(result?.shadow?.switchAllNewUsd).toBe(0.208);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    'rejects invalid usage counters %s',
    (input) => {
      expect(
        observeGeneration({
          usage: { ...usage, input },
          target: cheap,
          attempts: 1,
          contextTruncated: false,
        }),
      ).toBeUndefined();
    },
  );

  it('reflects a tariff error in shadow data without introducing a confidence gate', () => {
    const base = observe();
    const inflated = observe(
      cheap,
      model('expensive', {
        ...expensive,
        cost: { ...expensive.cost, cacheRead: expensive.cost.cacheRead * 10 },
      }),
    );
    expect(base?.shadow?.stayAllReadUsd).toBe(0.14);
    expect(inflated?.shadow?.stayAllReadUsd).toBe(1.04);
    expect(inflated?.shadow?.switchAllNewUsd).toBe(
      base?.shadow?.switchAllNewUsd,
    );
    expect(inflated?.reportedCostUsd).toBe(base?.reportedCostUsd);
  });

  it('does not invent cost from missing or invalid reported totals', () => {
    expect(
      observeGeneration({
        usage,
        target: cheap,
        attempts: 1,
        contextTruncated: false,
        reportedCostUsd: Number.NaN,
      })?.reportedCostUsd,
    ).toBeUndefined();
    expect(
      observeGeneration({
        usage: message().usage,
        target: model(),
        attempts: 1,
        contextTruncated: false,
        reportedCostUsd: 0,
      })?.reportedCostUsd,
    ).toBeUndefined();
  });
});
