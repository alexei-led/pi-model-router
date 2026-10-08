import { describe, expect, it, vi } from 'vitest';
import {
  loadRouterConfig,
  mergeConfig,
  normalizeConfig,
  normalizeModelsMap,
  normalizeTierConfig,
  parseConfigFile,
  profileNames,
  resolveContextWindow,
  resolveMaxTokens,
  resolveModelRef,
  resolveProfileName,
  stripProjectAdvisorConfig,
} from './config';
import { isRouterTier } from './domain';
import type { ModelDefinition, RouterConfig, RouterProfile } from './types';

describe('status line configuration', () => {
  it.each([undefined, {}, { statusLine: 'compact' }])(
    'defaults to compact for %j',
    (ui) => {
      expect(normalizeConfig({ ui }).config.ui?.statusLine).toBe('compact');
    },
  );
  it('merges the project UI preference without touching routing', () => {
    const result = normalizeConfig(
      mergeConfig(
        {
          ui: { statusLine: 'compact' },
          profiles: { p: { medium: { model: 'test/model' } } },
        },
        { ui: { statusLine: 'detailed' } },
      ),
    );
    expect(result.config.ui?.statusLine).toBe('detailed');
    expect(result.config.profiles.p?.medium?.model).toBe('test/model');
  });
  it.each(['secret', { statusLine: 'secret' }, { statusLine: false }])(
    'rejects invalid UI config without echoing values: %j',
    (ui) => {
      const result = normalizeConfig({ ui });
      expect(result.config.ui?.statusLine).toBe('compact');
      expect(result.warnings).toContain(
        'Invalid ui.statusLine; using compact.',
      );
      expect(result.warnings.join()).not.toContain('secret');
    },
  );
});

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
  it.each(['', 'two words', ' leading'])(
    'rejects profile names that cannot be selected by the command: %j',
    (name) => {
      const { config, warnings } = normalizeConfig({
        profiles: {
          [name]: { medium: { model: 'test/primary' } },
          valid: { medium: { model: 'test/primary' } },
        },
      });
      expect(Object.keys(config.profiles)).toEqual(['valid']);
      expect(warnings).toContain(
        'Ignored router profile with an invalid name.',
      );
    },
  );

  it.each([
    'status',
    'profile',
    'usage',
    'settings',
    'help',
    'off',
    'pin',
    'thinking',
    'log',
    'widget',
    'reload',
    'disable',
    'fix',
    'debug',
    '?',
    'constructor',
  ])(
    'preserves explicit profile names even when they match command verbs: %s',
    (name) => {
      const { config, warnings } = normalizeConfig({
        profiles: { [name]: { medium: { model: 'test/primary' } } },
      });
      expect(Object.keys(config.profiles)).toEqual([name]);
      expect(warnings).toEqual([]);
    },
  );

  it.each([Infinity, -Infinity, NaN, 0, -1, '100'])(
    'does not accept invalid budgets or model capacities: %s',
    (value) => {
      const { config, warnings } = normalizeConfig({
        maxSessionBudget: value,
        models: {
          target: {
            model: 'test/primary',
            contextWindow: value,
            maxTokens: value,
          },
        },
        profiles: {
          valid: {
            medium: { model: 'target', contextWindow: value, maxTokens: value },
          },
        },
      });
      expect(config.maxSessionBudget).toBeUndefined();
      expect(config.models?.target?.contextWindow).toBeUndefined();
      expect(config.models?.target?.maxTokens).toBeUndefined();
      expect(config.profiles.valid?.medium?.contextWindow).toBeUndefined();
      expect(config.profiles.valid?.medium?.maxTokens).toBeUndefined();
      expect(config.profiles.valid?.medium?.resolvedContextWindow).toBe(128000);
      expect(config.profiles.valid?.medium?.resolvedMaxTokens).toBe(16384);
      expect(warnings).toContain('Invalid maxSessionBudget. Ignored.');
      expect(warnings).toContain(
        'Profile "valid" tier "medium" has invalid contextWindow. Ignored.',
      );
      expect(warnings).toContain(
        'Profile "valid" tier "medium" has invalid maxTokens. Ignored.',
      );
    },
  );

  it('rejects overflow numbers parsed from valid JSON', () => {
    const { config, warnings } = normalizeConfig(
      JSON.parse(
        '{"maxSessionBudget":1e999,"profiles":{"valid":{"medium":{"model":"test/primary","contextWindow":1e999,"maxTokens":1e999}}}}',
      ),
    );
    expect(config.maxSessionBudget).toBeUndefined();
    expect(config.profiles.valid?.medium?.resolvedContextWindow).toBe(128000);
    expect(config.profiles.valid?.medium?.resolvedMaxTokens).toBe(16384);
    expect(warnings.length).toBeGreaterThan(0);
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

    it.each([null, [], 'not-an-object'])(
      'keeps the base profile and warns when an override profile is invalid: %j',
      (value) => {
        const base: RouterConfig = {
          profiles: {
            balanced: {
              high: { model: 'openai/gpt-4o' },
              medium: { model: 'openai/gpt-4o-mini' },
            },
          },
        };
        const override = {
          profiles: { balanced: value },
        } as unknown as Partial<RouterConfig>;

        const warnings: string[] = [];
        const merged = mergeConfig(base, override, warnings);

        expect(
          (merged.profiles as Record<string, unknown> | undefined)?.balanced,
        ).toEqual(base.profiles.balanced);
        expect(warnings).toEqual([
          'Ignored invalid override for profile "balanced": expected an object. Keeping base profile.',
        ]);
      },
    );

    it('drops an invalid override profile with no base to keep, using neutral wording', () => {
      const warnings: string[] = [];
      const merged = mergeConfig(
        { profiles: {} },
        { profiles: { x: null } } as unknown as Partial<RouterConfig>,
        warnings,
      );
      expect((merged.profiles as Record<string, unknown> | undefined)?.x).toBe(
        undefined,
      );
      expect(warnings).toEqual([
        'Ignored invalid override for profile "x": expected an object.',
      ]);
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

    it('warns on a non-string fallback entry instead of dropping it silently', () => {
      const warnings: string[] = [];
      const raw = {
        model: 'gpt4',
        fallbacks: ['google/gemini-1.5-flash', { secret: 'leaked' }, 42, null],
      };
      const result = normalizeTierConfig(raw, 'p', 'high', warnings, models);
      expect(result?.fallbacks).toEqual(['google/gemini-1.5-flash']);
      expect(warnings).toHaveLength(3);
      for (const warning of warnings) {
        expect(warning).toContain('non-string fallback entry');
        expect(warning).not.toContain('leaked');
      }
    });

    it.each([
      ['a bare string', 'test/fallback'],
      ['an object', { secret: 'leaked' }],
    ])(
      'warns on a non-array fallbacks value (%s) instead of dropping it silently',
      (_label, fallbacks) => {
        const warnings: string[] = [];
        const result = normalizeTierConfig(
          { model: 'gpt4', fallbacks },
          'p',
          'high',
          warnings,
          models,
        );
        expect(result?.fallbacks).toBeUndefined();
        expect(warnings).toEqual([
          'Profile "p" high tier has invalid fallbacks; expected an array. Ignored.',
        ]);
        expect(JSON.stringify(warnings)).not.toContain('leaked');
      },
    );
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

    it('normalizes baselineTier and deprecates prompt-derived routing fields', () => {
      const raw = {
        debug: true,
        phaseBias: 0.8,
        maxSessionBudget: 5.5,
        rules: [{ matches: 'private-value', tier: 'high' }],
        profiles: {
          balanced: {
            baselineTier: 'high',
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
      expect(warnings).toEqual([
        'Deprecated router config field "phaseBias" ignored.',
        'Deprecated router config field "rules" ignored.',
      ]);
      expect(JSON.stringify(warnings)).not.toContain('private-value');
      expect(config.debug).toBe(true);
      expect(config.maxSessionBudget).toBe(5.5);
      expect(config.profiles.balanced?.baselineTier).toBe('high');
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

  it('accepts micro-only profiles and an explicit baseline tier', () => {
    const { config, warnings } = normalizeConfig({
      profiles: {
        p: {
          baselineTier: 'micro',
          micro: { model: 'test/tiny', thinking: 'minimal' },
        },
      },
    });
    expect(warnings).toEqual([]);
    expect(config.profiles.p?.baselineTier).toBe('micro');
    expect(config.profiles.p?.micro?.thinking).toBe('minimal');
    expect(isRouterTier('micro')).toBe(true);
  });

  it.each([undefined, 'high', 'unknown'])(
    'ignores a baseline tier that is not a configured valid tier: %s',
    (baselineTier) => {
      const { config, warnings } = normalizeConfig({
        profiles: {
          p: {
            ...(baselineTier === undefined ? {} : { baselineTier }),
            high: { model: 'test/high' },
          },
        },
      });
      if (baselineTier === undefined || baselineTier === 'high') {
        expect(config.profiles.p?.baselineTier).toBe(baselineTier);
        expect(warnings).toEqual([]);
      } else {
        expect(config.profiles.p?.baselineTier).toBeUndefined();
        expect(warnings).toEqual([
          'Profile "p" baselineTier must name a configured tier. Ignored.',
        ]);
      }
    },
  );
});

describe('classifier advisor config', () => {
  it('normalizes arbitrary provider classifier references and explicit profile approvals', () => {
    const { config, warnings } = normalizeConfig({
      advisor: {
        enabled: true,
        model: 'openai/gpt-6-luna',
        temperature: 1.3,
        maxRetries: 0,
      },
      profiles: {
        work: {
          advisor: { models: ['openai/gpt-6-luna', 'llama.cpp/julia-1'] },
          high: { model: 'test/high' },
        },
      },
    });
    expect(config.advisor).toMatchObject({
      model: 'openai/gpt-6-luna',
      enabled: true,
      temperature: 1.3,
      maxRetries: 0,
    });
    expect(config.profiles.work?.advisor?.models).toEqual([
      'openai/gpt-6-luna',
      'llama.cpp/julia-1',
    ]);
    expect(warnings).toEqual([]);
  });
  it('rejects malformed references and bounds retries without echoing values', () => {
    for (const raw of ['router/private', 'missing-slash', 'secret\nvalue']) {
      const result = normalizeConfig({
        advisor: { model: raw },
        profiles: { p: { high: { model: 'test/high' } } },
      });
      expect(result.config.advisor).toBeUndefined();
      expect(result.warnings).toEqual([
        'Ignored invalid advisor configuration. Configure a Pi classifier reference; credentials and endpoints belong to Pi.',
      ]);
      expect(JSON.stringify(result.warnings)).not.toContain(raw);
    }
    const result = normalizeConfig({
      advisor: { model: 'provider/model', maxRetries: 5 },
      profiles: { p: { high: { model: 'test/high' } } },
    });
    expect(result.config.advisor).toBeUndefined();
    expect(result.warnings).toEqual([
      'Ignored invalid advisor configuration. Configure a Pi classifier reference; credentials and endpoints belong to Pi.',
    ]);
  });
  it('never accepts project model selection, tuning or privacy approvals', () => {
    const base = {
      advisor: { model: 'typesafe/jev-latest', enabled: true },
      profiles: {
        work: {
          advisor: { models: ['typesafe/jev-latest'] },
          high: { model: 'test/high' },
        },
      },
    };
    const warnings: string[] = [];
    const merged = mergeConfig(
      base,
      stripProjectAdvisorConfig(
        {
          advisor: { model: 'attacker/steal', enabled: true },
          profiles: { work: { advisor: { models: ['attacker/steal'] } } },
        },
        warnings,
      ),
    );
    const { config } = normalizeConfig(merged);
    expect(config.advisor?.model).toBe('typesafe/jev-latest');
    expect(config.profiles.work?.advisor?.models).toEqual([
      'typesafe/jev-latest',
    ]);
  });
  it('requires canonical model references in explicit profile approvals', () => {
    const { config } = normalizeConfig({
      models: { local: { model: 'llama.cpp/julia-1' } },
      profiles: {
        work: {
          advisor: { models: ['local'] },
          medium: { model: 'test/model' },
        },
      },
    });
    expect(config.profiles.work?.advisor).toBeUndefined();
  });
});
