import { type Api, calculateCost, type Model } from '@earendil-works/pi-ai';
import type {
  EffortCacheSharing,
  GenerationDiagnostics,
  RoutePair,
  RouterConfig,
  SwitchCostDiagnostic,
} from './types';

type SwitchModel = Model<Api>;

export interface SwitchPolicyInput {
  current: RoutePair;
  proposed: RoutePair;
  currentModel: SwitchModel;
  proposedModel: SwitchModel;
  config: RouterConfig;
  previousGeneration?: GenerationDiagnostics;
  contextTokens: number;
  outputTokens: number;
  adviceConfidence: number | undefined;
}

export interface SwitchPolicyResult {
  accepted: boolean;
  diagnostic: SwitchCostDiagnostic;
}

const priceable = (model: SwitchModel, inputTokens: number): boolean => {
  const tier = model.cost.tiers
    ?.filter((entry) => inputTokens > entry.inputTokensAbove)
    .sort((left, right) => right.inputTokensAbove - left.inputTokensAbove)[0];
  const rates = tier ?? model.cost;
  return (
    [rates.input, rates.output, rates.cacheRead].every(
      (rate) => typeof rate === 'number' && Number.isFinite(rate) && rate > 0,
    ) &&
    typeof rates.cacheWrite === 'number' &&
    Number.isFinite(rates.cacheWrite) &&
    rates.cacheWrite >= 0
  );
};

const cost = (
  model: SwitchModel,
  values: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
): number =>
  calculateCost(model, {
    ...values,
    totalTokens:
      values.input + values.cacheRead + values.cacheWrite + values.output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }).total;

const effortCacheSharing = (
  config: RouterConfig,
  model: string,
): EffortCacheSharing => {
  const declarations = Object.values(config.models ?? {})
    .filter((definition) => definition.model === model)
    .map((definition) => definition.effortCacheSharing)
    .filter((value): value is EffortCacheSharing => value !== undefined);
  const unique = new Set(declarations);
  return unique.size === 1 ? (declarations[0] ?? 'unknown') : 'unknown';
};

const result = (
  accepted: boolean,
  reason: SwitchCostDiagnostic['reason'],
  horizonRequests: number,
  values: {
    stayUsd?: number | undefined;
    switchUsd?: number | undefined;
    rebuildUsd?: number | undefined;
    steadyDeltaUsd?: number | undefined;
    confidenceOverride?: boolean | undefined;
  } = {},
): SwitchPolicyResult => ({
  accepted,
  diagnostic: {
    reason,
    horizonRequests,
    ...(values.stayUsd !== undefined ? { stayUsd: values.stayUsd } : {}),
    ...(values.switchUsd !== undefined ? { switchUsd: values.switchUsd } : {}),
    ...(values.rebuildUsd !== undefined
      ? { rebuildUsd: values.rebuildUsd }
      : {}),
    ...(values.steadyDeltaUsd !== undefined
      ? { steadyDeltaUsd: values.steadyDeltaUsd }
      : {}),
    ...(values.stayUsd !== undefined && values.switchUsd !== undefined
      ? { incrementalUsd: values.switchUsd - values.stayUsd }
      : {}),
    confidenceOverride: values.confidenceOverride ?? false,
  },
});

/** Catalog estimates guide model switches; they are not cache-hit promises or billing. */
export const evaluateSwitch = (
  input: SwitchPolicyInput,
): SwitchPolicyResult => {
  const { current, proposed, currentModel, proposedModel, config } = input;
  const policy = config.switchPolicy ?? {
    horizonRequests: 5,
    costSensitivity: 0.5,
    strongAdviceConfidence: 0.9,
  };
  const horizon = policy.horizonRequests;
  const sameModel =
    currentModel.provider === proposedModel.provider &&
    currentModel.id === proposedModel.id;
  const sameEffort = sameModel && current.thinking === proposed.thinking;
  if (sameEffort) return result(true, 'same-route', horizon);

  const effortOnly = sameModel;
  const sharing = effortOnly
    ? effortCacheSharing(config, `${currentModel.provider}/${currentModel.id}`)
    : 'separate';
  if (effortOnly && sharing === 'shared')
    return result(true, 'effort-cache-shared', horizon, { rebuildUsd: 0 });
  if (effortOnly && sharing === 'unknown')
    return result(true, 'effort-cache-unknown', horizon);

  if (
    ![input.contextTokens, input.outputTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    return result(true, 'cost-unknown', horizon);
  const inputTokens = input.contextTokens;
  const outputTokens = input.outputTokens;
  if (
    inputTokens === 0 ||
    !priceable(currentModel, inputTokens) ||
    !priceable(proposedModel, inputTokens)
  )
    return result(true, 'cost-unknown', horizon);

  const observed = input.previousGeneration;
  const observedInput = observed
    ? observed.inputTokens +
      observed.cacheReadTokens +
      observed.cacheWriteTokens
    : 0;
  const warmShare =
    observed && observedInput > 0
      ? Math.min(1, observed.cacheReadTokens / observedInput)
      : 1;
  const warmTokens = Math.floor(inputTokens * warmShare);
  const newTokens = inputTokens - warmTokens;
  const currentSteadyUsd = cost(currentModel, {
    input: newTokens,
    output: outputTokens,
    cacheRead: warmTokens,
    cacheWrite: 0,
  });
  const stayUsd = horizon * currentSteadyUsd;
  const targetSteadyUsd = cost(proposedModel, {
    input: newTokens,
    output: outputTokens,
    cacheRead: warmTokens,
    cacheWrite: 0,
  });
  const coldRequestUsd = Math.max(
    cost(proposedModel, {
      input: inputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
    }),
    cost(proposedModel, {
      input: 0,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: inputTokens,
    }),
  );
  const switchUsd = coldRequestUsd + (horizon - 1) * targetSteadyUsd;
  const rebuildUsd = Math.max(0, coldRequestUsd - targetSteadyUsd);
  const steadyDeltaUsd = horizon * (targetSteadyUsd - currentSteadyUsd);
  const confidenceOverride =
    input.adviceConfidence !== undefined &&
    input.adviceConfidence >= policy.strongAdviceConfidence;
  if (confidenceOverride)
    return result(true, 'strong-advice', horizon, {
      stayUsd,
      switchUsd,
      rebuildUsd,
      steadyDeltaUsd,
      confidenceOverride: true,
    });

  const allowance = 1 + 2 * (1 - policy.costSensitivity);
  const accepted = switchUsd <= stayUsd * allowance;
  return result(accepted, accepted ? 'within-policy' : 'cost-held', horizon, {
    stayUsd,
    switchUsd,
    rebuildUsd,
    steadyDeltaUsd,
  });
};
