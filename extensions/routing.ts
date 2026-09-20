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
  RoutePair,
  RouterPhase,
  RouterProfile,
  RouterThinkingByTier,
  RouterTier,
  RoutingDecision,
  RoutingRule,
} from './types';
import { ROUTER_TIERS } from './types';

export const phaseForTier = (tier: RouterTier): RouterPhase => {
  if (tier === 'high') return 'planning';
  if (tier === 'medium') return 'implementation';
  return 'lightweight';
};

export const tierRank = (tier: RouterTier): number =>
  ROUTER_TIERS.length - 1 - ROUTER_TIERS.indexOf(tier);

export const allowed = (tier: RouterTier, floor: RouterTier): boolean =>
  tierRank(tier) >= tierRank(floor);

// Deliberately closed forms, not a shell parser. No chaining, substitution,
// redirection, arbitrary flags, or free-form edits qualify for the micro lane.
export const isMechanicalTask = (prompt: string): boolean => {
  const text = prompt.trim();
  if (text.length > 300) return false;
  return (
    /^(?:please )?(?:run |show )?(?:pwd|git status(?: --short)?|git diff --stat|git log -1 --oneline)\.?$/i.test(
      text,
    ) ||
    /^(?:please )?(?:run )?head -n (?:[1-9]|[1-9][0-9]|100) [a-z0-9_./][a-z0-9_./-]*$/i.test(
      text,
    ) ||
    /^replace the exact comment "\/\/ [^"\n]+" with "\/\/ [^"\n]+" in [a-z0-9_./-]+\.?$/i.test(
      text,
    )
  );
};

export const localSafetyFloor = (context: Context): RouterTier => {
  const prompt = getLastUserText(context).toLowerCase();
  if (
    /\b(security|auth(?:entication|orization)?|credentials?|secrets?|vulnerabilit\w*|encrypt\w*|destructive|delet\w*|destroy\w*|eras\w*|drop\w*|wip\w*|deploy\w*|production|migrat\w*|concurrency|concurrent|race conditions?|architect\w*|design(?:s|ing|ed)?|rm|sudo|chmod|chown|truncate)\b/.test(
      prompt,
    ) ||
    /\bgit\s+(?:reset|clean|push)\b/.test(prompt) ||
    /\b(?:debug|debugging|investigate)\b.*\b(?:system|entire|whole|broad)\b/.test(
      prompt,
    ) ||
    /\b(?:system-wide|entire|whole|broad)\b.*\b(?:debug|debugging|investigation)\b/.test(
      prompt,
    ) ||
    /\bremove\b.*\b(?:directory|database|repository)\b/.test(prompt)
  )
    return 'high';
  if (isMechanicalTask(prompt)) return 'micro';
  if (
    /\b(implement\w*|cod(?:e|ing)|fix\w*|updat\w*|edit\w*|writ\w*|add\w*|modif\w*|refactor\w*|patch\w*|chang\w*|replac\w*|remov\w*|debug\w*|bugs?|tests?)\b/.test(
      prompt,
    )
  )
    return 'medium';
  return 'low';
};

export const resolveAvailableTier = (
  profile: RouterProfile,
  preferred: RouterTier,
  floor: RouterTier = 'micro',
): RouterTier => {
  const eligible = (tier: RouterTier) => profile[tier] && allowed(tier, floor);
  if (eligible(preferred)) return preferred;
  const order = [...ROUTER_TIERS].reverse();
  const startIdx = order.indexOf(preferred);
  for (const tier of order.slice(startIdx + 1)) {
    if (eligible(tier)) return tier;
  }
  for (const tier of order.slice(0, startIdx).reverse()) {
    if (eligible(tier)) return tier;
  }
  throw new Error(
    'No eligible route: configure a tier at or above the local safety floor.',
  );
};

export const resolveRoutePair = (
  profile: RouterProfile,
  tier: RouterTier,
  thinkingOverrides?: RouterThinkingByTier,
): RoutePair => {
  const routed = profile[tier];
  if (!routed)
    throw new Error('No eligible route: selected tier is not configured.');
  const { provider, modelId } = parseCanonicalModelRef(routed.model);
  return {
    tier,
    model: `${provider}/${modelId}`,
    thinking:
      thinkingOverrides?.[tier] ??
      routed.thinking ??
      (tier === 'micro' ? 'off' : tier),
  };
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
  const pair = resolveRoutePair(profile, tier, thinkingOverrides);
  const { provider, modelId } = parseCanonicalModelRef(pair.model);

  return {
    profile: profileName,
    tier,
    phase,
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: pair.model,
    reasoning,
    thinking: pair.thinking,
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
  const floor = localSafetyFloor(context);
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

      for (const rule of rules) {
        const matches = Array.isArray(rule.matches)
          ? rule.matches
          : [rule.matches];
        const lowercaseMatches = matches.map((m) => m.toLowerCase());
        if (containsAny(prompt, lowercaseMatches)) {
          if (!highestTier || tierRank(rule.tier) > tierRank(highestTier)) {
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

      if (floor === 'micro') {
        phase = 'lightweight';
        tier = 'micro';
        reasoning = 'micro-mechanical';
      } else if (containsAny(prompt, explicitHighHints)) {
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

  if (!allowed(tier, floor)) {
    tier = floor;
    phase = phaseForTier(tier);
    reasoning = 'local-safety-floor';
  }

  let isBudgetForced = false;
  if (isBudgetExceeded && tier === 'high') {
    if (allowed('medium', floor)) {
      tier = 'medium';
      phase = 'implementation';
      reasoning = 'Budget exceeded. Downgraded from high to medium tier.';
      isBudgetForced = true;
    } else {
      reasoning = 'budget-floor-conflict';
    }
  }

  // Keep the old soft-budget preference for low when medium is absent,
  // but never let partial profiles undercut the local floor.
  const budgetLow =
    isBudgetForced && !profile.medium && profile.low && allowed('low', floor);
  const resolvedTier = resolveAvailableTier(
    profile,
    budgetLow ? 'low' : tier,
    floor,
  );
  if (resolvedTier !== tier) {
    if (
      reasoning !== 'local-safety-floor' &&
      reasoning !== 'budget-floor-conflict'
    ) {
      reasoning = `Resolved from ${tier} to ${resolvedTier} tier (${tier} tier is not configured). Original: ${reasoning}`;
    }
    phase = phaseForTier(resolvedTier);
    tier = resolvedTier;
  }

  if (isBudgetForced && tier === 'high') {
    reasoning = 'budget-floor-conflict';
    isBudgetForced = false;
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
