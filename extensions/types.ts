import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

// Descending routing complexity; all tier iteration and ranking derives here.
export const ROUTER_TIERS = ['high', 'medium', 'low', 'micro'] as const;
export type RouterTier = (typeof ROUTER_TIERS)[number];
export type ClassifierTier = Exclude<RouterTier, 'micro'>;
export type RouterPin = RouterTier | 'auto';
export type RouterPhase = 'planning' | 'implementation' | 'lightweight';
export type RouterPinByProfile = Partial<Record<string, RouterTier>>;
export type RouterThinkingByTier = Partial<Record<RouterTier, ThinkingLevel>>;
export type RouterThinkingByProfile = Record<string, RouterThinkingByTier>;

export interface RoutingRule {
  matches: string | string[];
  tier: RouterTier;
  reason?: string | undefined;
}

export interface ModelDefinition {
  model: string;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  reasoning?: boolean | undefined;
  thinkingLevels?: ThinkingLevel[] | undefined;
}

export interface ClassifierConfig {
  model: string;
  thinking?: ThinkingLevel | undefined;
}

export interface RoutedTierConfig {
  model: string;
  /** False for normalization defaults; omitted on legacy in-memory profiles. */
  thinkingExplicit?: boolean | undefined;
  thinking?: ThinkingLevel | undefined;
  fallbacks?: string[] | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  reasoning?: boolean | undefined;
  thinkingLevels?: ThinkingLevel[] | undefined;
  resolvedContextWindow?: number | undefined;
  resolvedMaxTokens?: number | undefined;
  resolvedThinkingLevels?: ThinkingLevel[] | undefined;
}

export interface JevConfig {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  confidenceThreshold: number;
  maxStateChars: number;
  mode: 'advisory';
}

export interface JevProfileConfig {
  enabled: boolean;
}

export interface RouterProfile {
  jev?: JevProfileConfig | undefined;
  high?: RoutedTierConfig | undefined;
  medium?: RoutedTierConfig | undefined;
  low?: RoutedTierConfig | undefined;
  micro?: RoutedTierConfig | undefined;
}

export interface RouterConfig {
  jev?: JevConfig | undefined;
  debug?: boolean | undefined;
  classifierModel?: ClassifierConfig | undefined;
  phaseBias?: number | undefined;
  maxSessionBudget?: number | undefined;
  rules?: RoutingRule[] | undefined;
  profiles: Record<string, RouterProfile>;
  models?: Record<string, ModelDefinition> | undefined;
}

export interface RouterStatusState {
  routerEnabled: boolean;
  selectedProfile: string | undefined;
  pinnedTierByProfile: RouterPinByProfile;
  lastDecision: RoutingDecision | undefined;
  lastNonRouterModel: string | undefined;
  accumulatedCost: number;
  widgetEnabled: boolean;
  currentConfig: RouterConfig;
}

export interface RoutePair {
  tier: RouterTier;
  model: string;
  thinking: ThinkingLevel;
}

export interface JevRouteCandidate extends RoutePair {
  id: string;
}

export interface JevDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface JevRequest {
  taskSummary: string;
  candidates: readonly JevRouteCandidate[];
  profile: JevProfileConfig | undefined;
  /** Absolute monotonic deadline supplied by the routing orchestrator. */
  routingDeadline: number;
  signal?: AbortSignal | undefined;
}

/** Only allowlisted local identity and numeric diagnostics cross the adapter boundary. */
export interface JevAdvice {
  candidateId: string;
  confidence: number;
  latencyMs: number;
}

export const ROUTING_REASON_CODES = [
  'pinned',
  'custom-rule',
  'micro-mechanical',
  'continuation',
  'classifier',
  'jev',
  'heuristic',
  'fallback',
  'budget-floor-conflict',
  'legacy',
] as const;
export type RoutingReasonCode = (typeof ROUTING_REASON_CODES)[number];
export const isRoutingReasonCode = (
  value: unknown,
): value is RoutingReasonCode =>
  ROUTING_REASON_CODES.some((code) => code === value);
export type RoutingErrorClass = 'advisor-unavailable' | 'deadline';

export interface RoutingDecision {
  profile: string;
  tier: RouterTier;
  phase: RouterPhase;
  targetProvider: string;
  targetModelId: string;
  targetLabel: string;
  reasonCode: RoutingReasonCode;
  routingLatencyMs?: number | undefined;
  errorClass?: RoutingErrorClass | undefined;
  thinking: ThinkingLevel;
  timestamp: number;
  isClassifier?: boolean | undefined;
  isFallback?: boolean | undefined;
  isBudgetForced?: boolean | undefined;
  isRuleMatched?: boolean | undefined;
}

export interface RouterLastProfileState {
  selectedProfile: string;
  timestamp: number;
}

export interface PersistedStateInput {
  routerEnabled: boolean;
  selectedProfile: string | undefined;
  pinnedTierByProfile: RouterPinByProfile;
  thinkingByProfile: RouterThinkingByProfile;
  debugEnabled: boolean;
  widgetEnabled: boolean;
  debugHistory: RoutingDecision[];
  lastDecision: RoutingDecision | undefined;
  lastNonRouterModel: string | undefined;
  accumulatedCost: number;
}

export interface RouterPersistedState {
  enabled: boolean;
  selectedProfile: string;
  pinTier?: RouterTier | undefined;
  pinByProfile?: RouterPinByProfile | undefined;
  thinkingByProfile?: RouterThinkingByProfile | undefined;
  debugEnabled?: boolean | undefined;
  widgetEnabled?: boolean | undefined;
  debugHistory?: RoutingDecision[] | undefined;
  lastPhase?: RouterPhase | undefined;
  lastDecision?: RoutingDecision | undefined;
  lastNonRouterModel?: string | undefined;
  accumulatedCost?: number | undefined;
  timestamp: number;
}

export interface RawRouterConfig {
  jev?: unknown;
  debug?: unknown;
  classifierModel?: unknown;
  phaseBias?: unknown;
  maxSessionBudget?: unknown;
  rules?: unknown;
  profiles?: unknown;
  models?: unknown;
}

export interface ConfigLoadResult {
  config: RouterConfig;
  warnings: string[];
}

export interface ParsedConfigFile {
  config: RawRouterConfig;
  warnings: string[];
}
