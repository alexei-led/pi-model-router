import type { Api, Model } from '@earendil-works/pi-ai';
import { buildRouteMatrix } from '../routing';
import type {
  ResolvedMode,
  RouterActivity,
  RouterPin,
  RouterProfile,
  RouterThinkingByTier,
  RouterTier,
  RouterUIRoutePreference,
} from '../types';

/** Text-only preference, not a prediction of auth, request-context fit or a held switch. */
export const routePreferences = (input: {
  profile: RouterProfile | undefined;
  find: ((provider: string, id: string) => Model<Api> | undefined) | undefined;
  mode: ResolvedMode;
  pin: RouterPin;
  thinkingOverrides: RouterThinkingByTier;
  activityRouting: boolean;
  budgetExceeded: boolean;
}): ((
  activity: RouterActivity,
  tier: RouterTier,
) => RouterUIRoutePreference) => {
  const pin = input.pin === 'auto' ? undefined : input.pin;
  const matrix =
    input.profile && input.find
      ? buildRouteMatrix(
          input.profile,
          input.find,
          false,
          0,
          input.thinkingOverrides,
          input.activityRouting,
          pin,
          { mode: input.mode.mode, budgetExceeded: input.budgetExceeded },
        )
      : undefined;
  return (activity, tier) => {
    if (!input.find) return { mode: input.mode, status: 'unknown' };
    const selectedTier = pin ?? tier;
    const plan =
      matrix?.plans.find(
        (entry) =>
          entry.tier === selectedTier &&
          entry.cell === (input.activityRouting && !pin ? activity : undefined),
      ) ??
      matrix?.plans.find((entry) => entry.tier === selectedTier && !entry.cell);
    if (!plan) return { mode: input.mode, status: 'unavailable' };
    return {
      mode: input.mode,
      status: 'eligible',
      route: { ...plan.attempts[0] },
      lever: plan.mode?.lever ?? 'none',
      sourceTier: plan.mode?.sourceTier ?? selectedTier,
      ...(pin
        ? { bypass: 'pin' as const }
        : input.thinkingOverrides[tier]
          ? { bypass: 'effort' as const }
          : !input.activityRouting
            ? { bypass: 'activity-off' as const }
            : {}),
      ...(plan.config.model !== plan.attempts[0].model
        ? { fallback: true }
        : {}),
    };
  };
};
