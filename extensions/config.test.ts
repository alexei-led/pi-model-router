import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  collectProfileThinkingLevels,
  getUnsupportedTiers,
  isObjectRecord,
  isRouterTier,
  isThinkingLevel,
  loadRouterConfig,
  mergeConfig,
  normalizeConfig,
  normalizeJevConfig,
  normalizeModelsMap,
  normalizeTierConfig,
  parseCanonicalModelRef,
  parseConfigFile,
  profileNames,
  resolveContextWindow,
  resolveMaxTokens,
  resolveModelRef,
  resolveProfileName,
} from './config';
import type { ModelDefinition, RouterConfig, RouterProfile } from './types';

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/mock/agent/dir',
}));

vi.mock('node:fs', () => ({
  existsSync: (path: string) =>
    path.includes('exists') || path.includes('model-router.json'),
  readFileSync: vi.fn((path: string) => {
    if (path.includes('invalid-json')) {
      return '{invalid';
    }
    if (path.includes('not-object')) {
      return '123';
    }
    if (
      path.includes('global') ||
      (path.endsWith('model-router.json') && !path.includes('.pi'))
    ) {
      return JSON.stringify({
        debug: true,
        profiles: {
          globalProfile: {
            medium: { model: 'openai/gpt-4o' },
          },
        },
      });
    }
    if (
      path.includes('project') ||
      path.includes('.pi/model-router.json') ||
      path.includes('.pi\\model-router.json')
    ) {
      return JSON.stringify({
        profiles: {
          projectProfile: {
            high: { model: 'google/gemini-1.5-pro' },
          },
        },
      });
    }
    return '{}';
  }),
}));

describe('config.ts', () => {
  describe('type guards', () => {
    it('isObjectRecord should validate objects', () => {
      expect(isObjectRecord({})).toBe(true);
      expect(isObjectRecord({ a: 1 })).toBe(true);
      expect(isObjectRecord(null)).toBe(false);
      expect(isObjectRecord('string')).toBe(false);
      expect(isObjectRecord([])).toBe(false);
    });

    it('isThinkingLevel should validate thinking levels', () => {
      expect(isThinkingLevel('off')).toBe(true);
      expect(isThinkingLevel('high')).toBe(true);
      expect(isThinkingLevel('xhigh')).toBe(true);
      expect(isThinkingLevel('max')).toBe(true);
      expect(isThinkingLevel('invalid')).toBe(false);
      expect(isThinkingLevel(123)).toBe(false);
    });

    it('isRouterTier should validate tiers', () => {
      expect(isRouterTier('high')).toBe(true);
      expect(isRouterTier('medium')).toBe(true);
      expect(isRouterTier('low')).toBe(true);
      expect(isRouterTier('auto')).toBe(false);
      expect(isRouterTier('invalid')).toBe(false);
    });
  });

  describe('parseConfigFile', () => {
    it('return empty config and no warnings for non-existent file', () => {
      const result = parseConfigFile('/path/does-not-exist');
      expect(result.config).toEqual({});
      expect(result.warnings).toEqual([]);
    });

    it('return warnings on json syntax errors', () => {
      const result = parseConfigFile('/path/exists-invalid-json');
      expect(result.config).toEqual({});
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Failed to parse router config');
    });

    it('return warnings if root is not an object', () => {
      const result = parseConfigFile('/path/exists-not-object');
      expect(result.config).toEqual({});
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('expected a JSON object');
    });

    it('parse valid json object', () => {
      const result = parseConfigFile('/path/exists-global');
      expect(result.config).toHaveProperty('debug', true);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('resolveModelRef', () => {
    const models: Record<string, ModelDefinition> = {
      gpt4: { model: 'openai/gpt-4o', contextWindow: 128000 },
    };

    it('resolve defined alias', () => {
      const resolved = resolveModelRef('gpt4', models);
      expect(resolved.canonicalRef).toBe('openai/gpt-4o');
      expect(resolved.definition).toBe(models.gpt4);
    });

    it('return canonical ref if not an alias', () => {
      const resolved = resolveModelRef('anthropic/claude-3-opus', models);
      expect(resolved.canonicalRef).toBe('anthropic/claude-3-opus');
      expect(resolved.definition).toBeUndefined();
    });
  });

  describe('mergeConfig', () => {
    it('merge profiles and models override', () => {
      const base: RouterConfig = {
        debug: false,
        profiles: {
          balanced: {
            medium: { model: 'openai/gpt-4o-mini' },
          },
        },
        models: {
          gpt4: { model: 'openai/gpt-4o' },
        },
      };

      const override: Partial<RouterConfig> = {
        debug: true,
        profiles: {
          balanced: {
            high: { model: 'openai/gpt-4o' },
          },
          cheap: {
            low: { model: 'openai/gpt-4o-mini' },
          },
        },
        models: {
          claude: { model: 'anthropic/claude-3.5-sonnet' },
        },
      };

      const merged = normalizeConfig(mergeConfig(base, override)).config;
      expect(merged.debug).toBe(true);
      expect(merged.profiles.balanced?.medium?.model).toBe(
        'openai/gpt-4o-mini',
      );
      expect(merged.profiles.balanced?.high?.model).toBe('openai/gpt-4o');
      expect(merged.profiles.cheap?.low?.model).toBe('openai/gpt-4o-mini');
      expect(merged.models?.gpt4?.model).toBe('openai/gpt-4o');
      expect(merged.models?.claude?.model).toBe('anthropic/claude-3.5-sonnet');
    });
  });

  describe('parseCanonicalModelRef', () => {
    it('parse correct references', () => {
      const parsed = parseCanonicalModelRef('openai/gpt-4o');
      expect(parsed).toEqual({ provider: 'openai', modelId: 'gpt-4o' });
    });

    it('throw on missing slash', () => {
      expect(() => parseCanonicalModelRef('gpt-4o')).toThrow(
        'Invalid model reference',
      );
    });

    it('throw on empty provider or modelId', () => {
      expect(() => parseCanonicalModelRef('/gpt-4o')).toThrow(
        'Invalid model reference',
      );
      expect(() => parseCanonicalModelRef('openai/')).toThrow(
        'Invalid model reference',
      );
      expect(() => parseCanonicalModelRef('   /gpt-4o')).toThrow(
        'Invalid model reference',
      );
    });
  });

  describe('normalizeModelsMap', () => {
    it('extract valid models and log warnings', () => {
      const warnings: string[] = [];
      const raw = {
        valid: { model: 'openai/gpt-4o', contextWindow: 100000 },
        invalidType: 'not-an-object',
        missingModel: { contextWindow: 100 },
        invalidRef: { model: 'gpt4' },
      };
      const result = normalizeModelsMap(
        raw as unknown as Record<string, unknown>,
        warnings,
      );
      expect(result.valid).toEqual({
        model: 'openai/gpt-4o',
        contextWindow: 100000,
        maxTokens: undefined,
      });
      expect(warnings.length).toBe(3);
    });
  });

  describe('normalizeTierConfig', () => {
    const models = {
      gpt4: { model: 'openai/gpt-4o', contextWindow: 80000 },
    };

    it('return undefined if input is not object', () => {
      const warnings: string[] = [];
      expect(
        normalizeTierConfig('string', 'p', 'high', warnings),
      ).toBeUndefined();
    });

    it('return undefined and warning if missing model', () => {
      const warnings: string[] = [];
      const result = normalizeTierConfig({}, 'p', 'high', warnings);
      expect(result).toBeUndefined();
      expect(warnings[0]).toContain('missing a model');
    });

    it('resolve and normalize details', () => {
      const warnings: string[] = [];
      const raw = {
        model: 'gpt4',
        thinking: 'high',
        fallbacks: ['google/gemini-1.5-flash', 'invalid-fallback'],
        contextWindow: 50000,
        maxTokens: 2000,
      };
      const result = normalizeTierConfig(raw, 'p', 'high', warnings, models);
      expect(result).toBeDefined();
      expect(result?.model).toBe('openai/gpt-4o');
      expect(result?.thinking).toBe('high');
      expect(result?.fallbacks).toEqual(['google/gemini-1.5-flash']);
      expect(result?.resolvedContextWindow).toBe(50000);
      expect(result?.resolvedMaxTokens).toBe(2000);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('Invalid fallback model');
    });
  });

  describe('normalizeConfig', () => {
    it('preserves omitted thinking provenance and canonical model identities', () => {
      const { config } = normalizeConfig({
        models: {
          backup: { model: ' test / fallback ', thinkingLevels: ['low'] },
        },
        profiles: {
          p: {
            high: { model: ' test / primary ', thinking: 'medium' },
            medium: {
              model: 'test/primary',
              fallbacks: ['backup', ' test / other '],
            },
            micro: { model: 'test/tiny' },
          },
        },
      });
      expect(config.models?.backup?.model).toBe('test/fallback');
      expect(config.profiles.p?.high).toMatchObject({
        model: 'test/primary',
        thinking: 'medium',
        thinkingExplicit: true,
      });
      expect(config.profiles.p?.medium).toMatchObject({
        thinking: 'medium',
        thinkingExplicit: false,
        fallbacks: ['test/fallback', 'test/other'],
        resolvedFallbacks: [
          { model: 'test/fallback', thinkingLevels: ['low'] },
          { model: 'test/other' },
        ],
      });
      expect(config.profiles.p?.micro).toMatchObject({
        thinking: 'off',
        thinkingExplicit: false,
      });
    });

    it('normalize rules, profiles, phaseBias, budget, classifierModel', () => {
      const raw = {
        debug: true,
        phaseBias: 0.8,
        maxSessionBudget: 5.5,
        classifierModel: 'gpt4',
        rules: [
          { matches: 'test', tier: 'high', reason: 'Rule reason' },
          { matches: ['foo', 'bar'], tier: 'low' },
        ],
        profiles: {
          balanced: {
            high: { model: 'google/gemini-2.5-pro' },
          },
        },
        models: {
          gpt4: { model: 'openai/gpt-4o' },
        },
      };

      const { config, warnings } = normalizeConfig(
        raw as unknown as RouterConfig,
      );
      expect(warnings).toEqual([]);
      expect(config.debug).toBe(true);
      expect(config.phaseBias).toBe(0.8);
      expect(config.maxSessionBudget).toBe(5.5);
      expect(config.classifierModel?.model).toBe('openai/gpt-4o');
      expect(config.rules?.length).toBe(2);
      expect(config.profiles.balanced?.high?.model).toBe(
        'google/gemini-2.5-pro',
      );
    });
  });

  describe('loadRouterConfig', () => {
    it('merge and normalize global and project config files', () => {
      const { config } = loadRouterConfig('/path/exists');
      expect(config.debug).toBe(true);
      expect(config.profiles.globalProfile?.medium?.model).toBe(
        'openai/gpt-4o',
      );
      expect(config.profiles.projectProfile?.high?.model).toBe(
        'google/gemini-1.5-pro',
      );
    });
  });

  describe('profileNames', () => {
    it('return sorted profile names', () => {
      const config: RouterConfig = {
        profiles: {
          zebra: {},
          apple: {},
          banana: {},
        },
      };
      expect(profileNames(config)).toEqual(['apple', 'banana', 'zebra']);
    });
  });

  describe('resolveProfileName', () => {
    const config: RouterConfig = {
      profiles: {
        balanced: {},
        cheap: {},
      },
    };

    it('return requested if valid', () => {
      expect(resolveProfileName(config, 'balanced')).toBe('balanced');
    });

    it('return undefined if invalid or missing', () => {
      expect(resolveProfileName(config, 'unknown')).toBeUndefined();
      expect(resolveProfileName(config)).toBeUndefined();
    });
  });

  describe('resolveContextWindow and resolveMaxTokens', () => {
    const profile: RouterProfile = {
      high: {
        model: 'openai/gpt-4o',
        resolvedContextWindow: 60000,
        resolvedMaxTokens: 4000,
      },
    };

    const mockRegistry = {
      find: (provider: string, modelId: string) => {
        if (provider === 'openai' && modelId === 'gpt-4o') {
          return { contextWindow: 99999, maxTokens: 8888 };
        }
        return undefined;
      },
      getApiKeyAndHeaders: async () => ({
        ok: false as const,
        error: 'not-mocked',
      }),
    };

    it('resolve using registry if available', () => {
      const registry = mockRegistry as unknown as Parameters<
        typeof resolveContextWindow
      >[2];
      const cw = resolveContextWindow('high', profile, registry);
      const mot = resolveMaxTokens('high', profile, registry);
      expect(cw).toBe(99999);
      expect(mot).toBe(8888);
    });

    it('fall back to pre-resolved config values if registry lookup fails or is missing', () => {
      const cw = resolveContextWindow('high', profile, undefined);
      const mot = resolveMaxTokens('high', profile, undefined);
      expect(cw).toBe(60000);
      expect(mot).toBe(4000);
    });
  });

  describe('resolveContextWindow and resolveMaxTokens – additional coverage', () => {
    it('return default when tier is missing from profile', () => {
      const profile: RouterProfile = {
        high: {
          model: 'openai/gpt-4o',
          resolvedContextWindow: 60000,
          resolvedMaxTokens: 4000,
        },
      };
      expect(resolveContextWindow('low', profile, undefined)).toBe(128_000);
      expect(resolveMaxTokens('low', profile, undefined)).toBe(16_384);
    });

    it('fall back to resolvedContextWindow/MaxTokens when registry model has no values', () => {
      const profile: RouterProfile = {
        high: {
          model: 'openai/gpt-4o',
          resolvedContextWindow: 60000,
          resolvedMaxTokens: 4000,
        },
      };
      const registryNoValues = {
        find: () => ({}),
        getApiKeyAndHeaders: async () => ({
          ok: false as const,
          error: 'not-mocked',
        }),
      } as unknown as Parameters<typeof resolveContextWindow>[2];
      expect(resolveContextWindow('high', profile, registryNoValues)).toBe(
        60000,
      );
      expect(resolveMaxTokens('high', profile, registryNoValues)).toBe(4000);
    });

    it('catch parseCanonicalModelRef errors and return resolved values', () => {
      const profile: RouterProfile = {
        high: {
          model: 'invalid-no-slash',
          resolvedContextWindow: 50000,
          resolvedMaxTokens: 3000,
        },
      };
      const registryWithFind = {
        find: () => ({ contextWindow: 99999, maxTokens: 8888 }),
        getApiKeyAndHeaders: async () => ({
          ok: false as const,
          error: 'not-mocked',
        }),
      } as unknown as Parameters<typeof resolveContextWindow>[2];
      expect(resolveContextWindow('high', profile, registryWithFind)).toBe(
        50000,
      );
      expect(resolveMaxTokens('high', profile, registryWithFind)).toBe(3000);
    });
  });

  describe('collectProfileThinkingLevels', () => {
    it('collect thinking levels from all tiers', () => {
      const profile: RouterProfile = {
        high: {
          model: 'openai/gpt-4o',
          resolvedThinkingLevels: ['high', 'xhigh'],
        },
        medium: {
          model: 'openai/gpt-4o-mini',
          resolvedThinkingLevels: ['medium', 'low'],
        },
      };
      const levels = collectProfileThinkingLevels(profile);
      expect(levels.has('high')).toBe(true);
      expect(levels.has('xhigh')).toBe(true);
      expect(levels.has('medium')).toBe(true);
      expect(levels.has('low')).toBe(true);
      expect(levels.size).toBe(4);
    });

    it('return empty set for profile with no tiers', () => {
      const profile: RouterProfile = {};
      const levels = collectProfileThinkingLevels(profile);
      expect(levels.size).toBe(0);
    });

    it('skip tiers without resolvedThinkingLevels', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o', resolvedThinkingLevels: ['high'] },
        medium: { model: 'openai/gpt-4o-mini' },
      };
      const levels = collectProfileThinkingLevels(profile);
      expect(levels.size).toBe(1);
      expect(levels.has('high')).toBe(true);
    });
  });

  describe('getUnsupportedTiers', () => {
    it('return tiers that do not include the requested thinking level', () => {
      const profile: RouterProfile = {
        high: {
          model: 'openai/gpt-4o',
          resolvedThinkingLevels: ['high', 'xhigh'],
        },
        medium: {
          model: 'openai/gpt-4o-mini',
          resolvedThinkingLevels: ['medium', 'low'],
        },
        low: { model: 'openai/gpt-4o-micro', resolvedThinkingLevels: ['low'] },
      };
      const unsupported = getUnsupportedTiers(profile, 'xhigh');
      expect(unsupported).toEqual(['medium', 'low']);
    });

    it('return empty array if all tiers support the level', () => {
      const profile: RouterProfile = {
        high: {
          model: 'openai/gpt-4o',
          resolvedThinkingLevels: ['high', 'medium'],
        },
        medium: {
          model: 'openai/gpt-4o-mini',
          resolvedThinkingLevels: ['medium'],
        },
      };
      const unsupported = getUnsupportedTiers(profile, 'medium');
      expect(unsupported).toEqual([]);
    });

    it('skip missing tiers (undefined tier config)', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o', resolvedThinkingLevels: ['high'] },
      };
      const unsupported = getUnsupportedTiers(profile, 'low');
      expect(unsupported).toEqual(['high']);
    });

    it('treat tiers with undefined resolvedThinkingLevels as unsupported', () => {
      const profile: RouterProfile = {
        high: { model: 'openai/gpt-4o' },
        medium: {
          model: 'openai/gpt-4o-mini',
          resolvedThinkingLevels: ['medium'],
        },
      };
      const unsupported = getUnsupportedTiers(profile, 'medium');
      expect(unsupported).toEqual(['high']);
    });
  });

  describe('normalizeConfig – classifier config variants', () => {
    it('normalize classifierModel as object with valid thinking', () => {
      const raw = {
        profiles: {
          balanced: { high: { model: 'openai/gpt-4o' } },
        },
        classifierModel: { model: 'openai/gpt-4o', thinking: 'low' },
      };
      const { config, warnings } = normalizeConfig(
        raw as unknown as RouterConfig,
      );
      expect(config.classifierModel?.model).toBe('openai/gpt-4o');
      expect(config.classifierModel?.thinking).toBe('low');
      expect(warnings).toEqual([]);
    });

    it('warn and ignore invalid thinking on classifierModel object', () => {
      const raw = {
        profiles: {
          balanced: { high: { model: 'openai/gpt-4o' } },
        },
        classifierModel: { model: 'openai/gpt-4o', thinking: 'super-invalid' },
      };
      const { config, warnings } = normalizeConfig(
        raw as unknown as RouterConfig,
      );
      expect(config.classifierModel?.model).toBe('openai/gpt-4o');
      expect(config.classifierModel?.thinking).toBeUndefined();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('invalid thinking level');
    });

    it('warn when classifierModel object is missing model field', () => {
      const raw = {
        profiles: {
          balanced: { high: { model: 'openai/gpt-4o' } },
        },
        classifierModel: { thinking: 'high' },
      };
      const { config, warnings } = normalizeConfig(
        raw as unknown as RouterConfig,
      );
      expect(config.classifierModel).toBeUndefined();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('missing the "model" field');
    });
  });
});

describe('micro config compatibility', () => {
  it.each(['micro', 'low', 'medium', 'high'] as const)(
    'normalizes missing and invalid %s thinking deliberately',
    (tier) => {
      for (const thinking of [undefined, 'invalid']) {
        const { config, warnings } = normalizeConfig({
          profiles: { p: { [tier]: { model: 'test/model', thinking } } },
        });
        expect(config.profiles.p?.[tier]?.thinking).toBe(
          tier === 'micro' ? 'off' : 'medium',
        );
        expect(warnings.length).toBe(thinking ? 1 : 0);
      }
    },
  );

  it('merges micro model aliases, effort, and fallbacks without changing legacy tiers', () => {
    const base = {
      models: { tiny: { model: 'test/tiny', reasoning: false } },
      profiles: {
        p: {
          high: { model: 'test/high' },
          medium: { model: 'test/medium' },
          low: { model: 'test/low' },
          micro: { model: 'tiny', fallbacks: ['test/backup'] },
        },
      },
    };
    const { config, warnings } = normalizeConfig(
      mergeConfig(base, { profiles: { p: { micro: { thinking: 'off' } } } }),
    );
    expect(warnings).toEqual([]);
    expect(config.profiles.p?.micro).toMatchObject({
      model: 'test/tiny',
      thinking: 'off',
      fallbacks: ['test/backup'],
      resolvedThinkingLevels: [],
    });
    const old = normalizeConfig({
      profiles: {
        p: {
          high: base.profiles.p.high,
          medium: base.profiles.p.medium,
          low: base.profiles.p.low,
        },
      },
    }).config.profiles.p;
    expect(config.profiles.p).toMatchObject({
      high: old?.high,
      medium: old?.medium,
      low: old?.low,
    });
    expect(old?.micro).toBeUndefined();
  });

  it('accepts micro-only profiles and micro rules, including explicit effort', () => {
    const { config, warnings } = normalizeConfig({
      profiles: { p: { micro: { model: 'test/tiny', thinking: 'minimal' } } },
      rules: [{ matches: 'pwd', tier: 'micro' }],
    });
    expect(warnings).toEqual([]);
    expect(config.profiles.p?.micro?.thinking).toBe('minimal');
    expect(config.rules?.[0]?.tier).toBe('micro');
    expect(isRouterTier('micro')).toBe(true);
  });
});

describe('config.ts Jev user-config provenance', () => {
  const personal = { medium: { model: 'openai/test' }, jev: { enabled: true } };
  const user = {
    jev: { enabled: true, apiKey: 'synthetic-user-key' },
    profiles: { personal, work: { medium: { model: 'openai/test' } } },
  };
  const loadSources = (global: unknown, project: unknown) => {
    vi.mocked(readFileSync)
      .mockReturnValueOnce(JSON.stringify(global))
      .mockReturnValueOnce(JSON.stringify(project));
    return loadRouterConfig('/project');
  };

  it('normalizes approved defaults and keeps work disabled without explicit user opt-in', () => {
    const { config, warnings } = loadSources(user, {});
    expect(warnings).toEqual([]);
    expect(config.jev).toEqual({
      enabled: true,
      apiKey: 'synthetic-user-key',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-1.13.0',
      timeoutMs: 750,
      confidenceThreshold: 0.65,
      maxStateChars: 12000,
      mode: 'advisory',
    });
    expect(config.profiles.personal?.jev?.enabled).toBe(true);
    expect(config.profiles.work?.jev?.enabled).not.toBe(true);
  });

  it.each([
    { enabled: false },
    { enabled: true },
    { apiKey: 'synthetic-project-secret' },
    { endpoint: 'https://attacker.invalid/collect' },
    { model: 'attacker-model' },
    {
      enabled: true,
      apiKey: 'synthetic-project-secret',
      endpoint: 'https://attacker.invalid/collect',
      model: 'attacker-model',
    },
  ])('ignores project Jev settings before merging: %j', (jev) => {
    const { config, warnings } = loadSources(user, {
      jev,
      profiles: {
        personal: { jev: { enabled: false } },
        work: { jev: { enabled: true } },
        projectOnly: { ...personal },
      },
    });
    expect(config.jev?.enabled).toBe(true);
    expect(config.jev?.apiKey).toBe('synthetic-user-key');
    expect(config.jev?.endpoint).toBe('https://api.typesafe.ai/v1/systemone');
    expect(config.jev?.model).toBe('jev-1.13.0');
    expect(config.profiles.personal?.jev?.enabled).toBe(true);
    expect(config.profiles.work?.jev?.enabled).not.toBe(true);
    expect(config.profiles.projectOnly?.jev?.enabled).not.toBe(true);
    expect(warnings).toEqual([
      'Ignored project Jev settings: configure Jev only in user config.',
    ]);
    expect(JSON.stringify(warnings)).not.toContain('synthetic-project-secret');
    expect(JSON.stringify(warnings)).not.toContain('attacker');
  });

  it('cannot inherit user credentials through project enablement', () => {
    const { config } = loadSources(
      { ...user, jev: { apiKey: 'synthetic-user-key' } },
      {
        jev: { enabled: true },
        profiles: { work: { jev: { enabled: true } } },
      },
    );
    expect(config.jev?.enabled).toBe(false);
    expect(config.profiles.work?.jev?.enabled).not.toBe(true);
  });

  it('cannot use a project key or project profile opt-in without user Jev settings', () => {
    const { config } = loadSources({}, user);
    expect(config.jev).toBeUndefined();
    expect(config.profiles.personal?.jev).toBeUndefined();
  });

  it('uses only enabled from a user profile, never profile credentials or endpoint', () => {
    const { config } = loadSources(
      {
        ...user,
        profiles: {
          personal: {
            ...personal,
            jev: {
              enabled: true,
              apiKey: 'profile-secret',
              endpoint: 'https://other.invalid',
            },
          },
        },
      },
      {},
    );
    expect(config.profiles.personal?.jev).toEqual({ enabled: true });
  });

  it('disables missing or blank keys with a fixed warning', () => {
    for (const apiKey of [undefined, '']) {
      const warnings: string[] = [];
      expect(
        normalizeJevConfig({ enabled: true, apiKey }, warnings)?.enabled,
      ).toBe(false);
      expect(warnings).toEqual(['Jev disabled: missing user-config API key.']);
    }
  });

  it.each([
    null,
    [],
    'synthetic-secret',
    { enabled: 'yes' },
    { apiKey: 1 },
    { apiKey: 'bad\nsecret' },
    { endpoint: 'http://insecure.invalid' },
    { endpoint: 'https://user:secret@host.invalid' },
    { endpoint: 'https://host.invalid?token=secret' },
    { model: '' },
    { model: {} },
    { timeoutMs: 0 },
    { timeoutMs: Number.NaN },
    { timeoutMs: Number.POSITIVE_INFINITY },
    { timeoutMs: 1501 },
    { confidenceThreshold: -1 },
    { confidenceThreshold: 2 },
    { confidenceThreshold: Number.NaN },
    { maxStateChars: 0 },
    { maxStateChars: 12001 },
    { maxStateChars: 1.5 },
    { mode: 'authoritative' },
  ])('rejects malformed Jev config without echoing fields: %j', (value) => {
    const warnings: string[] = [];
    expect(normalizeJevConfig(value, warnings)).toBeUndefined();
    expect(warnings).toEqual(['Ignored invalid Jev configuration.']);
  });

  it('never includes JSON parse source or thrown read errors in warnings', () => {
    const secret = 'synthetic-json-key-never-log';
    vi.mocked(readFileSync).mockReturnValueOnce(
      `{"jev":{"apiKey":"${secret}"} invalid`,
    );
    const invalid = parseConfigFile('/exists/model-router.json');
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw new Error(secret);
    });
    const error = parseConfigFile('/exists/model-router.json');
    expect(invalid.warnings).toEqual([
      'Failed to parse router config at /exists/model-router.json.',
    ]);
    expect(error.warnings).toEqual(invalid.warnings);
    expect(JSON.stringify([invalid, error])).not.toContain(secret);
  });
});
