import { createHash } from 'node:crypto';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { DEFAULT_MODES, normalizeAdvisorConfig } from '../config';
import { isThinkingLevel, parseCanonicalModelRef } from '../domain';
import { effectivePolicy, modeBypassFor, modeForProfile } from '../modes';
import {
  availableRoutePairs,
  preservesRouteCoverage,
  resolveRoutePair,
  routeThinking,
} from '../routing';
import { snapshotDecision } from '../state';
import type {
  ModelDefinition,
  RoutedTierConfig,
  RouterActivity,
  RouterProfile,
  RouterRequestObservation,
  RouterThinkingByTier,
  RouterTier,
  RouterUIActivityCell,
  RouterUIAdapters,
  RouterUIChatModel,
  RouterUIControls,
  RouterUIHistoryEntry,
  RouterUILifecycle,
  RouterUIPendingControls,
  RouterUIPolicyControl,
  RouterUIPolicySource,
  RouterUIRoute,
  RouterUIRouteCellState,
  RouterUIRouteSelection,
  RouterUIRuntimeState,
  RouterUISnapshot,
  RoutingDecision,
} from '../types';
import {
  ROUTER_ACTIVITIES,
  ROUTER_TIERS,
  ROUTER_UI_POLICY_CONTROLS,
} from '../types';
import { validateRouterUIControls } from './controls';
import { routePreferences } from './preview';

const thinkingFields = {
  high: 'thinkingHigh',
  medium: 'thinkingMedium',
  low: 'thinkingLow',
  micro: 'thinkingMicro',
} as const;
const routeKey = (activity: RouterActivity, tier: RouterTier): string =>
  `${activity}/${tier}`;
const routeRevision = (route: RoutedTierConfig): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        model: route.model,
        thinking: route.thinking,
        thinkingExplicit: route.thinkingExplicit,
        fallbacks: route.fallbacks,
        resolvedFallbacks: route.resolvedFallbacks,
        contextWindow: route.contextWindow,
        maxTokens: route.maxTokens,
        reasoning: route.reasoning,
        thinkingLevels: route.thinkingLevels,
        resolvedContextWindow: route.resolvedContextWindow,
        resolvedMaxTokens: route.resolvedMaxTokens,
      }),
    )
    .digest('hex')
    .slice(0, 20);
const routeStateEqual = (
  left: RouterUIRouteCellState,
  right: RouterUIRouteCellState,
): boolean =>
  left.state === right.state &&
  left.revision === right.revision &&
  left.model === right.model &&
  left.thinking === right.thinking &&
  left.fallbacks.length === right.fallbacks.length &&
  left.fallbacks.every(
    (fallback, index) => fallback === right.fallbacks[index],
  );
interface RouterUIRouteOverride extends RouterUIRouteSelection {
  fallbacks: string[];
  revision?: string | undefined;
  resolvedFallbacks?: ModelDefinition[] | undefined;
}
interface PendingRouterUIRoute {
  base: RouterUIRouteCellState;
  value: RouterUIRouteOverride | undefined;
}
const routeOf = (decision: RoutingDecision): RouterUIRoute => ({
  activity: decision.activity,
  routeCell: decision.routeCell,
  tier: decision.tier,
  provider: decision.targetProvider,
  model: decision.targetModelId,
  thinking: decision.thinking,
});
const recommendationOf = (
  decision: RoutingDecision,
): RouterUIRoute | undefined => {
  if (!decision.proposedRoute) return undefined;
  const model = parseCanonicalModelRef(decision.proposedRoute.model);
  return {
    activity: decision.proposedRoute.activity,
    tier: decision.proposedRoute.tier,
    provider: model.provider,
    model: model.modelId,
    thinking: decision.proposedRoute.thinking,
  };
};
const historyOf = (decision: RoutingDecision): RouterUIHistoryEntry => {
  const metrics = decision.classification;
  return {
    reason: decision.reasonCode,
    reviewOnly: decision.reviewOnly,
    actual:
      !decision.reviewOnly && decision.generation
        ? routeOf(decision)
        : undefined,
    proposed: recommendationOf(decision),
    switchCost: decision.switchCost,
    advice:
      metrics ||
      decision.advisor === 'classifier' ||
      decision.advisor === 'classifier-fallback'
        ? {
            profile: decision.profile,
            source: decision.adviceSource,
            advisor: metrics?.model ?? 'Classifier',
            requestId: metrics?.requestId,
            outcome:
              metrics?.outcome ??
              (decision.advisor === 'classifier'
                ? 'selected'
                : decision.errorClass === 'deadline'
                  ? 'deadline'
                  : 'unavailable'),
            latencyMs: metrics?.latencyMs ?? decision.routingLatencyMs,
            httpAttempts: metrics?.attempts,
            costUsd: metrics?.costUsd,
          }
        : undefined,
    reuse: decision.reuse,
    generationCostUsd: decision.generation?.reportedCostUsd,
    generationAttempts: decision.generation?.attempts,
    inputTokens: decision.generation?.inputTokens,
    outputTokens: decision.generation?.outputTokens,
    cacheReadTokens: decision.generation?.cacheReadTokens,
    cacheWriteTokens: decision.generation?.cacheWriteTokens,
  };
};
const lifecycleOf = (
  decision: RoutingDecision,
  active: boolean,
): RouterUILifecycle =>
  decision.isFallback
    ? 'fallback'
    : decision.isBudgetForced
      ? 'budget'
      : decision.reuse === 'continuation'
        ? 'continuation'
        : decision.classification?.outcome === 'deadline'
          ? 'timeout'
          : active
            ? 'generating'
            : 'idle';

/** Owns transient UI state only. Routing remains in the provider and policy modules. */
export const createRouterUIRuntime = (
  state: RouterUIRuntimeState,
  changed: () => void,
) => {
  const pending = new Map<string, RouterUIPendingControls>();
  const pendingRoutes = new Map<string, Map<string, PendingRouterUIRoute>>();
  let sessionPending: RouterUIPendingControls | undefined;
  const globalFields = new Set<keyof RouterUIControls>([
    'mode',
    'advisor',
    'timeout',
    'budget',
    'reviewEveryRequests',
    'costHorizon',
    'costSensitivity',
    'strongAdviceConfidence',
  ]);
  const edited = (
    entry: RouterUIPendingControls | undefined,
  ): (keyof RouterUIControls)[] =>
    entry
      ? (Object.keys(entry.value) as (keyof RouterUIControls)[]).filter(
          (key) => entry.value[key] !== entry.base[key],
        )
      : [];
  const listeners = new Set<() => void>();
  let controller = new AbortController();
  let epoch = 0;
  let lifecycle: RouterUILifecycle = 'idle';
  let observedProfile: string | undefined;
  let actual: RouterUIRoute | undefined;
  let advised: RouterUIRoute | undefined;
  let observation: RoutingDecision | undefined;
  let historySource: readonly RoutingDecision[] | undefined;
  let historyProfile: string | undefined;
  let history: RouterUIHistoryEntry[] = [];
  let lastAdvice:
    | {
        startedAt: number;
        advice: RouterUIHistoryEntry['advice'];
      }
    | undefined;
  const publish = () => {
    for (const refresh of listeners) {
      try {
        refresh();
      } catch {
        /* Teardown must not affect generation. */
      }
    }
  };
  const modeOf = (profile: string) =>
    modeForProfile(state.currentConfig, profile, state.modeOverride);
  const policySources = (
    profile: string,
  ): Record<RouterUIPolicyControl, RouterUIPolicySource> => {
    const config = state.currentConfig;
    const patch = (config.modes ?? DEFAULT_MODES)[modeOf(profile).mode].policy;
    return Object.fromEntries(
      Object.entries(ROUTER_UI_POLICY_CONTROLS).map(([control, key]) => [
        control,
        config.sessionPolicy?.[key] !== undefined
          ? 'session'
          : patch[key] !== undefined
            ? 'mode'
            : 'config',
      ]),
    ) as Record<RouterUIPolicyControl, RouterUIPolicySource>;
  };
  const controls = (profile: string): RouterUIControls => {
    const config = state.currentConfig;
    const thinking = state.thinkingByProfile[profile];
    const policy = effectivePolicy(config, modeOf(profile).mode);
    return {
      mode: state.modeOverride,
      pin: state.pinnedTierByProfile[profile] ?? 'auto',
      baseline: config.profiles[profile]?.baselineTier ?? 'auto',
      budget: config.maxSessionBudget,
      advisor: config.advisor?.model,
      timeout: config.advisor?.timeoutMs ?? 10_000,
      reviewEveryRequests: config.advisor?.reviewEveryRequests ?? 4,
      costHorizon: policy.horizonRequests,
      costSensitivity: policy.costSensitivity,
      strongAdviceConfidence: policy.strongAdviceConfidence,
      thinkingHigh: thinking?.high,
      thinkingMedium: thinking?.medium,
      thinkingLow: thinking?.low,
      thinkingMicro: thinking?.micro,
    };
  };
  const pendingValue = (profile: string): RouterUIControls | undefined => {
    const entries = [sessionPending, pending.get(profile)];
    if (!entries.some(Boolean)) return undefined;
    const value = controls(profile);
    for (const entry of entries)
      if (entry)
        for (const key of edited(entry))
          Object.assign(value, { [key]: entry.value[key] });
    return value;
  };
  const policyLayers = () => {
    const { switchPolicy, modes, sessionPolicy } = state.currentConfig;
    return JSON.stringify([switchPolicy, modes, sessionPolicy]);
  };
  const queue = (
    global: boolean,
    base: RouterUIControls,
    next: RouterUIControls,
    previous: RouterUIPendingControls | undefined,
  ): RouterUIPendingControls | undefined => {
    const entry = {
      base: { ...base },
      value: { ...base },
      policyLayers: previous?.policyLayers ?? policyLayers(),
    };
    for (const key of Object.keys(base) as (keyof RouterUIControls)[]) {
      if (globalFields.has(key) !== global || next[key] === base[key]) continue;
      Object.assign(entry.value, { [key]: next[key] });
      if (previous && previous.value[key] !== previous.base[key])
        Object.assign(entry.base, { [key]: previous.base[key] });
    }
    return edited(entry).length ? entry : undefined;
  };
  const thinkingOf = (value: RouterUIControls): RouterThinkingByTier =>
    Object.fromEntries(
      ROUTER_TIERS.filter(
        (tier) => value[thinkingFields[tier]] !== undefined,
      ).map((tier) => [tier, value[thinkingFields[tier]]]),
    );
  const chatModelCatalog = (): {
    entries: RouterUIChatModel[];
    find: (
      model: string,
    ) => ReturnType<NonNullable<typeof state.currentModelRegistry>['find']>;
  } => {
    const registry = state.currentModelRegistry;
    const models =
      typeof registry?.getModelsOfType === 'function'
        ? registry.getModelsOfType('chat')
        : [];
    const physical = models.filter(
      (model) => model.provider !== 'router' && model.input.includes('text'),
    );
    const find = (reference: string) => {
      try {
        const { provider, modelId } = parseCanonicalModelRef(reference);
        if (provider === 'router') return undefined;
        const model = registry?.find(provider, modelId);
        return model?.provider === provider && model.id === modelId
          ? model
          : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      entries: physical
        .map((model) => ({
          model: `${model.provider}/${model.id}`,
          name: model.name,
          efforts: getSupportedThinkingLevels(model).filter(isThinkingLevel),
        }))
        .sort((left, right) => left.model.localeCompare(right.model)),
      find,
    };
  };
  const routeState = (
    profileName: string,
    activity: RouterActivity,
    tier: RouterTier,
  ): RouterUIRouteCellState => {
    const profile = state.currentConfig.profiles[profileName];
    const override = profile?.activities?.[activity]?.[tier];
    const generic = profile?.[tier];
    const declaration = override ?? generic;
    if (!declaration) return { state: 'missing', fallbacks: [] };
    const stateValue = override
      ? override.activitySource === 'builtin'
        ? 'builtin'
        : 'override'
      : 'inherited';
    try {
      const { provider, modelId } = parseCanonicalModelRef(declaration.model);
      return {
        state: stateValue,
        revision: routeRevision(declaration),
        model: `${provider}/${modelId}`,
        thinking: declaration.thinking ?? (tier === 'micro' ? 'off' : tier),
        fallbacks: [...(declaration.fallbacks ?? [])],
      };
    } catch {
      return {
        state: stateValue,
        revision: routeRevision(declaration),
        thinking: declaration.thinking ?? (tier === 'micro' ? 'off' : tier),
        fallbacks: [...(declaration.fallbacks ?? [])],
      };
    }
  };
  const genericRouteState = (
    profileName: string,
    tier: RouterTier,
  ): RouterUIRouteCellState => {
    const profile = state.currentConfig.profiles[profileName];
    const declaration = profile?.[tier];
    if (!declaration) return { state: 'missing', fallbacks: [] };
    try {
      const { provider, modelId } = parseCanonicalModelRef(declaration.model);
      return {
        state: 'inherited',
        revision: routeRevision(declaration),
        model: `${provider}/${modelId}`,
        thinking: declaration.thinking ?? (tier === 'micro' ? 'off' : tier),
        fallbacks: [...(declaration.fallbacks ?? [])],
      };
    } catch {
      return {
        state: 'inherited',
        revision: routeRevision(declaration),
        thinking: declaration.thinking ?? (tier === 'micro' ? 'off' : tier),
        fallbacks: [...(declaration.fallbacks ?? [])],
      };
    }
  };
  const stateForOverride = (
    profileName: string,
    tier: RouterTier,
    value: RouterUIRouteOverride | undefined,
  ): RouterUIRouteCellState =>
    value
      ? {
          state: 'override',
          revision: value.revision,
          model: value.model,
          thinking: value.thinking,
          fallbacks: [...value.fallbacks],
        }
      : genericRouteState(profileName, tier);
  const sameFallbacks = (
    left: readonly string[] | undefined,
    right: readonly string[],
  ): boolean =>
    (left ?? []).length === right.length &&
    (left ?? []).every((fallback, index) => fallback === right[index]);
  const fallbackMetadataFor = (
    profileName: string,
    activity: RouterActivity,
    tier: RouterTier,
    fallbacks: readonly string[],
  ): ModelDefinition[] | undefined => {
    const profile = state.currentConfig.profiles[profileName];
    const activityRoute = profile?.activities?.[activity]?.[tier];
    const genericRoute = profile?.[tier];
    const source = [activityRoute, genericRoute].find((route) =>
      sameFallbacks(route?.fallbacks, fallbacks),
    );
    return source?.resolvedFallbacks?.map((fallback) => ({ ...fallback }));
  };
  const profileWithRouteOverrides = (
    profileName: string,
    overrides: ReadonlyMap<string, RouterUIRouteOverride | undefined>,
  ): RouterProfile | undefined => {
    const configured = state.currentConfig.profiles[profileName];
    if (!configured) return undefined;
    const catalog = chatModelCatalog();
    const activities = { ...configured.activities };
    for (const [key, value] of overrides) {
      const [activityName, tierName] = key.split('/');
      const activity = ROUTER_ACTIVITIES.find((item) => item === activityName);
      const tier = ROUTER_TIERS.find((item) => item === tierName);
      if (!activity || !tier) return undefined;
      const tiers = { ...activities[activity] };
      if (value) {
        const target = catalog.entries.find(
          (model) => model.model === value.model,
        );
        const targetModel = catalog.find(value.model);
        const targetEfforts = targetModel
          ? getSupportedThinkingLevels(targetModel).filter(isThinkingLevel)
          : [];
        if (!target || !targetModel || !targetEfforts.includes(value.thinking))
          return undefined;
        const inherited =
          configured.activities?.[activity]?.[tier] ?? configured[tier];
        const fallbackMetadata =
          value.resolvedFallbacks ??
          fallbackMetadataFor(profileName, activity, tier, value.fallbacks);
        const updated: RoutedTierConfig = {
          model: target.model,
          thinking: value.thinking,
          thinkingExplicit: true,
          fallbacks: [...value.fallbacks],
          ...(fallbackMetadata
            ? {
                resolvedFallbacks: fallbackMetadata.map((entry) => ({
                  ...entry,
                })),
              }
            : {}),
          ...(inherited?.contextWindow === undefined
            ? {}
            : { contextWindow: inherited.contextWindow }),
          ...(inherited?.maxTokens === undefined
            ? {}
            : { maxTokens: inherited.maxTokens }),
          reasoning: targetModel.reasoning,
          resolvedContextWindow:
            inherited?.contextWindow ?? targetModel.contextWindow,
          resolvedMaxTokens: inherited?.maxTokens ?? targetModel.maxTokens,
        };
        // Use the canonical registry target directly; don't normalize other cells or aliases again.
        tiers[tier] = updated;
        activities[activity] = tiers;
      } else {
        delete tiers[tier];
        if (Object.keys(tiers).length) activities[activity] = tiers;
        else delete activities[activity];
      }
    }
    const nextProfile: RouterProfile = { ...configured };
    if (Object.keys(activities).length) nextProfile.activities = activities;
    else delete nextProfile.activities;
    return nextProfile;
  };
  const validateRouteProfile = (
    profile: RouterProfile | undefined,
    value: RouterUIControls,
  ): boolean => {
    const registry = state.currentModelRegistry;
    if (!profile || !registry) return false;
    const find = (provider: string, id: string) => registry.find(provider, id);
    const thinking = thinkingOf(value);
    const activityRouting = state.currentConfig.activityRouting !== 'off';
    if (!preservesRouteCoverage(profile, find, thinking, activityRouting))
      return false;
    const baseline = value.baseline === 'auto' ? undefined : value.baseline;
    if (
      baseline &&
      !profile[baseline] &&
      (!activityRouting ||
        !Object.values(profile.activities ?? {}).some((cell) => cell[baseline]))
    )
      return false;
    const pin = value.pin === 'auto' ? undefined : value.pin;
    return (
      !pin ||
      [false, true].some((image) =>
        availableRoutePairs(profile, find, image, thinking).some(
          (pair) => pair.tier === pin,
        ),
      )
    );
  };
  const validate = (profile: string, value: RouterUIControls) => {
    const config = state.currentConfig.profiles[profile];
    const registry = state.currentModelRegistry;
    if (!config || !registry || validateRouterUIControls(value)) return false;
    if (
      value.advisor &&
      value.advisor !== state.currentConfig.advisor?.model &&
      !registry
        .getModelsOfType('classifier')
        .some((model) => `${model.provider}/${model.id}` === value.advisor)
    )
      return false;
    const baseline = value.baseline;
    if (
      baseline !== 'auto' &&
      !config[baseline] &&
      (state.currentConfig.activityRouting === 'off' ||
        !Object.values(config.activities ?? {}).some((cell) => cell[baseline]))
    )
      return false;
    const find = (provider: string, id: string) => registry.find(provider, id);
    const thinking = thinkingOf(value);
    return (
      preservesRouteCoverage(
        config,
        find,
        thinking,
        state.currentConfig.activityRouting !== 'off',
      ) &&
      (value.pin === 'auto' ||
        [false, true].some((image) =>
          availableRoutePairs(config, find, image, thinking).some(
            (pair) => pair.tier === value.pin,
          ),
        ))
    );
  };
  const getSnapshot = (): RouterUISnapshot => {
    const profile = state.selectedProfile ?? 'none';
    const config = state.currentConfig;
    const configured = config.profiles[profile];
    const sameProfile = observedProfile === profile;
    const last = sameProfile
      ? observation
      : state.lastDecision?.profile === profile
        ? state.lastDecision
        : undefined;
    if (historySource !== state.debugHistory || historyProfile !== profile) {
      historySource = state.debugHistory;
      historyProfile = profile;
      history = state.debugHistory
        .filter((entry) => entry.profile === profile)
        .map(historyOf);
    }
    const registry = state.currentModelRegistry;
    const eligible =
      configured && registry
        ? Object.fromEntries(
            availableRoutePairs(
              configured,
              (provider, id) => registry.find(provider, id),
              false,
              state.thinkingByProfile[profile],
            )
              .filter(
                (pair, i, pairs) =>
                  pairs.findIndex((other) => other.tier === pair.tier) === i,
              )
              .map((pair) => {
                const ref = parseCanonicalModelRef(pair.model);
                return [
                  pair.tier,
                  {
                    tier: pair.tier,
                    provider: ref.provider,
                    model: ref.modelId,
                    thinking: pair.thinking,
                  },
                ];
              }),
          )
        : {};
    const activityRouting = config.activityRouting ?? 'on';
    const activityCells: RouterUIActivityCell[] = ROUTER_ACTIVITIES.flatMap(
      (activity) => {
        const cell = configured?.activities?.[activity];
        if (!cell) return [];
        const pairs =
          activityRouting === 'on' && registry
            ? availableRoutePairs(
                cell,
                (provider, id) => registry.find(provider, id),
                false,
                state.thinkingByProfile[profile],
              )
            : [];
        return ROUTER_TIERS.flatMap((tier): RouterUIActivityCell[] => {
          const declaration = cell[tier];
          if (!declaration) return [];
          const pair = pairs.find((entry) => entry.tier === tier);
          const ref = pair ? parseCanonicalModelRef(pair.model) : undefined;
          return [
            {
              activity,
              ...(declaration.activitySource
                ? { source: declaration.activitySource }
                : {}),
              configured: resolveRoutePair(
                cell,
                tier,
                state.thinkingByProfile[profile],
              ),
              fallbacks: [...(declaration.fallbacks ?? [])],
              ...(pair && ref
                ? {
                    availability: 'eligible' as const,
                    eligible: {
                      tier,
                      provider: ref.provider,
                      model: ref.modelId,
                      thinking: pair.thinking,
                    },
                  }
                : {
                    availability:
                      activityRouting === 'off'
                        ? ('disabled' as const)
                        : !registry
                          ? ('unknown' as const)
                          : ('unavailable' as const),
                  }),
            },
          ];
        });
      },
    );
    const catalog = chatModelCatalog();
    const activeControls = controls(profile);
    const queuedControls = pendingValue(profile);
    const preference = (
      candidate: RouterProfile | undefined,
      value: RouterUIControls,
    ) =>
      routePreferences({
        profile: candidate,
        find: registry
          ? (provider, id) => registry.find(provider, id)
          : undefined,
        mode: modeForProfile(config, profile, value.mode),
        pin: value.pin,
        thinkingOverrides: thinkingOf(value),
        activityRouting: activityRouting === 'on',
        budgetExceeded:
          config.maxSessionBudget !== undefined &&
          (state.accumulatedCost ?? 0) >= config.maxSessionBudget,
      });
    const preferred = preference(configured, activeControls);
    const queuedRoutes = pendingRoutes.get(profile);
    const futureProfile = queuedRoutes
      ? profileWithRouteOverrides(
          profile,
          new Map(
            [...queuedRoutes].map(([key, change]) => [key, change.value]),
          ),
        )
      : configured;
    const pendingPreferred =
      queuedControls || queuedRoutes
        ? preference(futureProfile, queuedControls ?? activeControls)
        : undefined;
    const pendingEffortFor = (tier: RouterTier) =>
      queuedControls
        ? queuedControls[thinkingFields[tier]]
        : activeControls[thinkingFields[tier]];
    const mappedEffort = (
      route: RouterUIRouteCellState,
      tier: RouterTier,
      effort: RouterUIControls['thinkingHigh'],
      declaredLevels?: readonly ThinkingLevel[],
    ) => {
      if (!route.model) return undefined;
      return routeThinking(
        {
          tier,
          model: route.model,
          thinking:
            effort ?? route.thinking ?? (tier === 'micro' ? 'off' : tier),
        },
        (provider, id) => registry?.find(provider, id),
        false,
        declaredLevels ? [...declaredLevels] : undefined,
      );
    };
    const routeCells = ROUTER_ACTIVITIES.flatMap((activity) =>
      ROUTER_TIERS.map((tier) => {
        const key = routeKey(activity, tier);
        const current = routeState(profile, activity, tier);
        const generic = genericRouteState(profile, tier);
        const queued = pendingRoutes.get(profile)?.get(key);
        const pendingRoute = queued
          ? stateForOverride(profile, tier, queued.value)
          : undefined;
        const declaration =
          configured?.activities?.[activity]?.[tier] ?? configured?.[tier];
        const activeEffort = activeControls[thinkingFields[tier]];
        const nextEffort = pendingEffortFor(tier);
        return {
          activity,
          tier,
          current,
          generic,
          preferred: preferred(activity, tier),
          ...(pendingPreferred
            ? { pendingPreferred: pendingPreferred(activity, tier) }
            : {}),
          ...(pendingRoute ? { pending: pendingRoute } : {}),
          effectiveThinking:
            activityRouting === 'off' &&
            (current.state === 'override' || current.state === 'builtin')
              ? undefined
              : mappedEffort(
                  current,
                  tier,
                  activeEffort,
                  declaration?.thinkingLevels,
                ),
          pendingEffectiveThinking:
            activityRouting === 'off' &&
            ['override', 'builtin'].includes((pendingRoute ?? current).state)
              ? undefined
              : mappedEffort(
                  pendingRoute ?? current,
                  tier,
                  nextEffort,
                  pendingRoute ? undefined : declaration?.thinkingLevels,
                ),
          ...(activeEffort === undefined
            ? {}
            : { tierEffortOverride: activeEffort }),
          ...(nextEffort === undefined
            ? {}
            : { pendingTierEffortOverride: nextEffort }),
        };
      }),
    );
    return {
      profile,
      accumulatedCost: state.accumulatedCost,
      chatModels: catalog.entries,
      classifiers:
        (typeof registry?.getModelsOfType === 'function'
          ? registry.getModelsOfType('classifier')
          : []
        )
          .map((model) => ({
            model: `${model.provider}/${model.id}`,
            name: model.name,
            textInput: model.input.includes('text'),
          }))
          .sort((a, b) => a.model.localeCompare(b.model)) ?? [],
      reuse: last?.reuse,
      bypassReason: last?.bypassReason,
      reason: last?.reasonCode,
      costRecovery: last?.costRecovery,
      failure:
        sameProfile && lifecycle === 'failed' ? 'request-failed' : undefined,
      lifecycle: !state.routerEnabled
        ? 'off'
        : sameProfile
          ? lifecycle
          : 'idle',
      actual: sameProfile
        ? actual
        : last?.generation
          ? routeOf(last)
          : undefined,
      advised: sameProfile
        ? advised
        : last
          ? recommendationOf(last)
          : undefined,
      switchCost: last?.switchCost,
      advice: last ? historyOf(last).advice : undefined,
      lastAdvice: lastAdvice?.advice,
      loggingEnabled: state.debugEnabled === true,
      mode: modeOf(profile),
      modeBypass: modeBypassFor(
        Object.hasOwn(state.pinnedTierByProfile, profile),
        state.thinkingByProfile[profile],
      ),
      policySources: policySources(profile),
      controls: controls(profile),
      pendingControls: pendingValue(profile),
      pendingRoutes: routeCells.some((cell) => cell.pending !== undefined),
      eligible,
      activityRouting,
      activityCells,
      activityPreset:
        configured?.activityPreset === 'off'
          ? 'off'
          : (configured?.activityPresetFamily ?? 'none (unrecognized routes)'),
      routeCells,
      privacy: {
        advisorEnabled: config.advisor?.enabled === true,
        approvedModels: configured?.advisor?.models ?? [],
        auth: 'unknown',
      },
      history,
    };
  };
  const routeStateWithPending = (
    profile: string,
    activity: RouterActivity,
    tier: RouterTier,
  ): RouterUIRouteCellState => {
    const queued = pendingRoutes.get(profile)?.get(routeKey(activity, tier));
    return queued
      ? stateForOverride(profile, tier, queued.value)
      : routeState(profile, activity, tier);
  };
  const adapters: RouterUIAdapters = {
    getSnapshot,
    get signal() {
      return controller.signal;
    },
    subscribe: (refresh) => {
      listeners.add(refresh);
      return () => {
        listeners.delete(refresh);
      };
    },
    applyControls: async (transaction) => {
      if (transaction.profile !== state.selectedProfile) return 'conflict';
      const previous = pending.get(transaction.profile);
      const base = controls(transaction.profile);
      const current = pendingValue(transaction.profile) ?? base;
      if (
        new Set(transaction.changes.map((change) => change.key)).size !==
          transaction.changes.length ||
        transaction.changes.some(
          (change) => current[change.key] !== change.before,
        )
      )
        return 'conflict';
      const next = { ...current };
      for (const change of transaction.changes)
        Object.assign(next, { [change.key]: change.after });
      if (!validate(transaction.profile, next)) return 'conflict';
      sessionPending = queue(true, base, next, sessionPending);
      const scoped = queue(false, base, next, previous);
      if (scoped) pending.set(transaction.profile, scoped);
      else pending.delete(transaction.profile);
      publish();
      changed();
      return 'applied';
    },
    applyRoutes: async (transaction) => {
      const profile = transaction.profile;
      if (
        profile !== state.selectedProfile ||
        !state.currentConfig.profiles[profile] ||
        new Set(
          transaction.changes.map((change) =>
            routeKey(change.activity, change.tier),
          ),
        ).size !== transaction.changes.length
      )
        return 'conflict';
      const nextPending = new Map(pendingRoutes.get(profile));
      const catalog = chatModelCatalog();
      for (const change of transaction.changes) {
        const key = routeKey(change.activity, change.tier);
        const current = routeStateWithPending(
          profile,
          change.activity,
          change.tier,
        );
        if (!routeStateEqual(current, change.before)) return 'conflict';
        let value: RouterUIRouteOverride | undefined;
        if (change.after) {
          const candidate = catalog.entries.find(
            (model) => model.model === change.after?.model,
          );
          if (!candidate?.efforts.includes(change.after.thinking))
            return 'invalid';
          const fallbacks = change.after.fallbacks ?? current.fallbacks;
          const genericFallbacks = genericRouteState(
            profile,
            change.tier,
          ).fallbacks;
          if (
            ![current.fallbacks, genericFallbacks].some(
              (allowed) =>
                allowed.length === fallbacks.length &&
                allowed.every((entry, index) => entry === fallbacks[index]),
            )
          )
            return 'invalid';
          const resolvedFallbacks = fallbackMetadataFor(
            profile,
            change.activity,
            change.tier,
            fallbacks,
          );
          const preservesRevision =
            current.model === candidate.model &&
            current.thinking === change.after.thinking &&
            sameFallbacks(current.fallbacks, [...fallbacks]);
          value = {
            model: candidate.model,
            thinking: change.after.thinking,
            // Keep the entire ordered effective chain; edits only replace the primary.
            fallbacks: [...fallbacks],
            ...(preservesRevision && current.revision
              ? { revision: current.revision }
              : {}),
            ...(resolvedFallbacks ? { resolvedFallbacks } : {}),
          };
        }
        const base =
          nextPending.get(key)?.base ??
          routeState(profile, change.activity, change.tier);
        const nextState = stateForOverride(profile, change.tier, value);
        if (routeStateEqual(nextState, base)) nextPending.delete(key);
        else nextPending.set(key, { base, value });
      }
      const overrides = new Map(
        [...nextPending].map(([key, change]) => [key, change.value]),
      );
      const candidate = profileWithRouteOverrides(profile, overrides);
      const effectiveControls = pendingValue(profile) ?? controls(profile);
      if (!validateRouteProfile(candidate, effectiveControls)) return 'invalid';
      if (nextPending.size) pendingRoutes.set(profile, nextPending);
      else pendingRoutes.delete(profile);
      publish();
      changed();
      return 'applied';
    },
  };
  const activatePending = (): boolean => {
    const profile = state.selectedProfile;
    if (!profile) return true;
    const entries = [sessionPending, pending.get(profile)];
    const nextControls = pendingValue(profile);
    const routeEdits = pendingRoutes.get(profile);
    if (!nextControls && !routeEdits) return true;
    sessionPending = undefined;
    pending.delete(profile);
    pendingRoutes.delete(profile);
    const latest = controls(profile);
    // Effective policy values depend on the mode; a mode or profile switch is not a concurrent edit.
    const layers = policyLayers();
    const baseConflict = entries.some(
      (entry) =>
        entry &&
        edited(entry).some((key) =>
          Object.hasOwn(ROUTER_UI_POLICY_CONTROLS, key)
            ? entry.policyLayers !== layers
            : latest[key] !== entry.base[key],
        ),
    );
    const overrides = new Map<string, RouterUIRouteOverride | undefined>();
    let routeConflict = false;
    for (const [key, entry] of routeEdits ?? []) {
      const [activityName, tierName] = key.split('/');
      const activity = ROUTER_ACTIVITIES.find((item) => item === activityName);
      const tier = ROUTER_TIERS.find((item) => item === tierName);
      if (
        !activity ||
        !tier ||
        !routeStateEqual(entry.base, routeState(profile, activity, tier))
      ) {
        routeConflict = true;
        break;
      }
      overrides.set(key, entry.value);
    }
    const config = state.currentConfig;
    const configured = config.profiles[profile];
    const candidateProfile = routeEdits
      ? profileWithRouteOverrides(profile, overrides)
      : configured;
    const applying = nextControls ?? latest;
    if (
      baseConflict ||
      routeConflict ||
      !configured ||
      (nextControls && !validate(profile, applying)) ||
      !validateRouteProfile(candidateProfile, applying)
    ) {
      publish();
      return false;
    }
    // Settings-tab policy edits are runtime intent: they beat the mode patch.
    const editedPolicy = Object.fromEntries(
      Object.entries(ROUTER_UI_POLICY_CONTROLS).flatMap(([control, key]) =>
        entries.some((entry) =>
          edited(entry).some((field) => field === control),
        )
          ? [[key, applying[control as RouterUIPolicyControl]]]
          : [],
      ),
    );
    const nextConfig = {
      ...config,
      ...(Object.keys(editedPolicy).length
        ? { sessionPolicy: { ...config.sessionPolicy, ...editedPolicy } }
        : {}),
      maxSessionBudget: applying.budget,
      profiles: {
        ...config.profiles,
        [profile]: {
          ...candidateProfile,
          baselineTier:
            applying.baseline === 'auto' ? undefined : applying.baseline,
        },
      },
    };
    const advisor = applying.advisor
      ? normalizeAdvisorConfig(
          {
            ...config.advisor,
            model: applying.advisor,
            enabled: config.advisor?.enabled ?? false,
            timeoutMs: applying.timeout,
            reviewEveryRequests: applying.reviewEveryRequests,
          },
          [],
        )
      : undefined;
    state.currentConfig = { ...nextConfig, advisor };
    state.modeOverride = applying.mode;

    if (applying.pin === 'auto') delete state.pinnedTierByProfile[profile];
    else state.pinnedTierByProfile[profile] = applying.pin;
    state.thinkingByProfile[profile] = thinkingOf(applying);
    publish();
    changed();
    return true;
  };
  const reset = () => {
    epoch++;
    controller.abort();
    controller = new AbortController();
    pending.clear();
    pendingRoutes.clear();
    sessionPending = undefined;
    lifecycle = 'idle';
    actual = undefined;
    advised = undefined;
    observation = undefined;
    lastAdvice = undefined;
    observedProfile = undefined;
    historySource = undefined;
    publish();
  };
  const beginRequest = (profile = state.selectedProfile) => {
    const requestEpoch = ++epoch;
    observedProfile = profile;
    lifecycle = 'choosing';
    actual = undefined;
    advised = undefined;
    observation = undefined;
    publish();
    changed();
    return (event: RouterRequestObservation) => {
      if (requestEpoch !== epoch || profile !== state.selectedProfile) return;
      if (event.decision) observation = snapshotDecision(event.decision);
      if (event.stage === 'selected') {
        if (event.decision) recordAdvice(event.decision);
        if (event.decision?.advisor === 'classifier')
          advised = recommendationOf(event.decision) ?? routeOf(event.decision);
      } else if (event.stage === 'generating' && event.decision) {
        actual = routeOf(event.decision);
        lifecycle = lifecycleOf(event.decision, true);
      } else if (event.stage === 'complete' && event.decision) {
        actual = event.decision.generation ? routeOf(event.decision) : actual;
        lifecycle = lifecycleOf(event.decision, false);
      } else if (event.stage === 'cancelled') lifecycle = 'cancelled';
      else if (event.stage === 'failed') {
        lifecycle = 'failed';
        actual = undefined;
      }
      publish();
      changed();
    };
  };
  const recordAdvice = (decision: RoutingDecision): void => {
    if (!decision.classification) return;
    const advice = historyOf(decision).advice;
    if (!advice) return;
    const startedAt = decision.classification.startedAt ?? decision.timestamp;
    if (
      lastAdvice &&
      (lastAdvice.startedAt > startedAt ||
        (advice.requestId !== undefined &&
          advice.requestId === lastAdvice.advice?.requestId))
    )
      return;
    lastAdvice = { startedAt, advice };
    publish();
  };
  return {
    adapters,
    activatePending,
    hasPending: () =>
      sessionPending !== undefined ||
      (state.selectedProfile !== undefined &&
        (pending.has(state.selectedProfile) ||
          pendingRoutes.has(state.selectedProfile))),
    reset,
    beginRequest,
    recordAdvice,
    publish,
  };
};
