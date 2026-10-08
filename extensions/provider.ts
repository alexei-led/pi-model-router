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

  for (const tier of ROUTER_TIERS) {
    const tierConfig = profile[tier];
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
    const registry = state.currentModelRegistry;
    const runsLevel = (level: ThinkingLevel): boolean =>
      [false, true].some((imageAttached) =>
        availableRoutePairs(
          profile,
          (provider, id) => registry?.find(provider, id),
          imageAttached,
          Object.fromEntries(ROUTER_TIERS.map((tier) => [tier, level])),
        ).some((pair) => pair.thinking === level),
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

  const modelsKey = JSON.stringify(modelDefinitions);
  if (state.lastRegisteredModels === modelsKey) return;

  const turnCache = createProviderTurnCache();
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
        model,
        context,
        ...(options ? { options } : {}),
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
