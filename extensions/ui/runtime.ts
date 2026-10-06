import {
  normalizeCloudflareConfig,
  normalizeJevConfig,
  parseCanonicalModelRef,
} from '../config';
import { availableRoutePairs, preservesRouteCoverage } from '../routing';
import { snapshotDecision } from '../state';
import type {
  RouterRequestObservation,
  RouterThinkingByTier,
  RouterUIAdapters,
  RouterUIControls,
  RouterUIHistoryEntry,
  RouterUILifecycle,
  RouterUIPendingControls,
  RouterUIRoute,
  RouterUIRuntimeState,
  RouterUISnapshot,
  RoutingDecision,
} from '../types';
import { ROUTER_TIERS } from '../types';
import { validateRouterUIControls } from './inspector';

const thinkingFields = {
  high: 'thinkingHigh',
  medium: 'thinkingMedium',
  low: 'thinkingLow',
  micro: 'thinkingMicro',
} as const;
const routeOf = (decision: RoutingDecision): RouterUIRoute => ({
  tier: decision.tier,
  provider: decision.targetProvider,
  model: decision.targetModelId,
  thinking: decision.thinking,
});
const historyOf = (decision: RoutingDecision): RouterUIHistoryEntry => {
  const metrics = decision.cloudflare ?? decision.jev;
  return {
    actual: decision.generation ? routeOf(decision) : undefined,
    advice: metrics
      ? {
          advisor: decision.cloudflare
            ? metrics.model === '@cf/cloudflare/clef-flash'
              ? 'clef-flash'
              : 'clef'
            : 'jev',
          requestId: metrics.requestId,
          outcome: metrics.outcome,
          latencyMs: metrics.latencyMs,
          httpAttempts: metrics.attempts,
        }
      : decision.advisor === 'classifier' ||
          decision.advisor === 'classifier-fallback'
        ? {
            advisor: 'classifier',
            outcome:
              decision.advisor === 'classifier'
                ? 'selected'
                : decision.errorClass === 'deadline'
                  ? 'deadline'
                  : 'unavailable',
            latencyMs: decision.routingLatencyMs,
          }
        : undefined,
    reuse: decision.reuse,
    generationCostUsd: decision.generation?.reportedCostUsd,
    generationAttempts: decision.generation?.attempts,
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
        : (decision.cloudflare ?? decision.jev)?.outcome === 'deadline'
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
  let sessionPending: RouterUIPendingControls | undefined;
  const globalFields = new Set<keyof RouterUIControls>([
    'advisor',
    'timeout',
    'budget',
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
  const publish = () => {
    for (const refresh of listeners) {
      try {
        refresh();
      } catch {
        /* Teardown must not affect generation. */
      }
    }
  };
  const controls = (profile: string): RouterUIControls => {
    const config = state.currentConfig;
    const thinking = state.thinkingByProfile[profile];
    return {
      pin: state.pinnedTierByProfile[profile] ?? 'auto',
      baseline: config.profiles[profile]?.baselineTier ?? 'auto',
      budget: config.maxSessionBudget,
      advisor: config.advisor ?? 'jev',
      timeout:
        (config.advisor && config.advisor !== 'jev'
          ? config.cloudflare
          : config.jev
        )?.timeoutMs ?? 1500,
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
  const queue = (
    global: boolean,
    base: RouterUIControls,
    next: RouterUIControls,
    previous: RouterUIPendingControls | undefined,
  ): RouterUIPendingControls | undefined => {
    const entry = { base: { ...base }, value: { ...base } };
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
  const validate = (profile: string, value: RouterUIControls) => {
    const config = state.currentConfig.profiles[profile];
    const registry = state.currentModelRegistry;
    if (!config || !registry || validateRouterUIControls(value)) return false;
    if (value.baseline !== 'auto' && !config[value.baseline]) return false;
    const find = (provider: string, id: string) => registry.find(provider, id);
    const thinking = thinkingOf(value);
    return (
      preservesRouteCoverage(config, find, thinking) &&
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
    return {
      profile,
      accumulatedCost: state.accumulatedCost,
      classifierModel: config.classifierModel?.model,
      reuse: last?.reuse,
      bypassReason: last?.bypassReason,
      reason: last?.reasonCode,
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
      advised: sameProfile ? advised : undefined,
      advice: last ? historyOf(last).advice : undefined,
      controls: controls(profile),
      pendingControls: pendingValue(profile),
      eligible,
      privacy: {
        jevApproved: Boolean(config.jev?.enabled && configured?.jev?.enabled),
        cloudflareApproved: Boolean(
          config.cloudflare?.enabled && configured?.cloudflare?.enabled,
        ),
        auth: 'unknown',
      },
      history,
    };
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
  };
  const activatePending = (): boolean => {
    const profile = state.selectedProfile;
    if (!profile) return true;
    const entries = [sessionPending, pending.get(profile)];
    const next = pendingValue(profile);
    if (!next) return true;
    sessionPending = undefined;
    pending.delete(profile);
    const latest = controls(profile);
    if (
      entries.some(
        (entry) =>
          entry && edited(entry).some((key) => latest[key] !== entry.base[key]),
      )
    ) {
      publish();
      return false;
    }
    if (!validate(profile, next)) {
      publish();
      return false;
    }
    const config = state.currentConfig;
    const configured = config.profiles[profile];
    if (!configured) return false;
    const nextConfig = {
      ...config,
      advisor: next.advisor,
      maxSessionBudget: next.budget,
      profiles: {
        ...config.profiles,
        [profile]: {
          ...configured,
          baselineTier: next.baseline === 'auto' ? undefined : next.baseline,
        },
      },
    };
    if (next.advisor === 'jev')
      nextConfig.jev = normalizeJevConfig(
        {
          ...config.jev,
          enabled: config.jev?.enabled ?? false,
          timeoutMs: next.timeout,
        },
        [],
      );
    else
      nextConfig.cloudflare = normalizeCloudflareConfig(
        {
          ...config.cloudflare,
          enabled: config.cloudflare?.enabled ?? false,
          timeoutMs: next.timeout,
        },
        [],
      );
    state.currentConfig = nextConfig;
    if (next.pin === 'auto') delete state.pinnedTierByProfile[profile];
    else state.pinnedTierByProfile[profile] = next.pin;
    state.thinkingByProfile[profile] = thinkingOf(next);
    publish();
    changed();
    return true;
  };
  const reset = () => {
    epoch++;
    controller.abort();
    controller = new AbortController();
    pending.clear();
    sessionPending = undefined;
    lifecycle = 'idle';
    actual = undefined;
    advised = undefined;
    observation = undefined;
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
        if (
          event.decision?.advisor === 'jev' ||
          event.decision?.advisor === 'cloudflare' ||
          event.decision?.advisor === 'classifier'
        )
          advised = routeOf(event.decision);
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
  return { adapters, activatePending, reset, beginRequest, publish };
};
