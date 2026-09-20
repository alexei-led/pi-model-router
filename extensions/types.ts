import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export type RouterTier = 'high' | 'medium' | 'low';
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

export interface RouterProfile {
  high?: RoutedTierConfig | undefined;
  medium?: RoutedTierConfig | undefined;
  low?: RoutedTierConfig | undefined;
}

export interface RouterConfig {
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

export interface RoutingDecision {
  profile: string;
  tier: RouterTier;
  phase: RouterPhase;
  targetProvider: string;
  targetModelId: string;
  targetLabel: string;
  reasoning: string;
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
