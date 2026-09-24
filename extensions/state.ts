import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  isObjectRecord,
  isRouterTier,
  isThinkingLevel,
  parseCanonicalModelRef,
} from './config';
import type {
  CacheCostShadow,
  GenerationDiagnostics,
  JevContextMetrics,
  JevDiagnostics,
  PersistedStateInput,
  RouterLastProfileState,
  RouterPersistedState,
  RouterPinByProfile,
  RoutingDecision,
} from './types';
import {
  GENERATION_TRANSITIONS,
  isAdvisorOutcome,
  isBypassReason,
  isRoutingReasonCode,
  JEV_OUTCOMES,
  JEV_RESPONSE_ISSUES,
  JEV_SELECTION_BASES,
} from './types';

const LAST_PROFILE_STATE_FILE = 'model-router-state.json';

const isPhase = (value: unknown) =>
  value === 'planning' || value === 'implementation' || value === 'lightweight';
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isModelRef = (value: unknown) => {
  if (typeof value !== 'string') return false;
  try {
    parseCanonicalModelRef(value);
    return true;
  } catch {
    return false;
  }
};

// Historical snapshots remain readable, but obsolete prompt-derived sources
// are sanitized to `legacy` and never become live routing behavior again.
const OBSOLETE_REASON_CODES = new Set([
  'custom-rule',
  'micro-mechanical',
  'heuristic',
  'safety-floor',
  'budget-floor-conflict',
]);
const isPersistedReasonCode = (value: unknown): boolean =>
  isRoutingReasonCode(value) ||
  (typeof value === 'string' && OBSOLETE_REASON_CODES.has(value));

const isDecision = (value: unknown): value is RoutingDecision =>
  isObjectRecord(value) &&
  isRouterTier(value.tier) &&
  isPhase(value.phase) &&
  isThinkingLevel(value.thinking) &&
  isFiniteNumber(value.timestamp) &&
  ['profile', 'targetProvider', 'targetModelId', 'targetLabel'].every(
    (key) => typeof value[key] === 'string',
  ) &&
  (value.reasonCode === undefined
    ? typeof value.reasoning === 'string'
    : isPersistedReasonCode(value.reasonCode)) &&
  (value.advisor === undefined || isAdvisorOutcome(value.advisor)) &&
  ['isClassifier', 'isFallback', 'isBudgetForced', 'isGenerationFailed'].every(
    (key) => value[key] === undefined || typeof value[key] === 'boolean',
  );
const isMap = (value: unknown, validate: (entry: unknown) => boolean) =>
  isObjectRecord(value) &&
  Object.entries(value).every(
    ([key, entry]) => key !== '__proto__' && validate(entry),
  );

export const isRouterLastProfileState = (
  value: unknown,
): value is RouterLastProfileState =>
  isObjectRecord(value) &&
  typeof value.selectedProfile === 'string' &&
  value.selectedProfile.length > 0 &&
  typeof value.timestamp === 'number';

export const loadLastRouterProfile = (
  agentDir = getAgentDir(),
): string | undefined => {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(agentDir, LAST_PROFILE_STATE_FILE), 'utf8'),
    );
    return isRouterLastProfileState(value) ? value.selectedProfile : undefined;
  } catch {
    return undefined;
  }
};

export const saveLastRouterProfile = (
  selectedProfile: string,
  agentDir = getAgentDir(),
): boolean => {
  const state: RouterLastProfileState = {
    selectedProfile,
    timestamp: Date.now(),
  };
  try {
    writeFileSync(
      join(agentDir, LAST_PROFILE_STATE_FILE),
      `${JSON.stringify(state, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
};

export const isRouterPersistedState = (
  value: unknown,
): value is RouterPersistedState => {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.enabled === 'boolean' &&
    typeof value.selectedProfile === 'string' &&
    isFiniteNumber(value.timestamp) &&
    (value.pinTier === undefined || isRouterTier(value.pinTier)) &&
    (value.pinByProfile === undefined ||
      isMap(value.pinByProfile, isRouterTier)) &&
    (value.thinkingByProfile === undefined ||
      isMap(
        value.thinkingByProfile,
        (tiers) =>
          isObjectRecord(tiers) &&
          Object.entries(tiers).every(
            ([tier, level]) => isRouterTier(tier) && isThinkingLevel(level),
          ),
      )) &&
    (value.lastDecision === undefined || isDecision(value.lastDecision)) &&
    (value.debugHistory === undefined ||
      (Array.isArray(value.debugHistory) &&
        value.debugHistory.every(isDecision))) &&
    (value.lastPhase === undefined || isPhase(value.lastPhase)) &&
    (value.lastNonRouterModel === undefined ||
      isModelRef(value.lastNonRouterModel)) &&
    (value.accumulatedCost === undefined ||
      (isFiniteNumber(value.accumulatedCost) && value.accumulatedCost >= 0)) &&
    ['debugEnabled', 'widgetEnabled'].every(
      (key) => value[key] === undefined || typeof value[key] === 'boolean',
    )
  );
};

const snapshotContextMetrics = (
  value: unknown,
): JevContextMetrics | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const result: JevContextMetrics = {
    currentRequestTokens: 0,
    historyTokens: 0,
    toolTokens: 0,
    historyTurns: 0,
    toolResults: 0,
    truncatedBlocks: 0,
  };
  for (const key of Object.keys(result) as (keyof JevContextMetrics)[]) {
    const number = value[key];
    if (!isFiniteNumber(number) || !Number.isSafeInteger(number) || number < 0)
      return undefined;
    result[key] = number;
  }
  return result;
};

const snapshotJev = (value: unknown): JevDiagnostics | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const outcome = JEV_OUTCOMES.find((entry) => entry === value.outcome);
  if (!outcome || !isFiniteNumber(value.latencyMs) || value.latencyMs < 0)
    return undefined;
  const result: JevDiagnostics = { outcome, latencyMs: value.latencyMs };
  const context = snapshotContextMetrics(value.context);
  if (context) result.context = context;
  if (
    typeof value.requestId === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.requestId)
  )
    result.requestId = value.requestId;
  if (
    typeof value.model === 'string' &&
    /^(?:jev-latest|jev-\d+(?:\.\d+){1,3})$/.test(value.model)
  )
    result.model = value.model;
  if (
    typeof value.resolvedModel === 'string' &&
    /^jev-\d+(?:\.\d+){1,3}$/.test(value.resolvedModel)
  )
    result.resolvedModel = value.resolvedModel;
  if (isRouterTier(value.choice) || value.choice === 'uncertain')
    result.choice = value.choice;
  if (isRouterTier(value.selectedTier))
    result.selectedTier = value.selectedTier;
  const basis = JEV_SELECTION_BASES.find(
    (entry) => entry === value.selectionBasis,
  );
  if (basis) result.selectionBasis = basis;
  for (const key of [
    'confidence',
    'probability',
    'routeProbability',
    'threshold',
    'probabilityThreshold',
  ] as const) {
    const number = value[key];
    if (isFiniteNumber(number) && number >= 0 && number <= 1)
      result[key] = number;
  }
  const issue = JEV_RESPONSE_ISSUES.find(
    (entry) => entry === value.responseIssue,
  );
  if (issue) result.responseIssue = issue;
  for (const key of [
    'startedAt',
    'timeoutMs',
    'candidateCount',
    'estimatedInputTokens',
    'actualInputTokens',
    'httpStatus',
    'attempts',
  ] as const) {
    const number = value[key];
    if (isFiniteNumber(number) && Number.isSafeInteger(number) && number >= 0)
      result[key] = number;
  }
  return result;
};

const snapshotGeneration = (
  value: unknown,
): GenerationDiagnostics | undefined => {
  if (!isObjectRecord(value)) return undefined;
  const transition = GENERATION_TRANSITIONS.find(
    (entry) => entry === value.transition,
  );
  if (!transition || typeof value.contextTruncated !== 'boolean')
    return undefined;
  const result: GenerationDiagnostics = {
    transition,
    contextTruncated: value.contextTruncated,
    attempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const key of [
    'attempts',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
  ] as const) {
    const number = value[key];
    if (!isFiniteNumber(number) || !Number.isSafeInteger(number) || number < 0)
      return undefined;
    result[key] = number;
  }
  if (result.attempts === 0) return undefined;
  if (isFiniteNumber(value.reportedCostUsd) && value.reportedCostUsd >= 0)
    result.reportedCostUsd = value.reportedCostUsd;
  const shadow = value.shadow;
  if (
    isObjectRecord(shadow) &&
    typeof shadow.previousModel === 'string' &&
    isModelRef(shadow.previousModel)
  ) {
    const copy: CacheCostShadow = {
      previousModel: shadow.previousModel,
      stayAllReadUsd: 0,
      stayAllNewUsd: 0,
      switchAllReadUsd: 0,
      switchAllNewUsd: 0,
    };
    for (const key of [
      'stayAllReadUsd',
      'stayAllNewUsd',
      'switchAllReadUsd',
      'switchAllNewUsd',
    ] as const) {
      const number = shadow[key];
      if (!isFiniteNumber(number) || number < 0) return result;
      copy[key] = number;
    }
    if (transition === 'model-switch' && !result.contextTruncated)
      result.shadow = copy;
  }
  return result;
};

// Copy only the decision contract, never incidental runtime properties.
export const snapshotDecision = (
  decision: RoutingDecision,
): RoutingDecision => ({
  profile: decision.profile,
  tier: decision.tier,
  phase: decision.phase,
  targetProvider: decision.targetProvider,
  targetModelId: decision.targetModelId,
  targetLabel: decision.targetLabel,
  reasonCode: isRoutingReasonCode(decision.reasonCode)
    ? decision.reasonCode
    : 'legacy',
  routingLatencyMs:
    isFiniteNumber(decision.routingLatencyMs) && decision.routingLatencyMs >= 0
      ? decision.routingLatencyMs
      : undefined,
  errorClass:
    decision.errorClass === 'advisor-unavailable' ||
    decision.errorClass === 'deadline'
      ? decision.errorClass
      : undefined,
  advisor: isAdvisorOutcome(decision.advisor) ? decision.advisor : undefined,
  bypassReason: isBypassReason(decision.bypassReason)
    ? decision.bypassReason
    : undefined,
  jev: snapshotJev(decision.jev),
  generation: snapshotGeneration(decision.generation),
  reuse:
    decision.reuse === 'same-turn' ||
    decision.reuse === 'shared' ||
    decision.reuse === 'continuation'
      ? decision.reuse
      : undefined,
  thinking: decision.thinking,
  timestamp: decision.timestamp,
  isClassifier: decision.isClassifier,
  isFallback: decision.isFallback,
  isBudgetForced: decision.isBudgetForced,
  isGenerationFailed: decision.isGenerationFailed,
});

export const buildPersistedState = ({
  routerEnabled,
  selectedProfile,
  pinnedTierByProfile,
  thinkingByProfile,
  debugEnabled,
  widgetEnabled,
  debugHistory,
  lastDecision,
  lastNonRouterModel,
  accumulatedCost,
}: PersistedStateInput): RouterPersistedState => {
  const pinByProfile: RouterPinByProfile = {};
  for (const [profile, tier] of Object.entries(pinnedTierByProfile)) {
    if (tier) pinByProfile[profile] = tier;
  }
  return structuredClone({
    enabled: routerEnabled,
    selectedProfile: selectedProfile ?? '',
    ...(selectedProfile &&
    Object.hasOwn(pinnedTierByProfile, selectedProfile) &&
    pinnedTierByProfile[selectedProfile]
      ? { pinTier: pinnedTierByProfile[selectedProfile] }
      : {}),
    pinByProfile,
    thinkingByProfile: { ...thinkingByProfile },
    debugEnabled,
    widgetEnabled,
    debugHistory: debugHistory.map(snapshotDecision),
    lastPhase: lastDecision?.phase,
    lastDecision: lastDecision ? snapshotDecision(lastDecision) : undefined,
    lastNonRouterModel,
    accumulatedCost,
    timestamp: Date.now(),
  });
};
