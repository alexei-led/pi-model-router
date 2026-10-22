import { setTimeout as delay } from 'node:timers/promises';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { modeForProfile } from './modes';
import type { GenerationOutcome } from './provider-generation';
import { runGenerationAttempts } from './provider-generation';
import {
  createRouterRequestIdentity,
  prepareRouterRequest,
} from './provider-request';
import type { ProviderTurnCache } from './provider-turns';
import type {
  RouterConfig,
  RouterMode,
  RouterPinByProfile,
  RouterRequestObservation,
  RouterThinkingByProfile,
  RoutingDecision,
} from './types';

const REGISTRY_WAIT_TIMEOUT_MS = 5000;
const REGISTRY_WAIT_INITIAL_DELAY_MS = 50;
const REGISTRY_WAIT_MAX_DELAY_MS = 500;

type RequestContext = {
  sessionManager: Pick<
    ExtensionContext['sessionManager'],
    'getBranch' | 'getSessionId'
  >;
  ui: Pick<ExtensionContext['ui'], 'setHiddenThinkingLabel'>;
};

interface ProviderStreamState {
  readonly requestEpoch?: number;
  readonly ownerSignal?: AbortSignal;
  readonly currentModelRegistry: ExtensionContext['modelRegistry'] | undefined;
  readonly currentConfig: RouterConfig;
  readonly lastExtensionContext: RequestContext | undefined;
  readonly pinnedTierByProfile: RouterPinByProfile;
  readonly thinkingByProfile: RouterThinkingByProfile;
  readonly modeOverride?: RouterMode | undefined;
  selectedProfile: string | undefined;
  routerEnabled: boolean;
  lastDecision: RoutingDecision | undefined;
  accumulatedCost: number;
  readonly registryTimeoutMs?: number;
}

interface ProviderStreamActions {
  persistState: () => void;
  recordDebugDecision: (decision: RoutingDecision) => void;
  updateStatus: () => void;
  syncPiThinkingLevel: (level: ThinkingLevel) => void;
  beginRequest?: (profile: string) => (event: RouterRequestObservation) => void;
}

interface RouterStreamInput {
  registrationSignal?: AbortSignal;
  registrationEpoch?: number;
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
  stream: AssistantMessageEventStream;
  state: ProviderStreamState;
  actions: ProviderStreamActions;
  cache: ProviderTurnCache;
}

interface PreparedStreamRequest {
  request: Awaited<ReturnType<typeof prepareRouterRequest>>;
  registry: NonNullable<ProviderStreamState['currentModelRegistry']>;
}

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

const prepareStreamRequest = async (
  input: RouterStreamInput,
  onTurnIdentified: (turn: string | undefined) => void,
): Promise<PreparedStreamRequest> => {
  const { model, context, options, state, cache } = input;
  const registry = await waitForRegistry(
    state,
    state.registryTimeoutMs,
    options?.signal,
  );
  if (!registry)
    throw new Error(
      'Router provider initialization timed out. session_start may not have fired.',
    );

  const config = state.currentConfig;
  const profile = Object.hasOwn(config.profiles, model.id)
    ? config.profiles[model.id]
    : undefined;
  if (!profile) throw new Error(`Unknown router profile: ${model.id}`);
  options?.signal?.throwIfAborted();
  state.selectedProfile = model.id;
  state.routerEnabled = true;

  const pinnedTier = Object.hasOwn(state.pinnedTierByProfile, model.id)
    ? state.pinnedTierByProfile[model.id]
    : undefined;
  const thinkingOverrides = Object.hasOwn(state.thinkingByProfile, model.id)
    ? state.thinkingByProfile[model.id]
    : undefined;
  const extensionContext = state.lastExtensionContext;
  const branch =
    extensionContext?.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type !== 'custom' || entry.customType !== 'router-state',
      )
      .map((entry) => entry.id) ?? [];
  const sessionId =
    extensionContext?.sessionManager.getSessionId?.() ?? options?.sessionId;
  const identity = createRouterRequestIdentity(context, sessionId, branch);
  onTurnIdentified(identity.turn);
  const modeFor = (current: RouterConfig) =>
    modeForProfile(current, model.id, state.modeOverride);
  const request = await prepareRouterRequest({
    profileName: model.id,
    profile,
    config,
    getCurrentConfig: () => state.currentConfig,
    context,
    registry,
    identity,
    ...(pinnedTier ? { pinnedTier } : {}),
    ...(thinkingOverrides ? { thinkingOverrides } : {}),
    mode: modeFor(config),
    getCurrentMode: () => modeFor(state.currentConfig),
    accumulatedCost: state.accumulatedCost,
    lastDecision: state.lastDecision,
    ...(options?.signal ? { signal: options.signal } : {}),
    cache,
    onReview: (decision) => {
      input.actions.recordDebugDecision(decision);
      input.actions.persistState();
      input.actions.updateStatus();
    },
  });
  return { request, registry };
};

const runGeneration = async (
  input: RouterStreamInput,
  prepared: PreparedStreamRequest,
  observe: (event: RouterRequestObservation) => void,
): Promise<GenerationOutcome> => {
  const { model, context, options, state, actions, stream, cache } = input;
  const { request, registry } = prepared;
  const decision = request.decision;
  state.lastDecision = decision;
  observe({ stage: 'selected', decision });

  let shownThinking = decision.thinking;
  try {
    actions.syncPiThinkingLevel(shownThinking);
    actions.updateStatus();
  } catch {
    // Stale extension context — skip non-critical UI updates.
  }

  return await runGenerationAttempts({
    model,
    context,
    ...(options ? { options } : {}),
    stream,
    registry,
    request,
    cache,
    onCost: (cost) => {
      state.accumulatedCost += cost;
    },
    onObservation: observe,
    onAttemptTarget: (target, thinking) => {
      try {
        if (thinking !== shownThinking) {
          actions.syncPiThinkingLevel(thinking);
          shownThinking = thinking;
        }
        const ui = input.state.lastExtensionContext?.ui;
        if (thinking !== 'off') {
          ui?.setHiddenThinkingLabel?.(
            `Thinking (${target.provider}/${target.modelId})...`,
          );
        } else {
          ui?.setHiddenThinkingLabel?.();
        }
      } catch {
        // Stale extension context — skip non-critical UI updates.
      }
    },
  });
};

const startStream = (input: RouterStreamInput): void => {
  const { model, options, stream, actions, cache } = input;
  let observer: ((event: RouterRequestObservation) => void) | undefined;
  try {
    observer = actions.beginRequest?.(model.id);
  } catch {
    observer = undefined;
  }
  const observe = (event: RouterRequestObservation) => {
    try {
      observer?.(event);
    } catch {
      // UI cannot change routing or retries.
    }
  };

  void (async () => {
    let partialMessage: AssistantMessage | undefined;
    let activeTurn: string | undefined;
    let generationSucceeded = false;
    let persistenceCompleted = false;
    try {
      const prepared = await prepareStreamRequest(input, (turn) => {
        activeTurn = turn;
      });
      const outcome = await runGeneration(input, prepared, observe);
      generationSucceeded = outcome.generationSucceeded;
      if (outcome.status === 'failed') {
        partialMessage = outcome.partialMessage;
        if (outcome.exhausted)
          actions.recordDebugDecision({
            ...prepared.request.decision,
            isGenerationFailed: true,
          });
        throw outcome.error;
      }
      actions.recordDebugDecision(prepared.request.decision);
      try {
        actions.persistState();
        persistenceCompleted = true;
      } catch {
        // Ignore: extension context may be stale after session teardown.
      }
      stream.push(outcome.terminalEvent);
      observe({
        stage: outcome.generationAborted
          ? 'cancelled'
          : outcome.terminalEvent.type === 'done'
            ? 'complete'
            : 'failed',
        decision: prepared.request.decision,
      });
      stream.end();
    } catch (error) {
      const reason =
        options?.signal?.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
          ? 'aborted'
          : 'error';
      observe({ stage: reason === 'aborted' ? 'cancelled' : 'failed' });
      try {
        actions.persistState();
        persistenceCompleted = true;
      } catch {
        // Ignore: extension context may be stale after session teardown.
      }
      stream.push({
        type: 'error',
        reason,
        error: {
          ...(partialMessage ?? createErrorMessage(model, '')),
          errorMessage: error instanceof Error ? error.message : String(error),
          stopReason: reason,
        },
      });
      stream.end();
    } finally {
      if (!generationSucceeded && activeTurn)
        cache.deleteAdvisedDecision(activeTurn);
      try {
        actions.updateStatus();
      } catch {
        // UI teardown must not prevent cost and decision persistence.
      }
      if (!persistenceCompleted) {
        try {
          actions.persistState();
        } catch {
          // Ignore: extension context may be stale after session teardown.
        }
      }
    }
  })();
};

export const startRouterProviderStream = (input: RouterStreamInput): void => {
  const epoch = input.registrationEpoch ?? input.state.requestEpoch;
  const ownerSignal = input.state.ownerSignal;
  const isCurrent = () =>
    input.state.requestEpoch === epoch &&
    !ownerSignal?.aborted &&
    !input.registrationSignal?.aborted;
  const signal =
    ownerSignal && input.options?.signal
      ? AbortSignal.any([ownerSignal, input.options.signal])
      : (ownerSignal ?? input.options?.signal);
  const guardedActions: ProviderStreamActions = {
    persistState: () => {
      if (isCurrent()) input.actions.persistState();
    },
    recordDebugDecision: (decision) => {
      if (isCurrent()) input.actions.recordDebugDecision(decision);
    },
    updateStatus: () => {
      if (isCurrent()) input.actions.updateStatus();
    },
    syncPiThinkingLevel: (level) => {
      if (
        isCurrent() &&
        input.state.routerEnabled &&
        input.state.selectedProfile === input.model.id
      )
        input.actions.syncPiThinkingLevel(level);
    },
    beginRequest: (profile) => {
      const observe = isCurrent()
        ? input.actions.beginRequest?.(profile)
        : undefined;
      return (event) => {
        if (isCurrent()) observe?.(event);
      };
    },
  };
  const state: ProviderStreamState = {
    get currentModelRegistry() {
      return input.state.currentModelRegistry;
    },
    get currentConfig() {
      return input.state.currentConfig;
    },
    get lastExtensionContext() {
      return input.state.lastExtensionContext;
    },
    get pinnedTierByProfile() {
      return input.state.pinnedTierByProfile;
    },
    get thinkingByProfile() {
      return input.state.thinkingByProfile;
    },
    get modeOverride() {
      return input.state.modeOverride;
    },
    get selectedProfile() {
      return input.state.selectedProfile;
    },
    set selectedProfile(value) {
      if (isCurrent()) input.state.selectedProfile = value;
    },
    get routerEnabled() {
      return input.state.routerEnabled;
    },
    set routerEnabled(value) {
      if (isCurrent()) input.state.routerEnabled = value;
    },
    get lastDecision() {
      return input.state.lastDecision;
    },
    set lastDecision(value) {
      if (isCurrent()) input.state.lastDecision = value;
    },
    get accumulatedCost() {
      return input.state.accumulatedCost;
    },
    set accumulatedCost(value) {
      if (isCurrent()) input.state.accumulatedCost = value;
    },
    ...(input.state.registryTimeoutMs !== undefined
      ? { registryTimeoutMs: input.state.registryTimeoutMs }
      : {}),
  };
  startStream({
    ...input,
    state,
    actions: guardedActions,
    options: { ...input.options, ...(signal ? { signal } : {}) },
  });
};

export const createErrorMessage = (
  model: Model<Api>,
  message: string,
): AssistantMessage => ({
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
});
