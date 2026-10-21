import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { DEFAULT_MODES, DEFAULT_SWITCH_POLICY } from './config';
import { THINKING_LEVELS } from './domain';
import type {
  ModeLever,
  ModeSource,
  ResolvedMode,
  RoutePair,
  RouterConfig,
  RouterMode,
  RouterSwitchPolicy,
  RouterTier,
} from './types';
import { ROUTER_TIERS } from './types';

/** Session override > project file > profile config > balanced. */
export const resolveMode = (layers: {
  session?: RouterMode | undefined;
  project?: RouterMode | undefined;
  profile?: RouterMode | undefined;
}): ResolvedMode => {
  const order: [ModeSource, RouterMode | undefined][] = [
    ['session', layers.session],
    ['project', layers.project],
    ['profile', layers.profile],
  ];
  for (const [source, mode] of order) if (mode) return { mode, source };
  return { mode: 'balanced', source: 'default' };
};

export const modeForProfile = (
  config: RouterConfig,
  profile: string | undefined,
  session: RouterMode | undefined,
): ResolvedMode =>
  resolveMode({
    session,
    project: config.projectMode,
    profile:
      profile && Object.hasOwn(config.profiles, profile)
        ? config.profiles[profile]?.mode
        : undefined,
  });

/** Config policy < mode patch < Settings-tab edits for this session. */
export const effectivePolicy = (
  config: RouterConfig,
  mode: RouterMode,
): RouterSwitchPolicy => ({
  ...(config.switchPolicy ?? DEFAULT_SWITCH_POLICY),
  ...(config.modes ?? DEFAULT_MODES)[mode].policy,
  ...config.sessionPolicy,
});

export interface ModeTransform {
  sourceTier: RouterTier;
  thinking: ThinkingLevel;
  lever: ModeLever;
}

const level = (value: ThinkingLevel) => THINKING_LEVELS.indexOf(value);
const LOWEST_THINKING_ABOVE_MICRO = level('low');
const shift = (tier: RouterTier, step: 1 | -1): RouterTier | undefined =>
  ROUTER_TIERS[ROUTER_TIERS.indexOf(tier) - step];

/**
 * The fixed, stateless mode transform (design §2). It always starts from the
 * configured pairs `routeAt`, never from an already transformed pair, and
 * moves one lever: cost prefers a cheaper model, quality a higher effort.
 * `project` maps an effort onto the levels the pair's model supports.
 */
export const transformRoute = (input: {
  mode: RouterMode;
  tier: RouterTier;
  routeAt: (tier: RouterTier) => RoutePair | undefined;
  project: (pair: RoutePair, level: ThinkingLevel) => ThinkingLevel | undefined;
  inputPrice: (model: string) => number | undefined;
  /** False over the soft budget: quality must not reach the high route. */
  allowHigh: boolean;
}): ModeTransform | undefined => {
  const { mode, tier } = input;
  const own = input.routeAt(tier);
  if (!own) return undefined;
  const keep: ModeTransform = {
    sourceTier: tier,
    thinking: own.thinking,
    lever: 'none',
  };
  if (mode === 'balanced' || tier === 'micro') return keep;
  const stepped = (step: 1 | -1) => {
    const next = THINKING_LEVELS[level(own.thinking) + step];
    return next ? input.project(own, next) : undefined;
  };
  if (mode === 'cost') {
    const lowerTier = tier === 'low' ? 'low' : (shift(tier, -1) ?? 'low');
    const lower = input.routeAt(lowerTier);
    const ownPrice = input.inputPrice(own.model);
    const lowerPrice = lower ? input.inputPrice(lower.model) : undefined;
    if (
      lower &&
      lower.model !== own.model &&
      ownPrice !== undefined &&
      // A zero price is a placeholder, not evidence of a cheaper model.
      lowerPrice !== undefined &&
      lowerPrice > 0 &&
      lowerPrice < ownPrice
    )
      return {
        sourceTier: lowerTier,
        thinking: lower.thinking,
        lever: 'model',
      };
    const effort = stepped(-1);
    return effort &&
      level(effort) < level(own.thinking) &&
      level(effort) >= LOWEST_THINKING_ABOVE_MICRO
      ? { sourceTier: tier, thinking: effort, lever: 'effort' }
      : keep;
  }
  const effort = stepped(1);
  if (effort && level(effort) > level(own.thinking))
    return { sourceTier: tier, thinking: effort, lever: 'effort' };
  const upperTier = shift(tier, 1) ?? 'high';
  const upper =
    upperTier === tier || (upperTier === 'high' && !input.allowHigh)
      ? undefined
      : input.routeAt(upperTier);
  return upper && (upper.model !== own.model || upper.thinking !== own.thinking)
    ? { sourceTier: upperTier, thinking: upper.thinking, lever: 'model' }
    : keep;
};
