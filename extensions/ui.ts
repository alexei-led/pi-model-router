import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type {
  ClassifierDiagnostics,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RouterUIPreferences,
  RouterUIRoute,
  RouterUISnapshot,
  RoutingDecision,
  StatusLineMode,
} from './types';
import {
  CLASSIFIER_OUTCOMES,
  isAdvisorOutcome,
  isRoutingReasonCode,
} from './types';
import {
  clock,
  latency,
  modelName,
  percent,
  TIER_DISPLAY_ORDER,
  tierMeter,
  usdFine,
} from './ui/format';
import { formatMode, routerTone, shortReason } from './ui/presentation';

export { openRouterInspector } from './ui/inspector';

/** The status line is shared with other extensions; Pi cuts the joined line. Stay short. */
const STATUS_COLUMNS = 40;
const PART_SEPARATOR = '  ';

const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.reviewOnly) flags.push('review-only');
  if (decision.activity) flags.push(`activity=${decision.activity}`);
  else if (decision.routeCell)
    flags.push(`availability-cell=${decision.routeCell}`);
  if (decision.costRecovery) flags.push('cost-recovery');
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
      return 'baseline only';
    case 'bypassed': {
      const reason = formatBypassReason(decision);
      return reason ? `advice skipped: ${reason}` : 'advice bypassed';
    }
    case 'classifier':
      return 'classifier ✓';
    case 'classifier-fallback':
      return 'classifier · baseline kept';
    default:
      return undefined;
  }
};

const formatRunTime = (startedAt: number | undefined): string | undefined =>
  startedAt !== undefined &&
  Number.isFinite(startedAt) &&
  startedAt >= 0 &&
  startedAt <= 8.64e15
    ? clock(startedAt)
    : undefined;

const activityDiagnostics = (metrics: ClassifierDiagnostics): string[] => [
  ...(metrics.activityOutcome
    ? [
        `${metrics.phaseOutcome ? 'goal' : 'activity'}=${metrics.activity ?? 'unknown'} (${metrics.activityOutcome})`,
      ]
    : []),
  ...(metrics.phaseOutcome
    ? [`phase=${metrics.phase ?? 'unknown'} (${metrics.phaseOutcome})`]
    : []),
];

export const formatAdvisorDetail = (
  decision: RoutingDecision,
): string | undefined => {
  const label = formatAdvisorLabel(decision);
  if (!label) return undefined;
  const metrics = decision.classification;
  const service = metrics?.model ?? 'Classifier';
  const latencyMs = metrics?.latencyMs ?? decision.routingLatencyMs;
  const parts = [label];
  if (metrics) {
    if (metrics.model) parts.push(metrics.model);
    const time = formatRunTime(metrics.startedAt);
    if (time) parts.push(`started=${time}`);
    parts.push(
      metrics.outcome === 'uncertain'
        ? `No tier chosen: ${service} could not judge the required capability from the supplied context; baseline used.`
        : metrics.outcome,
    );
    parts.push(...activityDiagnostics(metrics));
    if (metrics.choice && metrics.choice !== 'uncertain')
      parts.push(`choice=${metrics.choice}`);
    if (metrics.selectedTier && metrics.selectedTier !== metrics.choice)
      parts.push(`selected=${metrics.selectedTier}`);
    if (metrics.selectionBasis) parts.push(`basis=${metrics.selectionBasis}`);
    if (metrics.routeProbability !== undefined)
      parts.push(`route-p=${percent(metrics.routeProbability)}`);
    if (metrics.probability !== undefined)
      parts.push(
        `${metrics.outcome === 'uncertain' ? 'abstention-p' : 'p'}=${percent(metrics.probability)}`,
      );
    if (metrics.confidence !== undefined)
      parts.push(
        `${metrics.outcome === 'uncertain' ? 'abstention-confidence' : 'confidence'}=${percent(metrics.confidence)}`,
      );
    if (metrics.threshold !== undefined && metrics.outcome !== 'uncertain')
      parts.push(`threshold=${percent(metrics.threshold)}`);
    if (
      metrics.probabilityThreshold !== undefined &&
      metrics.selectionBasis === 'probability'
    )
      parts.push(`route-threshold=${percent(metrics.probabilityThreshold)}`);
    if (metrics.timeoutMs !== undefined)
      parts.push(`deadline=${latency(metrics.timeoutMs)}`);
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
      parts.push(`${service} usage=${metrics.actualInputTokens} input tokens`);
    if (metrics.actualOutputTokens !== undefined)
      parts.push(`output=${metrics.actualOutputTokens} tokens`);
    if (metrics.costUsd !== undefined)
      parts.push(`classifier cost ${usdFine(metrics.costUsd)} (catalog)`);
    if (metrics.httpStatus !== undefined)
      parts.push(`HTTP ${metrics.httpStatus}`);
    if (metrics.attempts !== undefined && metrics.attempts > 1)
      parts.push(`attempts=${metrics.attempts}`);
    if (metrics.responseIssue) parts.push(`response=${metrics.responseIssue}`);
    if (metrics.httpStatus === 401)
      parts.push('Check classifier authentication through Pi.');
    if (metrics.httpStatus === 422)
      parts.push(`${service} rejected the request shape.`);
    if (metrics.httpStatus === 429 || metrics.httpStatus === 529)
      parts.push(
        `Transient ${service} limit; retries are bounded by the advisory budget.`,
      );
  } else if (decision.errorClass) {
    parts.push(decision.errorClass);
  }
  if (latencyMs !== undefined && Number.isFinite(latencyMs))
    parts.push(latency(latencyMs));
  if (decision.reuse) parts.push(`reuse=${decision.reuse}`);
  return parts.join(' · ');
};

export const formatClassifierStats = (
  history: readonly RoutingDecision[],
): string[] => {
  const service = 'Classifier';
  const requests = new Map<
    string,
    NonNullable<RoutingDecision['classification']>
  >();
  let legacy = 0;
  for (const decision of history) {
    const metrics = decision.classification;
    if (!metrics) continue;
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
  const outcomes = CLASSIFIER_OUTCOMES.map(
    (outcome) =>
      [
        outcome,
        samples.filter((entry) => entry.outcome === outcome).length,
      ] as const,
  );
  return [
    `${service} stats: ${samples.length} unique advice requests in ${history.length} retained decisions (not session lifetime).`,
    `Advised tiers: ${TIER_DISPLAY_ORDER.map((tier) => `${tier}=${samples.filter((entry) => entry.choice === tier).length}`).join(', ')}.`,
    ...outcomes
      .filter(([, count]) => count > 0)
      .map(
        ([outcome, count]) =>
          `${outcome}: ${count}/${samples.length} (${percent(count / samples.length)})`,
      ),
    `Median ${service.toLowerCase()} latency: ${median === undefined ? 'n/a' : latency(median)}. Reused decisions are not new requests.`,
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
    `cost ${usdFine(usage.reportedCostUsd)} (catalog)`,
  ];
  if (usage.contextTruncated) parts.push('context truncated');
  const shadow = usage.shadow;
  parts.push(
    shadow
      ? `same tokens, all read / all new: stay ${shadow.previousModel} ${usdFine(shadow.stayAllReadUsd)} / ${usdFine(shadow.stayAllNewUsd)}, switch ${usdFine(shadow.switchAllReadUsd)} / ${usdFine(shadow.switchAllNewUsd)} (includes output; not predicted savings)`
      : 'same-token comparison unavailable',
  );
  return parts.join(' · ');
};

export const formatDecision = (decision: RoutingDecision): string => {
  const source = formatDecisionSource(decision);
  const flags = getDecisionFlags(decision);
  const flagsStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
  const advisor = formatAdvisorDetail(decision);
  const generation = formatGenerationDetail(decision);
  const switchCost = decision.switchCost
    ? `switch ${decision.switchCost.reason} · horizon ${decision.switchCost.horizonRequests} · stay ${usdFine(decision.switchCost.stayUsd)} · target ${usdFine(decision.switchCost.switchUsd)}${decision.proposedRoute ? ` · proposed ${decision.proposedRoute.tier}/${decision.proposedRoute.activity ?? 'base'} ${decision.proposedRoute.model} [${decision.proposedRoute.thinking}]` : ''}`
    : undefined;
  const mode = decision.mode
    ? ` {mode ${decision.mode}${decision.modeSource ? ` (${decision.modeSource})` : ''}${decision.modeLever && decision.modeLever !== 'none' ? ` · ${decision.modeLever === 'model' && decision.modeSourceTier === decision.tier ? 'mode model preference' : `${decision.modeLever} lever from ${decision.modeSourceTier ?? decision.tier}`}` : ''}}`
    : '';
  const escalated = decision.escalatedFrom
    ? ` {escalated from ${decision.escalatedFrom}}`
    : '';
  return `${decision.profile}: ${decision.tier} → ${decision.targetProvider}/${decision.targetModelId} [${decision.thinking}]${flagsStr}${source ? ` (${source})` : ''}${mode}${escalated}${advisor ? ` [${advisor}]` : ''}${switchCost ? ` [${switchCost}]` : ''}${generation ? ` [${generation}]` : ''}`;
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

interface StripPart {
  text: string;
  /** 0 never drops; higher numbers drop first when the line is too narrow. */
  priority: number;
}

/** Drops the highest-priority parts until the line fits, then cuts what is left. */
const fitParts = (parts: readonly StripPart[], width: number): string => {
  const kept = [...parts];
  const joined = () => kept.map((part) => part.text).join(PART_SEPARATOR);
  while (visibleWidth(joined()) > width) {
    let drop = -1;
    let dropPriority = 0;
    kept.forEach((part, index) => {
      if (part.priority > 0 && part.priority >= dropPriority) {
        drop = index;
        dropPriority = part.priority;
      }
    });
    if (drop < 0) break;
    kept.splice(drop, 1);
  }
  return truncateToWidth(joined(), width);
};

const routeCore = (
  route: RouterUIRoute,
  statusLine: StatusLineMode | undefined,
): string =>
  `${tierMeter(route.tier)} ${
    statusLine === 'detailed'
      ? `${route.provider}/${route.model}`
      : modelName(route.model)
  } · ${route.thinking}`;

export const updateRouterUIStrip = (
  ctx: ExtensionContext,
  snapshot: RouterUISnapshot,
  preferences: RouterUIPreferences,
): void => {
  if (ctx.mode !== 'tui') return;
  const tone = routerTone(snapshot);
  const pending = snapshot.pendingControls;
  const hasPending = pending !== undefined || snapshot.pendingRoutes === true;
  const route = snapshot.actual;
  const core = route
    ? routeCore(route, preferences.statusLine)
    : `Router · ${snapshot.profile}`;
  if (snapshot.lifecycle === 'off') {
    ctx.ui.setStatus('router', undefined);
    ctx.ui.setWidget('router', undefined);
    return;
  }
  if (!preferences.widgetEnabled) {
    ctx.ui.setWidget('router', undefined);
    const fault = ['fallback', 'timeout', 'budget', 'failed'].includes(
      snapshot.lifecycle,
    );
    const columns = process.stdout.columns ?? 80;
    ctx.ui.setStatus(
      'router',
      ctx.ui.theme.fg(
        tone,
        fitParts(
          [
            // The marker leads so the cut at the end never hides pending or fault state.
            {
              text: `${hasPending ? '⏵ ' : fault ? '! ' : ''}${core}`,
              priority: 0,
            },
            ...(route?.activity ? [{ text: route.activity, priority: 2 }] : []),
          ],
          Math.max(1, Math.min(columns, STATUS_COLUMNS)),
        ),
      ),
    );
    return;
  }
  ctx.ui.setStatus('router', undefined);
  const pendingLabel =
    pending !== undefined
      ? pending.pin !== snapshot.controls.pin
        ? `pin ${pending.pin}`
        : 'settings changed'
      : 'route edits queued';
  const advice = snapshot.advice;
  const adviceDetail =
    advice?.outcome === 'selected' && advice.latencyMs !== undefined
      ? `classifier ${latency(advice.latencyMs)}`
      : undefined;
  ctx.ui.setWidget('router', (_tui, theme) => ({
    invalidate: () => {},
    render: (width: number): string[] => {
      const w = Math.max(1, width);
      const second = [
        ...(hasPending ? [`⏵ next turn: ${pendingLabel}`] : []),
        snapshot.profile,
        formatMode(snapshot),
        ...(adviceDetail ? [adviceDetail] : []),
      ].join(' · ');
      return [
        theme.fg(
          tone,
          fitParts(
            [
              { text: core, priority: 0 },
              ...(route?.activity
                ? [{ text: route.activity, priority: 2 }]
                : []),
              { text: shortReason(snapshot), priority: 1 },
            ],
            w,
          ),
        ),
        theme.fg(hasPending ? 'warning' : 'muted', truncateToWidth(second, w)),
      ];
    },
  }));
};
