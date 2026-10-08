import {
  type Api,
  calculateCost,
  type Model,
  type Usage,
} from '@earendil-works/pi-ai';
import type { CacheCostShadow, GenerationDiagnostics } from './types';

const isCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;
const isCost = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;

const priced = (model: Model<Api>, input: number): boolean => {
  const tier = model.cost.tiers
    ?.filter((entry) => input > entry.inputTokensAbove)
    .sort((left, right) => right.inputTokensAbove - left.inputTokensAbove)[0];
  const rates = tier ?? model.cost;
  return (
    [rates.input, rates.output, rates.cacheRead].every(
      (rate) => isCost(rate) && rate > 0,
    ) && isCost(rates.cacheWrite)
  );
};

/** Catalog scenarios only. A zero/unknown tariff is not evidence of free generation. */
const compareCacheCosts = (
  previous: Model<Api>,
  target: Model<Api>,
  input: number,
  output: number,
): CacheCostShadow | undefined => {
  if (!priced(previous, input) || !priced(target, input)) return undefined;
  const scenarioCost = (
    model: Model<Api>,
    kind: 'input' | 'cacheRead' | 'cacheWrite',
  ) =>
    calculateCost(model, {
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      [kind]: input,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }).total;
  const allRead = (model: Model<Api>) => scenarioCost(model, 'cacheRead');
  const allNew = (model: Model<Api>) =>
    Math.max(scenarioCost(model, 'input'), scenarioCost(model, 'cacheWrite'));
  const costs = {
    stayAllReadUsd: allRead(previous),
    stayAllNewUsd: allNew(previous),
    switchAllReadUsd: allRead(target),
    switchAllNewUsd: allNew(target),
  };
  if (!Object.values(costs).every(isCost)) return undefined;
  return { previousModel: `${previous.provider}/${previous.id}`, ...costs };
};

export const observeGeneration = ({
  usage,
  target,
  previous,
  contextTruncated,
  attempts,
  reportedCostUsd,
}: {
  usage: Usage;
  target: Model<Api>;
  previous?: Model<Api> | undefined;
  contextTruncated: boolean;
  attempts: number;
  reportedCostUsd?: number | undefined;
}): GenerationDiagnostics | undefined => {
  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
  if (
    ![
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      totalInput,
      attempts,
    ].every(isCount) ||
    attempts === 0
  )
    return undefined;
  const transition = !previous
    ? 'initial'
    : previous.provider === target.provider && previous.id === target.id
      ? 'same-model'
      : 'model-switch';
  return {
    transition,
    contextTruncated,
    attempts,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    reportedCostUsd:
      isCost(reportedCostUsd) &&
      (reportedCostUsd > 0 || priced(target, totalInput))
        ? reportedCostUsd
        : undefined,
    // No TTL or prefix-equality evidence is available here. Never persist a warmth claim.
    shadow:
      previous && transition === 'model-switch' && !contextTruncated
        ? compareCacheCosts(previous, target, totalInput, usage.output)
        : undefined,
  };
};
