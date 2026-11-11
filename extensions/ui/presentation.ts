import { modeBypassLabel } from '../modes';
import type {
  RouterTier,
  RouterUIHistoryEntry,
  RouterUIRoute,
  RouterUIRoutePreference,
  RouterUISnapshot,
} from '../types';
import {
  count,
  latency,
  modelName,
  replies,
  signedUsd,
  TIER_DISPLAY_ORDER,
  tierMeter,
  usd,
} from './format';

/** `Opus 5.5 · high`: the model and its effort, as the strip and the Now tab show them. */
export const routeLabel = (route: RouterUIRoute): string =>
  `${modelName(route.model)} · ${route.thinking}`;

export const formatRoute = (route: RouterUIRoute | undefined): string =>
  route
    ? `${tierMeter(route.tier)} ${route.tier} · ${route.provider}/${route.model} · effort ${route.thinking}${route.activity ? ` · activity ${route.activity}` : route.routeCell ? ` · availability cell ${route.routeCell}` : ''}`
    : 'unknown / no observed generation';

export const activityLabel = (
  route: Pick<RouterUIRoute, 'activity' | 'routeCell'>,
): string =>
  route.activity ?? (route.routeCell ? `available ${route.routeCell}` : 'base');

export const activityRoutingSummary = (snapshot: RouterUISnapshot): string =>
  `Activity routing: ${snapshot.activityRouting} · ${snapshot.activityCells.length} activity cells${snapshot.activityPreset ? ` · preset ${snapshot.activityPreset} · ${snapshot.activityCells.filter((cell) => cell.source === 'builtin').length} built-in` : ''} · session Routes editor`;

export const preferenceLine = (
  value: RouterUIRoutePreference,
  label = 'Preferred',
): string => {
  const mode = `${value.mode.mode} (${value.mode.source})`;
  if (value.status !== 'eligible')
    return `${label} · ${mode}: ${value.status === 'unknown' ? 'unknown (no registry)' : 'no text-eligible route'}`;
  const detail =
    value.bypass === 'pin'
      ? `pin ${value.route.tier}; generic route`
      : value.bypass === 'effort'
        ? 'tier effort override'
        : value.bypass === 'activity-off'
          ? 'activity routing off; generic route'
          : value.lever === 'model'
            ? value.sourceTier === value.route.tier
              ? 'mode model preference'
              : `model from ${value.sourceTier}`
            : value.lever === 'effort'
              ? 'effort step'
              : 'configured pair';
  return `${label} · ${mode}: ${value.route.model} · effort ${value.route.thinking} · ${detail}${value.fallback ? ' · declared fallback' : ''}`;
};

export const activityRouteLines = (snapshot: RouterUISnapshot): string[] => [
  'Unlisted cells use generic tiers, if configured.',
  ...(snapshot.activityCells.length
    ? snapshot.activityCells.flatMap((cell) => {
        const preview = snapshot.routeCells.find(
          (entry) =>
            entry.activity === cell.activity &&
            entry.tier === cell.configured.tier,
        );
        return [
          `${cell.activity}/${cell.configured.tier}: configured ${cell.configured.model} · requested effort ${cell.configured.thinking}${cell.source === 'builtin' ? ' · built-in preset' : ''}`,
          `  ${
            cell.availability === 'eligible'
              ? `Text eligible: ${cell.eligible.provider}/${cell.eligible.model} · effort ${cell.eligible.thinking}`
              : cell.availability === 'disabled'
                ? 'Excluded (activity routing off)'
                : cell.availability === 'unknown'
                  ? 'Text eligibility unknown (no registry)'
                  : 'No text-eligible attempt'
          } · configured fallbacks: ${cell.fallbacks.join(' → ') || 'none'}`,
          ...(preview?.preferred ? [preferenceLine(preview.preferred)] : []),
          ...(preview?.pendingPreferred
            ? [preferenceLine(preview.pendingPreferred, 'Queued preferred')]
            : []),
        ];
      })
    : ['No configured activity overrides.']),
];

export const formatMode = (snapshot: RouterUISnapshot): string =>
  `${snapshot.mode.mode} (${snapshot.mode.source})${modeBypassLabel(snapshot.modeBypass)}`;

/** Source note for a switch-policy control shown with its effective value. */
export const policySourceNote = (
  snapshot: RouterUISnapshot,
  key: string,
): string => {
  const source = Object.hasOwn(snapshot.policySources, key)
    ? snapshot.policySources[key as keyof RouterUISnapshot['policySources']]
    : undefined;
  return source === 'mode'
    ? ` (mode ${snapshot.mode.mode})`
    : source === 'session'
      ? snapshot.mode.mode === 'balanced'
        ? ' (session)'
        : ' (session, overrides mode)'
      : '';
};

export const routerTone = (
  snapshot: RouterUISnapshot,
): 'error' | 'warning' | 'accent' =>
  snapshot.lifecycle === 'failed'
    ? 'error'
    : snapshot.switchCost?.reason === 'cost-held' ||
        ['timeout', 'fallback', 'budget'].includes(snapshot.lifecycle)
      ? 'warning'
      : 'accent';

const tierRank = (tier: RouterTier): number => TIER_DISPLAY_ORDER.indexOf(tier);

/** Only adjacent known generation targets establish a switch; reviews are not generation. */
export const observedRouteChanges = (
  history: readonly RouterUIHistoryEntry[],
) => {
  const changes: {
    kind: 'model' | 'effort' | 'observed';
    from?: RouterUIRoute;
    to: RouterUIRoute;
    reason?: string | undefined;
  }[] = [];
  let previous: RouterUIRoute | undefined;
  for (const entry of history.slice(-50)) {
    if (entry.reviewOnly) continue;
    const current = entry.actual;
    if (!current) {
      previous = undefined;
      continue;
    }
    const kind = !previous
      ? 'observed'
      : previous.provider !== current.provider ||
          previous.model !== current.model
        ? 'model'
        : previous.thinking !== current.thinking
          ? 'effort'
          : undefined;
    if (kind)
      changes.push({
        kind,
        ...(previous ? { from: previous } : {}),
        to: current,
        reason: entry.reason,
      });
    previous = current;
  }
  return changes;
};

/** Direction of the latest observed route change in tier terms. */
const lastMove = (
  history: readonly RouterUIHistoryEntry[],
): 'up' | 'down' | 'same' | undefined => {
  const last = observedRouteChanges(history).at(-1);
  if (!last?.from) return undefined;
  const delta = tierRank(last.to.tier) - tierRank(last.from.tier);
  return delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';
};

const adviceFault = (
  outcome: NonNullable<RouterUISnapshot['advice']>['outcome'],
): string | undefined => {
  switch (outcome) {
    case 'deadline':
      return '! timed out';
    case 'unavailable':
      return '! unavailable';
    case 'invalid-response':
      return '! bad answer';
    case 'input-too-large':
      return '! input too large';
    case 'network-error':
      return '! network error';
    case 'http-error':
      return '! http error';
    case 'uncertain':
      return '= unsure';
    case 'cancelled':
      return '= cancelled';
    default:
      return undefined;
  }
};

const moveGlyph = (move: ReturnType<typeof lastMove>): string =>
  move === 'up' ? '↑ stronger' : move === 'down' ? '↓ cheaper' : '= fits';

/**
 * A glyph and at most three words for the strip: `↑` stronger, `↓` cheaper,
 * `=` stays, `…` waits, `!` fault, `⏵` pin. `routeReason` keeps the sentence.
 */
export const shortReason = (snapshot: RouterUISnapshot): string => {
  if (snapshot.lifecycle === 'choosing') return '… choosing';
  if (snapshot.lifecycle === 'cancelled') return '= cancelled';
  if (snapshot.lifecycle === 'failed') return '! failed · /router log';
  if (snapshot.lifecycle === 'fallback') return '! fallback';
  if (snapshot.lifecycle === 'budget') return '↓ over budget';
  if (snapshot.costRecovery) return '↑ cost recovery';
  if (snapshot.reason === 'escalation') return '↑ tool errors';
  const switchCost = snapshot.switchCost;
  if (switchCost?.reason === 'cost-held') {
    const { advised, actual } = snapshot;
    const cheaper =
      advised && actual && tierRank(advised.tier) < tierRank(actual.tier);
    return `… ${cheaper ? 'cheaper' : 'stronger'}, waiting`;
  }
  const move = lastMove(snapshot.history);
  if (switchCost?.reason === 'strong-advice')
    return move === 'down' ? '↓ clearly cheaper' : '↑ clearly stronger';
  if (
    switchCost?.reason === 'effort-cache-shared' ||
    switchCost?.reason === 'effort-cache-unknown'
  )
    return '= effort changed';
  if (
    switchCost?.reason === 'within-policy' ||
    switchCost?.reason === 'cost-unknown'
  )
    return moveGlyph(move);
  if (snapshot.reuse) return '= reused';
  if (snapshot.bypassReason === 'pinned' || snapshot.reason === 'pinned')
    return '⏵ pinned';
  const advice = snapshot.advice;
  if (!advice) return '= baseline';
  return adviceFault(advice.outcome) ?? moveGlyph(move);
};

export const routeReason = (snapshot: RouterUISnapshot): string => {
  if (snapshot.lifecycle === 'off') return 'Router off';
  if (snapshot.lifecycle === 'choosing') return 'Choosing route';
  if (snapshot.lifecycle === 'cancelled') return 'Cancelled';
  if (snapshot.lifecycle === 'failed') return 'Generation failed · /router log';
  if (snapshot.lifecycle === 'fallback') return 'Explicit generation fallback';
  if (snapshot.lifecycle === 'budget')
    return 'Over soft budget · baseline kept';
  if (snapshot.costRecovery) return 'Cost recovery · balanced high route';
  if (snapshot.reason === 'escalation')
    return 'Repeated tool failure · escalated one tier';
  if (
    snapshot.reuse === 'continuation' &&
    snapshot.advice?.source === 'review' &&
    snapshot.advice?.outcome !== 'selected' &&
    snapshot.advice?.outcome !== undefined
  )
    return `Background review ${snapshot.advice.outcome} · current route retained`;
  const switchCost = snapshot.switchCost;
  if (switchCost?.reason === 'cost-held')
    return `Recommended ${formatRoute(snapshot.advised)} · held: ${usd(switchCost.switchUsd)} vs ${usd(switchCost.stayUsd)} over ${switchCost.horizonRequests} requests`;
  if (switchCost?.reason === 'strong-advice')
    return `Strong advice accepted · ${usd(switchCost.switchUsd)} vs ${usd(switchCost.stayUsd)} estimated`;
  if (switchCost?.reason === 'effort-cache-shared')
    return 'Effort changed · same model, cache-compatible';
  if (switchCost?.reason === 'effort-cache-unknown')
    return 'Effort changed · same model, cache behavior unknown';
  if (switchCost?.reason === 'within-policy')
    return `Model switch accepted · ${usd(switchCost.switchUsd)} estimated over ${switchCost.horizonRequests} requests`;
  if (switchCost?.reason === 'cost-unknown')
    return 'Model switch accepted · cost or cache pricing unknown';
  if (snapshot.lifecycle === 'continuation')
    return 'Tool route reused · no new advice';
  if (snapshot.reuse) return 'Route reused · no new advice';
  if (snapshot.bypassReason === 'pinned')
    return 'Pinned route · advice skipped';
  const advice = snapshot.advice;
  if (!advice)
    return snapshot.reason === 'pinned' ? 'Pinned route' : 'Baseline route';
  const took =
    advice.latencyMs === undefined ? '' : ` · ${latency(advice.latencyMs)}`;
  switch (advice.outcome) {
    case 'selected':
      return `Classifier advice accepted${took}`;
    case 'deadline':
      return 'Classifier timed out · baseline kept';
    case 'uncertain':
      return 'Classifier abstained · baseline kept';
    case 'cancelled':
      return 'Classifier cancelled';
    case 'unavailable':
      return 'Classifier unavailable · baseline kept';
    case 'invalid-response':
      return 'Classifier answer invalid · baseline kept';
    case 'input-too-large':
      return 'Classifier input too large · baseline kept';
    case 'network-error':
      return 'Classifier network error · baseline kept';
    case 'http-error':
      return 'Classifier HTTP error · baseline kept';
  }
};

export const textBar = (fraction: number, size = 10): string => {
  const count = Math.max(0, Math.min(size, Math.round(fraction * size)));
  const [filled, empty] = process.env.TERM === 'dumb' ? ['#', '-'] : ['█', '░'];
  return `[${filled?.repeat(count)}${empty?.repeat(size - count)}]`;
};

export const budgetLines = (snapshot: RouterUISnapshot): string[] => {
  const cost = snapshot.accumulatedCost;
  const budget = snapshot.controls.budget;
  const known = cost !== undefined && Number.isFinite(cost) && cost >= 0;
  return [
    'Soft generation budget · session',
    !budget
      ? `Budget unset · cost ${usd(cost)}`
      : !known
        ? `Cost unknown / ${usd(budget)}`
        : `${textBar(cost / budget)} ${Math.round((cost / budget) * 100)}% · ${usd(cost)} / ${usd(budget)}`,
    'Catalog prices. Not a bill or cap. Advice excluded.',
  ];
};

const retainedGenerations = (
  history: readonly RouterUIHistoryEntry[],
): RouterUIHistoryEntry[] =>
  history.slice(-50).filter((entry) => !entry.reviewOnly);

export const routeTimeline = (
  history: readonly RouterUIHistoryEntry[],
): string[] => {
  const changes = observedRouteChanges(history);
  if (!changes.length) return ['No retained generation targets.'];
  const identity = (value: RouterUIRoute) =>
    `${tierMeter(value.tier)} ${routeLabel(value)}`;
  return changes
    .slice(-4)
    .map(
      (change) =>
        `${change.kind === 'model' ? 'Model switch' : change.kind === 'effort' ? 'Effort change' : 'Observed'}: ${change.from ? `${identity(change.from)} → ` : ''}${identity(change.to)}${change.reason ? ` · ${change.reason}` : ''}`,
    );
};

export const historyStatus = (snapshot: RouterUISnapshot): string =>
  !snapshot.loggingEnabled
    ? 'History collection is off · /router log on'
    : snapshot.history.length
      ? 'History collection is on · last 50 observations'
      : 'History collection is on · no decisions retained yet';

export const classifierStatus = (
  snapshot: RouterUISnapshot,
  selected = snapshot.controls.advisor,
): string => {
  if (!snapshot.privacy.advisorEnabled)
    return 'Disabled · set advisor.enabled in user configuration';
  if (!selected) return 'Not configured · select a classifier';
  const model = snapshot.classifiers.find((entry) => entry.model === selected);
  if (!model) return 'Not registered · load its Pi provider extension';
  if (!model.textInput)
    return 'Unsupported input · select a text-capable classifier';
  if (!snapshot.privacy.approvedModels.includes(selected))
    return 'Not approved for this profile · edit user configuration';
  return 'Eligible to ask · Pi checks credentials at request time';
};

export const classifierLines = (
  snapshot: RouterUISnapshot,
  selected = snapshot.controls.advisor,
): string[] => {
  const last = snapshot.lastAdvice ?? snapshot.advice;
  return [
    classifierStatus(snapshot, selected),
    `Model  ${snapshot.controls.advisor ?? 'not configured'}`,
    `Advice ${snapshot.privacy.advisorEnabled ? 'on' : 'off'} · ${snapshot.profile}`,
    ...(last
      ? [
          `Last observed advice: ${last.outcome}${last.latencyMs === undefined ? '' : ` · ${latency(last.latencyMs)}`}`,
          `Operation model: ${last.advisor} · ${last.source ?? 'source unreported'}${last.profile ? ` · profile ${last.profile}` : ''}`,
        ]
      : ['No classifier calls observed.']),
    'Model selection is session-only; approval and credentials stay in user config.',
    'None skips advice · /router reload restores config.',
  ];
};

interface TierUsage {
  replies: number;
  costUsd: number;
}

const tierUsage = (
  retained: readonly RouterUIHistoryEntry[],
): Map<RouterTier, TierUsage> => {
  const byTier = new Map<RouterTier, TierUsage>();
  for (const entry of retained) {
    const tier = entry.actual?.tier;
    if (!tier) continue;
    const row = byTier.get(tier) ?? { replies: 0, costUsd: 0 };
    row.replies += 1;
    if (entry.generationCostUsd !== undefined)
      row.costUsd += entry.generationCostUsd;
    byTier.set(tier, row);
  }
  return byTier;
};

export const usageSummary = (snapshot: RouterUISnapshot): string[] => {
  const retained = retainedGenerations(snapshot.history);
  if (!retained.length)
    return [
      historyStatus(snapshot),
      'Send a new request with history on to collect decisions.',
    ];
  const costs = retained.flatMap((entry) =>
    entry.generationCostUsd === undefined ? [] : [entry.generationCostUsd],
  );
  const changes = observedRouteChanges(snapshot.history);
  const switches = changes.filter((change) => change.kind === 'model').length;
  const efforts = changes.filter((change) => change.kind === 'effort').length;
  const total = costs.length
    ? usd(costs.reduce((sum, cost) => sum + cost, 0))
    : 'unknown';
  const unpriced = retained.length - costs.length;
  const unknownRoutes = retained.filter((entry) => !entry.actual).length;
  const byTier = tierUsage(retained);
  const comparison = snapshot.comparison;
  // Below half a cent both sides read as `<$0.01` and the difference says nothing.
  const comparable =
    comparison !== undefined &&
    Math.max(comparison.yourUsd, comparison.routedUsd) >= 0.005;
  return [
    historyStatus(snapshot),
    `${total} catalog · ${replies(retained.length)}`,
    `${count(switches, 'switch', 'switches')} · ${count(efforts, 'effort change')}${unknownRoutes ? ` · ${count(unknownRoutes, 'unknown route')}` : ''}`,
    ...(unpriced ? [`${replies(unpriced)} unpriced: unknown, not free`] : []),
    '',
    ...TIER_DISPLAY_ORDER.flatMap((tier) => {
      const row = byTier.get(tier);
      return row
        ? [
            `${tierMeter(tier).padEnd(4)} ${tier.padEnd(6)} ${textBar(row.replies / retained.length)} ${replies(row.replies)} ${usd(row.costUsd)}`,
          ]
        : [];
    }),
    ...(comparison && comparable
      ? [
          '',
          `Same tokens on ${modelName(comparison.model)}: ${usd(comparison.yourUsd)} vs ${usd(comparison.routedUsd)} routed`,
          `${signedUsd(comparison.routedUsd - comparison.yourUsd, comparison.yourUsd)} · estimate over ${replies(comparison.replies)}`,
        ]
      : []),
    'Catalog prices, not a bill. Advice excluded.',
  ];
};
