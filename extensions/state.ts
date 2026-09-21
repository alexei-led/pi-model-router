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
  PersistedStateInput,
  RouterLastProfileState,
  RouterPersistedState,
  RouterPinByProfile,
  RoutingDecision,
} from './types';
import { isAdvisorOutcome, isRoutingReasonCode } from './types';

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
  ['isClassifier', 'isFallback', 'isBudgetForced'].every(
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
  thinking: decision.thinking,
  timestamp: decision.timestamp,
  isClassifier: decision.isClassifier,
  isFallback: decision.isFallback,
  isBudgetForced: decision.isBudgetForced,
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
    ...(selectedProfile && pinnedTierByProfile[selectedProfile]
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
