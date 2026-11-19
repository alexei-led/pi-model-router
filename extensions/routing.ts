import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai';
import { CONTEXT_FILL, DEFAULT_CONTEXT_WINDOW } from './constants';
import { parseCanonicalModelRef, THINKING_LEVELS } from './domain';
import { transformRoute } from './modes';
import type {
  ModelDefinition,
  ModeProvenance,
  RouteAttempt,
  RoutedTierConfig,
  RoutePair,
  RoutePlan,
  RouterMode,
  RouterProfile,
  RouterThinkingByTier,
  RouterTier,
  RoutingDecision,
  RoutingReasonCode,
} from './types';
import { ROUTER_ACTIVITIES, ROUTER_TIERS } from './types';

/** The configured default preference order when no baseline tier is supplied. */
export const BASELINE_TIER_ORDER: readonly RouterTier[] = [
  'medium',
  'high',
  'low',
  'micro',
] as const;

export const resolveRoutePair = (
  profile: RouterProfile,
  tier: RouterTier,
  thinkingOverrides?: RouterThinkingByTier,
): RoutePair => {
  const routed = profile[tier];
  if (!routed)
    throw new Error('No eligible route: selected tier is not configured.');
  const { provider, modelId } = parseCanonicalModelRef(routed.model);
  return {
    tier,
    model: `${provider}/${modelId}`,
    thinking:
      thinkingOverrides?.[tier] ??
      routed.thinking ??
      (tier === 'micro' ? 'off' : tier),
  };
};

/**
 * Legacy profiles use Pi's higher-first mapping; table profiles never round up.
 */
export const clampEffort = (
  requested: ThinkingLevel,
  allowed: readonly ThinkingLevel[],
  effortPolicy?: RouterProfile['effortPolicy'],
): ThinkingLevel | undefined => {
  if (allowed.includes(requested)) return requested;
  const index = THINKING_LEVELS.indexOf(requested);
  const lower = () =>
    THINKING_LEVELS.slice(0, index)
      .reverse()
      .find((level) => allowed.includes(level));
  return effortPolicy === 'table'
    ? lower()
    : (THINKING_LEVELS.slice(index + 1).find((level) =>
        allowed.includes(level),
      ) ?? lower());
};

const supportedEfforts = (
  model: Model<Api>,
  declaredLevels?: readonly ThinkingLevel[],
): ThinkingLevel[] =>
  getSupportedThinkingLevels(model).filter(
    (level) =>
      !declaredLevels || level === 'off' || declaredLevels.includes(level),
  );

/**
 * Resolve the effort a route runs at against the live registry, or undefined
 * when the model cannot serve the input. An unsupported effort maps to its
 * nearest supported level according to the profile policy. A declaration only
 * narrows the levels; it never grants one the live model does not expose.
 */
export const routeThinking = (
  pair: RoutePair,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  imageAttached: boolean,
  declaredLevels?: ModelDefinition['thinkingLevels'],
  effortPolicy?: RouterProfile['effortPolicy'],
): ThinkingLevel | undefined => {
  try {
    const { provider, modelId } = parseCanonicalModelRef(pair.model);
    if (provider === 'router') return undefined;
    const model = findModel(provider, modelId);
    if (!model?.input.includes(imageAttached ? 'image' : 'text'))
      return undefined;
    return clampEffort(
      pair.thinking,
      supportedEfforts(model, declaredLevels),
      effortPolicy,
    );
  } catch {
    return undefined;
  }
};

/**
 * Return all generation attempts that the active profile can serve. The first
 * route for a tier is its primary; subsequent routes are explicit generation
 * fallbacks and remain in their configured order.
 *
 * Tier and fallback references are normalized before this boundary. Parse them
 * directly so a canonical-looking model reference cannot resolve as an alias a
 * second time.
 */
const availableRouteAttempts = (
  profile: RouterProfile,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  imageAttached: boolean,
  thinkingOverrides?: RouterThinkingByTier,
): RouteAttempt[] =>
  ROUTER_TIERS.flatMap((tier) => {
    const config = profile[tier];
    if (!config) return [];

    let primary: RoutePair;
    try {
      primary = resolveRoutePair(profile, tier, thinkingOverrides);
    } catch {
      return [];
    }

    return [primary.model, ...(config.fallbacks ?? [])]
      .flatMap((ref, index) => {
        try {
          const { provider, modelId } = parseCanonicalModelRef(ref);
          const model = findModel(provider, modelId);
          const ownConfig =
            index === 0 ? config : config.resolvedFallbacks?.[index - 1];
          // A non-reasoning model defaults to off; any other unsupported
          // effort runs at its nearest supported level.
          const requested =
            thinkingOverrides?.[tier] ??
            ((config.thinkingExplicit ?? config.thinking !== undefined)
              ? primary.thinking
              : ownConfig?.reasoning === false || !model?.reasoning
                ? 'off'
                : primary.thinking);
          const target = `${provider}/${modelId}`;
          // Only declared levels narrow a route; undeclared means the registry's.
          const declaredLevels =
            ownConfig?.reasoning === false ? [] : ownConfig?.thinkingLevels;
          const thinking = routeThinking(
            { tier, model: target, thinking: requested },
            findModel,
            imageAttached,
            declaredLevels,
            profile.effortPolicy,
          );
          return thinking
            ? [
                {
                  tier,
                  model: target,
                  thinking,
                  ...(declaredLevels ? { declaredLevels } : {}),
                },
              ]
            : [];
        } catch {
          return [];
        }
      })
      .filter(
        (pair, index, pairs) =>
          pairs.findIndex((other) => other.model === pair.model) === index,
      );
  });

export const availableRoutePairs = (
  ...args: Parameters<typeof availableRouteAttempts>
): RoutePair[] =>
  availableRouteAttempts(...args).map(({ tier, model, thinking }) => ({
    tier,
    model,
    thinking,
  }));

/**
 * Keep at least one configured route usable for each input kind when a
 * thinking override is accepted. This prevents an override from silently
 * removing all generation options while still allowing partial profiles and
 * explicit pins to fail at their normal capability check.
 */
export const preservesRouteCoverage = (
  profile: RouterProfile,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  thinkingOverrides: RouterThinkingByTier,
  activityRouting = true,
): boolean => {
  const cells = [
    profile,
    ...(activityRouting ? Object.values(profile.activities ?? {}) : []),
  ];
  const pairsFor = (image: boolean, overrides?: RouterThinkingByTier) =>
    cells.flatMap((cell) =>
      availableRoutePairs(
        { ...cell, effortPolicy: profile.effortPolicy },
        findModel,
        image,
        overrides,
      ),
    );
  for (const imageAttached of [false, true]) {
    const configured = pairsFor(imageAttached);
    const overridden = pairsFor(imageAttached, thinkingOverrides);
    if (configured.length > 0 && overridden.length === 0) return false;
  }
  return [false, true].some(
    (image) => pairsFor(image, thinkingOverrides).length > 0,
  );
};

/** Routes whose text effort override runs at another level. */
export const effortAdjustments = (
  profile: RouterProfile,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  level: ThinkingLevel,
  activityRouting = true,
): string[] =>
  [
    { label: '', profile },
    ...(activityRouting
      ? ROUTER_ACTIVITIES.flatMap((activity) => {
          const cell = profile.activities?.[activity];
          return cell ? [{ label: `/${activity}`, profile: cell }] : [];
        })
      : []),
  ].flatMap((cell) => {
    const pairs = availableRoutePairs(
      { ...cell.profile, effortPolicy: profile.effortPolicy },
      findModel,
      false,
      Object.fromEntries(ROUTER_TIERS.map((tier) => [tier, level])),
    );
    return ROUTER_TIERS.flatMap((tier) => {
      const pair = pairs.find((entry) => entry.tier === tier);
      return pair && pair.thinking !== level
        ? [`${tier}${cell.label} runs at ${pair.thinking}`]
        : [];
    });
  });

/**
 * Keep routes whose context window holds the estimated request. When none
 * does, keep the largest windows so provider truncation drops the least.
 * An unknown window counts as fitting: nothing proves it is too small.
 */
export const fitContextRoutes = (
  pairs: readonly RoutePair[],
  windowOf: (pair: RoutePair) => number | undefined,
  contextTokens: number,
): RoutePair[] => {
  const size = (pair: RoutePair) => windowOf(pair) ?? Number.POSITIVE_INFINITY;
  const fitting = pairs.filter(
    (pair) => contextTokens <= size(pair) * CONTEXT_FILL,
  );
  if (fitting.length > 0) return fitting;
  const largest = Math.max(0, ...pairs.map(size));
  return pairs.filter((pair) => size(pair) === largest);
};

export interface BaselineSelection {
  pair: RoutePair;
  reasonCode: 'baseline' | 'pinned' | 'budget';
  isBudgetForced: boolean;
}

const routeForTier = (
  pairs: readonly RoutePair[],
  tier: RouterTier,
): RoutePair | undefined => pairs.find((pair) => pair.tier === tier);

const preferredOrder = (profile: RouterProfile): readonly RouterTier[] => {
  const baseline = profile.baselineTier;
  if (
    !baseline ||
    (!profile[baseline] &&
      !ROUTER_ACTIVITIES.some(
        (activity) => profile.activities?.[activity]?.[baseline],
      ))
  )
    return BASELINE_TIER_ORDER;
  return [baseline, ...BASELINE_TIER_ORDER.filter((tier) => tier !== baseline)];
};

const chooseFromOrder = (
  pairs: readonly RoutePair[],
  order: readonly RouterTier[],
): RoutePair | undefined => {
  for (const tier of order) {
    const pair = routeForTier(pairs, tier);
    if (pair) return pair;
  }
  return undefined;
};

/**
 * Select the local route without inspecting prompt text. Eligibility has
 * already been filtered by the registry/input/effort boundary.
 */
export const selectBaselineRoute = (
  profileName: string,
  profile: RouterProfile,
  pairs: readonly RoutePair[],
  pinnedTier?: RouterTier,
  isBudgetExceeded = false,
): BaselineSelection => {
  if (pinnedTier) {
    const pair = routeForTier(pairs, pinnedTier);
    if (!pair) {
      throw new Error(
        `Pinned tier "${pinnedTier}" for profile "${profileName}" has no eligible model for the current input and thinking level.`,
      );
    }
    return { pair, reasonCode: 'pinned', isBudgetForced: false };
  }

  const order = preferredOrder(profile);
  if (isBudgetExceeded) {
    const budgetOrder = order.filter(
      (tier) => tier === 'medium' || tier === 'low' || tier === 'micro',
    );
    const budgetPair = chooseFromOrder(pairs, budgetOrder);
    if (budgetPair) {
      return { pair: budgetPair, reasonCode: 'budget', isBudgetForced: true };
    }
    const configuredBaseline = chooseFromOrder(pairs, order);
    if (configuredBaseline) {
      return {
        pair: configuredBaseline,
        reasonCode: 'budget',
        isBudgetForced: false,
      };
    }
  } else {
    const baseline = chooseFromOrder(pairs, order);
    if (baseline)
      return { pair: baseline, reasonCode: 'baseline', isBudgetForced: false };
  }

  throw new Error(
    `No eligible route for profile "${profileName}": no configured model is available for the current input and thinking level.`,
  );
};

export const primaryRoutePairs = <T extends RoutePair>(
  profile: RouterProfile,
  pairs: readonly T[],
): T[] =>
  BASELINE_TIER_ORDER.flatMap((tier) => {
    // Keep the effective effort already validated against the live registry.
    const primary = pairs.find(
      (pair) => pair.tier === tier && pair.model === profile[tier]?.model,
    );
    // A configured tier whose primary ref is ineligible still offers its
    // first eligible fallback rather than dropping the tier entirely.
    const pair = primary ?? pairs.find((entry) => entry.tier === tier);
    return pair ? [pair] : [];
  });

export const decisionForPair = (
  profile: string,
  pair: RoutePair,
  reasonCode: RoutingReasonCode,
): RoutingDecision => {
  const { provider, modelId } = parseCanonicalModelRef(pair.model);
  return {
    profile,
    tier: pair.tier,
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: pair.model,
    thinking: pair.thinking,
    reasonCode,
    timestamp: Date.now(),
  };
};

/** Snapshot only local declarations. A selected cell never picks up a different fallback list. */
const freezeTierConfig = (
  config: RoutedTierConfig,
): Readonly<RoutedTierConfig> => {
  const copy = structuredClone(config);
  // Only the selected declaration belongs in an immutable generation plan.
  delete copy.builtinModes;
  delete copy.modeRoutes;
  if (copy.fallbacks) Object.freeze(copy.fallbacks);
  if (copy.thinkingLevels) Object.freeze(copy.thinkingLevels);
  if (copy.resolvedFallbacks) {
    for (const fallback of copy.resolvedFallbacks) {
      if (fallback.thinkingLevels) Object.freeze(fallback.thinkingLevels);
      Object.freeze(fallback);
    }
    Object.freeze(copy.resolvedFallbacks);
  }
  return Object.freeze(copy);
};

export interface RouteMatrix {
  readonly plans: readonly RoutePlan[];
  readonly representatives: readonly RoutePlan[];
  readonly meaningfulActivities: boolean;
}

export const planBehaviorKey = (plan: RoutePlan): string =>
  JSON.stringify(plan.attempts.map(({ model, thinking }) => [model, thinking]));

const declaredLevelsFor = (
  config: RoutedTierConfig,
  model: string,
): ModelDefinition['thinkingLevels'] => {
  const own =
    config.model === model
      ? config
      : config.resolvedFallbacks?.find((entry) => entry.model === model);
  return own?.reasoning === false ? [] : own?.thinkingLevels;
};

/** Use the selected target's metadata, never the original tier's window. */
export const routeContextWindow = (
  config: RoutedTierConfig | undefined,
  model: string,
  liveWindow: number | undefined,
): number => {
  if (liveWindow && Number.isFinite(liveWindow) && liveWindow > 0)
    return liveWindow;
  if (config?.model === model)
    return (
      config.resolvedContextWindow ??
      config.contextWindow ??
      DEFAULT_CONTEXT_WINDOW
    );

  // Duplicate aliases can declare different windows for the same target.
  const declared = config?.resolvedFallbacks?.flatMap((fallback) =>
    fallback.model === model && fallback.contextWindow !== undefined
      ? [fallback.contextWindow]
      : [],
  );
  return declared?.length ? Math.min(...declared) : DEFAULT_CONTEXT_WINDOW;
};

interface ModeCell {
  profile: RouterProfile;
  thinkingOverrides: RouterThinkingByTier | undefined;
  provenance: Partial<Record<RouterTier, ModeProvenance>>;
}

/**
 * Apply the mode to one cell before plans exist, so candidates, plan IDs and
 * generation revalidation all see the transformed pair. The transformed
 * effort rides in the plan's thinking overrides; a model lever swaps in the
 * source tier's configuration with its own fallbacks.
 */
const applyModeToCell = (
  generic: RouterProfile,
  cellProfile: RouterProfile,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  imageAttached: boolean,
  thinkingOverrides: RouterThinkingByTier | undefined,
  mode: RouterMode,
  budgetExceeded: boolean,
  contextTokens: number,
  recoverCostHigh = false,
  activity?: RoutePlan['cell'],
): ModeCell => {
  const configAt = (tier: RouterTier) => cellProfile[tier] ?? generic[tier];
  const resolved = { ...generic, ...cellProfile };
  // Lever sources use configured routes: another tier's manual override stays with that tier.
  const pairs = availableRoutePairs(resolved, findModel, imageAttached);
  const primaries = primaryRoutePairs(resolved, pairs);
  // Another tier's route is a lever only if its model holds the request.
  const fits = (pair: RoutePair, config: RoutedTierConfig | undefined) => {
    const { provider, modelId } = parseCanonicalModelRef(pair.model);
    const window = routeContextWindow(
      config,
      pair.model,
      findModel(provider, modelId)?.contextWindow,
    );
    return contextTokens <= window * CONTEXT_FILL;
  };
  const next: RouterProfile = { ...cellProfile };
  const overrides: RouterThinkingByTier = { ...thinkingOverrides };
  const provenance: ModeCell['provenance'] = {};
  for (const tier of ROUTER_TIERS) {
    // A manual effort override is a deliberate choice; the mode leaves it alone.
    if (!cellProfile[tier] || thinkingOverrides?.[tier]) continue;
    const recovery =
      recoverCostHigh && mode === 'cost' && tier === 'high' && !budgetExceeded;
    const userPreferred = recovery
      ? undefined
      : cellProfile[tier]?.modeRoutes?.[mode];
    const preferred = recovery
      ? undefined
      : (userPreferred ?? cellProfile[tier]?.builtinModes?.[mode]);
    const preferredPair = preferred
      ? availableRoutePairs(
          { [tier]: preferred, effortPolicy: generic.effortPolicy },
          findModel,
          imageAttached,
        ).find((pair) => pair.model === preferred.model)
      : undefined;
    const own = primaries.find((pair) => pair.tier === tier);
    const price = (ref: string) => {
      const { provider, modelId } = parseCanonicalModelRef(ref);
      return findModel(provider, modelId)?.cost.input;
    };
    // The configured primary's price is valid evidence even if it cannot serve this input.
    const configured = cellProfile[tier];
    const cheaper =
      configured &&
      preferredPair &&
      (configured.model === preferredPair.model ||
        ((price(preferredPair.model) ?? 0) > 0 &&
          (price(configured.model) ?? 0) > (price(preferredPair.model) ?? 0)));
    if (
      preferred &&
      preferredPair &&
      fits(preferredPair, preferred) &&
      (mode !== 'cost' || userPreferred || cheaper)
    ) {
      next[tier] = preferred;
      if (generic.effortPolicy !== 'table')
        overrides[tier] = preferredPair.thinking;
      provenance[tier] = Object.freeze({
        mode,
        lever:
          own?.model !== preferredPair.model
            ? 'model'
            : own.thinking !== preferredPair.thinking
              ? 'effort'
              : 'none',
        sourceTier: tier,
      });
      continue;
    }
    if (generic.effortPolicy === 'table' && !recovery) continue;
    const result = transformRoute({
      mode: recovery ? 'balanced' : mode,
      tier,
      activity,
      routeAt: (target) => {
        const pair = primaries.find((entry) => entry.tier === target);
        return pair && (target === tier || fits(pair, configAt(target)))
          ? pair
          : undefined;
      },
      project: (pair, level) => {
        const config = configAt(pair.tier);
        return config
          ? routeThinking(
              { ...pair, thinking: level },
              findModel,
              imageAttached,
              declaredLevelsFor(config, pair.model),
            )
          : undefined;
      },
      inputPrice: (ref) => {
        const { provider, modelId } = parseCanonicalModelRef(ref);
        return findModel(provider, modelId)?.cost.input;
      },
      allowHigh: !budgetExceeded,
    });
    if (!result) continue;
    provenance[tier] = Object.freeze({
      mode,
      lever: result.lever,
      sourceTier: result.sourceTier,
      ...(recovery ? { recovery: true } : {}),
    });
    if (result.lever === 'none') continue;
    next[tier] = configAt(result.sourceTier);
    overrides[tier] = result.thinking;
  }
  return {
    profile: next,
    thinkingOverrides: Object.keys(overrides).length ? overrides : undefined,
    provenance,
  };
};

const freezeAttempt = (pair: RouteAttempt): Readonly<RouteAttempt> =>
  Object.freeze({
    ...pair,
    ...(pair.declaredLevels
      ? { declaredLevels: Object.freeze([...pair.declaredLevels]) }
      : {}),
  });

/** Prevalidate each matrix cell; only its representative is subject to context fit. */
export const buildRouteMatrix = (
  profile: RouterProfile,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  imageAttached: boolean,
  contextTokens: number,
  thinkingOverrides?: RouterThinkingByTier,
  activityRouting = true,
  pinnedTier?: RouterTier,
  mode?: {
    mode: RouterMode;
    budgetExceeded: boolean;
    recoverCostHigh?: boolean;
  },
): RouteMatrix => {
  const cells = [
    { cell: undefined, profile },
    ...(activityRouting && !pinnedTier
      ? ROUTER_ACTIVITIES.flatMap((cell) => {
          const overrides = profile.activities?.[cell];
          return overrides ? [{ cell, profile: overrides }] : [];
        })
      : []),
  ].map((cell) => {
    // Pins and manual model picks bypass the mode.
    const moded: ModeCell =
      mode && !pinnedTier
        ? applyModeToCell(
            profile,
            cell.profile,
            findModel,
            imageAttached,
            thinkingOverrides,
            mode.mode,
            mode.budgetExceeded,
            contextTokens,
            mode.recoverCostHigh,
            cell.cell,
          )
        : { profile: cell.profile, thinkingOverrides, provenance: {} };
    return {
      cell: cell.cell,
      profile: moded.profile,
      provenance: moded.provenance,
      pairs: availableRouteAttempts(
        { ...moded.profile, effortPolicy: profile.effortPolicy },
        findModel,
        imageAttached,
        moded.thinkingOverrides,
      ),
    };
  });
  const all = cells.flatMap(({ pairs }) => pairs);
  const windows = new Map(
    pinnedTier
      ? []
      : cells.flatMap(({ profile: cellProfile, pairs }) =>
          pairs.map((pair) => {
            const { provider, modelId } = parseCanonicalModelRef(pair.model);
            return [
              pair,
              routeContextWindow(
                cellProfile[pair.tier],
                pair.model,
                findModel(provider, modelId)?.contextWindow,
              ),
            ] as const;
          }),
        ),
  );
  const fitting = new Set(
    pinnedTier
      ? all
      : fitContextRoutes(all, (pair) => windows.get(pair), contextTokens),
  );
  const plans: RoutePlan[] = cells.flatMap(
    ({ cell, profile: cellProfile, pairs, provenance }) =>
      primaryRoutePairs(
        cellProfile,
        pairs.filter((pair) => fitting.has(pair)),
      ).map((first) => {
        const config = freezeTierConfig(
          cellProfile[first.tier] as RoutedTierConfig,
        );
        const attempts = Object.freeze<
          [Readonly<RouteAttempt>, ...Readonly<RouteAttempt>[]]
        >([
          freezeAttempt(first),
          ...pairs
            .filter(
              (pair) =>
                pair.tier === first.tier &&
                pair.model !== first.model &&
                config.fallbacks?.includes(pair.model),
            )
            .map(freezeAttempt),
        ]);
        return Object.freeze({
          id: JSON.stringify([first.tier, cell, config, attempts]),
          tier: first.tier,
          cell,
          config,
          attempts,
          ...(provenance[first.tier] ? { mode: provenance[first.tier] } : {}),
        });
      }),
  );
  const representatives = BASELINE_TIER_ORDER.flatMap((tier) => {
    const plan = plans.find((entry) => entry.tier === tier);
    return plan ? [plan] : [];
  });
  return Object.freeze({
    plans: Object.freeze(plans),
    representatives: Object.freeze(representatives),
    meaningfulActivities: plans.some(
      (plan) =>
        plan.cell &&
        !plans.some(
          (generic) =>
            generic.tier === plan.tier &&
            !generic.cell &&
            planBehaviorKey(generic) === planBehaviorKey(plan),
        ),
    ),
  });
};

export const selectBaselinePlan = (
  profileName: string,
  profile: RouterProfile,
  matrix: RouteMatrix,
  pinnedTier?: RouterTier,
  isBudgetExceeded = false,
): {
  plan: RoutePlan;
  reasonCode: BaselineSelection['reasonCode'];
  isBudgetForced: boolean;
} => {
  const lower = matrix.plans.filter((plan) => plan.tier !== 'high');
  const pool = pinnedTier
    ? matrix.plans.filter((plan) => !plan.cell)
    : isBudgetExceeded && lower.length
      ? lower
      : matrix.plans;
  const generic = pool.filter((plan) => !plan.cell);
  const applicable = generic.length ? generic : pool;
  const selection = selectBaselineRoute(
    profileName,
    profile,
    applicable.map((plan) => plan.attempts[0]),
    pinnedTier,
    isBudgetExceeded,
  );
  const plan = applicable.find(
    (entry) => entry.attempts[0] === selection.pair,
  ) as RoutePlan;
  return { ...selection, plan };
};

/** Each physical target steps from its own effective mode effort, without remapping or widening the chain. */
export const stepPlanEffort = (
  plan: RoutePlan,
  findModel: Parameters<typeof routeThinking>[1],
  imageAttached: boolean,
  direction: 'up' | 'down',
): RoutePlan => {
  const step = (pair: Readonly<RouteAttempt>): Readonly<RouteAttempt> => {
    const { provider, modelId } = parseCanonicalModelRef(pair.model);
    const model = findModel(provider, modelId);
    if (!model?.input.includes(imageAttached ? 'image' : 'text')) return pair;
    const allowed = supportedEfforts(model, pair.declaredLevels);
    const at = THINKING_LEVELS.indexOf(pair.thinking);
    const ordered =
      direction === 'up'
        ? THINKING_LEVELS.slice(at + 1)
        : THINKING_LEVELS.slice(0, at).reverse();
    const thinking = ordered.find((level) => allowed.includes(level));
    return thinking ? Object.freeze({ ...pair, thinking }) : pair;
  };
  const [first, ...fallbacks] = plan.attempts;
  const attempts = Object.freeze([
    step(first),
    ...fallbacks.map(step),
  ] as const);
  if (attempts.every((pair, index) => pair === plan.attempts[index]))
    return plan;
  return Object.freeze({
    ...plan,
    id: JSON.stringify([plan.id, attempts]),
    sourcePlanId: plan.id,
    attempts,
  });
};

export const currentPlanPairs = (
  plan: RoutePlan,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  imageAttached: boolean,
): RoutePair[] =>
  // The frozen attempts already satisfied their declarations. Recheck only live
  // capabilities; a duplicate canonical fallback can have distinct alias metadata.
  plan.attempts.filter(
    (pair) => routeThinking(pair, findModel, imageAttached) === pair.thinking,
  );
