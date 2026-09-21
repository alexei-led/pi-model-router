import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  RouterPinByProfile,
  RouterStatusState,
  RouterThinkingByProfile,
  RoutingDecision,
  StatusLineMode,
} from './types';
import { isAdvisorOutcome, isRoutingReasonCode } from './types';

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

export const formatAdvisorLabel = (
  decision: RoutingDecision,
): string | undefined => {
  if (!isAdvisorOutcome(decision.advisor)) return undefined;
  switch (decision.advisor) {
    case 'none':
      return 'local baseline';
    case 'bypassed':
      return 'advice bypassed';
    case 'jev':
      return '🧭 Jev ✓';
    case 'jev-fallback':
      return '🧭 Jev ↪ base';
    case 'classifier':
      return '🧠 Classifier ✓';
    case 'classifier-fallback':
      return '🧠 Classifier ↪ base';
    default:
      return undefined;
  }
};

const formatRunTime = (startedAt: number | undefined): string | undefined =>
  startedAt !== undefined &&
  Number.isFinite(startedAt) &&
  startedAt >= 0 &&
  startedAt <= 8.64e15
    ? new Date(startedAt).toLocaleTimeString('en-GB', { hour12: false })
    : undefined;

export const formatAdvisorDetail = (
  decision: RoutingDecision,
): string | undefined => {
  const label = formatAdvisorLabel(decision);
  if (!label) return undefined;
  const metrics = decision.jev;
  const latencyMs = metrics?.latencyMs ?? decision.routingLatencyMs;
  const parts = [label];
  if (metrics) {
    if (metrics.model) parts.push(metrics.model);
    if (metrics.resolvedModel && metrics.resolvedModel !== metrics.model)
      parts.push(`resolved=${metrics.resolvedModel}`);
    const time = formatRunTime(metrics.startedAt);
    if (time) parts.push(`started=${time}`);
    parts.push(metrics.outcome);
    if (metrics.choice) parts.push(`choice=${metrics.choice}`);
    if (metrics.probability !== undefined)
      parts.push(`p=${(metrics.probability * 100).toFixed(1)}%`);
    if (metrics.confidence !== undefined)
      parts.push(`confidence=${(metrics.confidence * 100).toFixed(1)}%`);
    if (metrics.threshold !== undefined)
      parts.push(`threshold=${(metrics.threshold * 100).toFixed(1)}%`);
    if (metrics.timeoutMs !== undefined)
      parts.push(`budget=${metrics.timeoutMs}ms`);
    if (metrics.candidateCount !== undefined)
      parts.push(`candidates=${metrics.candidateCount}`);
    if (metrics.contextChars !== undefined)
      parts.push(`context=${metrics.contextChars} chars`);
    if (metrics.httpStatus !== undefined)
      parts.push(`HTTP ${metrics.httpStatus}`);
  } else if (decision.errorClass) {
    parts.push(decision.errorClass);
  }
  if (latencyMs !== undefined && Number.isFinite(latencyMs))
    parts.push(`${Math.round(latencyMs)}ms`);
  if (decision.reuse) parts.push(`reuse=${decision.reuse}`);
  return parts.join(' · ');
};

export const formatAdvisorFooter = (
  decision: RoutingDecision,
  mode: StatusLineMode = 'compact',
): string => {
  const label = formatAdvisorLabel(decision);
  if (!label) return '';
  const metrics = decision.jev;
  const detail = metrics
    ? metrics.outcome === 'selected'
      ? ''
      : `: ${metrics.outcome}`
    : decision.errorClass
      ? `: ${decision.errorClass}`
      : '';
  const choice = metrics?.choice
    ? ` [${metrics.choice}${metrics.confidence !== undefined ? ` c${Math.round(metrics.confidence * 100)}%` : ''}${metrics.probability !== undefined ? ` p${Math.round(metrics.probability * 100)}%` : ''}]`
    : '';
  const latency = metrics ? ` ${Math.round(metrics.latencyMs)}ms` : '';
  const time = formatRunTime(metrics?.startedAt);
  if (mode === 'compact') {
    const confidence =
      metrics?.confidence !== undefined
        ? ` c${Math.round(metrics.confidence * 100)}%`
        : '';
    const proposed =
      decision.advisor === 'jev-fallback' &&
      metrics?.choice &&
      metrics.choice !== 'uncertain'
        ? ` ${metrics.choice}`
        : '';
    const reused = decision.reuse ? ' · reuse' : '';
    if (
      metrics?.outcome === 'low-confidence' &&
      metrics.choice &&
      metrics.confidence !== undefined &&
      metrics.threshold !== undefined
    )
      return ` · 🧭 Jev ${metrics.choice}↪base${confidence}<${Math.round(metrics.threshold * 100)}%${latency}${reused}`;
    return ` · ${label}${detail}${proposed}${confidence}${latency}${reused}`;
  }
  const threshold =
    metrics?.threshold !== undefined
      ? ` t${Math.round(metrics.threshold * 100)}%`
      : '';
  const reuse =
    decision.reuse === 'continuation'
      ? ' · tool route'
      : decision.reuse
        ? ' · reused'
        : '';
  return ` · ${label}${detail}${choice}${threshold}${latency}${time ? ` @${time}` : ''}${reuse}`;
};

export const formatDecision = (decision: RoutingDecision): string => {
  const source = formatDecisionSource(decision);
  const advisor = formatAdvisorDetail(decision);
  return `${decision.profile}: ${decision.tier} -> ${decision.targetProvider}/${decision.targetModelId} [${decision.thinking}]${source ? ` (${source})` : ''}${advisor ? ` [${advisor}]` : ''}`;
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
    const matchesPin = !activePin || lastDecision?.tier === activePin;

    let statusText: string;
    if (lastDecision && matchesProfile && matchesPin) {
      const route =
        state.statusLine === 'detailed'
          ? `router:${activeRouterProfile}${pinLabel} -> ${lastDecision.tier} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${lastDecision.thinking})`
          : `${activeRouterProfile}${pinLabel} · ${lastDecision.tier} → ${lastDecision.targetModelId}/${lastDecision.thinking}`;
      statusText = `${route}${lastDecision.isFallback ? ' [fallback]' : ''}${formatAdvisorFooter(lastDecision, state.statusLine)}`;
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
    const advisorDetail = formatAdvisorDetail(lastDecision);

    widgetLines.push(
      `Route: ${lastDecision.tier}${flagsStr} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${lastDecision.thinking})`,
      `Source: ${formatDecisionSource(lastDecision) || 'unknown'}`,
      ...(advisorDetail ? [advisorDetail] : []),
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
