import { describe, expect, it } from 'vitest';
import { normalizeConfig } from './config';
import { evaluateSwitch } from './switch-policy';
import { model } from './test/fixtures';
import type { RoutePair, RouterConfig } from './types';

const pair = (
  modelRef: string,
  thinking: RoutePair['thinking'],
): RoutePair => ({
  tier: 'medium',
  model: modelRef,
  thinking,
});
const current = model('current', {
  cost: { input: 10, output: 20, cacheRead: 1, cacheWrite: 12.5 },
});
const cheap = model('cheap', {
  cost: { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 },
});
const evaluate = (
  options: {
    currentModel?: typeof current;
    proposedModel?: typeof current;
    currentEffort?: RoutePair['thinking'];
    proposedEffort?: RoutePair['thinking'];
    switchPolicy?: RouterConfig['switchPolicy'];
    effortCacheSharing?: 'shared' | 'separate' | 'unknown';
    confidence?: number;
  } = {},
) => {
  const currentModel = options.currentModel ?? current;
  const proposedModel = options.proposedModel ?? cheap;
  return evaluateSwitch({
    current: pair(
      `${currentModel.provider}/${currentModel.id}`,
      options.currentEffort ?? 'low',
    ),
    proposed: pair(
      `${proposedModel.provider}/${proposedModel.id}`,
      options.proposedEffort ?? 'high',
    ),
    currentModel,
    proposedModel,
    config: normalizeConfig({
      ...(options.switchPolicy ? { switchPolicy: options.switchPolicy } : {}),
      models: options.effortCacheSharing
        ? {
            current: {
              model: `${current.provider}/${current.id}`,
              effortCacheSharing: options.effortCacheSharing,
            },
          }
        : undefined,
      profiles: { balanced: { medium: { model: 'test/current' } } },
    }).config,
    contextTokens: 100_000,
    outputTokens: 2_000,
    adviceConfidence: options.confidence,
  });
};

describe('adaptive switch economics', () => {
  it('separates cache rebuild from steady generation prices and respects long-context tariffs', () => {
    const tiered = model('tiered', {
      cost: {
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: 1.25,
        tiers: [
          {
            inputTokensAbove: 200000,
            input: 2,
            output: 4,
            cacheRead: 0.2,
            cacheWrite: 2.5,
          },
        ],
      },
    });
    const result = evaluateSwitch({
      current: pair('test/current', 'low'),
      proposed: pair('test/tiered', 'high'),
      currentModel: current,
      proposedModel: tiered,
      config: normalizeConfig({ switchPolicy: { horizonRequests: 1 } }).config,
      contextTokens: 300000,
      outputTokens: 1000,
      adviceConfidence: 0.95,
    });
    expect(result.diagnostic.switchUsd).toBeCloseTo(0.754, 10);
    expect(result.diagnostic.rebuildUsd).toBeCloseTo(0.69, 10);
    expect(result.diagnostic.steadyDeltaUsd).toBeCloseTo(-0.256, 10);
    expect(result.diagnostic.incrementalUsd).toBeCloseTo(
      (result.diagnostic.rebuildUsd ?? 0) +
        (result.diagnostic.steadyDeltaUsd ?? 0),
      10,
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'keeps invalid workload %s unknown, not free',
    (contextTokens) => {
      const result = evaluateSwitch({
        current: pair('test/current', 'low'),
        proposed: pair('test/cheap', 'high'),
        currentModel: current,
        proposedModel: cheap,
        config: normalizeConfig({}).config,
        contextTokens,
        outputTokens: 1000,
        adviceConfidence: 0.95,
      });
      expect(result.diagnostic.reason).toBe('cost-unknown');
      expect(result.diagnostic.switchUsd).toBeUndefined();
    },
  );

  it('treats explicitly cache-compatible effort-only changes as zero rebuild cost', () => {
    const result = evaluate({
      currentModel: current,
      proposedModel: current,
      currentEffort: 'low',
      proposedEffort: 'high',
      effortCacheSharing: 'shared',
    });
    expect(result).toEqual({
      accepted: true,
      diagnostic: {
        reason: 'effort-cache-shared',
        horizonRequests: 5,
        rebuildUsd: 0,
        confidenceOverride: false,
      },
    });
  });

  it('allows unknown same-model effort changes without claiming cache preservation', () => {
    const result = evaluate({
      currentModel: current,
      proposedModel: current,
      currentEffort: 'low',
      proposedEffort: 'high',
    });
    expect(result.accepted).toBe(true);
    expect(result.diagnostic.reason).toBe('effort-cache-unknown');
    expect(result.diagnostic.stayUsd).toBeUndefined();
  });

  it('uses the request horizon to accept a cheaper model after its cold first input', () => {
    const result = evaluate({
      currentModel: current,
      proposedModel: cheap,
      switchPolicy: {
        horizonRequests: 5,
        costSensitivity: 1,
        strongAdviceConfidence: 0.9,
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.diagnostic.reason).toBe('within-policy');
    expect(result.diagnostic.switchUsd).toBeLessThan(
      result.diagnostic.stayUsd ?? 0,
    );
    expect(result.diagnostic.incrementalUsd).toBeLessThan(0);
  });

  it('holds an uneconomic cold upgrade unless classifier evidence is strong', () => {
    const costSensitive = {
      horizonRequests: 5,
      costSensitivity: 1,
      strongAdviceConfidence: 0.9,
    };
    const held = evaluate({
      currentModel: cheap,
      proposedModel: current,
      switchPolicy: costSensitive,
      confidence: 0.8,
    });
    expect(held.accepted).toBe(false);
    expect(held.diagnostic.reason).toBe('cost-held');
    const promoted = evaluate({
      currentModel: cheap,
      proposedModel: current,
      switchPolicy: costSensitive,
      confidence: 0.95,
    });
    expect(promoted.accepted).toBe(true);
    expect(promoted.diagnostic.reason).toBe('strong-advice');
    expect(promoted.diagnostic.confidenceOverride).toBe(true);
  });

  it('prices freshly written cache as part of the next reusable-prefix scenario', () => {
    const next = evaluateSwitch({
      current: pair('test/current', 'low'),
      proposed: pair('test/cheap', 'high'),
      currentModel: current,
      proposedModel: cheap,
      config: normalizeConfig({ switchPolicy: { horizonRequests: 5 } }).config,
      contextTokens: 100000,
      outputTokens: 2000,
      adviceConfidence: 0.8,
      previousGeneration: {
        transition: 'initial',
        contextTruncated: false,
        attempts: 1,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 100000,
        outputTokens: 2000,
      },
    });
    expect(next.diagnostic.stayUsd).toBeCloseTo(0.7, 10);
    expect(next.diagnostic.rebuildUsd).toBeGreaterThan(0);
  });

  it('does not forbid a cross-model switch when catalog cost is unavailable', () => {
    const unpriced = model('unknown', {
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const result = evaluate({ proposedModel: unpriced });
    expect(result.accepted).toBe(true);
    expect(result.diagnostic.reason).toBe('cost-unknown');
    expect(result.diagnostic.incrementalUsd).toBeUndefined();
  });

  it('does not treat matching IDs across providers as same-model effort changes', () => {
    const other = model('current', { provider: 'other', cost: current.cost });
    const result = evaluate({
      currentModel: current,
      proposedModel: other,
      currentEffort: 'low',
      proposedEffort: 'high',
      effortCacheSharing: 'shared',
    });
    expect(result.diagnostic.reason).not.toBe('effort-cache-shared');
  });
});
