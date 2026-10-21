import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  ClassifierApi,
  ClassifierModel,
  Context,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

// Descending routing complexity; all tier iteration and ranking derives here.
export const ROUTER_TIERS = ['high', 'medium', 'low', 'micro'] as const;
export type RouterTier = (typeof ROUTER_TIERS)[number];
export const ROUTER_ACTIVITIES = [
  'code',
  'debug',
  'explore',
  'plan',
  'review',
  'ops',
  'docs',
] as const;
export type RouterActivity = (typeof ROUTER_ACTIVITIES)[number];
export type ActivityRouting = 'on' | 'off';
export type RouterPin = RouterTier | 'auto';
export type RouterPinByProfile = Partial<Record<string, RouterTier>>;
export type RouterThinkingByTier = Partial<Record<RouterTier, ThinkingLevel>>;
export type RouterThinkingByProfile = Record<string, RouterThinkingByTier>;

export type EffortCacheSharing = 'shared' | 'separate' | 'unknown';

export interface ModelDefinition {
  model: string;
  effortCacheSharing?: EffortCacheSharing | undefined;
  contextWindow?: number | undefined;
  maxTokens?: number | undefined;
  reasoning?: boolean | undefined;
  thinkingLevels?: ThinkingLevel[] | undefined;
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
}

export interface ClassifierContextConfig {
  previousTurns: number;
  maxHistoryTokens: number;
  toolResults: 'none' | 'last' | 'last-error' | 'recent';
  maxToolTokens: number;
  currentLoopMessages: number;
}
export interface ClassifierTextExcerpt {
  text: string;
  truncated: boolean;
}
export interface ClassifierContextState {
  currentRequest: ClassifierTextExcerpt;
  recentDialogue: (ClassifierTextExcerpt & { role: 'user' | 'assistant' })[];
  recentToolEvidence: (ClassifierTextExcerpt & { isError: boolean })[];
}
export interface ClassifierContextMetrics {
  currentRequestTokens: number;
  historyTokens: number;
  toolTokens: number;
  historyTurns: number;
  toolResults: number;
  truncatedBlocks: number;
}

export interface AdvisorConfig {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  reviewEveryRequests: number;
  confidenceThreshold: number;
  probabilityThreshold: number;
  maxStateTokens: number;
  context?: ClassifierContextConfig | undefined;
  maxRetries: number;
  temperature?: number | undefined;
}

export interface ClassifierRegistry {
  findOfType: (
    type: 'classifier',
    provider: string,
    id: string,
  ) => ClassifierModel<ClassifierApi> | undefined;
  classify: ExtensionContext['modelRegistry']['classify'];
}
export interface CapabilityCriterion {
  covers: string;
  useWhen?: readonly string[];
  notFor: readonly string[];
  examples: readonly string[];
}

export interface AdvisorProfileConfig {
  /** Explicit user-owned consent for these exact classifier references. */
  models: string[];
}

export interface RouterProfile {
  /** Effective, re-normalized sparse overrides; omitted tiers use the generic cell. */
  activities?:
    | Partial<
        Record<RouterActivity, Partial<Record<RouterTier, RoutedTierConfig>>>
      >
    | undefined;
  baselineTier?: RouterTier | undefined;
  advisor?: AdvisorProfileConfig | undefined;
  high?: RoutedTierConfig | undefined;
  medium?: RoutedTierConfig | undefined;
  low?: RoutedTierConfig | undefined;
  micro?: RoutedTierConfig | undefined;
}

export type StatusLineMode = 'compact' | 'detailed';

export interface RouterSwitchPolicy {
  horizonRequests: number;
  costSensitivity: number;
  strongAdviceConfidence: number;
  /** Further user turns a repeated-failure escalation holds its floor. */
  escalationHoldTurns: number;
}

export interface RouterConfig {
  activityRouting?: ActivityRouting | undefined;
  switchPolicy?: RouterSwitchPolicy | undefined;
  ui?: { statusLine: StatusLineMode } | undefined;
  advisor?: AdvisorConfig | undefined;
  debug?: boolean | undefined;
  maxSessionBudget?: number | undefined;
  profiles: Record<string, RouterProfile>;
  models?: Record<string, ModelDefinition> | undefined;
}

export interface RoutePair {
  tier: RouterTier;
  model: string;
  thinking: ThinkingLevel;
}

export interface RouteRecommendation extends RoutePair {
  activity?: RouterActivity | undefined;
}

export interface RouteCandidate extends RoutePair {
  id: string;
}

/** A local matrix cell and its ordered, prevalidated physical attempts. Runtime only. */
export interface RoutePlan {
  readonly id: string;
  readonly tier: RouterTier;
  readonly cell: RouterActivity | undefined;
  readonly config: Readonly<RoutedTierConfig>;
  readonly attempts: readonly [Readonly<RoutePair>, ...Readonly<RoutePair>[]];
  readonly thinkingOverrides: Readonly<RouterThinkingByTier> | undefined;
}
export interface ActivityCandidate {
  activity: RouterActivity;
  candidate: RouteCandidate;
}

export interface ClassifierDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ClassifierRequest {
  context: Context;
  candidates: readonly RouteCandidate[];
  /** Present only when eligible activity cells change the physical attempt plan. */
  activityCandidates?: readonly ActivityCandidate[] | undefined;
  /** A single tier with several activity plans needs only the activity answer. */
  askRoute?: boolean | undefined;
  profile: AdvisorProfileConfig | undefined;
  /** Local fallback tier; abstention mass is assigned to it, never inferred remotely. */
  baselineTier: RouterTier;
  /** Absolute monotonic deadline supplied by the routing orchestrator. */
  routingDeadline: number;
  signal?: AbortSignal | undefined;
}

export const CLASSIFIER_SELECTION_BASES = ['choice', 'probability'] as const;
export type ClassifierSelectionBasis =
  (typeof CLASSIFIER_SELECTION_BASES)[number];

/** Local validation codes; remote error text is never retained. */
export const CLASSIFIER_RESPONSE_ISSUES = [
  'unreadable-body',
  'missing-answer',
  'unexpected-answer-type',
  'unknown-choice',
  'invalid-confidence',
  'distribution-keys',
  'distribution-sum',
  'distribution-argmax',
] as const;
export type ClassifierResponseIssue =
  (typeof CLASSIFIER_RESPONSE_ISSUES)[number];

export const CLASSIFIER_OUTCOMES = [
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
export type ClassifierOutcome = (typeof CLASSIFIER_OUTCOMES)[number];
export interface ClassifierDiagnostics {
  activity?: RouterActivity | 'uncertain' | undefined;
  activityConfidence?: number | undefined;
  activityOutcome?: 'selected' | 'uncertain' | 'invalid-response' | undefined;
  activityResponseIssue?: ClassifierResponseIssue | undefined;
  context?: ClassifierContextMetrics | undefined;
  /** Locally generated per classify call, shared by reusers; never supplied remotely. */
  requestId?: string | undefined;
  outcome: ClassifierOutcome;
  latencyMs: number;
  startedAt?: number | undefined;
  model?: string | undefined;
  choice?: RouterTier | 'uncertain' | undefined;
  /** Acted-on tier, which a conservative probability selection can raise above `choice`. */
  selectedTier?: RouterTier | undefined;
  selectionBasis?: ClassifierSelectionBasis | undefined;
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
  actualOutputTokens?: number | undefined;
  costUsd?: number | undefined;
  httpStatus?: number | undefined;
  /** HTTP calls observed through the Pi fetch hook; may include retries or several question requests. */
  attempts?: number | undefined;
  responseIssue?: ClassifierResponseIssue | undefined;
}
export interface ClassifierResult {
  advice?: ClassifierAdvice | undefined;
  diagnostics: ClassifierDiagnostics;
}

/** Only allowlisted local identity and numeric diagnostics cross the adapter boundary. */
export interface ClassifierAdvice {
  activity?: RouterActivity | undefined;
  candidateId: string;
  confidence: number;
  latencyMs: number;
}

export const ROUTING_REASON_CODES = [
  'baseline',
  'pinned',
  'continuation',
  'classifier',
  'fallback',
  'budget',
  'escalation',
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

export const SWITCH_COST_REASONS = [
  'same-route',
  'effort-cache-shared',
  'effort-cache-unknown',
  'within-policy',
  'strong-advice',
  'cost-held',
  'cost-unknown',
] as const;
export const ADVICE_SOURCES = ['initial', 'review'] as const;
export type AdviceSource = (typeof ADVICE_SOURCES)[number];

export interface SwitchCostDiagnostic {
  reason: (typeof SWITCH_COST_REASONS)[number];
  horizonRequests: number;
  stayUsd?: number | undefined;
  switchUsd?: number | undefined;
  incrementalUsd?: number | undefined;
  /** Estimated first-request premium, separate from generation totals. */
  rebuildUsd?: number | undefined;
  steadyDeltaUsd?: number | undefined;
  confidenceOverride: boolean;
}

export interface RoutingDecision {
  /** Classifier terminal observation only; never an observed generation. */
  reviewOnly?: boolean | undefined;
  adviceSource?: AdviceSource | undefined;
  /** Validated semantic answer, independent of the local cell used for availability. */
  activity?: RouterActivity | undefined;
  /** Local cell provenance, not an inferred activity. Omitted means generic. */
  routeCell?: RouterActivity | undefined;
  profile: string;
  tier: RouterTier;
  targetProvider: string;
  targetModelId: string;
  targetLabel: string;
  reasonCode: RoutingReasonCode;
  /** Tier selected before a repeated-failure escalation raised it. */
  escalatedFrom?: RouterTier | undefined;
  routingLatencyMs?: number | undefined;
  errorClass?: RoutingErrorClass | undefined;
  advisor?: AdvisorOutcome | undefined;
  bypassReason?: BypassReason | undefined;
  classification?: ClassifierDiagnostics | undefined;
  generation?: GenerationDiagnostics | undefined;
  proposedRoute?: RouteRecommendation | undefined;
  switchCost?: SwitchCostDiagnostic | undefined;
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
  ownerSessionId?: string | undefined;
  enabled: boolean;
  selectedProfile: string;
  pinTier?: RouterTier | undefined;
  pinByProfile?: RouterPinByProfile | undefined;
  thinkingByProfile?: RouterThinkingByProfile | undefined;
  debugEnabled?: boolean | undefined;
  widgetEnabled?: boolean | undefined;
  debugHistory?: RoutingDecision[] | undefined;
  lastDecision?: RoutingDecision | undefined;
  lastNonRouterModel?: string | undefined;
  accumulatedCost?: number | undefined;
  timestamp: number;
}

export interface RawRouterConfig {
  activityRouting?: unknown;
  switchPolicy?: unknown;
  ui?: unknown;
  advisor?: unknown;
  debug?: unknown;
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

export type RouterUIAdvisorId = string;
export const ROUTER_UI_VIEWS = [
  'now',
  'routes',
  'classifier',
  'usage',
  'settings',
] as const;
export type RouterUIView = (typeof ROUTER_UI_VIEWS)[number];
export type RouterUILifecycle =
  | 'choosing'
  | 'generating'
  | 'continuation'
  | 'timeout'
  | 'fallback'
  | 'budget'
  | 'cancelled'
  | 'failed'
  | 'off'
  | 'idle';

/** Flat fields make compare-and-set undo independent of unrelated edits. */
export interface RouterUIControls {
  pin: RouterPin;
  baseline: RouterPin;
  budget: number | undefined;
  advisor: RouterUIAdvisorId | undefined;
  timeout: number;
  reviewEveryRequests: number;
  costHorizon: number;
  costSensitivity: number;
  strongAdviceConfidence: number;
  thinkingHigh: ThinkingLevel | undefined;
  thinkingMedium: ThinkingLevel | undefined;
  thinkingLow: ThinkingLevel | undefined;
  thinkingMicro: ThinkingLevel | undefined;
}
export type RouterUIControlChange = {
  [K in keyof RouterUIControls]: {
    key: K;
    before: RouterUIControls[K];
    after: RouterUIControls[K];
  };
}[keyof RouterUIControls];
export interface RouterUIControlTransaction {
  profile: string;
  action: 'apply' | 'undo';
  changes: readonly RouterUIControlChange[];
}
export interface RouterUIRoute {
  activity?: RouterActivity | undefined;
  routeCell?: RouterActivity | undefined;
  tier: RouterTier;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
}
/** Effective configured override, not advice or an observed generation. */
export type RouterUIActivityCell = {
  activity: RouterActivity;
  configured: Readonly<RoutePair>;
  fallbacks: readonly string[];
} & (
  | {
      availability: 'eligible';
      /** First currently text-capable attempt; request input/context/auth are not checked here. */
      eligible: RouterUIRoute;
    }
  | {
      availability: 'unavailable' | 'unknown' | 'disabled';
      eligible?: undefined;
    }
);
export interface RouterUIChatModel {
  /** Canonical physical chat target; logical router models are excluded. */
  model: string;
  name: string;
  efforts: readonly ThinkingLevel[];
}
export interface RouterUIRouteCellState {
  state: 'inherited' | 'override' | 'missing';
  /** Opaque CAS token for normalized capability metadata; never rendered. */
  revision?: string | undefined;
  model?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  fallbacks: readonly string[];
}
export interface RouterUIRouteCell {
  activity: RouterActivity;
  tier: RouterTier;
  /** Current effective profile configuration, before queued UI changes. */
  current: RouterUIRouteCellState;
  /** Next-user-boundary route value, when a transaction is already queued. */
  pending?: RouterUIRouteCellState | undefined;
  /** Configured generic route used by reset-to-generic. */
  generic: RouterUIRouteCellState;
  /** Effective mapped effort under the active all-activity tier override. */
  effectiveThinking?: ThinkingLevel | undefined;
  /** Effective effort after any queued control changes are activated. */
  pendingEffectiveThinking?: ThinkingLevel | undefined;
  /** Tier-wide session override, if one currently applies to this cell. */
  tierEffortOverride?: ThinkingLevel | undefined;
  /** Tier-wide override that will apply after queued controls activate. */
  pendingTierEffortOverride?: ThinkingLevel | undefined;
}
export interface RouterUIRouteSelection {
  model: string;
  thinking: ThinkingLevel;
  /** Ordered target fallback chain retained by the editor. */
  fallbacks?: readonly string[] | undefined;
}
export interface RouterUIRouteCellChange {
  activity: RouterActivity;
  tier: RouterTier;
  before: RouterUIRouteCellState;
  /** Undefined removes the sparse cell override and restores generic inheritance. */
  after: RouterUIRouteSelection | undefined;
}
export interface RouterUIRouteTransaction {
  profile: string;
  changes: readonly RouterUIRouteCellChange[];
}
export interface RouterUIAdviceObservation {
  profile?: string | undefined;
  source?: AdviceSource | undefined;
  advisor: RouterUIAdvisorId;
  requestId?: string | undefined;
  outcome: ClassifierOutcome;
  latencyMs?: number | undefined;
  httpAttempts?: number | undefined;
  costUsd?: number | undefined;
}
export interface RouterUIHistoryEntry {
  reason?: RoutingReasonCode | undefined;
  reviewOnly?: boolean | undefined;
  actual?: RouterUIRoute | undefined;
  proposed?: RouterUIRoute | undefined;
  switchCost?: SwitchCostDiagnostic | undefined;
  advice?: RouterUIAdviceObservation | undefined;
  reuse?: RoutingDecision['reuse'];
  /** Cost for this observation only; reuses must not repeat an earlier cost. */
  generationCostUsd?: number | undefined;
  generationAttempts?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}
/** Presentation only: no credentials, transcript text or remote explanations. */
export interface RouterUISnapshot {
  profile: string;
  lifecycle: RouterUILifecycle;
  /** Recorded catalog costs only, not a complete billing ledger. */
  accumulatedCost?: number | undefined;
  classifiers: readonly { model: string; name: string; textInput: boolean }[];
  /** Physical chat targets only; excludes logical router recursion and auth data. */
  chatModels: readonly RouterUIChatModel[];
  reuse?: RoutingDecision['reuse'];
  bypassReason?: BypassReason | undefined;
  reason?: RoutingReasonCode | undefined;
  failure?: 'request-failed' | undefined;
  actual?: RouterUIRoute | undefined;
  advised?: RouterUIRoute | undefined;
  switchCost?: SwitchCostDiagnostic | undefined;
  advice?: RouterUIAdviceObservation | undefined;
  lastAdvice?: RouterUIAdviceObservation | undefined;
  loggingEnabled: boolean;
  controls: Readonly<RouterUIControls>;
  pendingControls?: Readonly<RouterUIControls> | undefined;
  pendingRoutes?: boolean | undefined;
  eligible: Readonly<Partial<Record<RouterTier, RouterUIRoute>>>;
  activityRouting: ActivityRouting;
  activityCells: readonly RouterUIActivityCell[];
  routeCells: readonly RouterUIRouteCell[];
  privacy: {
    advisorEnabled: boolean;
    approvedModels: readonly string[];
    /** Public host capability only; not backend-login attestation. */
    auth: 'available' | 'unavailable' | 'unknown';
  };
  /** Active-branch retained decisions, not a session ledger; UI caps at 50.
   * Replace the array when observations change; keep its identity on token refreshes. */
  history: readonly RouterUIHistoryEntry[];
}
export interface RouterUIAdapters {
  getSnapshot: () => RouterUISnapshot;
  /** Atomically compare all before values; reject conflicts; queue next-user-turn controls. */
  applyControls: (
    transaction: RouterUIControlTransaction,
  ) => Promise<'applied' | 'conflict'>;
  /** Compare-and-set sparse per-cell route edits; changes stay pending until a user boundary. */
  applyRoutes: (
    transaction: RouterUIRouteTransaction,
  ) => Promise<'applied' | 'conflict' | 'invalid'>;
  subscribe: (refresh: () => void) => () => void;
  /** Abort on session replacement/reload/shutdown to complete and dispose the inspector. */
  signal?: AbortSignal | undefined;
}

export interface RouterUIPreferences {
  widgetEnabled: boolean;
  statusLine?: StatusLineMode | undefined;
}

/** Runtime-only observations. They must never affect generation or enter snapshots. */
export interface RouterRequestObservation {
  stage: 'selected' | 'generating' | 'complete' | 'cancelled' | 'failed';
  decision?: RoutingDecision | undefined;
}
export interface RouterUIPendingControls {
  base: RouterUIControls;
  value: RouterUIControls;
}
export interface RouterUIRuntimeState {
  currentConfig: RouterConfig;
  readonly accumulatedCost?: number | undefined;
  readonly selectedProfile: string | undefined;
  readonly routerEnabled: boolean;
  readonly pinnedTierByProfile: RouterPinByProfile;
  readonly thinkingByProfile: RouterThinkingByProfile;
  readonly lastDecision: RoutingDecision | undefined;
  readonly debugHistory: readonly RoutingDecision[];
  readonly debugEnabled?: boolean;
  readonly currentModelRegistry:
    | Pick<ExtensionContext['modelRegistry'], 'find' | 'getModelsOfType'>
    | undefined;
}
