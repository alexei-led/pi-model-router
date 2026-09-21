import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { runClassifier } from './classifier';
import {
  collectProfileThinkingLevels,
  MAX_THINKING_LEVEL,
  parseCanonicalModelRef,
  profileNames,
  ROUTER_TIERS,
  resolveContextWindow,
  resolveMaxTokens,
} from './config';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './constants';
import {
  extractTextFromContent,
  getBoundedRecentContext,
  hasImageAttachment,
} from './context';
import { createJevCandidate, runJev } from './jev';
import {
  availableRoutePairs,
  decisionForPair,
  primaryRoutePairs,
  selectBaselineRoute,
} from './routing';
import type {
  AdvisorOutcome,
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RouterTier,
  RoutingDecision,
} from './types';

const REGISTRY_WAIT_TIMEOUT_MS = 5000;
const REGISTRY_WAIT_INITIAL_DELAY_MS = 50;
const REGISTRY_WAIT_MAX_DELAY_MS = 500;

/**
 * Wait for the model registry to become available with exponential backoff.
 * This handles the race condition where subagents (e.g. from pi-dynamic-workflows)
 * invoke the router provider before session_start has fired in their context.
 */
export const waitForRegistry = async (
  state: {
    readonly currentModelRegistry:
      | ExtensionContext['modelRegistry']
      | undefined;
  },
  timeoutMs: number = REGISTRY_WAIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ExtensionContext['modelRegistry'] | undefined> => {
  signal?.throwIfAborted();
  if (state.currentModelRegistry) return state.currentModelRegistry;

  const start = Date.now();
  let interval = REGISTRY_WAIT_INITIAL_DELAY_MS;
  while (Date.now() - start < timeoutMs) {
    await delay(
      Math.min(interval, timeoutMs - (Date.now() - start)),
      undefined,
      { signal },
    );
    if (state.currentModelRegistry) return state.currentModelRegistry;
    interval = Math.min(interval * 2, REGISTRY_WAIT_MAX_DELAY_MS);
  }
  return undefined;
};

export const createErrorMessage = (
  model: Model<Api>,
  message: string,
): AssistantMessage => {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
};

/**
 * Heuristic token estimator (conservative: 3 characters per token)
 */
const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

/**
 * Truncate context to fit within a target token limit by removing oldest messages.
 * Preserves the system prompt and the complete latest user/tool turn.
 */
const truncateContext = (context: Context, limit: number): Context => {
  const messages = [...context.messages];
  if (messages.length <= 1) return context;

  const systemTokens = context.systemPrompt
    ? estimateTokens(context.systemPrompt)
    : 0;

  // Pre-calculate token sizes
  const messageTokens = messages.map((m) =>
    estimateTokens(extractTextFromContent(m.content)),
  );
  const totalTokens =
    systemTokens + messageTokens.reduce((sum, t) => sum + t, 0);

  if (totalTokens <= limit) return context;

  // Drop only complete turns. Splitting an assistant/tool-result pair corrupts transcripts.
  // This text estimate cannot guarantee a fit for images/tools or one oversized active turn.
  const systemMessages = messages.filter(
    (message) => message.role === 'system',
  );
  let remaining = totalTokens;
  let nextRemovableIndex = 0;
  for (let i = 0; i < messages.length && remaining > limit; i += 1) {
    if (messages[i]?.role !== 'user') continue;
    while (nextRemovableIndex < i) {
      const candidate = messages[nextRemovableIndex];
      if (candidate?.role !== 'system') {
        remaining -= messageTokens[nextRemovableIndex] ?? 0;
      }
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

const supportsReasoning = (
  profile: RouterConfig['profiles'][string],
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): boolean => {
  if (!modelRegistry) return false;

  for (const tier of ROUTER_TIERS) {
    const tierConfig = profile[tier];
    if (!tierConfig) continue;
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      if (modelRegistry.find(provider, modelId)?.reasoning) {
        return true;
      }
    } catch (_error) {
      // ignore invalid model refs here; config normalization handles warnings
    }
  }

  return false;
};

export const registerRouterProvider = (
  pi: ExtensionAPI,
  state: {
    lastRegisteredModels: string;
    readonly currentConfig: RouterConfig;
    readonly currentModelRegistry:
      | ExtensionContext['modelRegistry']
      | undefined;
    readonly lastExtensionContext: ExtensionContext | undefined;
    selectedProfile: string | undefined;
    routerEnabled: boolean;
    lastDecision: RoutingDecision | undefined;
    readonly thinkingByProfile: RouterThinkingByProfile;
    readonly pinnedTierByProfile: RouterPinByProfile;
    accumulatedCost: number;
    /** Override for the registry wait timeout (for testing). */
    readonly registryTimeoutMs?: number;
  },
  actions: {
    persistState: () => void;
    recordDebugDecision: (decision: RoutingDecision) => void;
    getThinkingOverride: (
      profileName: string,
      tier: RouterTier,
    ) => ThinkingLevel | undefined;
    updateStatus: (ctx: ExtensionContext) => void;
    syncPiThinkingLevel: (level: ThinkingLevel) => void;
  },
) => {
  const profileList = profileNames(state.currentConfig);

  // Map profiles to their capacities
  const modelDefinitions = profileList.flatMap((name) => {
    const profile = state.currentConfig.profiles[name];
    if (!profile) return [];

    // Report the MAX context window and max output tokens across all tiers.
    // The honesty check + truncateContext handles the case where the
    // actually routed model is smaller.
    let maxContextWindow = 0;
    let maxOutputTokens = 0;
    for (const tier of ROUTER_TIERS) {
      if (!profile[tier]) continue;
      const contextWindow = resolveContextWindow(
        tier,
        profile,
        state.currentModelRegistry,
      );
      const maxTokens = resolveMaxTokens(
        tier,
        profile,
        state.currentModelRegistry,
      );
      if (contextWindow > maxContextWindow) maxContextWindow = contextWindow;
      if (maxTokens > maxOutputTokens) maxOutputTokens = maxTokens;
    }

    const hasReasoning = supportsReasoning(profile, state.currentModelRegistry);
    const profileLevels = collectProfileThinkingLevels(profile);
    // Build thinkingLevelMap from the union of all tier models' declared levels.
    // Only needed if xhigh or max are in the set (pi supports all others by default).
    let thinkingLevelMap: Record<string, string> | undefined;
    if (hasReasoning) {
      const map: Record<string, string> = {};
      if (profileLevels.has('xhigh')) map.xhigh = 'xhigh';
      if (profileLevels.has(MAX_THINKING_LEVEL)) map.max = MAX_THINKING_LEVEL;
      if (Object.keys(map).length > 0) thinkingLevelMap = map;
    }

    return [
      {
        id: name,
        name: `Router ${name}`,
        reasoning: hasReasoning,
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        input: ['text', 'image'] satisfies ('text' | 'image')[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: maxContextWindow || DEFAULT_CONTEXT_WINDOW,
        maxTokens: maxOutputTokens || DEFAULT_MAX_TOKENS,
      },
    ];
  });

  const modelsKey = JSON.stringify(modelDefinitions);
  if (state.lastRegisteredModels === modelsKey) return;

  // Runtime only: no task identities or branch metadata enter persisted decisions.
  type ContinuationRecord = {
    turn: string;
    policy: string;
    branch: string[];
    decision: RoutingDecision;
    toolCalls: Set<string>;
    config: RouterConfig;
  };
  // Streams can complete out of order. Keep a small turn-keyed history rather
  // than letting the latest stream replace another stream's continuation.
  const continuations = new Map<string, ContinuationRecord>();
  const advisedTurns = new Map<string, AdvisorOutcome>();
  const rememberContinuation = (record: ContinuationRecord) => {
    continuations.delete(record.turn);
    continuations.set(record.turn, record);
    while (continuations.size > 16) {
      const oldest = continuations.keys().next().value;
      if (oldest === undefined) break;
      continuations.delete(oldest);
    }
  };
  const rememberAdvisedTurn = (turn: string, outcome: AdvisorOutcome) => {
    advisedTurns.delete(turn);
    advisedTurns.set(turn, outcome);
    while (advisedTurns.size > 16) {
      const oldest = advisedTurns.keys().next().value;
      if (oldest === undefined) break;
      advisedTurns.delete(oldest);
    }
  };

  pi.registerProvider('router', {
    baseUrl: 'router://local',
    apiKey: 'pi-model-router',
    api: 'router-local-api',
    models: modelDefinitions,
    streamSimple(
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
      const stream = createAssistantMessageEventStream();

      void (async () => {
        let partialMessage: AssistantMessage | undefined;
        let activeTurn: string | undefined;
        let generationSucceeded = false;
        try {
          // Wait for the router to be fully initialized (session_start sets currentModelRegistry).
          // This handles the race where subagents (e.g. from pi-dynamic-workflows) invoke
          // the router provider before session_start has fired in their context.
          const registry = await waitForRegistry(
            state,
            state.registryTimeoutMs,
            options?.signal,
          );
          if (!registry) {
            throw new Error(
              'Router provider initialization timed out. session_start may not have fired.',
            );
          }
          const profile = state.currentConfig.profiles[model.id];
          if (!profile) {
            throw new Error(`Unknown router profile: ${model.id}`);
          }

          options?.signal?.throwIfAborted();
          state.selectedProfile = model.id;
          state.routerEnabled = true;

          const pinnedTier = state.pinnedTierByProfile[model.id];
          const isBudgetExceeded =
            state.currentConfig.maxSessionBudget !== undefined &&
            state.accumulatedCost >= state.currentConfig.maxSessionBudget;

          const imageAttached = hasImageAttachment(context);
          const findModel = (provider: string, id: string) =>
            registry.find(provider, id);
          const thinkingOverrides = state.thinkingByProfile[model.id];
          const available = () =>
            availableRoutePairs(
              profile,
              findModel,
              imageAttached,
              thinkingOverrides,
            );
          let pairs = available();
          const lastUserIndex = context.messages.findLastIndex(
            (entry) => entry.role === 'user',
          );
          const user = context.messages[lastUserIndex];
          const turn =
            user?.role === 'user' && user.timestamp > 0
              ? createHash('sha256')
                  .update(
                    JSON.stringify(
                      context.messages.slice(0, lastUserIndex + 1),
                    ),
                  )
                  .digest('hex')
              : undefined;
          activeTurn = turn;
          const branch =
            state.lastExtensionContext?.sessionManager
              .getBranch()
              .filter(
                (entry) =>
                  entry.type !== 'custom' ||
                  entry.customType !== 'router-state',
              )
              .map((entry) => entry.id) ?? [];
          // Pi resolves authentication per request. This validates provider/model
          // identity, not the backend account behind that provider.
          const policy = JSON.stringify([
            model.id,
            profile,
            pinnedTier,
            thinkingOverrides,
            state.currentConfig.classifierModel,
            isBudgetExceeded,
          ]);
          const toolContinuation =
            context.messages.at(-1)?.role === 'toolResult';
          const jev = state.currentConfig.jev;
          const useJev = Boolean(
            jev?.enabled &&
              profile.jev?.enabled &&
              jev.apiKey.trim().length > 0,
          );
          const advisorConfigured =
            useJev || Boolean(state.currentConfig.classifierModel);
          const continuationRecord =
            toolContinuation && turn ? continuations.get(turn) : undefined;
          const continuationDecision = continuationRecord?.decision;
          const latestAssistantIndex = context.messages.findLastIndex(
            (entry) => entry.role === 'assistant',
          );
          const latestResults = context.messages
            .slice(latestAssistantIndex + 1)
            .filter((entry) => entry.role === 'toolResult');
          const latestAssistant = context.messages[latestAssistantIndex];
          const reusable =
            toolContinuation &&
            continuationRecord &&
            continuationDecision &&
            turn &&
            continuationRecord.turn === turn &&
            continuationRecord.policy === policy &&
            continuationRecord.config === state.currentConfig &&
            continuationDecision?.profile === model.id &&
            branch.length > 0 &&
            branch.every((id) => typeof id === 'string' && id.length > 0) &&
            continuationRecord.branch.length > 0 &&
            continuationRecord.branch.every((id, i) => branch[i] === id) &&
            latestResults.length > 0 &&
            latestAssistant?.role === 'assistant' &&
            latestAssistant.provider === continuationDecision.targetProvider &&
            latestAssistant.model === continuationDecision.targetModelId &&
            latestResults.every((entry) =>
              latestAssistant.content.some(
                (part) =>
                  part.type === 'toolCall' && part.id === entry.toolCallId,
              ),
            ) &&
            latestResults.every((entry) =>
              continuationRecord.toolCalls.has(entry.toolCallId),
            ) &&
            pairs.some(
              (pair) =>
                pair.tier === continuationDecision.tier &&
                pair.model === continuationDecision.targetLabel &&
                pair.thinking === continuationDecision.thinking,
            );
          let decision: RoutingDecision;
          if (reusable && continuationDecision) {
            decision = {
              ...continuationDecision,
              reasonCode: 'continuation',
              // Advisor diagnostics describe the original routing attempt only.
              isClassifier: undefined,
              routingLatencyMs: undefined,
              errorClass: undefined,
              timestamp: Date.now(),
            };
          } else {
            if (toolContinuation && turn) continuations.delete(turn);
            const baseline = selectBaselineRoute(
              model.id,
              profile,
              pairs,
              pinnedTier,
              isBudgetExceeded,
            );
            decision = decisionForPair(
              model.id,
              baseline.pair,
              baseline.reasonCode,
            );
            decision.isBudgetForced = baseline.isBudgetForced;
            decision.advisor = advisorConfigured ? 'bypassed' : 'none';
            if (!toolContinuation && turn) {
              const previousAdvisor = advisedTurns.get(turn);
              if (previousAdvisor) decision.advisor = previousAdvisor;
            }
          }

          // Tool results never invoke advisors, even when their prior route cannot be reused.
          if (
            !toolContinuation &&
            !pinnedTier &&
            !isBudgetExceeded &&
            user &&
            turn &&
            !advisedTurns.has(turn) &&
            advisorConfigured
          ) {
            const started = performance.now();
            const routingDeadline = started + (useJev ? 1500 : 10_000);
            const candidates = primaryRoutePairs(profile, pairs).map(
              createJevCandidate,
            );
            // A single primary bypasses advice, not a baseline's eligible fallback.
            if (candidates.length <= 1) {
              decision.advisor = 'bypassed';
              rememberAdvisedTurn(turn, 'bypassed');
            } else if (useJev && jev) {
              decision.advisor = 'jev';
              rememberAdvisedTurn(turn, 'jev');
              const advice = await runJev(
                {
                  ...jev,
                  timeoutMs: Math.min(750, jev.timeoutMs),
                },
                {
                  taskSummary: getBoundedRecentContext(
                    context,
                    jev.maxStateChars,
                  ),
                  candidates,
                  profile: profile.jev,
                  routingDeadline,
                  signal: options?.signal,
                },
              ).catch(() => undefined);
              options?.signal?.throwIfAborted();
              // Re-read registry capabilities after the network boundary.
              pairs = available();
              const candidate = candidates.find(
                (entry) => entry.id === advice?.candidateId,
              );
              if (
                candidate &&
                performance.now() < routingDeadline &&
                pairs.some(
                  (pair) =>
                    pair.model === candidate.model &&
                    pair.tier === candidate.tier &&
                    pair.thinking === candidate.thinking,
                )
              ) {
                decision = {
                  ...decisionForPair(model.id, candidate, 'jev'),
                  advisor: 'jev',
                };
              } else {
                const baseline = selectBaselineRoute(model.id, profile, pairs);
                decision = decisionForPair(
                  model.id,
                  baseline.pair,
                  baseline.reasonCode,
                );
                decision.advisor = 'jev-fallback';
                rememberAdvisedTurn(turn, 'jev-fallback');
                decision.errorClass = 'advisor-unavailable';
              }
              decision.routingLatencyMs = Math.max(
                0,
                performance.now() - started,
              );
              if (performance.now() >= routingDeadline)
                decision.errorClass = 'deadline';
            } else if (state.currentConfig.classifierModel) {
              const classifier = state.currentConfig.classifierModel;
              const result = await runClassifier(
                classifier.model,
                registry,
                context,
                undefined,
                classifier.thinking,
                options?.signal,
                routingDeadline,
              ).catch(() => undefined);
              options?.signal?.throwIfAborted();
              pairs = available();
              const baseline = selectBaselineRoute(model.id, profile, pairs);
              decision = decisionForPair(
                model.id,
                baseline.pair,
                baseline.reasonCode,
              );
              if (result && performance.now() < routingDeadline) {
                const pair = pairs.find((entry) => entry.tier === result.tier);
                if (pair) {
                  decision = {
                    ...decisionForPair(model.id, pair, 'classifier'),
                    isClassifier: true,
                    advisor: 'classifier',
                  };
                  rememberAdvisedTurn(turn, 'classifier');
                } else {
                  decision.advisor = 'classifier-fallback';
                  rememberAdvisedTurn(turn, 'classifier-fallback');
                  decision.errorClass = 'advisor-unavailable';
                }
              } else {
                decision.advisor = 'classifier-fallback';
                rememberAdvisedTurn(turn, 'classifier-fallback');
                decision.errorClass = 'advisor-unavailable';
              }
              decision.routingLatencyMs = Math.max(
                0,
                performance.now() - started,
              );
              if (performance.now() >= routingDeadline)
                decision.errorClass = 'deadline';
            }
          }

          // Google thought signatures cannot be replayed against a different thinking model.
          const priorAssistant = context.messages[latestAssistantIndex];
          if (
            toolContinuation &&
            priorAssistant?.role === 'assistant' &&
            priorAssistant.provider === 'google' &&
            priorAssistant.content.some(
              (entry) =>
                entry.type === 'thinking' ||
                (entry.type === 'toolCall' && entry.thoughtSignature),
            ) &&
            (decision.targetProvider !== priorAssistant.provider ||
              decision.targetModelId !== priorAssistant.model)
          ) {
            const priorPair =
              pairs.find(
                (pair) =>
                  pair.model ===
                    `${priorAssistant.provider}/${priorAssistant.model}` &&
                  pair.tier === continuationDecision?.tier &&
                  pair.thinking === continuationDecision?.thinking,
              ) ??
              pairs.find(
                (pair) =>
                  pair.model ===
                  `${priorAssistant.provider}/${priorAssistant.model}`,
              );
            if (!priorPair)
              throw new Error(
                'No compatible route for Google tool continuation.',
              );
            decision = {
              ...decisionForPair(model.id, priorPair, 'continuation'),
              advisor: decision.advisor,
            };
          }

          state.lastDecision = decision;

          // Sync pi's thinking level display with the router's effective thinking.
          // Wrapped in try/catch: in subagent contexts the extension runtime
          // may be invalidated (stale) after session teardown.
          const effectiveThinking =
            actions.getThinkingOverride(model.id, decision.tier) ??
            decision.thinking;
          try {
            actions.syncPiThinkingLevel(effectiveThinking);
            if (state.lastExtensionContext) {
              actions.updateStatus(state.lastExtensionContext);
            }
          } catch {
            // Stale extension context — skip non-critical UI updates.
          }

          // Explicit fallback refs authorize provider changes; never discover other accounts.
          const modelsToTry = [
            decision.targetLabel,
            ...(profile[decision.tier]?.fallbacks ?? []),
          ].filter((ref, i, refs) => refs.indexOf(ref) === i);
          let lastError: unknown;
          let success = false;

          for (const [i, modelRef] of modelsToTry.entries()) {
            options?.signal?.throwIfAborted();
            const { provider: targetProvider, modelId: targetModelId } =
              parseCanonicalModelRef(modelRef);

            if (targetProvider === 'router') continue;

            const targetModel = registry.find(targetProvider, targetModelId);
            if (!targetModel) {
              lastError = new Error(
                `Routed model not found: ${targetProvider}/${targetModelId}`,
              );
              continue;
            }

            let contentReceived = false;
            try {
              // HONESTY CHECK & AUTO-TRUNCATION
              // If the picked model has a smaller context than what we reported, truncate now.
              let effectiveContext = context;
              const targetLimit =
                targetModel.contextWindow ??
                resolveContextWindow(decision.tier, profile, registry);
              if (
                model.contextWindow !== undefined &&
                targetLimit < model.contextWindow
              ) {
                effectiveContext = truncateContext(context, targetLimit);
              }

              const pair = available().find(
                (candidate) =>
                  candidate.tier === decision.tier &&
                  candidate.model === modelRef,
              );
              if (!pair)
                throw new Error(
                  'Routed model capabilities or thinking are unsupported.',
                );
              if (
                toolContinuation &&
                priorAssistant?.role === 'assistant' &&
                priorAssistant.provider === 'google' &&
                priorAssistant.content.some(
                  (entry) =>
                    entry.type === 'thinking' ||
                    (entry.type === 'toolCall' && entry.thoughtSignature),
                ) &&
                (targetProvider !== priorAssistant.provider ||
                  targetModelId !== priorAssistant.model)
              ) {
                throw new Error(
                  'No compatible route for Google tool continuation.',
                );
              }
              const delegatedReasoning: SimpleStreamOptions['reasoning'] =
                pair.thinking !== 'off' ? pair.thinking : undefined;

              try {
                if (state.lastExtensionContext) {
                  if (delegatedReasoning) {
                    state.lastExtensionContext.ui.setHiddenThinkingLabel?.(
                      `Thinking (${targetProvider}/${targetModelId})...`,
                    );
                  } else {
                    state.lastExtensionContext.ui.setHiddenThinkingLabel?.();
                  }
                }
              } catch {
                // Stale extension context — skip non-critical UI updates.
              }

              // Router credentials must not override the concrete provider's request auth.
              const {
                reasoning: _piReasoning,
                apiKey: _routerKey,
                headers: _routerHeaders,
                env: _routerEnv,
                ...delegationOptions
              } = options ?? {};

              const delegatedOptions: SimpleStreamOptions = {
                ...delegationOptions,
                ...(delegatedReasoning
                  ? { reasoning: delegatedReasoning }
                  : {}),
              };
              // Pi owns request-time auth, custom/native providers, URLs and transcript normalization.
              const delegatedStream = registry.streamSimple(
                targetModel,
                effectiveContext,
                delegatedOptions,
              );
              let terminalReceived = false;
              const pendingEvents: AssistantMessageEvent[] = [];
              const recordTarget = () => {
                decision.targetProvider = targetProvider;
                decision.targetModelId = targetModelId;
                decision.targetLabel = modelRef;
                decision.thinking = delegatedReasoning ?? 'off';
                decision.isFallback =
                  i > 0 || modelRef !== profile[decision.tier]?.model;
                if (
                  decision.isFallback &&
                  decision.reasonCode !== 'continuation'
                )
                  decision.reasonCode = 'fallback';
              };
              for await (const event of delegatedStream) {
                if (
                  event.type === 'error' &&
                  event.reason !== 'aborted' &&
                  !contentReceived
                ) {
                  const errorMessage =
                    'error' in event &&
                    event.error &&
                    typeof event.error === 'object' &&
                    'errorMessage' in event.error &&
                    typeof event.error.errorMessage === 'string'
                      ? event.error.errorMessage
                      : undefined;
                  throw new Error(
                    errorMessage || 'Model failed before sending content.',
                  );
                }
                const isContent =
                  event.type === 'text_delta' ||
                  event.type === 'thinking_delta' ||
                  event.type === 'toolcall_delta' ||
                  event.type === 'toolcall_end';
                if (isContent) {
                  contentReceived = true;
                  recordTarget();
                }
                if (event.type === 'done' || event.type === 'error') {
                  terminalReceived = true;
                  generationSucceeded = event.type === 'done';
                  recordTarget();
                  const cost = (
                    event.type === 'done' ? event.message : event.error
                  ).usage.cost.total;
                  if (event.type === 'done' && turn) {
                    rememberContinuation({
                      turn,
                      policy,
                      branch,
                      decision,
                      config: state.currentConfig,
                      toolCalls: new Set(
                        event.message.content.flatMap((entry) =>
                          entry.type === 'toolCall' ? [entry.id] : [],
                        ),
                      ),
                    });
                  }
                  if (Number.isFinite(cost) && cost > 0)
                    state.accumulatedCost += cost;
                }
                if (contentReceived || terminalReceived) {
                  for (const pending of pendingEvents.splice(0))
                    stream.push(pending);
                  stream.push(event);
                  if ('partial' in event) partialMessage = event.partial;
                } else {
                  pendingEvents.push(event);
                }
                if (terminalReceived) break;
              }
              if (!terminalReceived)
                throw new Error(
                  'Provider stream ended without a terminal event.',
                );
              success = true;
              break;
            } catch (err) {
              if (contentReceived || options?.signal?.aborted) throw err;
              lastError = err;
            }
          }

          if (!success) {
            throw lastError instanceof Error
              ? lastError
              : new Error(
                  typeof lastError === 'string'
                    ? lastError
                    : 'Failed to delegate to any model in the chain.',
                );
          }

          actions.recordDebugDecision(decision);
          stream.end();
        } catch (error) {
          const reason = options?.signal?.aborted ? 'aborted' : 'error';
          stream.push({
            type: 'error',
            reason,
            error: {
              ...(partialMessage ?? createErrorMessage(model, '')),
              errorMessage:
                error instanceof Error ? error.message : String(error),
              stopReason: reason,
            },
          });
          stream.end();
        } finally {
          if (!generationSucceeded && activeTurn)
            advisedTurns.delete(activeTurn);
          try {
            actions.persistState();
          } catch {
            // Ignore: extension context may be stale after session teardown.
          }
        }
      })();

      return stream;
    },
  });

  state.lastRegisteredModels = modelsKey;
};
