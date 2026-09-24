import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai';
import { parseCanonicalModelRef, THINKING_LEVELS } from './config';
import type {
  ModelDefinition,
  RoutePair,
  RouterPhase,
  RouterProfile,
  RouterThinkingByTier,
  RouterTier,
  RoutingDecision,
  RoutingReasonCode,
} from './types';
import { ROUTER_TIERS } from './types';

/** The configured default preference order when no baseline tier is supplied. */
export const BASELINE_TIER_ORDER: readonly RouterTier[] = [
  'medium',
  'high',
  'low',
  'micro',
] as const;

export const phaseForTier = (tier: RouterTier): RouterPhase => {
  if (tier === 'high') return 'planning';
  if (tier === 'medium') return 'implementation';
  return 'lightweight';
};

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
 * Pi's clampThinkingLevel over the levels a route may use: the requested
 * effort, else the nearest higher one, else the nearest lower one.
 */
export const clampEffort = (
  requested: ThinkingLevel,
  allowed: readonly ThinkingLevel[],
): ThinkingLevel | undefined => {
  if (allowed.includes(requested)) return requested;
  const index = THINKING_LEVELS.indexOf(requested);
  return (
    THINKING_LEVELS.slice(index + 1).find((level) => allowed.includes(level)) ??
    THINKING_LEVELS.slice(0, index)
      .reverse()
      .find((level) => allowed.includes(level))
  );
};

/**
 * Resolve the effort a route runs at against the live registry, or undefined
 * when the model cannot serve the input. An unsupported effort maps to its
 * nearest supported level, as pi does. A configured effort declaration only
 * narrows the levels; it never grants one the live model does not expose.
 */
export const routeThinking = (
  pair: RoutePair,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  imageAttached: boolean,
  declaredLevels?: ModelDefinition['thinkingLevels'],
): ThinkingLevel | undefined => {
  try {
    const { provider, modelId } = parseCanonicalModelRef(pair.model);
    if (provider === 'router') return undefined;
    const model = findModel(provider, modelId);
    if (!model?.input.includes(imageAttached ? 'image' : 'text'))
      return undefined;
    const allowed = getSupportedThinkingLevels(model).filter(
      (level) =>
        !declaredLevels || level === 'off' || declaredLevels.includes(level),
    );
    return clampEffort(pair.thinking, allowed);
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
export const availableRoutePairs = (
  profile: RouterProfile,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  imageAttached: boolean,
  thinkingOverrides?: RouterThinkingByTier,
): RoutePair[] =>
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
          const thinking = routeThinking(
            { tier, model: target, thinking: requested },
            findModel,
            imageAttached,
            // Only declared levels narrow a route; undeclared means the registry's.
            ownConfig?.reasoning === false ? [] : ownConfig?.thinkingLevels,
          );
          return thinking ? [{ tier, model: target, thinking }] : [];
        } catch {
          return [];
        }
      })
      .filter(
        (pair, index, pairs) =>
          pairs.findIndex((other) => other.model === pair.model) === index,
      );
  });

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
): boolean => {
  for (const imageAttached of [false, true]) {
    const configured = availableRoutePairs(profile, findModel, imageAttached);
    const overridden = availableRoutePairs(
      profile,
      findModel,
      imageAttached,
      thinkingOverrides,
    );
    if (configured.length > 0 && overridden.length === 0) return false;
  }
  return [false, true].some(
    (imageAttached) =>
      availableRoutePairs(profile, findModel, imageAttached, thinkingOverrides)
        .length > 0,
  );
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
  if (!baseline || !profile[baseline]) return BASELINE_TIER_ORDER;
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

export const primaryRoutePairs = (
  profile: RouterProfile,
  pairs: readonly RoutePair[],
): RoutePair[] =>
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
    phase: phaseForTier(pair.tier),
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: pair.model,
    thinking: pair.thinking,
    reasonCode,
    timestamp: Date.now(),
  };
};
