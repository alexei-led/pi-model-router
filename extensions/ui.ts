import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  RouterPinByProfile,
  RouterStatusState,
  RouterThinkingByProfile,
  RoutingDecision,
} from './types';
import { isRoutingReasonCode } from './types';

const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.isFallback) flags.push('fallback');
  if (decision.isBudgetForced) flags.push('budget-limit');
  return flags;
};

export const formatDecisionSource = (decision: RoutingDecision): string =>
  isRoutingReasonCode(decision.reasonCode) && decision.reasonCode !== 'legacy'
    ? decision.reasonCode
    : '';

export const formatDecision = (decision: RoutingDecision): string => {
  const source = formatDecisionSource(decision);
  return `${decision.profile}: ${decision.tier} -> ${decision.targetProvider}/${decision.targetModelId} [${decision.thinking}]${source ? ` (${source})` : ''}`;
};

export const formatPinSummary = (
  pinnedTierByProfile: RouterPinByProfile,
): string => {
  const entries = Object.entries(pinnedTierByProfile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, tier]) => `${profile}:${tier}`);
  return entries.length > 0 ? entries.join(', ') : 'none';
};

export const formatThinkingSummary = (
  thinkingByProfile: RouterThinkingByProfile,
): string => {
  const entries = Object.entries(thinkingByProfile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, tierMap]) => {
      const tiers = Object.entries(tierMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tier, level]) => `${tier}:${level}`);
      return `${profile}(${tiers.join(',')})`;
    });
  return entries.length > 0 ? entries.join(', ') : 'none';
};

export const formatModelRef = (ref: string | undefined): string => {
  return ref ?? 'none';
};

export const updateStatus = (
  ctx: ExtensionContext,
  state: RouterStatusState,
) => {
  const {
    routerEnabled,
    selectedProfile,
    pinnedTierByProfile,
    lastDecision,
    lastNonRouterModel,
    accumulatedCost,
    widgetEnabled,
    maxSessionBudget,
  } = state;
  const activeRouterProfile = routerEnabled ? selectedProfile : undefined;
  const statusProfile = selectedProfile ?? 'none';
  const activePin = selectedProfile
    ? pinnedTierByProfile[selectedProfile]
    : undefined;
  const pinLabel = activePin ? ` [pin:${activePin}]` : '';

  if (activeRouterProfile) {
    const matchesProfile =
      lastDecision && lastDecision.profile === activeRouterProfile;
    const matchesPin = activePin
      ? lastDecision?.tier === activePin ||
        lastDecision?.reasonCode === 'pinned' ||
        lastDecision?.reasonCode === 'budget'
      : true;

    let statusText: string;
    if (lastDecision && matchesProfile && matchesPin) {
      statusText = `router:${activeRouterProfile}${pinLabel} -> ${lastDecision.tier} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${lastDecision.thinking})`;
    } else {
      statusText = `router:${activeRouterProfile}${pinLabel} -> waiting`;
    }
    ctx.ui.setStatus('router', `🚥 ${statusText}`);
  } else {
    ctx.ui.setStatus('router', undefined);
  }

  if (!widgetEnabled) {
    ctx.ui.setWidget('router', undefined);
    return;
  }

  const widgetLines = [
    `Router: ${routerEnabled ? 'enabled' : 'disabled'}`,
    `Profile: ${statusProfile}${activeRouterProfile ? ' (active)' : ''}`,
    `Pin: ${activePin ?? 'auto'}`,
    `Cost: $${accumulatedCost.toFixed(4)}` +
      (maxSessionBudget ? ` / $${maxSessionBudget.toFixed(2)}` : ''),
  ];
  if (lastDecision && lastDecision.profile === statusProfile) {
    const flags = getDecisionFlags(lastDecision);
    const flagsStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';

    widgetLines.push(
      `Route: ${lastDecision.tier}${flagsStr} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${lastDecision.thinking})`,
      `Phase: ${lastDecision.phase}`,
      `Source: ${formatDecisionSource(lastDecision) || 'unknown'}`,
      ...(Number.isFinite(lastDecision.routingLatencyMs)
        ? [`Routing: ${Math.round(lastDecision.routingLatencyMs ?? 0)}ms`]
        : []),
      ...(lastDecision.errorClass === 'deadline' ||
      lastDecision.errorClass === 'advisor-unavailable'
        ? [`Routing error: ${lastDecision.errorClass}`]
        : []),
    );
  } else if (!routerEnabled && lastNonRouterModel) {
    widgetLines.push(`Fallback: ${lastNonRouterModel}`);
  }
  if (Object.keys(pinnedTierByProfile).length > 1) {
    widgetLines.push(`Pins: ${formatPinSummary(pinnedTierByProfile)}`);
  }
  ctx.ui.setWidget(
    'router',
    widgetLines.map((line) => ctx.ui.theme.fg('dim', line)),
  );
};
