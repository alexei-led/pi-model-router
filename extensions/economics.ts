import type { Api, Model, Usage } from '@earendil-works/pi-ai';
import type { CacheCostShadow, GenerationDiagnostics } from './types';

const isCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;
const isCost = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;

const priced = (model: Model<Api>): boolean =>
  [model.cost.input, model.cost.output, model.cost.cacheRead].every(
    (rate) => isCost(rate) && rate > 0,
  ) && isCost(model.cost.cacheWrite);

/** Catalog scenarios only. A zero/unknown tariff is not evidence of free generation. */
const compareCacheCosts = (
  previous: Model<Api>,
  target: Model<Api>,
  input: number,
  output: number,
): CacheCostShadow | undefined => {
  if (!priced(previous) || !priced(target)) return undefined;
  const allRead = (model: Model<Api>) =>
    (input * model.cost.cacheRead + output * model.cost.output) / 1e6;
  const allNew = (model: Model<Api>) =>
    (input * Math.max(model.cost.input, model.cost.cacheWrite) +
      output * model.cost.output) /
    1e6;
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
      isCost(reportedCostUsd) && (reportedCostUsd > 0 || priced(target))
        ? reportedCostUsd
        : undefined,
    // No TTL or prefix-equality evidence is available here. Never persist a warmth claim.
    shadow:
      previous && transition === 'model-switch' && !contextTruncated
        ? compareCacheCosts(previous, target, totalInput, usage.output)
        : undefined,
  };
};
