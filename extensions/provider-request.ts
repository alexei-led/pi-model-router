import { createHash } from 'node:crypto';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import {
  calculateContextTokens,
  type ExtensionContext,
  estimateTokens as estimateMessageTokens,
} from '@earendil-works/pi-coding-agent';
import { createCandidate } from './choice';
import { runClassifierDetailed } from './classifier';
import { DEFAULT_CLASSIFIER_TIMEOUT_MS } from './constants';
import { hasImageAttachment } from './context';
import { parseCanonicalModelRef } from './domain';
import {
  createClassifierFlightKey,
  type ProviderTurnCache,
  waitForAbortable,
} from './provider-turns';
import {
  availableRoutePairs,
  decisionForPair,
  fitContextRoutes,
  primaryRoutePairs,
  selectBaselineRoute,
} from './routing';
import type {
  AdvisorConfig,
  ClassifierRegistry,
  ClassifierRequest,
  RoutePair,
  RouterConfig,
  RouterProfile,
  RouterThinkingByTier,
  RouterTier,
  RoutingDecision,
} from './types';

type RoutingRegistry = Pick<
  ExtensionContext['modelRegistry'],
  'find' | 'findOfType' | 'classify'
>;

export interface RouterRequestIdentity {
  turn?: string;
  branch: string[];
}

export interface PreparedRouterRequest {
  decision: RoutingDecision;
  profile: RouterProfile;
  turn?: string;
  branch: string[];
  policy: string;
  config: RouterConfig;
  toolContinuation: boolean;
  priorAssistant?: AssistantMessage;
  mustContinueGoogle: boolean;
  imageAttached: boolean;
  thinkingOverrides?: RouterThinkingByTier;
}

interface RequestRouteInput {
  profileName: string;
  profile: RouterProfile;
  config: RouterConfig;
  getCurrentConfig: () => RouterConfig;
  context: Context;
  registry: RoutingRegistry;
  identity: RouterRequestIdentity;
  pinnedTier?: RouterTier;
  thinkingOverrides?: RouterThinkingByTier;
  accumulatedCost: number;
  lastDecision: RoutingDecision | undefined;
  signal?: AbortSignal | undefined;
  cache: ProviderTurnCache;
}

export const createRouterRequestIdentity = (
  context: Context,
  sessionId: string | undefined,
  branch: readonly string[],
): RouterRequestIdentity => {
  const lastUserIndex = context.messages.findLastIndex(
    (entry) => entry.role === 'user',
  );
  const user = context.messages[lastUserIndex];
  const turn =
    user?.role === 'user' && user.timestamp > 0
      ? createHash('sha256')
          .update(
            JSON.stringify([
              sessionId,
              context.messages.slice(0, lastUserIndex + 1),
            ]),
          )
          .digest('hex')
      : undefined;
  return { ...(turn ? { turn } : {}), branch: [...branch] };
};

export const estimateRequestTokens = (context: Context): number => {
  const system = context.systemPrompt
    ? Math.ceil(context.systemPrompt.length / 4)
    : 0;
  const sizes = context.messages.map((message) =>
    estimateMessageTokens(message),
  );
  const text = system + sizes.reduce((sum, size) => sum + size, 0);
  const index = context.messages.findLastIndex(
    (message) =>
      message.role === 'assistant' &&
      message.stopReason !== 'error' &&
      message.stopReason !== 'aborted' &&
      calculateContextTokens(message.usage) > 0,
  );
  const last = context.messages[index];
  if (last?.role !== 'assistant') return text;
  const later = sizes.slice(index + 1).reduce((sum, size) => sum + size, 0);
  return Math.max(text, calculateContextTokens(last.usage) + later);
};

export const requiresGoogleContinuation = (
  message: AssistantMessage,
): boolean =>
  (message.api === 'google-generative-ai' ||
    message.api === 'google-vertex' ||
    message.api === 'google-gemini-cli') &&
  message.content.some(
    (entry) =>
      entry.type === 'thinking' ||
      (entry.type === 'toolCall' && !!entry.thoughtSignature) ||
      (entry.type === 'text' && !!entry.textSignature),
  );

const selectedRoutes = (
  profile: RouterProfile,
  registry: Pick<RoutingRegistry, 'find'>,
  context: Context,
  thinkingOverrides: RouterThinkingByTier | undefined,
  pinnedTier: RouterTier | undefined,
): {
  eligible: () => RoutePair[];
  available: () => RoutePair[];
  imageAttached: boolean;
} => {
  const imageAttached = hasImageAttachment(context);
  const eligible = () =>
    availableRoutePairs(
      profile,
      (provider, id) => registry.find(provider, id),
      imageAttached,
      thinkingOverrides,
    );
  const contextTokens = estimateRequestTokens(context);
  const windowOf = (pair: RoutePair) => {
    const { provider, modelId } = parseCanonicalModelRef(pair.model);
    return registry.find(provider, modelId)?.contextWindow;
  };
  return {
    eligible,
    available: () =>
      pinnedTier
        ? eligible()
        : fitContextRoutes(eligible(), windowOf, contextTokens),
    imageAttached,
  };
};

const canReuseContinuation = (
  input: RequestRouteInput,
  decision: RoutingDecision | undefined,
  toolContinuation: boolean,
  latestAssistant: AssistantMessage | undefined,
  latestResults: readonly Extract<
    Context['messages'][number],
    { role: 'toolResult' }
  >[],
  available: readonly RoutePair[],
  currentPolicy: string,
): boolean => {
  const record = input.identity.turn
    ? input.cache.continuationFor(input.identity.turn)
    : undefined;
  const turn = input.identity.turn;
  if (
    !toolContinuation ||
    !record ||
    !decision ||
    !turn ||
    record.turn !== turn ||
    record.policy !== currentPolicy ||
    record.config !== input.config ||
    decision.profile !== input.profileName ||
    input.identity.branch.length === 0 ||
    !input.identity.branch.every(
      (id) => typeof id === 'string' && id.length > 0,
    ) ||
    record.branch.length === 0 ||
    !record.branch.every((id, index) => input.identity.branch[index] === id) ||
    latestResults.length === 0 ||
    !latestAssistant ||
    latestAssistant.provider !== decision.targetProvider ||
    latestAssistant.model !== decision.targetModelId ||
    !latestResults.every((entry) =>
      latestAssistant.content.some(
        (part) => part.type === 'toolCall' && part.id === entry.toolCallId,
      ),
    ) ||
    !latestResults.every((entry) => record.toolCalls.has(entry.toolCallId)) ||
    !available.some(
      (pair) =>
        pair.tier === decision.tier &&
        pair.model === decision.targetLabel &&
        pair.thinking === decision.thinking,
    )
  )
    return false;
  return true;
};

const baselineDecision = (
  input: RequestRouteInput,
  pairs: readonly RoutePair[],
  pinnedTier: RouterTier | undefined,
  isBudgetExceeded: boolean,
  advisorConfigured: boolean,
  toolContinuation: boolean,
  hasUserTurn: boolean,
): RoutingDecision => {
  const baseline = selectBaselineRoute(
    input.profileName,
    input.profile,
    pairs,
    pinnedTier,
    isBudgetExceeded,
  );
  const decision = decisionForPair(
    input.profileName,
    baseline.pair,
    baseline.reasonCode,
  );
  decision.isBudgetForced = baseline.isBudgetForced;
  decision.advisor = advisorConfigured ? 'bypassed' : 'none';
  if (advisorConfigured)
    decision.bypassReason = pinnedTier
      ? 'pinned'
      : isBudgetExceeded
        ? 'budget'
        : toolContinuation
          ? 'tool-continuation'
          : !hasUserTurn
            ? 'no-user-turn'
            : input.identity.turn &&
                input.cache.hasAdvisedDecision(input.identity.turn)
              ? 'turn-advised'
              : undefined;
  return decision;
};

const chooseAdvisorRoute = async (
  input: RequestRouteInput,
  pairs: RoutePair[],
  available: () => RoutePair[],
  advisor: AdvisorConfig | undefined,
  authorization: string,
  advisorConfigured: boolean,
  toolContinuation: boolean,
  hasUserTurn: boolean,
  decision: RoutingDecision,
  policy: string,
): Promise<RoutingDecision> => {
  const turn = input.identity.turn;
  if (
    toolContinuation ||
    input.pinnedTier ||
    (input.config.maxSessionBudget !== undefined &&
      input.accumulatedCost >= input.config.maxSessionBudget) ||
    !hasUserTurn ||
    !turn ||
    input.cache.hasAdvisedDecision(turn) ||
    !advisorConfigured
  )
    return decision;

  const started = performance.now();
  const routingDeadline =
    started + (advisor?.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS);
  const candidates = primaryRoutePairs(input.profile, pairs).map(
    createCandidate,
  );
  if (candidates.length <= 1) {
    decision.advisor = 'bypassed';
    decision.bypassReason = 'single-candidate';
    input.cache.rememberAdvisedDecision(turn, decision, policy, input.config);
    return decision;
  }
  if (!advisor) return decision;

  input.signal?.throwIfAborted();
  const request: ClassifierRequest = {
    context: input.context,
    candidates,
    profile: input.profile.advisor,
    baselineTier: selectBaselineRoute(input.profileName, input.profile, pairs)
      .pair.tier,
    routingDeadline,
  };
  const classifierRegistry: ClassifierRegistry = {
    findOfType: (type, provider, id) =>
      input.registry.findOfType(type, provider, id),
    classify: (model, context, options) =>
      input.registry.classify(model, context, options),
  };
  const flight = input.cache.startClassifier(
    createClassifierFlightKey(
      turn,
      input.profileName,
      candidates,
      advisor,
      policy,
    ),
    advisor,
    request,
    (classifierRequest) =>
      runClassifierDetailed(advisor, classifierRequest, classifierRegistry),
  );
  const result = await waitForAbortable(flight.promise, input.signal).finally(
    flight.release,
  );
  if (result.diagnostics.outcome === 'cancelled')
    throw new DOMException('Advisor aborted', 'AbortError');
  input.signal?.throwIfAborted();
  pairs.splice(0, pairs.length, ...available());
  const candidate = candidates.find(
    (entry) => entry.id === result.advice?.candidateId,
  );
  const activeConfig = input.getCurrentConfig();
  if (
    candidate &&
    activeConfig === input.config &&
    authorization ===
      JSON.stringify([activeConfig.advisor, input.profile.advisor]) &&
    performance.now() < routingDeadline &&
    pairs.some(
      (pair) =>
        pair.model === candidate.model &&
        pair.tier === candidate.tier &&
        pair.thinking === candidate.thinking,
    )
  ) {
    decision = {
      ...decisionForPair(input.profileName, candidate, 'classifier'),
      isClassifier: true,
      advisor: 'classifier',
    };
  } else {
    const baseline = selectBaselineRoute(
      input.profileName,
      input.profile,
      pairs,
    );
    decision = {
      ...decisionForPair(input.profileName, baseline.pair, baseline.reasonCode),
      advisor: 'classifier-fallback',
      errorClass: 'advisor-unavailable',
    };
  }
  decision.classification =
    decision.advisor === 'classifier-fallback' &&
    result.diagnostics.outcome === 'selected'
      ? {
          ...result.diagnostics,
          outcome:
            performance.now() >= routingDeadline ? 'deadline' : 'unavailable',
        }
      : result.diagnostics;
  decision.reuse = flight.shared ? 'shared' : undefined;
  decision.routingLatencyMs = result.diagnostics.latencyMs;
  if (decision.classification.outcome === 'deadline')
    decision.errorClass = 'deadline';
  input.cache.rememberAdvisedDecision(turn, decision, policy, input.config);
  return decision;
};

const continueCompatibleRoute = (
  input: RequestRouteInput,
  decision: RoutingDecision,
  continuationDecision: RoutingDecision | undefined,
  available: RoutePair[],
  eligible: () => RoutePair[],
  toolContinuation: boolean,
  priorAssistant: AssistantMessage | undefined,
  mustContinueGoogle: boolean,
): RoutingDecision => {
  if (
    !toolContinuation ||
    !priorAssistant ||
    (!mustContinueGoogle && decision.reasonCode !== 'baseline') ||
    (decision.targetProvider === priorAssistant.provider &&
      decision.targetModelId === priorAssistant.model)
  )
    return decision;

  const priorRef = `${priorAssistant.provider}/${priorAssistant.model}`;
  const priorRoute =
    continuationDecision ??
    (input.lastDecision?.targetLabel === priorRef
      ? input.lastDecision
      : undefined);
  const continuable = mustContinueGoogle ? eligible() : available;
  const sameTier = (pair: RoutePair) =>
    pair.model === priorRef && pair.tier === priorRoute?.tier;
  const priorPair =
    continuable.find(
      (pair) => sameTier(pair) && pair.thinking === priorRoute?.thinking,
    ) ??
    continuable.find(
      mustContinueGoogle ? (pair) => pair.model === priorRef : sameTier,
    );
  if (!priorPair && mustContinueGoogle)
    throw new Error('No compatible route for Google tool continuation.');
  if (!priorPair) return decision;
  return {
    ...decisionForPair(input.profileName, priorPair, 'continuation'),
    advisor: decision.advisor,
    bypassReason: decision.bypassReason,
  };
};

export const prepareRouterRequest = async (
  input: RequestRouteInput,
): Promise<PreparedRouterRequest> => {
  const isBudgetExceeded =
    input.config.maxSessionBudget !== undefined &&
    input.accumulatedCost >= input.config.maxSessionBudget;
  const pinnedTier = input.pinnedTier;
  const { eligible, available, imageAttached } = selectedRoutes(
    input.profile,
    input.registry,
    input.context,
    input.thinkingOverrides,
    pinnedTier,
  );
  const pairs = available();
  const toolContinuation = input.context.messages.at(-1)?.role === 'toolResult';
  const lastUserIndex = input.context.messages.findLastIndex(
    (entry) => entry.role === 'user',
  );
  const user = input.context.messages[lastUserIndex];
  const hasUserTurn = user?.role === 'user';
  const advisor = input.config.advisor;
  const authorization = JSON.stringify([advisor, input.profile.advisor]);
  const advisorConfigured = Boolean(advisor?.enabled);
  const policy = JSON.stringify([
    input.profileName,
    input.profile,
    input.profile.advisor,
    pinnedTier,
    input.thinkingOverrides,
    advisor,
    isBudgetExceeded,
  ]);
  const turn = input.identity.turn;
  const continuationRecord =
    toolContinuation && turn ? input.cache.continuationFor(turn) : undefined;
  const continuationDecision = continuationRecord?.decision;
  const latestAssistantIndex = input.context.messages.findLastIndex(
    (entry) => entry.role === 'assistant',
  );
  const latestAssistantMessage = input.context.messages[latestAssistantIndex];
  const priorAssistant =
    latestAssistantMessage?.role === 'assistant'
      ? latestAssistantMessage
      : undefined;
  const latestResults = input.context.messages
    .slice(latestAssistantIndex + 1)
    .filter((entry) => entry.role === 'toolResult');
  const reusable = canReuseContinuation(
    input,
    continuationDecision,
    toolContinuation,
    priorAssistant,
    latestResults,
    pairs,
    policy,
  );
  const advisedDecision =
    !toolContinuation && turn
      ? input.cache.reusableAdvisedDecision(turn, policy, input.config, pairs)
      : undefined;
  let decision: RoutingDecision;
  if (reusable && continuationDecision) {
    decision = {
      ...continuationDecision,
      reasonCode: 'continuation',
      reuse: 'continuation',
      isClassifier: undefined,
      routingLatencyMs: undefined,
      errorClass: undefined,
      timestamp: Date.now(),
    };
  } else if (advisedDecision) {
    decision = advisedDecision;
  } else {
    if (toolContinuation && turn) input.cache.deleteContinuation(turn);
    decision = baselineDecision(
      input,
      pairs,
      pinnedTier,
      isBudgetExceeded,
      advisorConfigured,
      toolContinuation,
      hasUserTurn && Boolean(turn),
    );
  }
  decision = await chooseAdvisorRoute(
    input,
    pairs,
    available,
    advisor,
    authorization,
    advisorConfigured,
    toolContinuation,
    hasUserTurn && Boolean(turn),
    decision,
    policy,
  );
  const mustContinueGoogle = priorAssistant
    ? requiresGoogleContinuation(priorAssistant)
    : false;
  decision = continueCompatibleRoute(
    input,
    decision,
    continuationDecision,
    pairs,
    eligible,
    toolContinuation,
    priorAssistant,
    mustContinueGoogle,
  );
  decision.generation = undefined;
  return {
    decision,
    profile: input.profile,
    ...(turn ? { turn } : {}),
    branch: input.identity.branch,
    policy,
    config: input.config,
    toolContinuation,
    ...(priorAssistant ? { priorAssistant } : {}),
    mustContinueGoogle,
    imageAttached,
    ...(input.thinkingOverrides
      ? { thinkingOverrides: input.thinkingOverrides }
      : {}),
  };
};
