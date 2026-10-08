import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { resolveContextWindow } from './config';
import { extractTextFromContent } from './context';
import { parseCanonicalModelRef } from './domain';
import { observeGeneration } from './economics';
import type { PreparedRouterRequest } from './provider-request';
import type { ProviderTurnCache } from './provider-turns';
import { availableRoutePairs } from './routing';
import type { RouterRequestObservation } from './types';

type GenerationRegistry = Pick<
  ExtensionContext['modelRegistry'],
  'find' | 'streamSimple'
>;

export interface GenerationInput {
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
  stream: AssistantMessageEventStream;
  registry: GenerationRegistry;
  request: PreparedRouterRequest;
  cache: Pick<
    ProviderTurnCache,
    'hasAdvisedDecision' | 'rememberAdvisedDecision' | 'rememberContinuation'
  >;
  onCost: (cost: number) => void;
  onObservation: (event: RouterRequestObservation) => void;
  onAttemptTarget: (
    target: { provider: string; modelId: string },
    thinking: ThinkingLevel,
  ) => void;
}

export type GenerationOutcome =
  | {
      status: 'complete';
      generationSucceeded: boolean;
      generationAborted: boolean;
      terminalEvent: Extract<AssistantMessageEvent, { type: 'done' | 'error' }>;
    }
  | {
      status: 'failed';
      error: unknown;
      exhausted: boolean;
      generationSucceeded: false;
      generationAborted: boolean;
      partialMessage?: AssistantMessage;
    };

interface AttemptState {
  contentReceived: boolean;
  usageReceived: boolean;
  terminalReceived: boolean;
  generationSucceeded: boolean;
  generationAborted: boolean;
  reportedCostUsd: number | undefined;
  terminalEvent?: Extract<AssistantMessageEvent, { type: 'done' | 'error' }>;
  partialMessage?: AssistantMessage;
}

interface DelegateAttemptInput {
  input: GenerationInput;
  target: { provider: string; modelId: string };
  targetModel: Model<Api>;
  modelRef: string;
  index: number;
  routedTargetLabel: string;
  thinking: ThinkingLevel;
  context: Context;
  options: SimpleStreamOptions;
  attempts: number;
  reportedCostUsd: number | undefined;
}

type DelegateAttemptOutcome =
  | { status: 'terminal'; state: AttemptState }
  | { status: 'retry'; state: AttemptState; error: unknown }
  | { status: 'stop'; state: AttemptState; error: unknown };

interface AttemptEventProgress {
  terminal: boolean;
  error?: Error;
}

const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

const truncateContext = (context: Context, limit: number): Context => {
  const messages = [...context.messages];
  if (messages.length <= 1) return context;

  const systemTokens = context.systemPrompt
    ? estimateTokens(context.systemPrompt)
    : 0;
  const messageTokens = messages.map((message) =>
    estimateTokens(extractTextFromContent(message.content)),
  );
  const totalTokens =
    systemTokens + messageTokens.reduce((sum, tokens) => sum + tokens, 0);
  if (totalTokens <= limit) return context;

  const systemMessages = messages.filter(
    (message) => message.role === 'system',
  );
  let remaining = totalTokens;
  let nextRemovableIndex = 0;
  for (
    let index = 0;
    index < messages.length && remaining > limit;
    index += 1
  ) {
    if (messages[index]?.role !== 'user') continue;
    while (nextRemovableIndex < index) {
      const candidate = messages[nextRemovableIndex];
      if (candidate?.role !== 'system')
        remaining -= messageTokens[nextRemovableIndex] ?? 0;
      nextRemovableIndex += 1;
    }
  }
  return {
    ...context,
    messages: [
      ...systemMessages,
      ...messages
        .slice(nextRemovableIndex)
        .filter((message) => message.role !== 'system'),
    ],
  };
};

const estimateCost = (
  state: AttemptState,
  usage: AssistantMessage['usage'],
) => {
  const cost = usage.cost.total;
  if (Number.isFinite(cost) && cost >= 0) {
    state.reportedCostUsd =
      state.reportedCostUsd === undefined
        ? undefined
        : state.reportedCostUsd + cost;
    return cost;
  }
  state.reportedCostUsd = undefined;
  return undefined;
};

const updateDecisionForTarget = (
  decision: PreparedRouterRequest['decision'],
  target: DelegateAttemptInput['target'],
  modelRef: string,
  index: number,
  profile: PreparedRouterRequest['profile'],
  routedTargetLabel: string,
  thinking: ThinkingLevel,
): void => {
  decision.targetProvider = target.provider;
  decision.targetModelId = target.modelId;
  decision.targetLabel = modelRef;
  decision.thinking = thinking;
  decision.isFallback = index > 0 || modelRef !== profile[decision.tier]?.model;
  if (modelRef !== routedTargetLabel && decision.reasonCode !== 'continuation')
    decision.reasonCode = 'fallback';
};

const processAttemptEvent = (
  attempt: DelegateAttemptInput,
  state: AttemptState,
  event: AssistantMessageEvent,
  pendingEvents: AssistantMessageEvent[],
): AttemptEventProgress => {
  const { input, target, targetModel, context, attempts } = attempt;
  const { request, stream } = input;
  const decision = request.decision;
  if (event.type === 'error' && event.reason === 'aborted')
    state.generationAborted = true;

  if (event.type === 'done' || event.type === 'error') {
    state.usageReceived = true;
    const usage =
      event.type === 'done' ? event.message.usage : event.error.usage;
    const cost = estimateCost(state, usage);
    if (cost !== undefined) input.onCost(cost);
    updateDecisionForTarget(
      decision,
      target,
      attempt.modelRef,
      attempt.index,
      request.profile,
      attempt.routedTargetLabel,
      attempt.thinking,
    );
    decision.generation = observeGeneration({
      usage,
      target: targetModel,
      previous:
        request.priorAssistant &&
        request.priorAssistant.stopReason !== 'error' &&
        request.priorAssistant.stopReason !== 'aborted'
          ? input.registry.find(
              request.priorAssistant.provider,
              request.priorAssistant.model,
            )
          : undefined,
      contextTruncated: context.messages.length < input.context.messages.length,
      attempts,
      reportedCostUsd: state.reportedCostUsd,
    });
    if (event.type === 'error' && decision.generation)
      decision.generation.shadow = undefined;
  }

  if (
    event.type === 'error' &&
    event.reason !== 'aborted' &&
    !state.contentReceived
  )
    return {
      terminal: false,
      error: new Error(
        errorMessageOf(event) || 'Model failed before sending content.',
      ),
    };

  if (isContentEvent(event)) {
    state.contentReceived = true;
    updateDecisionForTarget(
      decision,
      target,
      attempt.modelRef,
      attempt.index,
      request.profile,
      attempt.routedTargetLabel,
      attempt.thinking,
    );
  }
  if (event.type === 'done' || event.type === 'error') {
    state.terminalReceived = true;
    state.generationSucceeded = event.type === 'done';
    state.terminalEvent = event;
    updateDecisionForTarget(
      decision,
      target,
      attempt.modelRef,
      attempt.index,
      request.profile,
      attempt.routedTargetLabel,
      attempt.thinking,
    );
    rememberCompletedTurn(input, event);
  }
  if (state.contentReceived || state.terminalReceived) {
    for (const pending of pendingEvents.splice(0)) stream.push(pending);
    if (!state.terminalReceived) stream.push(event);
    if ('partial' in event) state.partialMessage = event.partial;
  } else pendingEvents.push(event);
  return { terminal: state.terminalReceived };
};

const errorMessageOf = (event: AssistantMessageEvent): string | undefined =>
  event.type === 'error' &&
  event.error &&
  typeof event.error === 'object' &&
  'errorMessage' in event.error &&
  typeof event.error.errorMessage === 'string'
    ? event.error.errorMessage
    : undefined;

const isContentEvent = (event: AssistantMessageEvent): boolean =>
  event.type === 'text_delta' ||
  event.type === 'thinking_delta' ||
  event.type === 'toolcall_delta' ||
  event.type === 'toolcall_end';

const rememberCompletedTurn = (
  input: GenerationInput,
  event: Extract<AssistantMessageEvent, { type: 'done' | 'error' }>,
): void => {
  if (event.type !== 'done' || !input.request.turn) return;
  const turn = input.request.turn;
  if (!input.request.toolContinuation && input.cache.hasAdvisedDecision(turn))
    input.cache.rememberAdvisedDecision(
      turn,
      input.request.decision,
      input.request.policy,
      input.request.config,
    );
  input.cache.rememberContinuation({
    turn,
    policy: input.request.policy,
    branch: input.request.branch,
    decision: input.request.decision,
    config: input.request.config,
    toolCalls: new Set(
      event.message.content.flatMap((entry) =>
        entry.type === 'toolCall' ? [entry.id] : [],
      ),
    ),
  });
};

const runDelegateAttempt = async (
  attempt: DelegateAttemptInput,
): Promise<DelegateAttemptOutcome> => {
  const state: AttemptState = {
    contentReceived: false,
    usageReceived: false,
    terminalReceived: false,
    generationSucceeded: false,
    generationAborted: false,
    reportedCostUsd: attempt.reportedCostUsd,
  };
  const pendingEvents: AssistantMessageEvent[] = [];
  try {
    const delegatedStream = attempt.input.registry.streamSimple(
      attempt.targetModel,
      attempt.context,
      attempt.options,
    );
    for await (const event of delegatedStream) {
      const progress = processAttemptEvent(
        attempt,
        state,
        event,
        pendingEvents,
      );
      if (progress.error) throw progress.error;
      if (progress.terminal) break;
    }
    if (!state.terminalReceived)
      throw new Error('Provider stream ended without a terminal event.');
    return { status: 'terminal', state };
  } catch (error) {
    if (state.contentReceived || attempt.input.options?.signal?.aborted)
      return { status: 'stop', state, error };
    return { status: 'retry', state, error };
  }
};

const failureOutcome = (
  error: unknown,
  exhausted: boolean,
  generationAborted: boolean,
  partialMessage?: AssistantMessage,
): GenerationOutcome => ({
  status: 'failed',
  error,
  exhausted,
  generationSucceeded: false,
  generationAborted,
  ...(partialMessage ? { partialMessage } : {}),
});

export const runGenerationAttempts = async (
  input: GenerationInput,
): Promise<GenerationOutcome> => {
  const request = input.request;
  const { decision, profile, toolContinuation, priorAssistant } = request;
  let generationSucceeded = false;
  let generationAborted = false;

  try {
    const routedTargetLabel = decision.targetLabel;
    const modelsToTry = [
      decision.targetLabel,
      ...(profile[decision.tier]?.fallbacks ?? []),
    ].filter((ref, index, refs) => refs.indexOf(ref) === index);
    let lastError: unknown;
    let success = false;
    let attempts = 0;
    let reportedCostUsd: number | undefined = 0;
    let terminalEvent:
      | Extract<AssistantMessageEvent, { type: 'done' | 'error' }>
      | undefined;

    for (const [index, modelRef] of modelsToTry.entries()) {
      input.options?.signal?.throwIfAborted();
      const { provider, modelId } = parseCanonicalModelRef(modelRef);
      if (provider === 'router') continue;
      const targetModel = input.registry.find(provider, modelId);
      if (!targetModel) {
        lastError = new Error(`Routed model not found: ${provider}/${modelId}`);
        continue;
      }

      try {
        let effectiveContext = input.context;
        const targetLimit =
          targetModel.contextWindow ??
          resolveContextWindow(decision.tier, profile, input.registry);
        if (
          input.model.contextWindow !== undefined &&
          targetLimit < input.model.contextWindow
        )
          effectiveContext = truncateContext(input.context, targetLimit);

        const pair = availableRoutePairs(
          profile,
          (targetProvider, targetId) =>
            input.registry.find(targetProvider, targetId),
          request.imageAttached,
          request.thinkingOverrides,
        ).find(
          (candidate) =>
            candidate.tier === decision.tier && candidate.model === modelRef,
        );
        if (!pair)
          throw new Error(
            'Routed model capabilities or thinking are unsupported.',
          );
        if (
          toolContinuation &&
          priorAssistant &&
          request.mustContinueGoogle &&
          (provider !== priorAssistant.provider ||
            modelId !== priorAssistant.model)
        )
          throw new Error('No compatible route for Google tool continuation.');

        const delegatedReasoning: SimpleStreamOptions['reasoning'] =
          pair.thinking !== 'off' ? pair.thinking : undefined;
        input.onAttemptTarget({ provider, modelId }, pair.thinking);
        const {
          reasoning: _piReasoning,
          apiKey: _routerKey,
          headers: _routerHeaders,
          env: _routerEnv,
          ...delegationOptions
        } = input.options ?? {};
        const delegatedOptions: SimpleStreamOptions = {
          ...delegationOptions,
          ...(delegatedReasoning ? { reasoning: delegatedReasoning } : {}),
        };
        attempts += 1;
        input.onObservation({
          stage: 'generating',
          decision: {
            ...decision,
            targetProvider: provider,
            targetModelId: modelId,
            targetLabel: modelRef,
            thinking: pair.thinking,
            isFallback: index > 0 || modelRef !== profile[decision.tier]?.model,
          },
        });
        const attempt = await runDelegateAttempt({
          input,
          target: { provider, modelId },
          targetModel,
          modelRef,
          index,
          routedTargetLabel,
          thinking: pair.thinking,
          context: effectiveContext,
          options: delegatedOptions,
          attempts,
          reportedCostUsd,
        });
        reportedCostUsd = attempt.state.reportedCostUsd;
        generationAborted ||= attempt.state.generationAborted;
        if (attempt.status !== 'terminal' && !attempt.state.usageReceived) {
          reportedCostUsd = undefined;
          if (decision.generation) {
            decision.generation.attempts = attempts;
            decision.generation.reportedCostUsd = undefined;
            decision.generation.shadow = undefined;
          }
        }
        if (attempt.status === 'stop')
          return failureOutcome(
            attempt.error,
            false,
            generationAborted,
            attempt.state.partialMessage,
          );
        if (attempt.status === 'retry') {
          lastError = attempt.error;
          continue;
        }
        generationSucceeded = attempt.state.generationSucceeded;
        terminalEvent = attempt.state.terminalEvent;
        success = true;
        break;
      } catch (error) {
        if (input.options?.signal?.aborted)
          return failureOutcome(error, false, generationAborted);
        lastError = error;
      }
    }

    if (!success)
      return failureOutcome(
        lastError instanceof Error
          ? lastError
          : new Error(
              typeof lastError === 'string'
                ? lastError
                : 'Failed to delegate to any model in the chain.',
            ),
        true,
        generationAborted,
      );
    if (!terminalEvent)
      return failureOutcome(
        new Error('Provider stream ended without a terminal event.'),
        true,
        generationAborted,
      );
    return {
      status: 'complete',
      generationSucceeded,
      generationAborted,
      terminalEvent,
    };
  } catch (error) {
    return failureOutcome(error, false, generationAborted);
  }
};
