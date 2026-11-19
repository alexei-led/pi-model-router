import type { PromptKeyword, RoutePlan, RouterTier } from './types';
import { PROMPT_KEYWORDS, ROUTER_TIERS } from './types';

// Word continuations, including non-ASCII letters and combining marks, are not delimiters.
export const promptKeyword = (text: string): PromptKeyword | undefined => {
  const word = /^\s*([a-z]+)(?![\p{L}\p{M}\p{N}\p{Pc}-])/iu
    .exec(text)?.[1]
    ?.toLowerCase();
  return PROMPT_KEYWORDS.find((keyword) => keyword === word);
};

export const promptTierPlan = (
  keyword: Exclude<PromptKeyword, 'morethink' | 'lessthink'>,
  tier: RouterTier,
  planAt: (tier: RouterTier) => RoutePlan | undefined,
): RoutePlan | undefined => {
  const at = ROUTER_TIERS.indexOf(tier);
  const tiers =
    keyword === 'highthink' || keyword === 'maxthink'
      ? ROUTER_TIERS.slice(0, at)
      : ROUTER_TIERS.slice(at + 1);
  if (keyword === 'highthink' || keyword === 'nothink') tiers.reverse();
  for (const candidate of tiers) {
    const plan = planAt(candidate);
    if (plan) return plan;
  }
  return undefined;
};
