import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_CLASSIFIER_CONTEXT,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  MAX_CLASSIFIER_CONTEXT_TURNS,
  MAX_CLASSIFIER_RETRIES,
  MAX_CLASSIFIER_STATE_TOKENS,
} from './constants';
import {
  isObjectRecord,
  isRouterTier,
  isThinkingLevel,
  parseCanonicalModelRef,
} from './domain';
import type {
  AdvisorConfig,
  ClassifierContextConfig,
  ConfigLoadResult,
  ModelDefinition,
  ParsedConfigFile,
  RawRouterConfig,
  RoutedTierConfig,
  RouterConfig,
  RouterProfile,
  RouterTier,
} from './types';

export const parseConfigFile = (path: string): ParsedConfigFile => {
  if (!existsSync(path)) {
    return { config: {}, warnings: [] };
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isObjectRecord(parsed)) {
      return {
        config: {},
        warnings: [`Ignored router config at ${path}: expected a JSON object.`],
      };
    }
    return { config: parsed, warnings: [] };
  } catch {
    // JSON parse errors can include source snippets containing credentials.
    return {
      config: {},
      warnings: [`Failed to parse router config at ${path}.`],
    };
  }
};

/**
 * Resolve a model reference: if it matches a key in the models map,
 * return the canonical ref and definition; otherwise treat it as a
 * canonical "provider/model" ref.
 */
export const resolveModelRef = (
  ref: string,
  models: Record<string, ModelDefinition> | undefined,
): { canonicalRef: string; definition?: ModelDefinition } => {
  const definition =
    models && Object.hasOwn(models, ref) ? models[ref] : undefined;
  if (definition) {
    return { canonicalRef: definition.model, definition };
  }
  return { canonicalRef: ref };
};

const mergeRawValue = (existing: unknown, next: unknown): unknown => {
  if (next === undefined) return existing;
  if (isObjectRecord(existing) && isObjectRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
};

export const mergeConfig = (
  base: RawRouterConfig,
  override: RawRouterConfig,
  warnings: string[] = [],
): RawRouterConfig => {
  const baseProfiles = isObjectRecord(base.profiles) ? base.profiles : {};
  const overrideProfiles = isObjectRecord(override.profiles)
    ? override.profiles
    : {};
  const mergedProfiles: Record<string, unknown> = { ...baseProfiles };
  for (const [name, profile] of Object.entries(overrideProfiles)) {
    if (name === '__proto__') continue;
    if (!isObjectRecord(profile)) {
      if (profile !== undefined) {
        warnings.push(
          Object.hasOwn(baseProfiles, name)
            ? `Ignored invalid override for profile "${name}": expected an object. Keeping base profile.`
            : `Ignored invalid override for profile "${name}": expected an object.`,
        );
      }
      continue;
    }
    const existing = isObjectRecord(mergedProfiles[name])
      ? mergedProfiles[name]
      : {};
    mergedProfiles[name] = {
      baselineTier: mergeRawValue(existing.baselineTier, profile.baselineTier),
      high: mergeRawValue(existing.high, profile.high),
      medium: mergeRawValue(existing.medium, profile.medium),
      low: mergeRawValue(existing.low, profile.low),
      micro: mergeRawValue(existing.micro, profile.micro),
      advisor: mergeRawValue(existing.advisor, profile.advisor),
    };
  }

  const baseModels = isObjectRecord(base.models) ? base.models : {};
  const overrideModels = isObjectRecord(override.models) ? override.models : {};
  const mergedModels = { ...baseModels, ...overrideModels };

  const mergedAdvisor = mergeRawValue(base.advisor, override.advisor);
  const advisor = isObjectRecord(mergedAdvisor)
    ? {
        ...mergedAdvisor,
        context: mergeRawValue(
          isObjectRecord(base.advisor) ? base.advisor.context : undefined,
          isObjectRecord(override.advisor)
            ? override.advisor.context
            : undefined,
        ),
      }
    : mergedAdvisor;
  return {
    ui: mergeRawValue(base.ui, override.ui),
    advisor,
    debug: override.debug ?? base.debug,
    phaseBias: override.phaseBias ?? base.phaseBias,
    maxSessionBudget: override.maxSessionBudget ?? base.maxSessionBudget,
    rules: override.rules ?? base.rules,
    profiles: mergedProfiles,
    models: Object.keys(mergedModels).length > 0 ? mergedModels : undefined,
  };
};

/**
 * Validate and normalize the models map from config.
 */
export const normalizeModelsMap = (
  raw: unknown,
  warnings: string[],
): Record<string, ModelDefinition> => {
  const result: Record<string, ModelDefinition> = {};
  if (!raw || !isObjectRecord(raw)) return result;

  for (const [alias, entry] of Object.entries(raw)) {
    if (alias === '__proto__') continue;
    if (!isObjectRecord(entry)) {
      warnings.push(
        `Ignored invalid model definition "${alias}": expected an object.`,
      );
      continue;
    }

    let model = typeof entry.model === 'string' ? entry.model.trim() : '';
    if (!model) {
      warnings.push(
        `Model definition "${alias}" is missing the "model" field. Skipped.`,
      );
      continue;
    }

    try {
      const { provider, modelId } = parseCanonicalModelRef(model);
      model = `${provider}/${modelId}`;
    } catch {
      warnings.push(
        `Model definition "${alias}" has an invalid model reference. Skipped.`,
      );
      continue;
    }

    const contextWindow =
      typeof entry.contextWindow === 'number' &&
      Number.isFinite(entry.contextWindow) &&
      entry.contextWindow > 0
        ? entry.contextWindow
        : undefined;
    if (entry.contextWindow !== undefined && !contextWindow) {
      warnings.push(
        `Model definition "${alias}" has invalid contextWindow. Ignored.`,
      );
    }

    const maxTokens =
      typeof entry.maxTokens === 'number' &&
      Number.isFinite(entry.maxTokens) &&
      entry.maxTokens > 0
        ? entry.maxTokens
        : undefined;
    if (entry.maxTokens !== undefined && !maxTokens) {
      warnings.push(
        `Model definition "${alias}" has invalid maxTokens. Ignored.`,
      );
    }

    const reasoning =
      typeof entry.reasoning === 'boolean' ? entry.reasoning : undefined;

    let thinkingLevels: ThinkingLevel[] | undefined;
    if (Array.isArray(entry.thinkingLevels)) {
      thinkingLevels = entry.thinkingLevels.filter((l): l is ThinkingLevel =>
        isThinkingLevel(l),
      );
      if (thinkingLevels.length === 0) thinkingLevels = undefined;
    }

    result[alias] = {
      model,
      contextWindow,
      maxTokens,
      reasoning,
      thinkingLevels,
    };
  }

  return result;
};

export const normalizeTierConfig = (
  value: unknown,
  profileName: string,
  tier: RouterTier,
  warnings: string[],
  models?: Record<string, ModelDefinition>,
): RoutedTierConfig | undefined => {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const rawModel = typeof value.model === 'string' ? value.model.trim() : '';

  if (!rawModel) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier is missing a model. Tier disabled.`,
    );
    return undefined;
  }

  const resolved = resolveModelRef(rawModel, models);
  const aliasDefinition = resolved.definition;
  let parsedModel: string;
  try {
    const { provider, modelId } = parseCanonicalModelRef(resolved.canonicalRef);
    parsedModel = `${provider}/${modelId}`;
  } catch {
    warnings.push(
      `Profile "${profileName}" ${tier} tier has an invalid model reference. Tier disabled.`,
    );
    return undefined;
  }

  const tierReasoning =
    typeof value.reasoning === 'boolean' ? value.reasoning : undefined;
  const effectiveReasoning = tierReasoning ?? aliasDefinition?.reasoning;
  const defaultThinking =
    tier === 'micro' || effectiveReasoning === false ? 'off' : 'medium';
  const thinking = isThinkingLevel(value.thinking)
    ? value.thinking
    : defaultThinking;
  if (value.thinking !== undefined && !isThinkingLevel(value.thinking)) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier has invalid thinking level. Defaulting to ${defaultThinking}.`,
    );
  }

  let fallbacks: string[] | undefined;
  const resolvedFallbacks: ModelDefinition[] = [];
  if (Array.isArray(value.fallbacks)) {
    fallbacks = [];
    for (const f of value.fallbacks) {
      if (typeof f === 'string') {
        const resolvedFallback = resolveModelRef(f, models);
        try {
          const { provider, modelId } = parseCanonicalModelRef(
            resolvedFallback.canonicalRef,
          );
          const model = `${provider}/${modelId}`;
          fallbacks.push(model);
          resolvedFallbacks.push({ ...resolvedFallback.definition, model });
        } catch {
          warnings.push(
            `Invalid fallback model in profile "${profileName}" ${tier} tier. Ignored.`,
          );
        }
      } else {
        warnings.push(
          `Profile "${profileName}" ${tier} tier has a non-string fallback entry. Ignored.`,
        );
      }
    }
  } else if (value.fallbacks !== undefined) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier has invalid fallbacks; expected an array. Ignored.`,
    );
  }

  // Resolve contextWindow: tier config > alias > hardcoded default
  const tierContextWindow =
    typeof value.contextWindow === 'number' &&
    Number.isFinite(value.contextWindow) &&
    value.contextWindow > 0
      ? value.contextWindow
      : undefined;
  if (value.contextWindow !== undefined && tierContextWindow === undefined)
    warnings.push(
      `Profile "${profileName}" tier "${tier}" has invalid contextWindow. Ignored.`,
    );
  const resolvedContextWindow =
    tierContextWindow ??
    aliasDefinition?.contextWindow ??
    DEFAULT_CONTEXT_WINDOW;

  // Resolve maxTokens: tier config > alias > hardcoded default
  const tierMaxTokens =
    typeof value.maxTokens === 'number' &&
    Number.isFinite(value.maxTokens) &&
    value.maxTokens > 0
      ? value.maxTokens
      : undefined;
  if (value.maxTokens !== undefined && tierMaxTokens === undefined)
    warnings.push(
      `Profile "${profileName}" tier "${tier}" has invalid maxTokens. Ignored.`,
    );
  const resolvedMaxTokens =
    tierMaxTokens ?? aliasDefinition?.maxTokens ?? DEFAULT_MAX_TOKENS;

  // Tier declarations take precedence after invalid levels are removed.
  let tierThinkingLevels: ThinkingLevel[] | undefined;
  if (Array.isArray(value.thinkingLevels)) {
    tierThinkingLevels = value.thinkingLevels.filter((l): l is ThinkingLevel =>
      isThinkingLevel(l),
    );
    if (tierThinkingLevels.length === 0) tierThinkingLevels = undefined;
  }

  const explicitThinkingLevels =
    tierThinkingLevels ?? aliasDefinition?.thinkingLevels;
  return {
    model: parsedModel,
    thinkingExplicit: isThinkingLevel(value.thinking),
    thinking,
    fallbacks,
    resolvedFallbacks,
    contextWindow: tierContextWindow,
    maxTokens: tierMaxTokens,
    reasoning: effectiveReasoning,
    thinkingLevels: explicitThinkingLevels,
    resolvedContextWindow,
    resolvedMaxTokens,
  };
};

// Node turns larger setTimeout delays into 1 ms rather than waiting longer.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const DEFAULT_ADVISOR_CONFIG = {
  timeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
  confidenceThreshold: 0.65,
  probabilityThreshold: 0.8,
  maxStateTokens: 3000,
  maxRetries: 1,
} as const;

export const normalizeClassifierRef = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const { provider, modelId } = parseCanonicalModelRef(value.trim());
    if (provider === 'router') return undefined;
    return `${provider}/${modelId}`;
  } catch {
    return undefined;
  }
};

const normalizeClassifierContext = (
  raw: unknown,
): ClassifierContextConfig | undefined => {
  if (raw === undefined) return { ...DEFAULT_CLASSIFIER_CONTEXT };
  if (
    !isObjectRecord(raw) ||
    Object.keys(raw).some(
      (key) => !Object.hasOwn(DEFAULT_CLASSIFIER_CONTEXT, key),
    )
  )
    return undefined;
  const context = { ...DEFAULT_CLASSIFIER_CONTEXT, ...raw };
  if (
    typeof context.previousTurns !== 'number' ||
    !Number.isSafeInteger(context.previousTurns) ||
    context.previousTurns < 0 ||
    context.previousTurns > MAX_CLASSIFIER_CONTEXT_TURNS ||
    typeof context.maxHistoryTokens !== 'number' ||
    !Number.isInteger(context.maxHistoryTokens) ||
    context.maxHistoryTokens < 0 ||
    context.maxHistoryTokens > MAX_CLASSIFIER_STATE_TOKENS ||
    typeof context.maxToolTokens !== 'number' ||
    !Number.isInteger(context.maxToolTokens) ||
    context.maxToolTokens < 0 ||
    context.maxToolTokens > MAX_CLASSIFIER_STATE_TOKENS ||
    !['none', 'last', 'last-error'].includes(context.toolResults)
  )
    return undefined;
  return context;
};

export const normalizeAdvisorConfig = (
  raw: unknown,
  warnings: string[],
): AdvisorConfig | undefined => {
  if (raw === undefined) return undefined;
  const invalid = (): undefined => {
    warnings.push(
      'Ignored invalid advisor configuration. Configure a Pi classifier reference; credentials and endpoints belong to Pi.',
    );
    return undefined;
  };
  const allowed = [
    'enabled',
    'model',
    'timeoutMs',
    'confidenceThreshold',
    'probabilityThreshold',
    'maxStateTokens',
    'context',
    'maxRetries',
    'temperature',
  ];
  if (
    !isObjectRecord(raw) ||
    Object.keys(raw).some((key) => !allowed.includes(key))
  )
    return invalid();
  const value: Record<string, unknown> = { ...DEFAULT_ADVISOR_CONFIG, ...raw };
  const model = normalizeClassifierRef(value.model);
  const context = normalizeClassifierContext(value.context);
  if (
    !model ||
    !context ||
    (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
    typeof value.timeoutMs !== 'number' ||
    !Number.isFinite(value.timeoutMs) ||
    value.timeoutMs <= 0 ||
    value.timeoutMs > MAX_TIMER_DELAY_MS ||
    typeof value.confidenceThreshold !== 'number' ||
    !Number.isFinite(value.confidenceThreshold) ||
    value.confidenceThreshold < 0 ||
    value.confidenceThreshold > 1 ||
    typeof value.probabilityThreshold !== 'number' ||
    !Number.isFinite(value.probabilityThreshold) ||
    value.probabilityThreshold <= 0 ||
    value.probabilityThreshold > 1 ||
    typeof value.maxStateTokens !== 'number' ||
    !Number.isInteger(value.maxStateTokens) ||
    value.maxStateTokens < 1 ||
    value.maxStateTokens > MAX_CLASSIFIER_STATE_TOKENS ||
    typeof value.maxRetries !== 'number' ||
    !Number.isSafeInteger(value.maxRetries) ||
    value.maxRetries < 0 ||
    value.maxRetries > MAX_CLASSIFIER_RETRIES ||
    (value.temperature !== undefined &&
      (typeof value.temperature !== 'number' ||
        !Number.isFinite(value.temperature) ||
        value.temperature <= 0))
  )
    return invalid();
  return {
    enabled: value.enabled === true,
    model,
    timeoutMs: value.timeoutMs,
    confidenceThreshold: value.confidenceThreshold,
    probabilityThreshold: value.probabilityThreshold,
    maxStateTokens: value.maxStateTokens,
    context,
    maxRetries: value.maxRetries,
    ...(typeof value.temperature === 'number'
      ? { temperature: value.temperature }
      : {}),
  };
};

/** Project configuration cannot select a destination or authorize advisor text. */
export const stripProjectAdvisorConfig = (
  raw: RawRouterConfig,
  warnings: string[],
): RawRouterConfig => {
  const { advisor, ...project } = raw;
  let found = advisor !== undefined;
  if (isObjectRecord(project.profiles)) {
    project.profiles = Object.fromEntries(
      Object.entries(project.profiles).map(([name, profile]) => {
        if (!isObjectRecord(profile)) return [name, profile];
        const { advisor, ...tiers } = profile;
        if (advisor !== undefined) found = true;
        return [name, tiers];
      }),
    );
  }
  if (found)
    warnings.push(
      'Ignored project advisor settings: classifier selection, tuning and profile approvals belong only in user config.',
    );
  return project;
};

export const normalizeConfig = (raw: RawRouterConfig): ConfigLoadResult => {
  const warnings: string[] = [];

  // Normalize models map first so aliases are available during tier normalization
  const normalizedModels = normalizeModelsMap(raw.models, warnings);
  const hasModels = Object.keys(normalizedModels).length > 0;

  const normalizedProfiles: Record<string, RouterProfile> = {};

  for (const [name, profile] of Object.entries(
    isObjectRecord(raw.profiles) ? raw.profiles : {},
  )) {
    if (name === '__proto__') continue;
    if (!name || /\s/.test(name)) {
      warnings.push('Ignored router profile with an invalid name.');
      continue;
    }
    const profileRecord = isObjectRecord(profile) ? profile : {};
    const high = normalizeTierConfig(
      profileRecord.high,
      name,
      'high',
      warnings,
      hasModels ? normalizedModels : undefined,
    );
    const medium = normalizeTierConfig(
      profileRecord.medium,
      name,
      'medium',
      warnings,
      hasModels ? normalizedModels : undefined,
    );
    const low = normalizeTierConfig(
      profileRecord.low,
      name,
      'low',
      warnings,
      hasModels ? normalizedModels : undefined,
    );

    const micro = normalizeTierConfig(
      profileRecord.micro,
      name,
      'micro',
      warnings,
      hasModels ? normalizedModels : undefined,
    );

    if (!high && !medium && !low && !micro) {
      warnings.push(`Profile "${name}" has no valid tiers. Skipped.`);
      continue;
    }

    let baselineTier: RouterTier | undefined;
    if (profileRecord.baselineTier !== undefined) {
      const candidate = profileRecord.baselineTier;
      const normalizedTier = isRouterTier(candidate)
        ? { high, medium, low, micro }[candidate]
        : undefined;
      if (isRouterTier(candidate) && normalizedTier) {
        baselineTier = candidate;
      } else {
        warnings.push(
          `Profile "${name}" baselineTier must name a configured tier. Ignored.`,
        );
      }
    }

    let advisor: RouterProfile['advisor'];
    if (profileRecord.advisor !== undefined) {
      const rawApproval = profileRecord.advisor;
      if (
        isObjectRecord(rawApproval) &&
        Array.isArray(rawApproval.models) &&
        Object.keys(rawApproval).every((key) => key === 'models') &&
        rawApproval.models.every(
          (ref) => normalizeClassifierRef(ref) !== undefined,
        )
      ) {
        advisor = {
          models: [
            ...new Set(
              rawApproval.models.map(
                (ref) => normalizeClassifierRef(ref) as string,
              ),
            ),
          ],
        };
      } else
        warnings.push(
          'Ignored invalid profile advisor approval. List exact Pi classifier references in advisor.models.',
        );
    }
    normalizedProfiles[name] = {
      ...(baselineTier ? { baselineTier } : {}),
      high,
      medium,
      low,
      micro,
      advisor,
    };
  }

  if (raw.phaseBias !== undefined)
    warnings.push('Deprecated router config field "phaseBias" ignored.');
  if (raw.rules !== undefined)
    warnings.push('Deprecated router config field "rules" ignored.');

  const maxSessionBudget =
    typeof raw.maxSessionBudget === 'number' &&
    Number.isFinite(raw.maxSessionBudget) &&
    raw.maxSessionBudget > 0
      ? raw.maxSessionBudget
      : undefined;
  if (raw.maxSessionBudget !== undefined && maxSessionBudget === undefined)
    warnings.push('Invalid maxSessionBudget. Ignored.');

  const statusLine = isObjectRecord(raw.ui) ? raw.ui.statusLine : undefined;
  if (
    raw.ui !== undefined &&
    (!isObjectRecord(raw.ui) ||
      (statusLine !== undefined &&
        statusLine !== 'compact' &&
        statusLine !== 'detailed'))
  )
    warnings.push('Invalid ui.statusLine; using compact.');

  return {
    config: {
      ui: { statusLine: statusLine === 'detailed' ? 'detailed' : 'compact' },
      advisor: normalizeAdvisorConfig(raw.advisor, warnings),
      debug: typeof raw.debug === 'boolean' ? raw.debug : false,
      maxSessionBudget,
      profiles: normalizedProfiles,
      models: hasModels ? normalizedModels : undefined,
    },
    warnings,
  };
};

export const loadRouterConfig = (cwd: string): ConfigLoadResult => {
  const globalPath = join(getAgentDir(), 'model-router.json');
  const projectPath = join(cwd, '.pi', 'model-router.json');
  const globalResult = parseConfigFile(globalPath);
  const projectResult = parseConfigFile(projectPath);
  const baseConfig: RawRouterConfig = { profiles: {} };
  const mergeWarnings: string[] = [];
  const merged = mergeConfig(
    mergeConfig(baseConfig, globalResult.config, mergeWarnings),
    stripProjectAdvisorConfig(projectResult.config, projectResult.warnings),
    mergeWarnings,
  );
  const normalized = normalizeConfig(merged);
  return {
    config: normalized.config,
    warnings: [
      ...globalResult.warnings,
      ...projectResult.warnings,
      ...mergeWarnings,
      ...normalized.warnings,
    ],
  };
};

export const profileNames = (config: RouterConfig): string[] => {
  return Object.keys(config.profiles).sort();
};

export const resolveProfileName = (
  config: RouterConfig,
  requested?: string,
): string | undefined => {
  if (requested && Object.hasOwn(config.profiles, requested)) {
    return requested;
  }
  return undefined;
};

/**
 * Resolve the effective context window for a specific tier at runtime,
 * incorporating the API model registry as the highest-priority source.
 *
 * Resolution chain: API > tier config > model alias > hardcoded default
 */
export const resolveContextWindow = (
  tier: RouterTier,
  profile: RouterProfile,
  modelRegistry: Pick<ExtensionContext['modelRegistry'], 'find'> | undefined,
): number => {
  const tierConfig = profile[tier];
  if (!tierConfig) return DEFAULT_CONTEXT_WINDOW;

  if (modelRegistry) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      const registryModel = modelRegistry.find(provider, modelId);
      if (registryModel?.contextWindow) return registryModel.contextWindow;
    } catch {
      // Invalid refs cannot resolve live capabilities; retain normalized metadata.
    }
  }

  return tierConfig.resolvedContextWindow ?? DEFAULT_CONTEXT_WINDOW;
};

/**
 * Resolve the effective max tokens for a specific tier at runtime,
 * incorporating the API model registry as the highest-priority source.
 *
 * Resolution chain: API > tier config > model alias > hardcoded default
 */
export const resolveMaxTokens = (
  tier: RouterTier,
  profile: RouterProfile,
  modelRegistry: Pick<ExtensionContext['modelRegistry'], 'find'> | undefined,
): number => {
  const tierConfig = profile[tier];
  if (!tierConfig) return DEFAULT_MAX_TOKENS;

  if (modelRegistry) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      const registryModel = modelRegistry.find(provider, modelId);
      if (registryModel?.maxTokens) return registryModel.maxTokens;
    } catch {
      // Invalid refs cannot resolve live capabilities; retain normalized metadata.
    }
  }

  return tierConfig.resolvedMaxTokens ?? DEFAULT_MAX_TOKENS;
};
