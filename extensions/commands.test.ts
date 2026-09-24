import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerCommands } from './commands';
import { normalizeConfig } from './config';
import { model } from './test/fixtures';
import type {
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
} from './types';

type CommandState = Parameters<typeof registerCommands>[1];
type MutableCommandState = {
  -readonly [Key in keyof CommandState]: CommandState[Key];
};

const buildMockPi = () => {
  let registered: Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
  return {
    registerCommand: (
      name: string,
      cmd: Parameters<ExtensionAPI['registerCommand']>[1],
    ) => {
      if (name === 'router') registered = cmd;
    },
    setModel: vi.fn().mockResolvedValue(true),
    command: () => {
      if (!registered?.getArgumentCompletions)
        throw new Error('Router command with completions was not registered');
      const complete = registered.getArgumentCompletions;
      return {
        ...registered,
        complete: (prefix: string) => {
          const completions = complete(prefix);
          if (completions instanceof Promise)
            throw new Error('Expected synchronous completions');
          return completions?.map((item) => item.value) ?? null;
        },
      };
    },
  };
};

const buildMockCtx = () => ({
  ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
  modelRegistry: {
    find: vi
      .fn()
      .mockImplementation((provider: string, modelId: string) =>
        provider === 'router' || provider === 'openai'
          ? model(modelId, { provider })
          : null,
      ),
  },
  model: { provider: 'router', id: 'balanced' },
});

const decision: RoutingDecision = {
  profile: 'balanced',
  tier: 'medium',
  phase: 'implementation',
  targetProvider: 'openai',
  targetModelId: 'gpt-4o-mini',
  targetLabel: 'openai/gpt-4o-mini',
  reasonCode: 'baseline',
  thinking: 'medium',
  timestamp: Date.now(),
};

const buildState = (): MutableCommandState => ({
  currentConfig: normalizeConfig({
    profiles: {
      balanced: {
        high: { model: 'openai/gpt-4o' },
        medium: { model: 'openai/gpt-4o-mini' },
        micro: { model: 'openai/tiny' },
      },
      cheap: { low: { model: 'openai/gpt-4o-micro' } },
    },
  }).config as RouterConfig,
  routerEnabled: true,
  selectedProfile: 'balanced',
  pinnedTierByProfile: {} as RouterPinByProfile,
  thinkingByProfile: {} as RouterThinkingByProfile,
  lastDecision: decision,
  lastNonRouterModel: 'openai/gpt-4o',
  accumulatedCost: 0.05,
  debugEnabled: false,
  widgetEnabled: false,
  debugHistory: [decision],
  lastConfigWarnings: [],
});

const setup = (mutate?: (state: MutableCommandState) => void) => {
  const pi = buildMockPi();
  const state = buildState();
  mutate?.(state);
  const actions = {
    persistState: vi.fn(),
    updateStatus: vi.fn(),
    reloadConfig: vi.fn(),
    ensureValidActiveRouterProfile: vi.fn(),
    switchToRouterProfile: vi.fn().mockResolvedValue(true),
    syncPiThinkingLevel: vi.fn(),
  };
  const ctx = buildMockCtx();
  registerCommands(pi as unknown as ExtensionAPI, state, actions);
  const cmd = pi.command();
  const run = (args: string) =>
    cmd.handler(args, ctx as unknown as ExtensionCommandContext);
  const lastNotice = () => ctx.ui.notify.mock.calls.at(-1) ?? [];
  return { pi, state, actions, ctx, cmd, run, lastNotice };
};

describe('/router surface', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'shows auto pin for unpinned prototype-like profile %s',
    async (profile) => {
      const s = setup((state) => {
        state.selectedProfile = profile;
        state.currentConfig = normalizeConfig({
          profiles: { [profile]: { medium: { model: 'openai/gpt-4o' } } },
        }).config;
      });
      s.ctx.model.id = profile;
      await s.run('pin');
      expect(s.lastNotice()[0]).toBe(`Pin: auto (profile ${profile})`);
      await s.run('pin low');
      await s.run('pin auto');
      await s.run('pin');
      expect(s.lastNotice()[0]).toBe(`Pin: auto (profile ${profile})`);
    },
  );

  it('offers exactly the eight verbs plus profile names at the top level', () => {
    const { cmd } = setup();
    expect(cmd.complete('')).toEqual([
      'balanced',
      'cheap',
      'pin',
      'thinking',
      'log',
      'widget',
      'off',
      'reload',
      'help',
    ]);
    expect(cmd.complete('p')).toEqual(['pin']);
    expect(cmd.complete('ch')).toEqual(['cheap']);
  });

  it('completes verb arguments without retired forms', () => {
    const { cmd } = setup();
    expect(cmd.complete('pin ')).toEqual([
      'pin auto',
      'pin high',
      'pin medium',
      'pin low',
      'pin micro',
    ]);
    expect(cmd.complete('pin mi')).toEqual(['pin micro']);
    expect(cmd.complete('thinking ')).toContain('thinking auto');
    expect(cmd.complete('thinking ')).toContain('thinking max');
    expect(cmd.complete('thinking high ')).toBeNull();
    expect(cmd.complete('log ')).toEqual(['log on', 'log off', 'log clear']);
    expect(cmd.complete('widget ')).toBeNull();
    expect(cmd.complete('debug ')).toBeNull();
    expect(cmd.complete('profile ')).toBeNull();
  });

  it.each([
    ['status', '/router'],
    ['profile balanced', '/router <profile>'],
    ['disable', '/router off'],
    ['fix high', '/router pin <tier>'],
    ['debug show', '/router log'],
    ['?', '/router help'],
  ])(
    'answers retired verb %s with its replacement and does nothing',
    async (args, replacement) => {
      const { run, lastNotice, state, actions } = setup();
      await run(args);
      expect(lastNotice()[0]).toContain(`use ${replacement}`);
      expect(lastNotice()[1]).toBe('error');
      expect(state.pinnedTierByProfile).toEqual({});
      expect(actions.switchToRouterProfile).not.toHaveBeenCalled();
      expect(actions.persistState).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown verbs and points at help', async () => {
    const { run, lastNotice } = setup();
    await run('bogus');
    expect(lastNotice()[0]).toContain('Unknown router command: bogus');
    expect(lastNotice()[0]).toContain('/router help');
  });

  it('prints usage for help and for verbs given extra arguments', async () => {
    const { run, lastNotice } = setup();
    await run('help');
    const [text, level] = lastNotice();
    expect(level).toBe('info');
    for (const verb of ['pin', 'thinking', 'log', 'widget', 'off', 'reload'])
      expect(text).toContain(`/router ${verb}`);
    expect(text).not.toContain('debug');
    expect(text).not.toContain('fix');
    for (const args of ['help x', 'widget on', 'off now', 'reload all'])
      await run(args).then(() => expect(lastNotice()[1]).toBe('error'));
  });
});

describe('/router status', () => {
  it('summarizes profile, pin, thinking, cost, Jev and the last decision', async () => {
    const { run, lastNotice, state } = setup((s) => {
      s.currentConfig.maxSessionBudget = 10;
      s.pinnedTierByProfile.balanced = 'high';
      s.lastConfigWarnings = ['Warning 1'];
    });
    await run('');
    const [text, level] = lastNotice();
    expect(level).toBe('info');
    expect(text).toContain(
      'Router: on · profile balanced · available: balanced, cheap',
    );
    expect(text).toContain('Pin: balanced:high');
    expect(text).toContain('$0.0500 / $10.00');
    expect(text).toContain('Jev: not configured');
    expect(text).toContain('Last: medium → openai/gpt-4o-mini (medium)');
    expect(text).toContain('⚠️ Configuration warnings:');
    expect(text).toContain('Warning 1');
    state.lastDecision = undefined;
    await run('');
    expect(lastNotice()[0]).not.toContain('Last:');
  });

  it('shows Jev settings when configured', async () => {
    const { run, lastNotice } = setup((s) => {
      s.currentConfig = normalizeConfig({
        jev: { enabled: true, apiKey: 'synthetic', timeoutMs: 3000 },
        profiles: {
          balanced: {
            jev: { enabled: true },
            high: { model: 'openai/gpt-4o' },
          },
        },
      }).config;
    });
    await run('');
    expect(lastNotice()[0]).toContain(
      'Jev: enabled · profile opt-in: yes · budget 3000ms · context 2 turns',
    );
    expect(lastNotice()[0]).not.toContain('synthetic');
  });
});

describe('/router <profile> and off', () => {
  it('switches to a configured profile and reports the result', async () => {
    const { run, actions, ctx, lastNotice } = setup();
    await run('cheap');
    expect(actions.switchToRouterProfile).toHaveBeenCalledWith('cheap', ctx);
    expect(lastNotice()[0]).toContain('Router profile: balanced');
  });

  it('does not report success when the switch fails', async () => {
    const { run, actions, ctx } = setup();
    actions.switchToRouterProfile.mockResolvedValueOnce(false);
    await run('cheap');
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it('restores the previous non-router model on off', async () => {
    const { run, pi, state, actions, lastNotice } = setup();
    await run('off');
    expect(pi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'gpt-4o', provider: 'openai' }),
    );
    expect(state.routerEnabled).toBe(false);
    expect(actions.persistState).toHaveBeenCalled();
    expect(lastNotice()[0]).toContain('Router off. Restored openai/gpt-4o');
  });

  it.each([
    [
      'no recorded model',
      (s: MutableCommandState) => {
        s.lastNonRouterModel = undefined;
      },
      'warning',
    ],
    [
      'unavailable model',
      (s: MutableCommandState) => {
        s.lastNonRouterModel = 'missing/model';
      },
      'error',
    ],
  ])(
    'keeps the router on when off cannot restore (%s)',
    async (_label, mutate, level) => {
      const { run, state, pi, lastNotice } = setup(mutate);
      await run('off');
      expect(pi.setModel).not.toHaveBeenCalled();
      expect(state.routerEnabled).toBe(true);
      expect(lastNotice()[1]).toBe(level);
    },
  );

  it('keeps the router on when Pi refuses the model switch', async () => {
    const { run, state, pi, lastNotice } = setup();
    pi.setModel.mockResolvedValueOnce(false);
    await run('off');
    expect(state.routerEnabled).toBe(true);
    expect(lastNotice()[1]).toBe('error');
  });
});

describe('/router pin', () => {
  it('pins, shows and clears the active profile pin', async () => {
    const { run, state, actions, lastNotice } = setup();
    await run('pin');
    expect(lastNotice()[0]).toBe('Pin: auto (profile balanced)');
    await run('pin MICRO');
    expect(state.pinnedTierByProfile.balanced).toBe('micro');
    expect(lastNotice()[0]).toBe('Router pinned to micro');
    await run('pin');
    expect(lastNotice()[0]).toBe('Pin: micro (profile balanced)');
    await run('pin auto');
    expect(state.pinnedTierByProfile.balanced).toBeUndefined();
    expect(lastNotice()[0]).toContain('pin cleared');
    expect(actions.persistState).toHaveBeenCalledTimes(2);
    expect(actions.updateStatus).toHaveBeenCalledTimes(2);
  });

  it.each(['pin ultra', 'pin high medium'])(
    'rejects %s with usage and no state change',
    async (args) => {
      const { run, state, actions, lastNotice } = setup();
      await run(args);
      expect(lastNotice()).toEqual([
        'Usage: /router pin <auto|high|medium|low|micro>',
        'error',
      ]);
      expect(state.pinnedTierByProfile).toEqual({});
      expect(actions.persistState).not.toHaveBeenCalled();
    },
  );

  it('requires an active profile', async () => {
    const { run, lastNotice } = setup((s) => {
      s.selectedProfile = undefined;
    });
    await run('pin high');
    expect(lastNotice()[0]).toContain('No router profile is active');
    expect(lastNotice()[1]).toBe('error');
  });
});

describe('/router thinking', () => {
  it('applies one level to every tier, syncs Pi, and clears with auto', async () => {
    const { run, state, actions, lastNotice } = setup();
    await run('thinking');
    expect(lastNotice()[0]).toContain('Thinking override: none');
    await run('thinking high');
    expect(state.thinkingByProfile.balanced).toEqual({
      high: 'high',
      medium: 'high',
      low: 'high',
      micro: 'high',
    });
    expect(actions.syncPiThinkingLevel).toHaveBeenLastCalledWith('high');
    expect(lastNotice()[0]).toContain('Router thinking set to high');
    await run('thinking auto');
    expect(state.thinkingByProfile.balanced).toBeUndefined();
    expect(actions.syncPiThinkingLevel).toHaveBeenLastCalledWith('medium');
    expect(lastNotice()).toEqual(['Router thinking override cleared', 'info']);
  });

  it.each(['max', 'minimal'])(
    'rejects %s when the profile has no eligible route, without mutating state',
    async (level) => {
      const { run, state, actions, ctx, lastNotice } = setup((s) => {
        s.thinkingByProfile.balanced = { high: 'high' };
      });
      // No model resolves at all, so every tier is ineligible regardless of
      // the requested level (clamping only saves a route that has a live
      // model to clamp against).
      ctx.modelRegistry.find.mockReturnValue(undefined);
      await run(`thinking ${level}`);
      expect(state.thinkingByProfile.balanced).toEqual({ high: 'high' });
      expect(actions.persistState).not.toHaveBeenCalled();
      expect(actions.syncPiThinkingLevel).not.toHaveBeenCalled();
      expect(lastNotice()[0]).toContain('leaves no eligible route');
      expect(lastNotice()[1]).toBe('warning');
    },
  );

  it.each(['max', 'minimal'])(
    'accepts %s by clamping to the nearest level each live model supports',
    async (level) => {
      const { run, state, actions, ctx } = setup((s) => {
        s.thinkingByProfile.balanced = { high: 'high' };
      });
      ctx.modelRegistry.find.mockImplementation((provider, id) =>
        model(id, { provider, thinkingLevelMap: { max: null, minimal: null } }),
      );
      await run(`thinking ${level}`);
      expect(state.thinkingByProfile.balanced).toEqual({
        high: level,
        medium: level,
        low: level,
        micro: level,
      });
      expect(actions.persistState).toHaveBeenCalledOnce();
      expect(actions.syncPiThinkingLevel).toHaveBeenLastCalledWith(level);
    },
  );

  it('warns about tiers that may skip an unsupported level but still applies it', async () => {
    const { run, state, ctx, lastNotice } = setup((s) => {
      s.currentConfig.profiles.balanced = {
        high: { model: 'openai/gpt-4o', thinkingLevels: ['max'] },
        medium: { model: 'openai/gpt-4o-mini', thinkingLevels: ['off'] },
      };
    });
    ctx.modelRegistry.find.mockImplementation((provider, id) =>
      model(id, { provider, thinkingLevelMap: { max: 'max', off: null } }),
    );
    await run('thinking max');
    expect(state.thinkingByProfile.balanced?.high).toBe('max');
    expect(lastNotice()[0]).toContain(
      'medium may not support it and will run at the nearest supported level',
    );
    expect(lastNotice()[1]).toBe('warning');
  });

  it.each(['thinking high max', 'thinking ultra'])(
    'rejects the retired per-tier form and unknown levels: %s',
    async (args) => {
      const { run, state, lastNotice } = setup();
      await run(args);
      expect(lastNotice()[0]).toMatch(/^Usage: \/router thinking <auto\|/);
      expect(lastNotice()[1]).toBe('error');
      expect(state.thinkingByProfile).toEqual({});
    },
  );
});

describe('/router log', () => {
  it('shows stats and history, and reports collection state', async () => {
    const { run, lastNotice, state } = setup();
    await run('log');
    const [text, level] = lastNotice();
    expect(level).toBe('info');
    expect(text).toContain('Log: off; /router log on collects new decisions');
    expect(text).toContain('Recent decisions:');
    expect(text).toContain('gpt-4o-mini');
    state.debugHistory.length = 0;
    state.debugEnabled = true;
    await run('log');
    expect(lastNotice()[0]).toContain('Log: on');
    expect(lastNotice()[0]).toContain('No recent routing decisions.');
  });

  it('turns collection on and off and clears history', async () => {
    const { run, state, actions, lastNotice } = setup();
    await run('log on');
    expect(state.debugEnabled).toBe(true);
    expect(lastNotice()).toEqual(['Router log on', 'info']);
    await run('log clear');
    expect(state.debugHistory).toEqual([]);
    expect(state.debugEnabled).toBe(true);
    await run('log off');
    expect(state.debugEnabled).toBe(false);
    expect(actions.persistState).toHaveBeenCalledTimes(3);
  });

  it.each(['log show', 'log stats', 'log toggle', 'log on off'])(
    'rejects %s with usage',
    async (args) => {
      const { run, lastNotice, state } = setup();
      await run(args);
      expect(lastNotice()).toEqual([
        'Usage: /router log [on|off|clear]',
        'error',
      ]);
      expect(state.debugEnabled).toBe(false);
    },
  );
});

describe('/router widget and reload', () => {
  it('toggles the widget on each call', async () => {
    const { run, state, actions, lastNotice } = setup();
    await run('widget');
    expect(state.widgetEnabled).toBe(true);
    expect(lastNotice()).toEqual(['Router widget on', 'info']);
    await run('widget');
    expect(state.widgetEnabled).toBe(false);
    expect(actions.updateStatus).toHaveBeenCalledTimes(2);
  });

  it('reloads config, revalidates the profile and lists profiles', async () => {
    const { run, actions, ctx, lastNotice } = setup();
    await run('reload');
    expect(actions.reloadConfig).toHaveBeenCalledWith(ctx, {
      preserveDebug: true,
    });
    expect(actions.ensureValidActiveRouterProfile).toHaveBeenCalledWith(ctx);
    expect(lastNotice()[0]).toContain('Profiles: balanced, cheap');
  });
});
