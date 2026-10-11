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
import {
  createClassifierFlightKey,
  type ProviderTurnCache,
  waitForAbortable,
} from './provider-turns';
import {
  buildRouteMatrix,
  decisionForPair,
  planBehaviorKey,
  type RouteMatrix,
  selectBaselinePlan,
} from './routing';
import type {
  ClassifierRegistry,
  ClassifierRequest,
  RoutePlan,
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

interface SelectedRoute {
  decision: RoutingDecision;
  plan: RoutePlan;
}

const decisionForPlan = (
  input: RequestRouteInput,
  plan: RoutePlan,
  reason: RoutingDecision['reasonCode'],
): RoutingDecision => ({
  ...decisionForPair(input.profileName, plan.attempts[0], reason),
  routeCell: plan.cell,
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

const chooseAdvisorRoute = async (
  input: RequestRouteInput,
  matrix: RouteMatrix,
  refreshMatrix: () => RouteMatrix,
  selected: SelectedRoute,
  policy: string,
  toolContinuation: boolean,
): Promise<SelectedRoute> => {
  const turn = input.identity.turn;
  const advisor = input.config.advisor;
  const budget =
    input.config.maxSessionBudget !== undefined &&
    input.accumulatedCost >= input.config.maxSessionBudget;
  if (
    toolContinuation ||
    input.pinnedTier ||
    budget ||
    !turn ||
    input.cache.hasAdvisedDecision(turn) ||
    !advisor?.enabled
  )
    return selected;
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
  input.signal?.throwIfAborted();
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
  const result = await waitForAbortable(flight.promise, input.signal).finally(
    flight.release,
  );
  if (result.diagnostics.outcome === 'cancelled')
    throw new DOMException('Advisor aborted', 'AbortError');
  input.signal?.throwIfAborted();
  const current = refreshMatrix();
  const candidate = candidates.find(
    (entry) => entry.id === result.advice?.candidateId,
  );
  const activeConfig = input.getCurrentConfig();
  const authorized =
    activeConfig === input.config &&
    authorization ===
      JSON.stringify([activeConfig.advisor, input.profile.advisor]) &&
    performance.now() < routingDeadline;
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
  selected.decision.classification =
    !validated && result.diagnostics.outcome === 'selected'
      ? {
          ...result.diagnostics,
          outcome:
            performance.now() >= routingDeadline ? 'deadline' : 'unavailable',
        }
      : result.diagnostics;
  selected.decision.reuse = flight.shared ? 'shared' : undefined;
  selected.decision.routingLatencyMs = result.diagnostics.latencyMs;
  if (selected.decision.classification.outcome === 'deadline')
    selected.decision.errorClass = 'deadline';
  input.cache.rememberAdvisedDecision(
    turn,
    selected.decision,
    policy,
    input.config,
    selected.plan,
  );
  return selected;
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
      activity: previous?.activity,
      advisor: selected.decision.advisor,
      bypassReason: selected.decision.bypassReason,
    },
  };
};

export const prepareRouterRequest = async (
  input: RequestRouteInput,
): Promise<PreparedRouterRequest> => {
  input.signal?.throwIfAborted();
  const imageAttached = hasImageAttachment(input.context);
  const contextTokens = estimateRequestTokens(input.context);
  const matrixFor = (tokens: number) =>
    buildRouteMatrix(
      input.profile,
      (provider, id) => input.registry.find(provider, id),
      imageAttached,
      tokens,
      input.thinkingOverrides,
      input.config.activityRouting !== 'off',
      input.pinnedTier,
    );
  const available = () => matrixFor(contextTokens);
  const matrix = available();
  const toolContinuation = input.context.messages.at(-1)?.role === 'toolResult';
  const latest = input.context.messages.findLast(
    (entry) => entry.role === 'assistant',
  );
  const priorAssistant = latest?.role === 'assistant' ? latest : undefined;
  const mustContinueGoogle = priorAssistant
    ? requiresGoogleContinuation(priorAssistant)
    : false;
  const budget =
    input.config.maxSessionBudget !== undefined &&
    input.accumulatedCost >= input.config.maxSessionBudget;
  const policy = JSON.stringify([
    input.profileName,
    input.profile,
    input.pinnedTier,
    input.thinkingOverrides,
    input.config.advisor,
    input.config.activityRouting,
    budget,
  ]);
  const turn = input.identity.turn;
  let selected = toolContinuation
    ? canReuseContinuation(input, matrix, policy, priorAssistant)
    : turn
      ? input.cache.reusableAdvisedDecision(
          turn,
          policy,
          input.config,
          matrix.plans,
        )
      : undefined;
  selected ??= baselineRoute(input, matrix, toolContinuation);
  selected = await chooseAdvisorRoute(
    input,
    matrix,
    available,
    selected,
    policy,
    toolContinuation,
  );
  if (toolContinuation)
    selected = continueCompatibleRoute(
      input,
      selected,
      matrix,
      () => matrixFor(0),
      priorAssistant,
      mustContinueGoogle,
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
