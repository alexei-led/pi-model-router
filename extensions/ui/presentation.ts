import type {
  RouterUIAdviceObservation,
  RouterUIHistoryEntry,
  RouterUIRoute,
  RouterUISnapshot,
} from '../types';

export const advisorName = (
  advisor: RouterUIAdviceObservation['advisor'],
): string => (advisor === 'classifier' ? 'Pi classifier' : advisor);

export const formatRoute = (route: RouterUIRoute | undefined): string =>
  route
    ? `${route.tier} → ${route.provider}/${route.model} · effort ${route.thinking}${route.activity ? ` · activity ${route.activity}` : route.routeCell ? ` · availability cell ${route.routeCell}` : ''}`
    : 'unknown / no observed generation';

export const activityRoutingSummary = (snapshot: RouterUISnapshot): string =>
  `Activity routing: ${snapshot.activityRouting} · ${snapshot.activityCells.length} override cells · session Routes editor`;

export const activityRouteLines = (snapshot: RouterUISnapshot): string[] => [
  'Unlisted cells use generic tiers, if configured.',
  ...(snapshot.activityCells.length
    ? snapshot.activityCells.flatMap((cell) => [
        `${cell.activity}/${cell.configured.tier}: configured ${cell.configured.model} · requested effort ${cell.configured.thinking}`,
        `  ${
          cell.availability === 'eligible'
            ? `Text eligible: ${cell.eligible.provider}/${cell.eligible.model} · effort ${cell.eligible.thinking}`
            : cell.availability === 'disabled'
              ? 'Excluded (activity routing off)'
              : cell.availability === 'unknown'
                ? 'Text eligibility unknown (no registry)'
                : 'No text-eligible attempt'
        } · configured fallbacks: ${cell.fallbacks.join(' → ') || 'none'}`,
      ])
    : ['No configured activity overrides.']),
];

export const routerTone = (
  snapshot: RouterUISnapshot,
): 'error' | 'warning' | 'accent' =>
  snapshot.lifecycle === 'failed'
    ? 'error'
    : snapshot.switchCost?.reason === 'cost-held' ||
        ['timeout', 'fallback', 'budget'].includes(snapshot.lifecycle)
      ? 'warning'
      : 'accent';

export const routeReason = (snapshot: RouterUISnapshot): string => {
  if (snapshot.lifecycle === 'off') return 'Router off';
  if (snapshot.lifecycle === 'choosing')
    return 'Choosing route · no generation started';
  if (snapshot.lifecycle === 'cancelled') return 'Cancelled';
  if (snapshot.lifecycle === 'failed') return 'Generation failed · /router log';
  if (snapshot.lifecycle === 'fallback') return 'Explicit generation fallback';
  if (snapshot.lifecycle === 'budget')
    return 'Over soft budget → eligible baseline';
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
  const money = (value: number | undefined) =>
    value === undefined ? 'unknown' : `$${value.toFixed(4)}`;
  if (switchCost?.reason === 'cost-held')
    return `Recommended ${formatRoute(snapshot.advised)} · held: ${money(switchCost.switchUsd)} vs ${money(switchCost.stayUsd)} over ${switchCost.horizonRequests} requests`;
  if (switchCost?.reason === 'strong-advice')
    return `Strong advice accepted · ${money(switchCost.switchUsd)} vs ${money(switchCost.stayUsd)} estimated`;
  if (switchCost?.reason === 'effort-cache-shared')
    return 'Effort changed · same model, cache-compatible';
  if (switchCost?.reason === 'effort-cache-unknown')
    return 'Effort changed · same model, cache behavior unknown';
  if (switchCost?.reason === 'within-policy')
    return `Model switch accepted · ${money(switchCost.switchUsd)} estimated over ${switchCost.horizonRequests} requests`;
  if (switchCost?.reason === 'cost-unknown')
    return 'Model switch accepted · cost or cache pricing unknown';
  switch (snapshot.lifecycle) {
    case 'continuation':
      return 'Tool route reused · no new advice';
    default:
      break;
  }
  if (snapshot.reuse) return 'Route reused · no new advice';
  if (snapshot.bypassReason === 'pinned')
    return 'Pinned route · advice skipped';
  const advice = snapshot.advice;
  if (!advice)
    return snapshot.reason === 'pinned'
      ? 'Pinned route'
      : 'Local eligible baseline';
  const name = advisorName(advice.advisor);
  const latency =
    advice.latencyMs === undefined
      ? ''
      : ` · ${Math.round(advice.latencyMs)} ms`;
  switch (advice.outcome) {
    case 'selected':
      return `${name} advice accepted${latency}`;
    case 'deadline':
      return `${name} timed out → baseline`;
    case 'uncertain':
      return `${name} abstained → baseline`;
    case 'cancelled':
      return `${name} cancelled`;
    case 'unavailable':
      return `${name} unavailable → baseline`;
    case 'invalid-response':
      return `${name} invalid advice → baseline`;
    case 'input-too-large':
      return `${name} input too large → baseline`;
    case 'network-error':
      return `${name} network error → baseline`;
    case 'http-error':
      return `${name} HTTP error → baseline`;
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
      ? `Budget unset · recorded cost ${known ? `$${cost.toFixed(4)}` : 'unknown'}`
      : !known
        ? `Recorded cost unknown / $${budget.toFixed(2)}`
        : `${textBar(cost / budget)} ${Math.round((cost / budget) * 100)}% · $${cost.toFixed(4)} / $${budget.toFixed(2)}`,
    'Catalog only; not a bill or cap. Advice excluded.',
  ];
};

export const routeMix = (
  history: readonly RouterUIHistoryEntry[],
): string[] => {
  const retained = history.slice(-50).filter((entry) => !entry.reviewOnly);
  if (!retained.length) return ['No retained decisions. /router log on'];
  return [
    ...(['micro', 'low', 'medium', 'high'] as const).map((tier) => {
      const count = retained.filter(
        (entry) => entry.actual?.tier === tier,
      ).length;
      return `${tier.padEnd(6)} ${textBar(count / retained.length)} ${count}/${retained.length}`;
    }),
    `Unknown routes: ${retained.filter((entry) => !entry.actual).length}`,
  ];
};

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

export const routeTimeline = (
  history: readonly RouterUIHistoryEntry[],
): string[] => {
  const changes = observedRouteChanges(history);
  if (!changes.length) return ['No retained generation targets.'];
  const identity = (value: RouterUIRoute) =>
    `${value.provider}/${value.model} [${value.thinking}]`;
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
  if (!selected) return 'Not configured · select a Pi classifier';
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
    `Active model: ${snapshot.controls.advisor ?? 'not configured'}`,
    `Advisor enabled: ${snapshot.privacy.advisorEnabled} · profile ${snapshot.profile}`,
    ...(last
      ? [
          `Last observed advice: ${last.outcome}${last.latencyMs === undefined ? '' : ` · ${Math.round(last.latencyMs)} ms`}`,
          `Operation model: ${last.advisor} · ${last.source ?? 'source unreported'}${last.profile ? ` · profile ${last.profile}` : ''}`,
        ]
      : ['No classifier calls observed.']),
    'Credentials and profile approval are read-only.',
    'Selecting a model does not enable advice or grant approval.',
    'Session selection applies next user turn. No config writes.',
    'None stops advice; /router reload restores file settings.',
  ];
};

export const usageSummary = (snapshot: RouterUISnapshot): string[] => {
  const retained = snapshot.history
    .slice(-50)
    .filter((entry) => !entry.reviewOnly);
  const costs = retained.flatMap((entry) =>
    entry.generationCostUsd === undefined ? [] : [entry.generationCostUsd],
  );
  const changes = observedRouteChanges(snapshot.history);
  return [
    historyStatus(snapshot),
    `Retained generation decisions: ${retained.length} · active branch, not lifetime`,
    ...(retained.length
      ? [
          `Model switches: ${changes.filter((change) => change.kind === 'model').length} · effort changes: ${changes.filter((change) => change.kind === 'effort').length}`,
          `Known generation cost: ${costs.length ? `$${costs.reduce((sum, cost) => sum + cost, 0).toFixed(4)}` : 'unknown'} · coverage ${costs.length}/${retained.length}`,
          'Catalog prices only. Missing cost is unknown, not free.',
        ]
      : ['Send a new request with history on to collect decisions.']),
  ];
};
