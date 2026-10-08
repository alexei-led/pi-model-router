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
    ? `${route.tier} → ${route.provider}/${route.model} · effort ${route.thinking}`
    : 'unknown / no observed generation';

export const routerTone = (
  snapshot: RouterUISnapshot,
): 'error' | 'warning' | 'accent' =>
  snapshot.lifecycle === 'failed'
    ? 'error'
    : ['timeout', 'fallback', 'budget'].includes(snapshot.lifecycle)
      ? 'warning'
      : 'accent';

export const routeReason = (snapshot: RouterUISnapshot): string => {
  switch (snapshot.lifecycle) {
    case 'off':
      return 'Router off';
    case 'choosing':
      return 'Choosing route · no generation started';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Generation failed · /router log';
    case 'fallback':
      return 'Explicit generation fallback';
    case 'budget':
      return 'Over soft budget → eligible baseline';
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
      ? `Budget unset · recorded cost ${known ? '$' + cost.toFixed(4) : 'unknown'}`
      : !known
        ? `Recorded cost unknown / $${budget.toFixed(2)}`
        : `${textBar(cost / budget)} ${Math.round((cost / budget) * 100)}% · $${cost.toFixed(4)} / $${budget.toFixed(2)}`,
    'Catalog only; not a bill or cap. Advice excluded.',
  ];
};

export const routeMix = (
  history: readonly RouterUIHistoryEntry[],
): string[] => {
  const retained = history.slice(-50);
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
