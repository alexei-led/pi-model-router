import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type Api,
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
import { profileNames, resolveContextWindow, resolveMaxTokens } from './config';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './constants';
import { MAX_THINKING_LEVEL, parseCanonicalModelRef } from './domain';
import { startRouterProviderStream } from './provider-runtime';
import { createProviderTurnCache } from './provider-turns';
import { availableRoutePairs } from './routing';
import type {
  RouterConfig,
  RouterPinByProfile,
  RouterRequestObservation,
  RouterThinkingByProfile,
  RoutingDecision,
} from './types';
import { ROUTER_TIERS } from './types';

const supportsReasoning = (
  profile: RouterConfig['profiles'][string],
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): boolean => {
  if (!modelRegistry) return false;

  for (const tierConfig of [
    profile,
    ...Object.values(profile.activities ?? {}),
  ].flatMap((cell) =>
    ROUTER_TIERS.flatMap((tier) => (cell[tier] ? [cell[tier]] : [])),
  )) {
    if (!tierConfig) continue;
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      if (modelRegistry.find(provider, modelId)?.reasoning) return true;
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
    readonly requestEpoch?: number;
    readonly ownerSignal?: AbortSignal;
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
    readonly registryTimeoutMs?: number;
  },
  actions: {
    persistState: () => void;
    recordDebugDecision: (decision: RoutingDecision) => void;
    updateStatus: (ctx: ExtensionContext) => void;
    syncPiThinkingLevel: (level: ThinkingLevel) => void;
    beginRequest?: (
      profile: string,
    ) => (event: RouterRequestObservation) => void;
  },
) => {
  const profileList = profileNames(state.currentConfig);
  const modelDefinitions = profileList.flatMap((name) => {
    const profile = state.currentConfig.profiles[name];
    if (!profile) return [];

    let maxContextWindow = 0;
    let maxOutputTokens = 0;
    const cells = [
      profile,
      ...(state.currentConfig.activityRouting !== 'off'
        ? Object.values(profile.activities ?? {})
        : []),
    ];
    for (const cell of cells)
      for (const tier of ROUTER_TIERS) {
        if (!cell[tier]) continue;
        const contextWindow = resolveContextWindow(
          tier,
          cell,
          state.currentModelRegistry,
        );
        const maxTokens = resolveMaxTokens(
          tier,
          cell,
          state.currentModelRegistry,
        );
        if (contextWindow > maxContextWindow) maxContextWindow = contextWindow;
        if (maxTokens > maxOutputTokens) maxOutputTokens = maxTokens;
      }

    const hasReasoning = cells.some((cell) =>
      supportsReasoning(cell, state.currentModelRegistry),
    );
    const registry = state.currentModelRegistry;
    const runsLevel = (level: ThinkingLevel): boolean =>
      cells.some((cell) =>
        [false, true].some((imageAttached) =>
          availableRoutePairs(
            cell,
            (provider, id) => registry?.find(provider, id),
            imageAttached,
            Object.fromEntries(ROUTER_TIERS.map((tier) => [tier, level])),
          ).some((pair) => pair.thinking === level),
        ),
      );
    let thinkingLevelMap: Record<string, string> | undefined;
    if (hasReasoning) {
      const map: Record<string, string> = {};
      if (runsLevel('xhigh')) map.xhigh = 'xhigh';
      if (runsLevel(MAX_THINKING_LEVEL)) map.max = MAX_THINKING_LEVEL;
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

  const modelsKey = JSON.stringify([state.requestEpoch, modelDefinitions]);
  if (state.lastRegisteredModels === modelsKey) return;

  const turnCache = createProviderTurnCache();
  const registrationSignal = state.ownerSignal;
  const registrationEpoch = state.requestEpoch;
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
      startRouterProviderStream({
        ...(registrationEpoch !== undefined ? { registrationEpoch } : {}),
        model,
        context,
        options: {
          ...options,
          ...(registrationSignal
            ? {
                signal: options?.signal
                  ? AbortSignal.any([registrationSignal, options.signal])
                  : registrationSignal,
              }
            : {}),
        },
        stream,
        state,
        cache: turnCache,
        actions: {
          persistState: actions.persistState,
          recordDebugDecision: actions.recordDebugDecision,
          updateStatus: () => {
            if (state.lastExtensionContext)
              actions.updateStatus(state.lastExtensionContext);
          },
          syncPiThinkingLevel: actions.syncPiThinkingLevel,
          ...(actions.beginRequest
            ? { beginRequest: actions.beginRequest }
            : {}),
        },
      });
      return stream;
    },
  });

  state.lastRegisteredModels = modelsKey;
};
