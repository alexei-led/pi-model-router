import type { Context } from '@earendil-works/pi-ai';
import { parseCanonicalModelRef } from './config';
import {
  containsAny,
  countToolResults,
  countWords,
  getLastUserText,
  getRecentConversationText,
} from './context';
import type {
  RouterPhase,
  RouterProfile,
  RouterThinkingByTier,
  RouterTier,
  RoutingDecision,
  RoutingRule,
} from './types';

export const phaseForTier = (tier: RouterTier): RouterPhase => {
  if (tier === 'high') return 'planning';
  if (tier === 'medium') return 'implementation';
  return 'lightweight';
};

export const resolveAvailableTier = (
  profile: RouterProfile,
  preferred: RouterTier,
): RouterTier => {
  if (profile[preferred]) return preferred;
  // Fall "up": low → medium → high
  const order: RouterTier[] = ['low', 'medium', 'high'];
  const startIdx = order.indexOf(preferred);
  for (let i = startIdx + 1; i < order.length; i++) {
    const tier = order[i];
    if (tier && profile[tier]) return tier;
  }
  // Fall "down" as last resort
  for (let i = startIdx - 1; i >= 0; i--) {
    const tier = order[i];
    if (tier && profile[tier]) return tier;
  }
  return preferred; // unreachable if profile has ≥1 tier
};

export const buildRoutingDecision = (
  profileName: string,
  profile: RouterProfile,
  tier: RouterTier,
  phase: RouterPhase,
  reasoning: string,
  thinkingOverrides?: RouterThinkingByTier,
  isClassifier?: boolean,
): RoutingDecision => {
  const routed = profile[tier];
  if (!routed) {
    throw new Error(
      `Profile "${profileName}" has no configuration for the ${tier} tier.`,
    );
  }
  const { provider, modelId } = parseCanonicalModelRef(routed.model);
  const baseThinking =
    routed.thinking ??
    (tier === 'high' ? 'high' : tier === 'low' ? 'low' : 'medium');
  const effectiveThinking = thinkingOverrides?.[tier] ?? baseThinking;

  return {
    profile: profileName,
    tier,
    phase,
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: routed.model,
    reasoning,
    thinking: effectiveThinking,
    timestamp: Date.now(),
    isClassifier,
  };
};

export const decideRouting = (
  context: Context,
  profileName: string,
  profile: RouterProfile,
  previousDecision: RoutingDecision | undefined,
  pinnedTier?: RouterTier,
  thinkingOverrides?: RouterThinkingByTier,
  phaseBias = 0.5,
  rules?: RoutingRule[],
  isBudgetExceeded = false,
): RoutingDecision => {
  if (previousDecision?.profile !== profileName) previousDecision = undefined;
  const prompt = getLastUserText(context).toLowerCase();
  const recentConversation = getRecentConversationText(context);
  const toolResultCount = countToolResults(context);
  const wordCount = countWords(prompt);
  const multiLinePrompt = prompt.split('\n').length >= 4;

  const explicitHighHints = [
    'best',
    'deep',
    'deeply',
    'carefully',
    'thoroughly',
    'robust',
    'comprehensive',
    'step by step',
    'think hard',
    'highest quality',
    'ultrathink',
  ];
  const explicitLowHints = [
    'fast',
    'cheap',
    'quick',
    'quickly',
    'brief',
    'briefly',
    'one sentence',
    'one line',
    'tiny',
    'small',
  ];
  const planningKeywords = [
    'plan',
    'planning',
    'architecture',
    'architect',
    'design',
    'tradeoff',
    'trade-off',
    'research',
    'investigate',
    'root cause',
    'analyze',
    'analysis',
    'migration',
    'strategy',
    'compare',
    'options',
    'approach',
  ];
  const summaryKeywords = [
    'summarize',
    'summary',
    'changelog',
    'rewrite',
    'reformat',
    'format',
    'rename',
    'explain briefly',
    'recap',
    'tl;dr',
  ];
  const implementationKeywords = [
    'implement',
    'code',
    'fix',
    'update',
    'edit',
    'write',
    'refactor',
    'add tests',
    'patch',
    'change',
    'apply',
    'continue',
    'resume',
    'make the changes',
    'go ahead',
  ];
  const lookupKeywords = [
    'where is',
    'which file',
    'show me',
    'list',
    'what files',
    'find',
    'grep',
  ];

  let phase: RouterPhase = previousDecision?.phase ?? 'implementation';
  let tier: RouterTier = 'medium';
  let reasoning = 'Defaulted to medium tier for general coding work.';
  let isRuleMatched = false;

  if (pinnedTier) {
    phase = phaseForTier(pinnedTier);
    tier = pinnedTier;
    reasoning = `Pinned to ${pinnedTier} tier via /router-pin.`;
  } else {
    // Check custom rules first
    if (rules) {
      let highestTier: RouterTier | undefined;
      let winningRule: RoutingRule | undefined;
      const tierRank: Record<RouterTier, number> = {
        low: 1,
        medium: 2,
        high: 3,
      };

      for (const rule of rules) {
        const matches = Array.isArray(rule.matches)
          ? rule.matches
          : [rule.matches];
        const lowercaseMatches = matches.map((m) => m.toLowerCase());
        if (containsAny(prompt, lowercaseMatches)) {
          if (!highestTier || tierRank[rule.tier] > tierRank[highestTier]) {
            highestTier = rule.tier;
            winningRule = rule;
          }
        }
      }

      if (winningRule && highestTier) {
        tier = highestTier;
        phase = phaseForTier(tier);
        const matches = Array.isArray(winningRule.matches)
          ? winningRule.matches
          : [winningRule.matches];
        reasoning =
          winningRule.reason ??
          `Matched custom routing rule for: ${matches.join(', ')}`;
        isRuleMatched = true;
      }
    }

    if (!isRuleMatched) {
      // Sticky phase adjustments
      const highThreshold = Math.max(
        40,
        120 - (previousDecision?.phase === 'planning' ? phaseBias * 80 : 0),
      );
      const lowThreshold = Math.max(
        4,
        12 -
          (previousDecision?.phase === 'implementation' ||
          previousDecision?.phase === 'planning'
            ? phaseBias * 8
            : 0),
      );

      if (containsAny(prompt, explicitHighHints)) {
        phase = 'planning';
        tier = 'high';
        reasoning =
          'Detected an explicit request for deeper or higher-quality reasoning.';
      } else if (containsAny(prompt, explicitLowHints)) {
        phase = 'lightweight';
        tier = 'low';
        reasoning =
          'Detected an explicit request for a faster or lighter response.';
      } else if (containsAny(prompt, summaryKeywords)) {
        phase = 'lightweight';
        tier = 'low';
        reasoning = 'Detected summary or lightweight transformation keywords.';
      } else if (
        containsAny(prompt, planningKeywords) ||
        prompt.startsWith('why ') ||
        wordCount >= highThreshold ||
        multiLinePrompt
      ) {
        phase = 'planning';
        tier = 'high';
        reasoning =
          previousDecision?.phase === 'planning'
            ? 'Continued planning phase based on complexity or keywords.'
            : 'Detected planning, broad analysis, or a high-complexity request.';
      } else if (containsAny(prompt, implementationKeywords)) {
        phase = 'implementation';
        tier = 'medium';
        reasoning =
          'Detected implementation-oriented work with bounded execution scope.';
      } else if (
        containsAny(prompt, lookupKeywords) &&
        wordCount <= 24 &&
        toolResultCount === 0
      ) {
        phase = 'lightweight';
        tier = 'low';
        reasoning = 'Detected a short read-only lookup request.';
      } else if (
        previousDecision?.phase === 'planning' &&
        toolResultCount === 0 &&
        wordCount > lowThreshold
      ) {
        phase = 'planning';
        tier = 'high';
        reasoning =
          'Kept the planning-phase bias because the conversation still looks exploratory.';
      } else if (
        toolResultCount > 0 ||
        previousDecision?.phase === 'implementation' ||
        recentConversation.includes('plan:')
      ) {
        phase = 'implementation';
        tier = 'medium';
        reasoning =
          'Detected active implementation work from prior tools or recent plan execution context.';
      } else if (wordCount <= lowThreshold) {
        phase = 'lightweight';
        tier = 'low';
        reasoning = 'Detected a short bounded request.';
      }
    }
  }

  let isBudgetForced = false;
  if (isBudgetExceeded && tier === 'high') {
    tier = 'medium';
    phase = 'implementation';
    reasoning = `Budget exceeded. Downgraded from high to medium tier. (Original: ${reasoning})`;
    isBudgetForced = true;
  }

  // Resolve to nearest available tier if the selected tier is disabled
  const resolvedTier =
    isBudgetForced && !profile.medium && profile.low
      ? 'low'
      : resolveAvailableTier(profile, tier);
  if (resolvedTier !== tier) {
    reasoning = `Resolved from ${tier} to ${resolvedTier} tier (${tier} tier is not configured). Original: ${reasoning}`;
    phase = phaseForTier(resolvedTier);
    tier = resolvedTier;
  }

  const decision = buildRoutingDecision(
    profileName,
    profile,
    tier,
    phase,
    reasoning,
    thinkingOverrides,
    false,
  );
  decision.isRuleMatched = isRuleMatched;
  decision.isBudgetForced = isBudgetForced;
  return decision;
};
