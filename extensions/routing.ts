import {
  type Api,
  type Context,
  getSupportedThinkingLevels,
  type Model,
} from '@earendil-works/pi-ai';
import { parseCanonicalModelRef } from './config';
import {
  containsAny,
  countToolResults,
  countWords,
  getLastUserText,
  getRecentConversationText,
} from './context';
import type {
  ModelDefinition,
  RoutePair,
  RouterPhase,
  RouterProfile,
  RouterThinkingByTier,
  RouterTier,
  RoutingDecision,
  RoutingReasonCode,
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
    /^replace the exact comment "\/\/ [^"\r\n\u2028\u2029]+" with "\/\/ [^"\r\n\u2028\u2029]+" in [a-z0-9_./-]+\.?$/i.test(
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
  reasonCode: RoutingReasonCode,
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
    reasonCode,
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
  let reasonCode: RoutingReasonCode = 'heuristic';
  let isRuleMatched = false;

  if (pinnedTier) {
    phase = phaseForTier(pinnedTier);
    tier = pinnedTier;
    reasonCode = 'pinned';
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
        reasonCode = 'custom-rule';
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
        reasonCode = 'micro-mechanical';
      } else if (containsAny(prompt, explicitHighHints)) {
        phase = 'planning';
        tier = 'high';
      } else if (containsAny(prompt, explicitLowHints)) {
        phase = 'lightweight';
        tier = 'low';
      } else if (containsAny(prompt, summaryKeywords)) {
        phase = 'lightweight';
        tier = 'low';
      } else if (
        containsAny(prompt, planningKeywords) ||
        prompt.startsWith('why ') ||
        wordCount >= highThreshold ||
        multiLinePrompt
      ) {
        phase = 'planning';
        tier = 'high';
      } else if (containsAny(prompt, implementationKeywords)) {
        phase = 'implementation';
        tier = 'medium';
      } else if (
        containsAny(prompt, lookupKeywords) &&
        wordCount <= 24 &&
        toolResultCount === 0
      ) {
        phase = 'lightweight';
        tier = 'low';
      } else if (
        previousDecision?.phase === 'planning' &&
        toolResultCount === 0 &&
        wordCount > lowThreshold
      ) {
        phase = 'planning';
        tier = 'high';
      } else if (
        toolResultCount > 0 ||
        previousDecision?.phase === 'implementation' ||
        recentConversation.includes('plan:')
      ) {
        phase = 'implementation';
        tier = 'medium';
      } else if (wordCount <= lowThreshold) {
        phase = 'lightweight';
        tier = 'low';
      }
    }
  }

  if (!allowed(tier, floor)) {
    tier = floor;
    phase = phaseForTier(tier);
    // Preserve the local source when safety raises its selected tier.
  }

  let isBudgetForced = false;
  if (isBudgetExceeded && tier === 'high') {
    if (allowed('medium', floor)) {
      tier = 'medium';
      phase = 'implementation';
      reasonCode = 'fallback';
      isBudgetForced = true;
    } else {
      reasonCode = 'budget-floor-conflict';
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
    if (reasonCode !== 'budget-floor-conflict') reasonCode = 'fallback';
    phase = phaseForTier(resolvedTier);
    tier = resolvedTier;
  }

  if (isBudgetForced && tier === 'high') {
    reasonCode = 'budget-floor-conflict';
    isBudgetForced = false;
  }

  const decision = buildRoutingDecision(
    profileName,
    profile,
    tier,
    phase,
    reasonCode,
    thinkingOverrides,
    false,
  );
  decision.isRuleMatched = isRuleMatched;
  decision.isBudgetForced = isBudgetForced;
  return decision;
};

/** Revalidate the actual target; primary-model declarations never authorize a fallback's effort. */
export const validateRoutePair = (
  pair: RoutePair,
  floor: RouterTier,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  imageAttached: boolean,
  declaredLevels?: ModelDefinition['thinkingLevels'],
): boolean => {
  if (!allowed(pair.tier, floor)) return false;
  try {
    const { provider, modelId } = parseCanonicalModelRef(pair.model);
    if (provider === 'router') return false;
    const model = findModel(provider, modelId);
    return Boolean(
      model &&
        (!imageAttached || model.input.includes('image')) &&
        getSupportedThinkingLevels(model).includes(pair.thinking) &&
        (!declaredLevels ||
          pair.thinking === 'off' ||
          declaredLevels.includes(pair.thinking)),
    );
  } catch {
    return false;
  }
};

export const availableRoutePairs = (
  profile: RouterProfile,
  floor: RouterTier,
  findModel: (provider: string, modelId: string) => Model<Api> | undefined,
  imageAttached: boolean,
  thinkingOverrides?: RouterThinkingByTier,
  models?: Record<string, ModelDefinition>,
): RoutePair[] =>
  ROUTER_TIERS.flatMap((tier) => {
    const config = profile[tier];
    if (!config || !allowed(tier, floor)) return [];
    const primary = resolveRoutePair(profile, tier, thinkingOverrides);
    return [...new Set([primary.model, ...(config.fallbacks ?? [])])].flatMap(
      (ref) => {
        try {
          const { provider, modelId } = parseCanonicalModelRef(ref);
          const model = findModel(provider, modelId);
          const ownConfig =
            ref === primary.model
              ? config
              : Object.values(models ?? {}).find(
                  (entry) => entry.model === ref,
                );
          // A non-reasoning model defaults to off, but explicit unsupported effort is rejected.
          const thinking =
            thinkingOverrides?.[tier] ??
            ((config.thinkingExplicit ?? config.thinking !== undefined)
              ? primary.thinking
              : model?.reasoning
                ? primary.thinking
                : 'off');
          const pair = { tier, model: `${provider}/${modelId}`, thinking };
          return validateRoutePair(
            pair,
            floor,
            findModel,
            imageAttached,
            ref === primary.model
              ? (config.thinkingLevels ?? config.resolvedThinkingLevels)
              : ownConfig?.thinkingLevels,
          )
            ? [pair]
            : [];
        } catch {
          return [];
        }
      },
    );
  });

export const decisionForPair = (
  profile: string,
  pair: RoutePair,
  reasonCode: RoutingReasonCode,
): RoutingDecision => {
  const { provider, modelId } = parseCanonicalModelRef(pair.model);
  return {
    profile,
    tier: pair.tier,
    phase: phaseForTier(pair.tier),
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: pair.model,
    thinking: pair.thinking,
    reasonCode,
    timestamp: Date.now(),
  };
};
