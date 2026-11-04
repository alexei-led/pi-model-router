import type { RouterTier, RoutingDecision } from '../types';
import { modelName, TIER_DISPLAY_ORDER } from './format';

export const thinkingUnchanged = (level: string): string =>
  `Router thinking unchanged: '${level}' leaves no eligible route.`;

export const thinkingSet = (
  level: string,
  adjusted: readonly string[],
): string =>
  `Router thinking set to ${level}${adjusted.length > 0 ? `; ${adjusted.join(', ')}` : ''}`;

const rank = (tier: RouterTier): number => TIER_DISPLAY_ORDER.indexOf(tier);

/** Short reason for a finished decision: a glyph and at most three words. */
export const decisionReason = (
  decision: RoutingDecision,
  previous?: RoutingDecision,
): string => {
  switch (decision.reasonCode) {
    case 'pinned':
      return '⏵ pinned';
    case 'escalation':
      return '↑ tool errors';
    case 'budget':
      return '↓ over budget';
    case 'fallback':
      return '! fallback';
    case 'cost-recovery':
      return '↑ cost recovery';
    case 'continuation':
      return '= reused';
    default:
      break;
  }
  if (!previous)
    return decision.reasonCode === 'classifier' ? '= fits' : '= baseline';
  const delta = rank(decision.tier) - rank(previous.tier);
  return delta > 0 ? '↑ stronger' : delta < 0 ? '↓ cheaper' : '= fits';
};

const sameModel = (left: RoutingDecision, right: RoutingDecision): boolean =>
  left.targetProvider === right.targetProvider &&
  left.targetModelId === right.targetModelId;

/**
 * One line for a model change between turns, or undefined. An effort-only
 * change, a different profile, a review, or a first decision does not notify.
 */
export const modelChangeNotice = (
  previous: RoutingDecision | undefined,
  next: RoutingDecision,
): string | undefined => {
  if (
    !previous ||
    previous.reviewOnly ||
    next.reviewOnly ||
    previous.profile !== next.profile ||
    sameModel(previous, next)
  )
    return undefined;
  const label = (decision: RoutingDecision) =>
    `${modelName(decision.targetModelId)} · ${decision.thinking}`;
  return `Model changed: ${label(previous)} → ${label(next)} · ${decisionReason(next, previous)}`;
};
