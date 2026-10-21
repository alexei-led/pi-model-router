import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODES,
  loadRouterConfig,
  normalizeConfig,
  projectRouterConfig,
} from './config';

const files = new Map<string, unknown>();
vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/agent',
}));
vi.mock('node:fs', () => ({
  existsSync: (path: string) => files.has(path),
  readFileSync: (path: string) => JSON.stringify(files.get(path)),
}));
const GLOBAL = '/agent/model-router.json';
const PROJECT = '/repo/.pi/model-router.json';
beforeEach(() => files.clear());

const tier = { model: 'test/model' };

describe('profile mode', () => {
  it.each(['cost', 'balanced', 'quality'] as const)('accepts %s', (mode) => {
    const { config, warnings } = normalizeConfig({
      profiles: { work: { mode, medium: tier } },
    });
    expect(config.profiles.work?.mode).toBe(mode);
    expect(warnings).toEqual([]);
  });

  it.each(['cheap', 1, null])(
    'ignores invalid mode %j with a warning',
    (mode) => {
      const { config, warnings } = normalizeConfig({
        profiles: { work: { mode, medium: tier } },
      });
      expect(config.profiles.work?.mode).toBeUndefined();
      expect(warnings).toEqual([
        'Profile "work" mode must be cost, balanced or quality. Ignored.',
      ]);
    },
  );
});

describe('mode policy patches', () => {
  it('defaults to the built-in untuned patches', () => {
    expect(normalizeConfig({}).config.modes).toEqual(DEFAULT_MODES);
    expect(DEFAULT_MODES).toEqual({
      cost: { policy: { costSensitivity: 0.8, escalationHoldTurns: 1 } },
      balanced: { policy: {} },
      quality: { policy: { costSensitivity: 0.2, escalationHoldTurns: 4 } },
    });
  });

  it('deep-merges user edits over the built-in patch', () => {
    const { config, warnings } = normalizeConfig({
      modes: {
        cost: { policy: { costSensitivity: 0.9, horizonRequests: 8 } },
        balanced: { policy: { escalationHoldTurns: 3 } },
      },
    });
    expect(config.modes?.cost.policy).toEqual({
      costSensitivity: 0.9,
      escalationHoldTurns: 1,
      horizonRequests: 8,
    });
    expect(config.modes?.balanced.policy).toEqual({ escalationHoldTurns: 3 });
    expect(config.modes?.quality).toEqual(DEFAULT_MODES.quality);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['unknown mode', { thrifty: { policy: {} } }],
    ['unknown policy key', { cost: { policy: { upgradeVotes: 3 } } }],
    ['out-of-range value', { cost: { policy: { costSensitivity: 2 } } }],
    ['non-object policy', { cost: { policy: 'cheap' } }],
    ['extra mode key', { cost: { policy: {}, floor: 'low' } }],
    ['non-object modes', 'cost'],
  ])('rejects %s and keeps the built-in patches', (_name, modes) => {
    const { config, warnings } = normalizeConfig({ modes });
    expect(config.modes).toEqual(DEFAULT_MODES);
    expect(warnings).toEqual(['Invalid modes; using built-in mode policies.']);
  });
});

describe('thinking floor at low and above', () => {
  it.each(['low', 'medium', 'high'] as const)(
    'disables %s with explicit off or minimal',
    (name) => {
      for (const thinking of ['off', 'minimal']) {
        const { config, warnings } = normalizeConfig({
          profiles: {
            work: { micro: tier, [name]: { ...tier, thinking } },
          },
        });
        expect(config.profiles.work?.[name]).toBeUndefined();
        expect(warnings).toEqual([
          `Profile "work" ${name} tier sets thinking ${thinking}; tiers at low and above need thinking. Tier disabled.`,
        ]);
      }
    },
  );

  it('disables an activity cell that inherits or sets off at low', () => {
    const { config, warnings } = normalizeConfig({
      profiles: {
        work: {
          medium: tier,
          activities: { code: { low: { ...tier, thinking: 'minimal' } } },
        },
      },
    });
    expect(config.profiles.work?.activities).toBeUndefined();
    expect(warnings).toContain(
      'Profile "work/code" low tier sets thinking minimal; tiers at low and above need thinking. Tier disabled.',
    );
  });

  it('keeps micro off and non-reasoning models at low', () => {
    const { config, warnings } = normalizeConfig({
      models: { plain: { model: 'test/plain', reasoning: false } },
      profiles: {
        work: {
          micro: { ...tier, thinking: 'off' },
          low: { model: 'plain' },
          medium: { model: 'plain', thinking: 'off' },
        },
      },
    });
    expect(config.profiles.work?.micro?.thinking).toBe('off');
    expect(config.profiles.work?.low).toMatchObject({
      model: 'test/plain',
      thinking: 'off',
    });
    expect(config.profiles.work?.medium?.thinking).toBe('off');
    expect(warnings).toEqual([]);
  });
});

describe('project file allowlist', () => {
  const project = {
    mode: 'cost',
    activityRouting: 'off',
    ui: { statusLine: 'detailed' },
    models: { fast: { model: 'test/fast' } },
    profiles: {
      work: {
        baselineTier: 'low',
        high: tier,
        medium: tier,
        low: { model: 'fast' },
        micro: tier,
        activities: { code: { medium: tier } },
      },
    },
  };

  it('keeps routes, display and mode', () => {
    const warnings: string[] = [];
    expect(projectRouterConfig(project, warnings)).toEqual(project);
    expect(warnings).toEqual([]);
  });

  it.each([
    ['switchPolicy', { switchPolicy: { costSensitivity: 0 } }],
    ['modes', { modes: { cost: { policy: {} } } }],
    ['maxSessionBudget', { maxSessionBudget: 1000 }],
    ['debug', { debug: true }],
    ['rules', { rules: [] }],
    ['phaseBias', { phaseBias: 1 }],
    ['an unknown key', { exfiltrate: 'secret-value' }],
    ['profile mode', { profiles: { work: { mode: 'quality' } } }],
    ['an unknown profile key', { profiles: { work: { budget: 1 } } }],
  ])('rejects %s without echoing values', (_name, raw: object) => {
    const warnings: string[] = [];
    const kept = projectRouterConfig(raw, warnings);
    expect(kept).toEqual('profiles' in raw ? { profiles: { work: {} } } : {});
    expect(warnings).toEqual([
      'Ignored project router settings: a project file may set only routes, display and mode.',
    ]);
    expect(JSON.stringify(warnings)).not.toContain('secret-value');
  });

  it('keeps the classifier warning for advisor keys', () => {
    const warnings: string[] = [];
    projectRouterConfig(
      { advisor: { enabled: true }, profiles: { work: { advisor: {} } } },
      warnings,
    );
    expect(warnings).toEqual([
      'Ignored project advisor settings: classifier selection, tuning and profile approvals belong only in user config.',
    ]);
  });

  it('cannot change user policy, budget or debug through the project file', () => {
    files.set(GLOBAL, {
      debug: false,
      maxSessionBudget: 5,
      switchPolicy: { costSensitivity: 0.5 },
      profiles: { work: { medium: tier } },
    });
    files.set(PROJECT, {
      debug: true,
      maxSessionBudget: 1000,
      switchPolicy: { costSensitivity: 0 },
      modes: { cost: { policy: { costSensitivity: 0 } } },
    });
    const { config } = loadRouterConfig('/repo');
    expect(config.debug).toBe(false);
    expect(config.maxSessionBudget).toBe(5);
    expect(config.switchPolicy?.costSensitivity).toBe(0.5);
    expect(config.modes).toEqual(DEFAULT_MODES);
  });

  it('reads the project mode separately from profile modes', () => {
    files.set(GLOBAL, { profiles: { work: { mode: 'cost', medium: tier } } });
    files.set(PROJECT, { mode: 'quality' });
    const { config, warnings } = loadRouterConfig('/repo');
    expect(config.projectMode).toBe('quality');
    expect(config.profiles.work?.mode).toBe('cost');
    expect(warnings).toEqual([]);
  });

  it('ignores an invalid project mode with a warning', () => {
    files.set(PROJECT, { mode: 'cheapest' });
    const { config, warnings } = loadRouterConfig('/repo');
    expect(config.projectMode).toBeUndefined();
    expect(warnings).toEqual([
      'Project mode must be cost, balanced or quality. Ignored.',
    ]);
  });

  it('ignores a top-level mode in user config', () => {
    files.set(GLOBAL, { mode: 'cost', profiles: { work: { medium: tier } } });
    const { config, warnings } = loadRouterConfig('/repo');
    expect(config.projectMode).toBeUndefined();
    expect(warnings).toEqual([
      'Ignored top-level mode in user config: set mode on each profile.',
    ]);
  });
});
