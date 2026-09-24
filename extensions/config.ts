import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_JEV_CONTEXT,
  DEFAULT_JEV_RETRY,
  DEFAULT_MAX_TOKENS,
  MAX_JEV_ATTEMPTS,
  MAX_JEV_BACKOFF_MS,
  MAX_JEV_CONTEXT_TURNS,
  MAX_JEV_STATE_TOKENS,
  ROUTER_COMMANDS,
} from './constants';
import type {
  ClassifierConfig,
  ConfigLoadResult,
  JevConfig,
  JevContextConfig,
  JevRetryConfig,
  ModelDefinition,
  ParsedConfigFile,
  RawRouterConfig,
  RoutedTierConfig,
  RouterConfig,
  RouterProfile,
  RouterTier,
} from './types';

import { ROUTER_TIERS } from './types';

export { ROUTER_TIERS } from './types';

// Pi accepts this model capability at runtime, but older peer type releases omit it.
export const MAX_THINKING_LEVEL: ThinkingLevel = 'max';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  MAX_THINKING_LEVEL,
];
export const ROUTER_PIN_VALUES = ['auto', ...ROUTER_TIERS] as const;
export type RouterPinValue = (typeof ROUTER_PIN_VALUES)[number];
export const isRouterPinValue = (value: unknown): value is RouterPinValue =>
  ROUTER_PIN_VALUES.some((candidate) => candidate === value);

export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'high',
  'medium',
  'low',
] as const;

export const isObjectRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && THINKING_LEVELS.some((level) => level === value);

export const isRouterTier = (value: unknown): value is RouterTier =>
  ROUTER_TIERS.some((tier) => tier === value);

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
      jev: mergeRawValue(existing.jev, profile.jev),
    };
  }

  const baseModels = isObjectRecord(base.models) ? base.models : {};
  const overrideModels = isObjectRecord(override.models) ? override.models : {};
  const mergedModels = { ...baseModels, ...overrideModels };

  const mergedJev = mergeRawValue(base.jev, override.jev);
  const nestedJev = (key: 'context' | 'retry') =>
    mergeRawValue(
      isObjectRecord(base.jev) ? base.jev[key] : undefined,
      isObjectRecord(override.jev) ? override.jev[key] : undefined,
    );
  const jev = isObjectRecord(mergedJev)
    ? { ...mergedJev, context: nestedJev('context'), retry: nestedJev('retry') }
    : mergedJev;
  return {
    ui: mergeRawValue(base.ui, override.ui),
    jev,
    debug: override.debug ?? base.debug,
    classifierModel: override.classifierModel ?? base.classifierModel,
    phaseBias: override.phaseBias ?? base.phaseBias,
    maxSessionBudget: override.maxSessionBudget ?? base.maxSessionBudget,
    rules: override.rules ?? base.rules,
    profiles: mergedProfiles,
    models: Object.keys(mergedModels).length > 0 ? mergedModels : undefined,
  };
};

export const parseCanonicalModelRef = (
  value: string,
): { provider: string; modelId: string } => {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    throw new Error('Invalid model reference. Expected "provider/model".');
  }
  const provider = value.slice(0, slashIndex).trim();
  const modelId = value.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    throw new Error('Invalid model reference. Expected "provider/model".');
  }
  return { provider, modelId };
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

  // Try to resolve as an alias first
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
        // Resolve aliases in fallbacks too
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

  // Resolve thinkingLevels: tier config > alias > default
  // Validate tier-level thinkingLevels array
  let tierThinkingLevels: ThinkingLevel[] | undefined;
  if (Array.isArray(value.thinkingLevels)) {
    tierThinkingLevels = value.thinkingLevels.filter((l): l is ThinkingLevel =>
      isThinkingLevel(l),
    );
    if (tierThinkingLevels.length === 0) tierThinkingLevels = undefined;
  }

  const explicitThinkingLevels =
    tierThinkingLevels ?? aliasDefinition?.thinkingLevels;
  const baseThinkingLevels: ThinkingLevel[] =
    explicitThinkingLevels ??
    (effectiveReasoning === false ? [] : [...DEFAULT_THINKING_LEVELS]);

  // Auto-add the tier's thinking value if it's not 'off' and not already present,
  // but only if the user didn't explicitly constrain the thinkingLevels array.
  const resolvedThinkingLevels: ThinkingLevel[] = [...baseThinkingLevels];
  if (
    !explicitThinkingLevels &&
    effectiveReasoning !== false &&
    thinking !== 'off' &&
    !resolvedThinkingLevels.includes(thinking)
  ) {
    resolvedThinkingLevels.push(thinking);
  }

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
    resolvedThinkingLevels,
  };
};

// Node turns larger setTimeout delays into 1 ms rather than waiting longer.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const DEFAULT_JEV_CONFIG = {
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-1.13.0',
  timeoutMs: 1500,
  confidenceThreshold: 0.65,
  probabilityThreshold: 0.8,
  maxStateTokens: 3000,
  mode: 'advisory',
} as const;

export const isJevEndpoint = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};

const normalizeJevContext = (raw: unknown): JevContextConfig | undefined => {
  if (raw === undefined) return { ...DEFAULT_JEV_CONTEXT };
  if (
    !isObjectRecord(raw) ||
    Object.keys(raw).some((key) => !Object.hasOwn(DEFAULT_JEV_CONTEXT, key))
  )
    return undefined;
  const context = { ...DEFAULT_JEV_CONTEXT, ...raw };
  if (
    typeof context.previousTurns !== 'number' ||
    !Number.isSafeInteger(context.previousTurns) ||
    context.previousTurns < 0 ||
    context.previousTurns > MAX_JEV_CONTEXT_TURNS ||
    typeof context.maxHistoryTokens !== 'number' ||
    !Number.isInteger(context.maxHistoryTokens) ||
    context.maxHistoryTokens < 0 ||
    context.maxHistoryTokens > MAX_JEV_STATE_TOKENS ||
    typeof context.maxToolTokens !== 'number' ||
    !Number.isInteger(context.maxToolTokens) ||
    context.maxToolTokens < 0 ||
    context.maxToolTokens > MAX_JEV_STATE_TOKENS ||
    !['none', 'last', 'last-error'].includes(context.toolResults)
  )
    return undefined;
  return context;
};

const normalizeJevRetry = (raw: unknown): JevRetryConfig | undefined => {
  if (raw === undefined) return { ...DEFAULT_JEV_RETRY };
  if (
    !isObjectRecord(raw) ||
    Object.keys(raw).some((key) => !Object.hasOwn(DEFAULT_JEV_RETRY, key))
  )
    return undefined;
  const retry = { ...DEFAULT_JEV_RETRY, ...raw };
  if (
    typeof retry.maxAttempts !== 'number' ||
    !Number.isSafeInteger(retry.maxAttempts) ||
    retry.maxAttempts < 1 ||
    retry.maxAttempts > MAX_JEV_ATTEMPTS ||
    typeof retry.backoffMs !== 'number' ||
    !Number.isSafeInteger(retry.backoffMs) ||
    retry.backoffMs < 0 ||
    retry.backoffMs > MAX_JEV_BACKOFF_MS
  )
    return undefined;
  return retry;
};

export const normalizeJevConfig = (
  raw: unknown,
  warnings: string[],
): JevConfig | undefined => {
  if (raw === undefined) return undefined;
  const invalid = (): undefined => {
    warnings.push('Ignored invalid Jev configuration.');
    return undefined;
  };
  if (!isObjectRecord(raw)) return invalid();
  const value: Record<string, unknown> = { ...DEFAULT_JEV_CONFIG, ...raw };
  const context = normalizeJevContext(value.context);
  if (!context) return invalid();
  const retry = normalizeJevRetry(value.retry);
  if (!retry) return invalid();
  if (
    (value.enabled !== undefined && typeof value.enabled !== 'boolean') ||
    !isJevEndpoint(value.endpoint) ||
    typeof value.model !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,128}$/.test(value.model) ||
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
    value.maxStateTokens > MAX_JEV_STATE_TOKENS ||
    value.mode !== 'advisory' ||
    (value.apiKey !== undefined &&
      (typeof value.apiKey !== 'string' || /[\r\n]/.test(value.apiKey)))
  )
    return invalid();
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  if (value.enabled === true && !apiKey) {
    warnings.push('Jev disabled: missing user-config API key.');
  }
  return {
    enabled: value.enabled === true && apiKey.length > 0,
    apiKey,
    endpoint: value.endpoint,
    model: value.model,
    timeoutMs: value.timeoutMs,
    confidenceThreshold: value.confidenceThreshold,
    probabilityThreshold: value.probabilityThreshold,
    maxStateTokens: value.maxStateTokens,
    context,
    retry,
    mode: 'advisory',
  };
};

// Remove every project Jev setting before merging with user-owned credentials.
export const stripProjectJevConfig = (
  raw: RawRouterConfig,
  warnings: string[],
): RawRouterConfig => {
  const { jev: ignored, ...project } = raw;
  let found = ignored !== undefined;
  if (isObjectRecord(project.profiles)) {
    project.profiles = Object.fromEntries(
      Object.entries(project.profiles).map(([name, profile]) => {
        if (!isObjectRecord(profile)) return [name, profile];
        const { jev, ...tiers } = profile;
        if (jev !== undefined) found = true;
        return [name, tiers];
      }),
    );
  }
  if (found)
    warnings.push(
      'Ignored project Jev settings: configure Jev only in user config.',
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
    if (
      !name ||
      /\s/.test(name) ||
      ROUTER_COMMANDS.some((command) => command.name === name)
    ) {
      warnings.push('Ignored router profile with an invalid or reserved name.');
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

    const jev = isObjectRecord(profileRecord.jev)
      ? { enabled: profileRecord.jev.enabled === true }
      : undefined;
    normalizedProfiles[name] = {
      ...(baselineTier ? { baselineTier } : {}),
      high,
      medium,
      low,
      micro,
      jev,
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

  // Resolve classifierModel — accepts string or { model, thinking } object
  let classifierModel: ClassifierConfig | undefined;
  const rawClassifier = raw.classifierModel;
  if (typeof rawClassifier === 'string' && rawClassifier.trim()) {
    const resolved = resolveModelRef(
      rawClassifier.trim(),
      hasModels ? normalizedModels : undefined,
    );
    try {
      parseCanonicalModelRef(resolved.canonicalRef);
      classifierModel = { model: resolved.canonicalRef };
    } catch {
      warnings.push('Invalid classifierModel model reference. Ignored.');
    }
  } else if (isObjectRecord(rawClassifier)) {
    const modelRef =
      typeof rawClassifier.model === 'string' ? rawClassifier.model.trim() : '';
    if (modelRef) {
      const resolved = resolveModelRef(
        modelRef,
        hasModels ? normalizedModels : undefined,
      );
      try {
        parseCanonicalModelRef(resolved.canonicalRef);
        const thinking = isThinkingLevel(rawClassifier.thinking)
          ? rawClassifier.thinking
          : undefined;
        if (rawClassifier.thinking !== undefined && !thinking) {
          warnings.push(
            'classifierModel has an invalid thinking level. Ignored.',
          );
        }
        const timeoutMs =
          typeof rawClassifier.timeoutMs === 'number' &&
          Number.isFinite(rawClassifier.timeoutMs) &&
          rawClassifier.timeoutMs > 0 &&
          rawClassifier.timeoutMs <= MAX_TIMER_DELAY_MS
            ? rawClassifier.timeoutMs
            : undefined;
        if (rawClassifier.timeoutMs !== undefined && timeoutMs === undefined) {
          warnings.push('classifierModel has an invalid timeoutMs. Ignored.');
        }
        classifierModel = { model: resolved.canonicalRef, thinking, timeoutMs };
      } catch {
        warnings.push('Invalid classifierModel model reference. Ignored.');
      }
    } else {
      warnings.push(
        'classifierModel object is missing the "model" field. Ignored.',
      );
    }
  }

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
      jev: normalizeJevConfig(raw.jev, warnings),
      debug: typeof raw.debug === 'boolean' ? raw.debug : false,
      classifierModel,
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
    stripProjectJevConfig(projectResult.config, projectResult.warnings),
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
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): number => {
  const tierConfig = profile[tier];
  if (!tierConfig) return DEFAULT_CONTEXT_WINDOW;

  // 1. API value (highest priority)
  if (modelRegistry) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      const registryModel = modelRegistry.find(provider, modelId);
      if (registryModel?.contextWindow) return registryModel.contextWindow;
    } catch {
      /* ignore */
    }
  }

  // 2-4. Pre-resolved during config normalization (tier > alias > hardcoded)
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
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): number => {
  const tierConfig = profile[tier];
  if (!tierConfig) return DEFAULT_MAX_TOKENS;

  // 1. API value (highest priority)
  if (modelRegistry) {
    try {
      const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
      const registryModel = modelRegistry.find(provider, modelId);
      if (registryModel?.maxTokens) return registryModel.maxTokens;
    } catch {
      /* ignore */
    }
  }

  // 2-4. Pre-resolved during config normalization (tier > alias > hardcoded)
  return tierConfig.resolvedMaxTokens ?? DEFAULT_MAX_TOKENS;
};

/**
 * Collect the union of all tier models' resolved thinking levels for a profile.
 * Returns a Set of ThinkingLevel values.
 */
export const collectProfileThinkingLevels = (
  profile: RouterProfile,
): Set<ThinkingLevel> => {
  const levels = new Set<ThinkingLevel>();
  for (const tier of ROUTER_TIERS) {
    const tierConfig = profile[tier];
    if (!tierConfig?.resolvedThinkingLevels) continue;
    for (const level of tierConfig.resolvedThinkingLevels) {
      levels.add(level);
    }
  }
  return levels;
};
