import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  RouterPinByProfile,
  RouterStatusState,
  RouterThinkingByProfile,
  RoutingDecision,
  StatusLineMode,
} from './types';
import {
  isAdvisorOutcome,
  isRoutingReasonCode,
  JEV_OUTCOMES,
  ROUTER_TIERS,
} from './types';

const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.isFallback) flags.push('fallback');
  if (decision.isBudgetForced) flags.push('budget-limit');
  if (decision.isGenerationFailed) flags.push('failed');
  return flags;
};

export const formatDecisionSource = (decision: RoutingDecision): string =>
  isRoutingReasonCode(decision.reasonCode) && decision.reasonCode !== 'legacy'
    ? decision.reasonCode
    : '';

const formatBypassReason = (decision: RoutingDecision): string => {
  switch (decision.bypassReason) {
    case 'pinned':
      return `pinned ${decision.tier}`;
    case 'budget':
      return 'over budget';
    case 'single-candidate':
      return `only ${decision.tier} eligible`;
    case 'tool-continuation':
      return 'tool turn';
    case 'no-user-turn':
      return 'no user turn';
    case 'turn-advised':
      return 'turn already advised';
    default:
      return '';
  }
};

export const formatAdvisorLabel = (
  decision: RoutingDecision,
): string | undefined => {
  if (!isAdvisorOutcome(decision.advisor)) return undefined;
  switch (decision.advisor) {
    case 'none':
      return 'local baseline';
    case 'bypassed': {
      const reason = formatBypassReason(decision);
      return reason ? `advice skipped: ${reason}` : 'advice bypassed';
    }
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
    parts.push(
      metrics.outcome === 'uncertain'
        ? 'No tier chosen: Jev could not judge the required capability from the supplied context; baseline used.'
        : metrics.outcome,
    );
    if (metrics.choice && metrics.choice !== 'uncertain')
      parts.push(`choice=${metrics.choice}`);
    if (metrics.selectedTier && metrics.selectedTier !== metrics.choice)
      parts.push(`selected=${metrics.selectedTier}`);
    if (metrics.selectionBasis) parts.push(`basis=${metrics.selectionBasis}`);
    if (metrics.routeProbability !== undefined)
      parts.push(`route-p=${(metrics.routeProbability * 100).toFixed(1)}%`);
    if (metrics.probability !== undefined)
      parts.push(
        `${metrics.outcome === 'uncertain' ? 'abstention-p' : 'p'}=${(metrics.probability * 100).toFixed(1)}%`,
      );
    if (metrics.confidence !== undefined)
      parts.push(
        `${metrics.outcome === 'uncertain' ? 'abstention-confidence' : 'confidence'}=${(metrics.confidence * 100).toFixed(1)}%`,
      );
    if (metrics.threshold !== undefined && metrics.outcome !== 'uncertain')
      parts.push(`threshold=${(metrics.threshold * 100).toFixed(1)}%`);
    if (
      metrics.probabilityThreshold !== undefined &&
      metrics.selectionBasis === 'probability'
    )
      parts.push(
        `route-threshold=${(metrics.probabilityThreshold * 100).toFixed(1)}%`,
      );
    if (metrics.timeoutMs !== undefined)
      parts.push(`budget=${metrics.timeoutMs}ms`);
    if (metrics.candidateCount !== undefined)
      parts.push(`candidates=${metrics.candidateCount}`);
    if (metrics.context) {
      const context = metrics.context;
      parts.push(
        `state≈${context.currentRequestTokens + context.historyTokens + context.toolTokens} tokens: ${context.currentRequestTokens} current + ${context.historyTokens} dialogue/${context.historyTurns} turns + ${context.toolTokens} tool/${context.toolResults} results; truncated=${context.truncatedBlocks}`,
      );
    }
    if (metrics.estimatedInputTokens !== undefined)
      parts.push(`request≈${metrics.estimatedInputTokens} tokens`);
    if (metrics.actualInputTokens !== undefined)
      parts.push(`Jev usage=${metrics.actualInputTokens} input tokens`);
    if (metrics.httpStatus !== undefined)
      parts.push(`HTTP ${metrics.httpStatus}`);
    if (metrics.attempts !== undefined && metrics.attempts > 1)
      parts.push(`attempts=${metrics.attempts}`);
    if (metrics.responseIssue) parts.push(`response=${metrics.responseIssue}`);
    if (metrics.httpStatus === 401)
      parts.push('Check the user-config Jev API key.');
    if (metrics.httpStatus === 422)
      parts.push('Jev rejected the request shape.');
    if (metrics.httpStatus === 429 || metrics.httpStatus === 529)
      parts.push('Transient Jev limit; the router retried once within budget.');
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
  if (!metrics)
    return ` · ${label}${decision.errorClass ? `: ${decision.errorClass}` : ''}`;
  const confidence =
    metrics.confidence !== undefined
      ? ` c${Math.round(metrics.confidence * 100)}%`
      : '';
  let summary: string;
  switch (metrics.outcome) {
    case 'selected':
      summary =
        metrics.selectionBasis === 'probability'
          ? `${metrics.choice ?? 'choice'}${confidence}${metrics.threshold !== undefined ? ` <${Math.round(metrics.threshold * 100)}%` : ''} → ${metrics.selectedTier ?? decision.tier}`
          : `→ ${metrics.choice ?? decision.tier}${confidence}`;
      break;
    case 'uncertain':
      summary = ': no tier chosen → baseline';
      break;
    case 'deadline':
      summary = ': timeout → baseline';
      break;
    case 'http-error':
      summary = `: HTTP ${metrics.httpStatus ?? 'error'} → baseline`;
      break;
    case 'network-error':
      summary = ': network error → baseline';
      break;
    case 'invalid-response':
      summary = `: invalid response${metrics.responseIssue ? ` (${metrics.responseIssue})` : ''} → baseline`;
      break;
    case 'cancelled':
      summary = ': cancelled';
      break;
    case 'unavailable':
      summary = `: ${metrics.choice ? 'target' : 'advice'} unavailable → baseline`;
      break;
    case 'input-too-large':
      summary = ': estimated request too large → baseline';
      break;
  }
  const latency =
    metrics.latencyMs >= 1000
      ? `${(metrics.latencyMs / 1000).toFixed(1)}s`
      : `${Math.round(metrics.latencyMs)}ms`;
  const reuse = decision.reuse
    ? ` · ${mode === 'detailed' && decision.reuse === 'continuation' ? 'tool route' : 'reuse'}`
    : '';
  const time = formatRunTime(metrics.startedAt);
  const extra =
    mode === 'detailed'
      ? `${metrics.probability !== undefined ? ` · ${metrics.outcome === 'uncertain' ? 'abstain ' : ''}p${Math.round(metrics.probability * 100)}%` : ''}${time ? ` @${time}` : ''}`
      : '';
  return ` · 🧭 Jev${summary.startsWith(':') ? '' : ' '}${summary} · ${latency}${extra}${reuse}`;
};

export const formatJevStats = (
  history: readonly RoutingDecision[],
): string[] => {
  const requests = new Map<string, NonNullable<RoutingDecision['jev']>>();
  let legacy = 0;
  for (const decision of history) {
    if (!decision.jev) continue;
    const metrics = decision.jev;
    if (!metrics.requestId) {
      legacy += 1;
      continue;
    }
    if (!requests.has(metrics.requestId))
      requests.set(metrics.requestId, metrics);
  }
  const samples = [...requests.values()];
  const latencies = samples
    .map((entry) => entry.latencyMs)
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);
  const median = latencies.length
    ? ((latencies[middle] ?? 0) +
        (latencies[Math.floor((latencies.length - 1) / 2)] ?? 0)) /
      2
    : undefined;
  const outcomes = JEV_OUTCOMES.map(
    (outcome) =>
      [
        outcome,
        samples.filter((entry) => entry.outcome === outcome).length,
      ] as const,
  );
  return [
    `Jev stats: ${samples.length} unique HTTP requests in ${history.length} retained decisions (not session lifetime).`,
    `Advised tiers: ${ROUTER_TIERS.map((tier) => `${tier}=${samples.filter((entry) => entry.choice === tier).length}`).join(', ')}.`,
    ...outcomes
      .filter(([, count]) => count > 0)
      .map(
        ([outcome, count]) =>
          `${outcome}: ${count}/${samples.length} (${((100 * count) / samples.length).toFixed(1)}%)`,
      ),
    `Median Jev latency: ${median === undefined ? 'n/a' : `${Math.round(median)}ms`}. Reused decisions are not new requests.`,
    ...(legacy
      ? [
          `${legacy} decisions without request IDs excluded (legacy or no HTTP request).`,
        ]
      : []),
  ];
};

export const formatGenerationDetail = (
  decision: RoutingDecision,
): string | undefined => {
  const usage = decision.generation;
  if (!usage) return undefined;
  const parts = [
    `Generation: ${usage.transition}`,
    `input=${usage.inputTokens} output=${usage.outputTokens} cache-read=${usage.cacheReadTokens} cache-write=${usage.cacheWriteTokens}`,
    `attempts=${usage.attempts}`,
    `reported cost=${usage.reportedCostUsd === undefined ? 'unknown' : `$${usage.reportedCostUsd.toFixed(4)}`} (catalog/list-price, not billing)`,
    'future cache warmth=unknown',
  ];
  if (usage.contextTruncated) parts.push('context truncated');
  const shadow = usage.shadow;
  parts.push(
    shadow
      ? `shadow same-token all-read/all-new: stay ${shadow.previousModel}=$${shadow.stayAllReadUsd.toFixed(4)}/$${shadow.stayAllNewUsd.toFixed(4)}, switch=$${shadow.switchAllReadUsd.toFixed(4)}/$${shadow.switchAllNewUsd.toFixed(4)} (includes output; not predicted savings)`
      : 'shadow unavailable',
  );
  return parts.join(' · ');
};

export const formatDecision = (decision: RoutingDecision): string => {
  const source = formatDecisionSource(decision);
  const flags = getDecisionFlags(decision);
  const flagsStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
  const advisor = formatAdvisorDetail(decision);
  const generation = formatGenerationDetail(decision);
  return `${decision.profile}: ${decision.tier} -> ${decision.targetProvider}/${decision.targetModelId} [${decision.thinking}]${flagsStr}${source ? ` (${source})` : ''}${advisor ? ` [${advisor}]` : ''}${generation ? ` [${generation}]` : ''}`;
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
  const activePin =
    selectedProfile && Object.hasOwn(pinnedTierByProfile, selectedProfile)
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
      const generation = lastDecision.generation;
      const cache =
        state.statusLine === 'detailed' && generation
          ? ` · cache r${generation.cacheReadTokens}/w${generation.cacheWriteTokens} · ${generation.transition}`
          : '';
      statusText = `${route}${lastDecision.isFallback ? ' [fallback]' : ''}${formatAdvisorFooter(lastDecision, state.statusLine)}${cache}`;
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
    `Estimated cost (catalog): $${accumulatedCost.toFixed(4)}` +
      (maxSessionBudget ? ` / $${maxSessionBudget.toFixed(2)}` : ''),
  ];
  if (lastDecision && lastDecision.profile === statusProfile) {
    const flags = getDecisionFlags(lastDecision);
    const flagsStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
    const advisorDetail = formatAdvisorDetail(lastDecision);
    const generationDetail = formatGenerationDetail(lastDecision);

    widgetLines.push(
      `Route: ${lastDecision.tier}${flagsStr} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${lastDecision.thinking})`,
      `Source: ${formatDecisionSource(lastDecision) || 'unknown'}`,
      ...(advisorDetail ? [advisorDetail] : []),
      ...(generationDetail ? [generationDetail] : []),
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
