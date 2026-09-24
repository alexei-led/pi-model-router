import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';

// Descending routing complexity; all tier iteration and ranking derives here.
export const ROUTER_TIERS = ['high', 'medium', 'low', 'micro'] as const;
export type RouterTier = (typeof ROUTER_TIERS)[number];
export type ClassifierTier = RouterTier;
export type RouterPin = RouterTier | 'auto';
export type RouterPhase = 'planning' | 'implementation' | 'lightweight';
export type RouterPinByProfile = Partial<Record<string, RouterTier>>;
export type RouterThinkingByTier = Partial<Record<RouterTier, ThinkingLevel>>;
export type RouterThinkingByProfile = Record<string, RouterThinkingByTier>;

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
  /** Total classifier budget in ms; `DEFAULT_CLASSIFIER_TIMEOUT_MS` when omitted. */
  timeoutMs?: number | undefined;
}

export interface RoutedTierConfig {
  model: string;
  /** False for normalization defaults; omitted on legacy in-memory profiles. */
  thinkingExplicit?: boolean | undefined;
  thinking?: ThinkingLevel | undefined;
  fallbacks?: string[] | undefined;
  /** Canonical targets and exact alias metadata, in the same order as fallbacks. */
  resolvedFallbacks?: ModelDefinition[] | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  reasoning?: boolean | undefined;
  thinkingLevels?: ThinkingLevel[] | undefined;
  resolvedContextWindow?: number | undefined;
  resolvedMaxTokens?: number | undefined;
  resolvedThinkingLevels?: ThinkingLevel[] | undefined;
}

export interface JevContextConfig {
  previousTurns: number;
  maxHistoryTokens: number;
  toolResults: 'none' | 'last' | 'last-error';
  maxToolTokens: number;
}
export interface JevRetryConfig {
  /** HTTP attempts in total; 1 disables retries. */
  maxAttempts: number;
  /** First backoff delay; doubled per attempt, raised by `Retry-After`. */
  backoffMs: number;
}
export interface JevTextExcerpt {
  text: string;
  truncated: boolean;
}
export interface JevContextState {
  currentRequest: JevTextExcerpt;
  recentDialogue: (JevTextExcerpt & { role: 'user' | 'assistant' })[];
  recentToolEvidence: (JevTextExcerpt & { isError: boolean })[];
}
export interface JevContextMetrics {
  currentRequestTokens: number;
  historyTokens: number;
  toolTokens: number;
  historyTurns: number;
  toolResults: number;
  truncatedBlocks: number;
}

export interface JevConfig {
  enabled: boolean;
  apiKey: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  confidenceThreshold: number;
  probabilityThreshold: number;
  maxStateTokens: number;
  context?: JevContextConfig | undefined;
  retry?: JevRetryConfig | undefined;
  mode: 'advisory';
}

export interface JevProfileConfig {
  enabled: boolean;
}

export interface RouterProfile {
  baselineTier?: RouterTier | undefined;
  jev?: JevProfileConfig | undefined;
  high?: RoutedTierConfig | undefined;
  medium?: RoutedTierConfig | undefined;
  low?: RoutedTierConfig | undefined;
  micro?: RoutedTierConfig | undefined;
}

export type StatusLineMode = 'compact' | 'detailed';

export interface RouterConfig {
  ui?: { statusLine: StatusLineMode } | undefined;
  jev?: JevConfig | undefined;
  debug?: boolean | undefined;
  classifierModel?: ClassifierConfig | undefined;
  maxSessionBudget?: number | undefined;
  profiles: Record<string, RouterProfile>;
  models?: Record<string, ModelDefinition> | undefined;
}

export interface RouterStatusState {
  statusLine?: StatusLineMode | undefined;
  routerEnabled: boolean;
  selectedProfile: string | undefined;
  pinnedTierByProfile: RouterPinByProfile;
  lastDecision: RoutingDecision | undefined;
  lastNonRouterModel: string | undefined;
  accumulatedCost: number;
  widgetEnabled: boolean;
  maxSessionBudget: number | undefined;
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
  context: Context;
  candidates: readonly JevRouteCandidate[];
  profile: JevProfileConfig | undefined;
  /** Local fallback tier; abstention mass is assigned to it, never inferred remotely. */
  baselineTier: RouterTier;
  /** Absolute monotonic deadline supplied by the routing orchestrator. */
  routingDeadline: number;
  signal?: AbortSignal | undefined;
}

export const JEV_SELECTION_BASES = ['choice', 'probability'] as const;
export type JevSelectionBasis = (typeof JEV_SELECTION_BASES)[number];

/** Local validation codes; remote error text is never retained. */
export const JEV_RESPONSE_ISSUES = [
  'unreadable-body',
  'missing-answer',
  'unexpected-answer-type',
  'unknown-choice',
  'invalid-confidence',
  'distribution-keys',
  'distribution-sum',
  'distribution-argmax',
] as const;
export type JevResponseIssue = (typeof JEV_RESPONSE_ISSUES)[number];

export const JEV_OUTCOMES = [
  'selected',
  'uncertain',
  'invalid-response',
  'http-error',
  'network-error',
  'deadline',
  'cancelled',
  'unavailable',
  'input-too-large',
] as const;
export type JevOutcome = (typeof JEV_OUTCOMES)[number];
export interface JevDiagnostics {
  context?: JevContextMetrics | undefined;
  /** Locally generated per HTTP request, shared by reusers; never supplied by Jev. */
  requestId?: string | undefined;
  outcome: JevOutcome;
  latencyMs: number;
  startedAt?: number | undefined;
  model?: string | undefined;
  resolvedModel?: string | undefined;
  choice?: RouterTier | 'uncertain' | undefined;
  /** Acted-on tier, which a conservative probability selection can raise above `choice`. */
  selectedTier?: RouterTier | undefined;
  selectionBasis?: JevSelectionBasis | undefined;
  confidence?: number | undefined;
  probability?: number | undefined;
  /** Cumulative probability of the selected tier and every lower tier. */
  routeProbability?: number | undefined;
  threshold?: number | undefined;
  probabilityThreshold?: number | undefined;
  timeoutMs?: number | undefined;
  candidateCount?: number | undefined;
  estimatedInputTokens?: number | undefined;
  actualInputTokens?: number | undefined;
  httpStatus?: number | undefined;
  /** HTTP attempts made, including the retry of a documented transient status. */
  attempts?: number | undefined;
  responseIssue?: JevResponseIssue | undefined;
}
export interface JevResult {
  advice?: JevAdvice | undefined;
  diagnostics: JevDiagnostics;
}

/** Runtime-only shared request; never persisted. */
export interface JevFlight {
  config: JevConfig;
  promise: Promise<JevResult>;
  controller: AbortController;
  waiters: number;
}

/** Runtime-only validated decision cache. */
export interface AdvisedTurnRecord {
  policy: string;
  config: RouterConfig;
  decision: RoutingDecision;
}

/** Only allowlisted local identity and numeric diagnostics cross the adapter boundary. */
export interface JevAdvice {
  candidateId: string;
  confidence: number;
  latencyMs: number;
}

export const ROUTING_REASON_CODES = [
  'baseline',
  'pinned',
  'continuation',
  'classifier',
  'jev',
  'fallback',
  'budget',
  'legacy',
] as const;
export type RoutingReasonCode = (typeof ROUTING_REASON_CODES)[number];
export const isRoutingReasonCode = (
  value: unknown,
): value is RoutingReasonCode =>
  ROUTING_REASON_CODES.some((code) => code === value);
export type RoutingErrorClass = 'advisor-unavailable' | 'deadline';
export const ADVISOR_OUTCOMES = [
  'none',
  'bypassed',
  'jev',
  'jev-fallback',
  'classifier',
  'classifier-fallback',
] as const;
export type AdvisorOutcome = (typeof ADVISOR_OUTCOMES)[number];
export const isAdvisorOutcome = (value: unknown): value is AdvisorOutcome =>
  ADVISOR_OUTCOMES.some((outcome) => outcome === value);
/** Why a configured advisor was not asked on this decision. */
export const BYPASS_REASONS = [
  'pinned',
  'budget',
  'single-candidate',
  'tool-continuation',
  'no-user-turn',
  'turn-advised',
] as const;
export type BypassReason = (typeof BYPASS_REASONS)[number];
export const isBypassReason = (value: unknown): value is BypassReason =>
  BYPASS_REASONS.some((reason) => reason === value);

export const GENERATION_TRANSITIONS = [
  'initial',
  'same-model',
  'model-switch',
] as const;

/** Same measured token workload, hypothetical cache extremes; not a savings prediction. */
export interface CacheCostShadow {
  previousModel: string;
  stayAllReadUsd: number;
  stayAllNewUsd: number;
  switchAllReadUsd: number;
  switchAllNewUsd: number;
}

/** Last terminal attempt's counters; reported cost sums all observed attempts. */
export interface GenerationDiagnostics {
  transition: (typeof GENERATION_TRANSITIONS)[number];
  contextTruncated: boolean;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reportedCostUsd?: number | undefined;
  shadow?: CacheCostShadow | undefined;
}

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
  advisor?: AdvisorOutcome | undefined;
  bypassReason?: BypassReason | undefined;
  jev?: JevDiagnostics | undefined;
  generation?: GenerationDiagnostics | undefined;
  reuse?: 'same-turn' | 'shared' | 'continuation' | undefined;
  thinking: ThinkingLevel;
  timestamp: number;
  isClassifier?: boolean | undefined;
  isFallback?: boolean | undefined;
  isBudgetForced?: boolean | undefined;
  /** Every model in the generation chain failed; no content was produced. */
  isGenerationFailed?: boolean | undefined;
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
  ui?: unknown;
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
