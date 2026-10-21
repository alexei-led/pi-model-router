import { createHash } from 'node:crypto';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import {
  calculateContextTokens,
  type ExtensionContext,
  estimateTokens as estimateMessageTokens,
} from '@earendil-works/pi-coding-agent';
import { createCandidate, selectedAdviceConfidence } from './choice';
import { runClassifierDetailed } from './classifier';
import { DEFAULT_CLASSIFIER_TIMEOUT_MS } from './constants';
import { hasImageAttachment } from './context';
import { parseCanonicalModelRef } from './domain';
import { updateEscalation } from './escalation';
import { effectivePolicy } from './modes';
import {
  createClassifierFlightKey,
  type ProviderTurnCache,
  type ReviewStamp,
  waitForAbortable,
} from './provider-turns';
import {
  buildRouteMatrix,
  decisionForPair,
  planBehaviorKey,
  type RouteMatrix,
  selectBaselinePlan,
} from './routing';
import { evaluateSwitch } from './switch-policy';
import type {
  ClassifierRegistry,
  ClassifierRequest,
  ClassifierResult,
  GenerationDiagnostics,
  ResolvedMode,
  RoutePlan,
  RouterConfig,
  RouterProfile,
  RouterThinkingByTier,
  RouterTier,
  RoutingDecision,
} from './types';
import { ROUTER_TIERS } from './types';

type RoutingRegistry = Pick<
  ExtensionContext['modelRegistry'],
  'find' | 'findOfType' | 'classify'
>;

export interface RouterRequestIdentity {
  turn?: string;
  branch: string[];
}

export interface PreparedRouterRequest {
  plan: RoutePlan;
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
  /** Mode in effect when the request started. */
  mode: ResolvedMode;
  /** Live mode; a change while advice is in flight rejects that advice. */
  getCurrentMode: () => ResolvedMode;
  accumulatedCost: number;
  lastDecision: RoutingDecision | undefined;
  signal?: AbortSignal | undefined;
  cache: ProviderTurnCache;
  onReview?: ((decision: RoutingDecision) => void) | undefined;
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

interface SelectedRoute {
  decision: RoutingDecision;
  plan: RoutePlan;
}

const modeFields = (
  input: RequestRouteInput,
  plan: RoutePlan,
): Pick<
  RoutingDecision,
  'mode' | 'modeSource' | 'modeLever' | 'modeSourceTier'
> =>
  plan.mode
    ? {
        mode: plan.mode.mode,
        modeSource: [input.mode, input.getCurrentMode()].find(
          (entry) => entry.mode === plan.mode?.mode,
        )?.source,
        modeLever: plan.mode.lever,
        modeSourceTier: plan.mode.sourceTier,
      }
    : {};

const decisionForPlan = (
  input: RequestRouteInput,
  plan: RoutePlan,
  reason: RoutingDecision['reasonCode'],
): RoutingDecision => ({
  ...decisionForPair(input.profileName, plan.attempts[0], reason),
  routeCell: plan.cell,
  ...modeFields(input, plan),
});

const canReuseContinuation = (
  input: RequestRouteInput,
  matrix: RouteMatrix,
  policy: string,
  assistant: AssistantMessage | undefined,
): SelectedRoute | undefined => {
  const turn = input.identity.turn;
  const record = turn ? input.cache.continuationFor(turn) : undefined;
  if (
    !record ||
    !assistant ||
    record.policy !== policy ||
    record.config !== input.config ||
    record.decision.profile !== input.profileName ||
    input.identity.branch.length === 0 ||
    !input.identity.branch.every(
      (id) => typeof id === 'string' && id.length > 0,
    ) ||
    record.branch.length === 0 ||
    !record.branch.every((id, index) => input.identity.branch[index] === id) ||
    assistant.provider !== record.decision.targetProvider ||
    assistant.model !== record.decision.targetModelId ||
    !matrix.plans.some(
      (plan) =>
        plan.id === record.plan.id &&
        plan.attempts.some(
          (pair) =>
            pair.model === record.decision.targetLabel &&
            pair.thinking === record.decision.thinking,
        ),
    )
  )
    return undefined;
  const index = input.context.messages.lastIndexOf(assistant);
  const results = input.context.messages
    .slice(index + 1)
    .filter((entry) => entry.role === 'toolResult');
  if (
    !results.length ||
    !results.every(
      (result) =>
        record.toolCalls.has(result.toolCallId) &&
        assistant.content.some(
          (part) => part.type === 'toolCall' && part.id === result.toolCallId,
        ),
    )
  )
    return undefined;
  return {
    plan: record.plan,
    decision: {
      ...record.decision,
      reasonCode: 'continuation',
      reuse: 'continuation',
      isClassifier: undefined,
      routingLatencyMs: undefined,
      errorClass: undefined,
      proposedRoute: undefined,
      switchCost: undefined,
      adviceSource: undefined,
      timestamp: Date.now(),
    },
  };
};

const baselineRoute = (
  input: RequestRouteInput,
  matrix: RouteMatrix,
  toolContinuation: boolean,
): SelectedRoute => {
  const budget =
    input.config.maxSessionBudget !== undefined &&
    input.accumulatedCost >= input.config.maxSessionBudget;
  const baseline = selectBaselinePlan(
    input.profileName,
    input.profile,
    matrix,
    input.pinnedTier,
    budget,
  );
  const decision = decisionForPlan(input, baseline.plan, baseline.reasonCode);
  decision.isBudgetForced = baseline.isBudgetForced;
  decision.advisor = input.config.advisor?.enabled ? 'bypassed' : 'none';
  if (input.config.advisor?.enabled)
    decision.bypassReason = input.pinnedTier
      ? 'pinned'
      : budget
        ? 'budget'
        : toolContinuation
          ? 'tool-continuation'
          : !input.identity.turn
            ? 'no-user-turn'
            : input.cache.hasAdvisedDecision(input.identity.turn)
              ? 'turn-advised'
              : undefined;
  return { decision, plan: baseline.plan };
};

const reviewCandidates = (matrix: RouteMatrix) => {
  const candidates = matrix.representatives.map((plan) =>
    createCandidate(plan.attempts[0]),
  );
  const activityCandidates = matrix.meaningfulActivities
    ? matrix.plans.flatMap((plan) =>
        plan.cell
          ? [
              {
                activity: plan.cell,
                candidate: createCandidate(plan.attempts[0]),
              },
            ]
          : [],
      )
    : undefined;
  return { candidates, activityCandidates };
};

const runBackgroundReview = async (
  input: RequestRouteInput,
  matrix: RouteMatrix,
  signal: AbortSignal,
): Promise<ClassifierResult> => {
  const advisor = input.config.advisor;
  if (
    !advisor?.enabled ||
    !input.profile.advisor?.models.includes(advisor.model)
  )
    throw new Error('Background review is not authorized.');
  const { candidates, activityCandidates } = reviewCandidates(matrix);
  const routingDeadline =
    performance.now() + (advisor.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS);
  const request: ClassifierRequest = {
    context: input.context,
    candidates,
    ...(activityCandidates
      ? { activityCandidates, askRoute: candidates.length > 1 }
      : {}),
    profile: input.profile.advisor,
    baselineTier: selectBaselinePlan(input.profileName, input.profile, matrix)
      .plan.tier,
    routingDeadline,
    signal,
  };
  const registry: ClassifierRegistry = {
    findOfType: (type, provider, id) =>
      input.registry.findOfType(type, provider, id),
    classify: (model, context, options) =>
      input.registry.classify(model, context, options),
  };
  const authorization = JSON.stringify([advisor, input.profile.advisor]);
  const result = await runClassifierDetailed(advisor, request, registry);
  const currentConfig = input.getCurrentConfig();
  if (
    currentConfig !== input.config ||
    authorization !==
      JSON.stringify([
        currentConfig.advisor,
        currentConfig.profiles[input.profileName]?.advisor,
      ])
  )
    return {
      diagnostics: { ...result.diagnostics, outcome: 'cancelled' },
    };
  return result;
};

const reviewStamp = (
  input: RequestRouteInput,
  matrix: RouteMatrix,
  selected: SelectedRoute,
  policy: string,
  requestCount: number,
): ReviewStamp => ({
  identity: JSON.stringify([
    policy,
    selected.plan.id,
    matrix.plans.map((plan) => plan.id),
  ]),
  branch: input.identity.branch,
  requestCount,
  ...(input.signal ? { signal: input.signal } : {}),
});

const scheduleBackgroundReview = (
  input: RequestRouteInput,
  matrix: RouteMatrix,
  selected: SelectedRoute,
  policy: string,
  requestCount: number,
  validContinuation: boolean,
): void => {
  const turn = input.identity.turn;
  const advisor = input.config.advisor;
  const reviewEvery = advisor?.reviewEveryRequests ?? 0;
  const budget =
    input.config.maxSessionBudget !== undefined &&
    input.accumulatedCost >= input.config.maxSessionBudget;
  const { candidates, activityCandidates } = reviewCandidates(matrix);
  if (
    !turn ||
    !validContinuation ||
    !input.context.messages.length ||
    input.pinnedTier ||
    budget ||
    !advisor?.enabled ||
    !input.profile.advisor?.models.includes(advisor.model) ||
    reviewEvery === 0 ||
    requestCount % reviewEvery !== 0 ||
    (candidates.length <= 1 && !activityCandidates) ||
    (matrix.meaningfulActivities &&
      new Set(matrix.plans.map(planBehaviorKey)).size <= 1)
  )
    return;
  const record = decisionForPlan(input, selected.plan, 'classifier');
  input.cache.startReview(
    turn,
    reviewStamp(input, matrix, selected, policy, requestCount),
    async (signal) => {
      const result = await runBackgroundReview(input, matrix, signal);
      input.onReview?.({
        ...record,
        reviewOnly: true,
        adviceSource: 'review',
        advisor: result.advice ? 'classifier' : 'classifier-fallback',
        classification: result.diagnostics,
        timestamp: Date.now(),
      });
      return result;
    },
  );
};

const chooseAdvisorRoute = async (
  input: RequestRouteInput,
  matrix: RouteMatrix,
  refreshMatrix: () => RouteMatrix,
  selected: SelectedRoute,
  policy: string,
  toolContinuation: boolean,
  reviewResult?: ClassifierResult,
): Promise<SelectedRoute> => {
  const turn = input.identity.turn;
  const advisor = input.config.advisor;
  const budget =
    input.config.maxSessionBudget !== undefined &&
    input.accumulatedCost >= input.config.maxSessionBudget;
  if (
    (toolContinuation && !reviewResult) ||
    input.pinnedTier ||
    budget ||
    !turn ||
    (!reviewResult && input.cache.hasAdvisedDecision(turn)) ||
    !advisor?.enabled
  )
    return selected;
  const { candidates, activityCandidates } = reviewCandidates(matrix);
  const oneEffectivePlan =
    matrix.meaningfulActivities &&
    new Set(matrix.plans.map(planBehaviorKey)).size <= 1;
  if ((candidates.length <= 1 && !activityCandidates) || oneEffectivePlan) {
    selected.decision.advisor = 'bypassed';
    selected.decision.bypassReason = 'single-candidate';
    input.cache.rememberAdvisedDecision(
      turn,
      selected.decision,
      policy,
      input.config,
      selected.plan,
    );
    return selected;
  }
  if (!reviewResult) input.signal?.throwIfAborted();
  const routingDeadline =
    performance.now() + (advisor.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS);
  const authorization = JSON.stringify([advisor, input.profile.advisor]);
  const request: ClassifierRequest = {
    context: input.context,
    candidates,
    ...(activityCandidates
      ? { activityCandidates, askRoute: candidates.length > 1 }
      : {}),
    profile: input.profile.advisor,
    baselineTier: selectBaselinePlan(input.profileName, input.profile, matrix)
      .plan.tier,
    routingDeadline,
  };
  const classifierRegistry: ClassifierRegistry = {
    findOfType: (type, provider, id) =>
      input.registry.findOfType(type, provider, id),
    classify: (model, context, options) =>
      input.registry.classify(model, context, options),
  };
  let shared = false;
  const classifyInitial = (): Promise<ClassifierResult> => {
    const flight = input.cache.startClassifier(
      createClassifierFlightKey(
        turn,
        input.profileName,
        candidates,
        advisor,
        JSON.stringify([
          policy,
          matrix.plans.map((plan) => plan.id),
          Boolean(activityCandidates),
        ]),
      ),
      advisor,
      request,
      (classifierRequest) =>
        runClassifierDetailed(advisor, classifierRequest, classifierRegistry),
    );
    shared = flight.shared;
    return waitForAbortable(flight.promise, input.signal).finally(
      flight.release,
    );
  };
  const result = reviewResult ?? (await classifyInitial());
  if (result.diagnostics.outcome === 'cancelled') {
    if (reviewResult) return selected;
    throw new DOMException('Advisor aborted', 'AbortError');
  }
  if (!reviewResult) input.signal?.throwIfAborted();
  const current = refreshMatrix();
  const candidate = candidates.find(
    (entry) => entry.id === result.advice?.candidateId,
  );
  const activeConfig = input.getCurrentConfig();
  const authorized =
    activeConfig === input.config &&
    input.getCurrentMode().mode === input.mode.mode &&
    authorization ===
      JSON.stringify([activeConfig.advisor, input.profile.advisor]) &&
    (reviewResult !== undefined || performance.now() < routingDeadline);
  const activity = authorized ? result.advice?.activity : undefined;
  const plan =
    authorized && candidate
      ? (current.plans.find(
          (entry) => entry.tier === candidate.tier && entry.cell === activity,
        ) ??
        current.plans.find(
          (entry) => entry.tier === candidate.tier && !entry.cell,
        ))
      : undefined;
  // Advice resolves a current cell; representative IDs never become physical targets by themselves.
  const validated = plan && matrix.plans.some((entry) => entry.id === plan.id);
  if (!validated && reviewResult) {
    selected.decision = {
      ...selected.decision,
      reasonCode: 'continuation',
      advisor: 'classifier-fallback',
      adviceSource: 'review',
      bypassReason: undefined,
      reuse: 'continuation',
      classification: result.diagnostics,
      errorClass:
        result.diagnostics.outcome === 'deadline'
          ? 'deadline'
          : 'advisor-unavailable',
    };
    return selected;
  }
  if (validated)
    selected = {
      plan,
      decision: {
        ...decisionForPlan(input, plan, 'classifier'),
        activity,
        isClassifier: true,
        advisor: 'classifier',
      },
    };
  else {
    const baseline = selectBaselinePlan(
      input.profileName,
      input.profile,
      current,
    );
    selected = {
      plan: baseline.plan,
      decision: {
        ...decisionForPlan(input, baseline.plan, baseline.reasonCode),
        advisor: 'classifier-fallback',
        errorClass: 'advisor-unavailable',
      },
    };
  }
  selected.decision.adviceSource = reviewResult ? 'review' : 'initial';
  selected.decision.classification =
    !validated && result.diagnostics.outcome === 'selected'
      ? {
          ...result.diagnostics,
          outcome:
            !reviewResult && performance.now() >= routingDeadline
              ? 'deadline'
              : 'unavailable',
        }
      : result.diagnostics;
  selected.decision.reuse = shared ? 'shared' : undefined;
  selected.decision.routingLatencyMs = result.diagnostics.latencyMs;
  if (selected.decision.classification.outcome === 'deadline')
    selected.decision.errorClass = 'deadline';
  if (!toolContinuation)
    input.cache.rememberAdvisedDecision(
      turn,
      selected.decision,
      policy,
      input.config,
      selected.plan,
    );
  return selected;
};

const applySwitchPolicy = (
  input: RequestRouteInput,
  incumbent: SelectedRoute | undefined,
  proposed: SelectedRoute,
  contextTokens: number,
): SelectedRoute => {
  if (
    !incumbent ||
    proposed.decision.advisor !== 'classifier' ||
    !proposed.decision.classification
  )
    return proposed;
  const proposedPair = proposed.plan.attempts[0];
  const actualPair =
    incumbent.plan.attempts.find(
      (pair) => pair.model === incumbent.decision.targetLabel,
    ) ?? incumbent.plan.attempts[0];
  if (
    actualPair.model === proposedPair.model &&
    actualPair.thinking === proposedPair.thinking
  )
    return proposed;
  const currentModelRef = parseCanonicalModelRef(actualPair.model);
  const proposedModelRef = parseCanonicalModelRef(proposedPair.model);
  const currentModel = input.registry.find(
    currentModelRef.provider,
    currentModelRef.modelId,
  );
  const nextModel = input.registry.find(
    proposedModelRef.provider,
    proposedModelRef.modelId,
  );
  if (!currentModel || !nextModel) return proposed;
  const priorAssistant = input.context.messages.findLast(
    (message) => message.role === 'assistant',
  );
  const usage =
    priorAssistant?.role === 'assistant' &&
    priorAssistant.provider === currentModelRef.provider &&
    priorAssistant.model === currentModelRef.modelId
      ? priorAssistant.usage
      : undefined;
  const recordedGeneration =
    input.lastDecision?.targetLabel === actualPair.model
      ? input.lastDecision.generation
      : undefined;
  const previousGeneration: GenerationDiagnostics | undefined =
    recordedGeneration ??
    (usage
      ? {
          transition: 'same-model',
          contextTruncated: false,
          attempts: 1,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
        }
      : undefined);
  const adviceConfidence = selectedAdviceConfidence(
    proposed.decision.classification,
    {
      tier: actualPair.tier !== proposedPair.tier,
      activity: incumbent.decision.activity !== proposed.decision.activity,
    },
  );
  const decision = evaluateSwitch({
    current: actualPair,
    proposed: proposedPair,
    currentModel,
    proposedModel: nextModel,
    config: {
      ...input.config,
      switchPolicy: effectivePolicy(input.config, input.mode.mode),
    },
    ...(previousGeneration ? { previousGeneration } : {}),
    contextTokens,
    outputTokens: previousGeneration?.outputTokens ?? 0,
    adviceConfidence,
  });
  const decorated = {
    ...proposed.decision,
    switchCost: decision.diagnostic,
  };
  if (decision.accepted) return { ...proposed, decision: decorated };
  return {
    plan: incumbent.plan,
    decision: {
      ...incumbent.decision,
      reasonCode: 'classifier',
      advisor: 'classifier',
      isClassifier: true,
      adviceSource: 'review',
      classification: proposed.decision.classification,
      proposedRoute: {
        activity: proposed.decision.activity,
        tier: proposedPair.tier,
        model: proposedPair.model,
        thinking: proposedPair.thinking,
      },
      switchCost: decision.diagnostic,
    },
  };
};

const continueCompatibleRoute = (
  input: RequestRouteInput,
  selected: SelectedRoute,
  matrix: RouteMatrix,
  eligible: () => RouteMatrix,
  assistant: AssistantMessage | undefined,
  mustContinueGoogle: boolean,
): SelectedRoute => {
  if (
    !assistant ||
    (!mustContinueGoogle && selected.decision.reasonCode !== 'baseline') ||
    (selected.decision.targetProvider === assistant.provider &&
      selected.decision.targetModelId === assistant.model)
  )
    return selected;
  const priorRef = `${assistant.provider}/${assistant.model}`;
  const record = input.identity.turn
    ? input.cache.continuationFor(input.identity.turn)
    : undefined;
  const previous =
    record?.decision ??
    (input.lastDecision?.targetLabel === priorRef
      ? input.lastDecision
      : undefined);
  const plans = (mustContinueGoogle ? eligible() : matrix).plans;
  const compatible = plans
    .flatMap((plan) => plan.attempts.map((pair) => ({ plan, pair })))
    .filter(
      ({ pair }) =>
        pair.model === priorRef &&
        (mustContinueGoogle || pair.tier === previous?.tier),
    );
  const match =
    compatible.find(
      ({ plan, pair }) =>
        plan.cell === previous?.routeCell &&
        pair.thinking === previous?.thinking,
    ) ?? compatible[0];
  if (!match && mustContinueGoogle)
    throw new Error('No compatible route for Google tool continuation.');
  if (!match) return selected;
  return {
    plan: match.plan,
    decision: {
      ...decisionForPair(input.profileName, match.pair, 'continuation'),
      routeCell: match.plan.cell,
      ...modeFields(input, match.plan),
      activity: previous?.activity,
      advisor: selected.decision.advisor,
      bypassReason: selected.decision.bypassReason,
    },
  };
};

const tierRank = (tier: RouterTier): number =>
  ROUTER_TIERS.length - ROUTER_TIERS.indexOf(tier);

/** A repeated failure raises the route to the floor tier; budget never admits high. */
const applyEscalation = (
  input: RequestRouteInput,
  selected: SelectedRoute,
  matrix: RouteMatrix,
  budget: boolean,
): SelectedRoute => {
  const { state, floor } = updateEscalation(input.cache.escalation(), {
    messages: input.context.messages,
    incumbent: selected.plan.tier,
    holdTurns: effectivePolicy(input.config, input.mode.mode)
      .escalationHoldTurns,
  });
  input.cache.setEscalation(state);
  if (!floor || tierRank(selected.plan.tier) >= tierRank(floor))
    return selected;
  const plan = [...ROUTER_TIERS]
    .reverse()
    .filter(
      (tier) =>
        tierRank(tier) >= tierRank(floor) && !(budget && tier === 'high'),
    )
    .flatMap((tier) => [
      matrix.plans.find(
        (entry) => entry.tier === tier && entry.cell === selected.plan.cell,
      ),
      matrix.plans.find((entry) => entry.tier === tier && !entry.cell),
    ])
    .find((entry) => entry !== undefined);
  if (!plan) return selected;
  const { activity, advisor, adviceSource, bypassReason, classification } =
    selected.decision;
  return {
    plan,
    decision: {
      ...decisionForPlan(input, plan, 'escalation'),
      activity,
      advisor,
      adviceSource,
      bypassReason,
      classification,
      escalatedFrom: selected.plan.tier,
    },
  };
};

export const prepareRouterRequest = async (
  input: RequestRouteInput,
): Promise<PreparedRouterRequest> => {
  input.signal?.throwIfAborted();
  const imageAttached = hasImageAttachment(input.context);
  const contextTokens = estimateRequestTokens(input.context);
  const budget =
    input.config.maxSessionBudget !== undefined &&
    input.accumulatedCost >= input.config.maxSessionBudget;
  const matrixFor = (tokens: number, mode = input.mode.mode) =>
    buildRouteMatrix(
      input.profile,
      (provider, id) => input.registry.find(provider, id),
      imageAttached,
      tokens,
      input.thinkingOverrides,
      input.config.activityRouting !== 'off',
      input.pinnedTier,
      { mode, budgetExceeded: budget },
    );
  const matrix = matrixFor(contextTokens);
  let currentMatrix = matrix;
  // After advice, rebuild from the live mode so only the current matrix generates.
  const available = () => {
    currentMatrix = matrixFor(contextTokens, input.getCurrentMode().mode);
    return currentMatrix;
  };
  const toolContinuation = input.context.messages.at(-1)?.role === 'toolResult';
  const latest = input.context.messages.findLast(
    (entry) => entry.role === 'assistant',
  );
  const priorAssistant = latest?.role === 'assistant' ? latest : undefined;
  const mustContinueGoogle = priorAssistant
    ? requiresGoogleContinuation(priorAssistant)
    : false;
  const policy = JSON.stringify([
    input.mode.mode,
    input.profileName,
    input.profile,
    input.pinnedTier,
    input.thinkingOverrides,
    input.config.advisor,
    input.config.activityRouting,
    budget,
  ]);
  const turn = input.identity.turn;
  const continuationRoute = toolContinuation
    ? canReuseContinuation(input, matrix, policy, priorAssistant)
    : undefined;
  let selected = toolContinuation
    ? continuationRoute
    : turn
      ? input.cache.reusableAdvisedDecision(
          turn,
          policy,
          input.config,
          matrix.plans,
        )
      : undefined;
  const validContinuation =
    !toolContinuation || continuationRoute !== undefined;
  const incumbent = continuationRoute;
  selected ??= baselineRoute(input, matrix, toolContinuation);
  input.cache.clearReviewsExcept(turn);
  const requestCount = turn ? input.cache.requestCount(turn) : 0;
  const stamp = reviewStamp(input, matrix, selected, policy, requestCount);
  const reviewResult =
    turn && toolContinuation && validContinuation && !mustContinueGoogle
      ? input.cache.takeReview(turn, stamp)
      : undefined;
  selected = await chooseAdvisorRoute(
    input,
    matrix,
    available,
    selected,
    policy,
    toolContinuation,
    reviewResult,
  );
  if (reviewResult?.advice && selected.decision.isClassifier)
    selected = applySwitchPolicy(input, incumbent, selected, contextTokens);
  if (toolContinuation)
    selected = continueCompatibleRoute(
      input,
      selected,
      matrix,
      () => matrixFor(0),
      priorAssistant,
      mustContinueGoogle,
    );
  if (!input.pinnedTier && !mustContinueGoogle)
    selected = applyEscalation(input, selected, currentMatrix, budget);
  if (toolContinuation && !mustContinueGoogle)
    scheduleBackgroundReview(
      input,
      matrix,
      selected,
      policy,
      requestCount,
      validContinuation,
    );
  selected.decision.generation = undefined;
  return {
    ...selected,
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
