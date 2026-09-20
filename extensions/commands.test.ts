import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerCommands } from './commands';
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

describe('commands.ts', () => {
  const buildMockPi = () => {
    let registeredCommand:
      | Parameters<ExtensionAPI['registerCommand']>[1]
      | undefined;
    return {
      registerCommand: (
        name: string,
        cmd: Parameters<ExtensionAPI['registerCommand']>[1],
      ) => {
        if (name === 'router') {
          registeredCommand = cmd;
        }
      },
      setModel: vi.fn().mockResolvedValue(true),
      getRegisteredCommand: () => {
        if (!registeredCommand?.getArgumentCompletions) {
          throw new Error('Router command with completions was not registered');
        }
        const complete = registeredCommand.getArgumentCompletions;
        return {
          ...registeredCommand,
          getArgumentCompletions: (prefix: string) => {
            const completions = complete(prefix);
            if (completions instanceof Promise)
              throw new Error('Expected synchronous completions');
            return completions;
          },
        };
      },
    };
  };

  const buildMockCtx = () => ({
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    modelRegistry: {
      find: vi.fn().mockImplementation((provider: string, modelId: string) => {
        if (provider === 'router' || provider === 'openai') {
          return { provider, id: modelId };
        }
        return null;
      }),
    },
    model: { provider: 'router', id: 'balanced' },
  });

  const buildDefaultState = (): MutableCommandState => {
    const config: RouterConfig = {
      phaseBias: 0.5,
      profiles: {
        balanced: {
          high: { model: 'openai/gpt-4o' },
          medium: { model: 'openai/gpt-4o-mini' },
        },
        cheap: {
          low: { model: 'openai/gpt-4o-micro' },
        },
      },
    };

    const lastDecision: RoutingDecision = {
      profile: 'balanced',
      tier: 'medium',
      phase: 'implementation',
      targetProvider: 'openai',
      targetModelId: 'gpt-4o-mini',
      targetLabel: 'openai/gpt-4o-mini',
      reasoning: 'Default reasoning',
      thinking: 'medium',
      timestamp: Date.now(),
    };

    return {
      currentConfig: config,
      routerEnabled: true,
      selectedProfile: 'balanced',
      pinnedTierByProfile: {} as RouterPinByProfile,
      thinkingByProfile: {} as RouterThinkingByProfile,
      lastDecision,
      lastNonRouterModel: 'openai/gpt-4o',
      accumulatedCost: 0.05,
      debugEnabled: false,
      widgetEnabled: false,
      debugHistory: [lastDecision],
      lastConfigWarnings: [],
    };
  };

  const buildMockActions = () => ({
    persistState: vi.fn(),
    updateStatus: vi.fn(),
    reloadConfig: vi.fn(),
    ensureValidActiveRouterProfile: vi.fn(),
    switchToRouterProfile: vi.fn().mockResolvedValue(true),
    syncPiThinkingLevel: vi.fn(),
  });

  const setup = () => {
    const pi = buildMockPi();
    const state = buildDefaultState();
    const actions = buildMockActions();
    const ctx = buildMockCtx();
    registerCommands(pi as unknown as ExtensionAPI, state, actions);
    return { pi, state, actions, ctx, cmd: pi.getRegisteredCommand() };
  };

  describe('Registration & Subcommand Completion', () => {
    it('register router command', () => {
      const { pi } = setup();
      expect(pi.getRegisteredCommand()).toBeDefined();
    });

    it('autocomplete subcommands', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('');
      expect(completions).toBeDefined();
      const names = completions?.map((c) => c.value);
      expect(names).toContain('status');
      expect(names).toContain('profile');
      expect(names).toContain('pin');
    });

    it('autocomplete profile names', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('profile ');
      expect(completions).toBeDefined();
      const values = completions?.map((c) => c.value);
      expect(values).toContain('profile balanced');
      expect(values).toContain('profile cheap');
    });

    it('autocomplete pin arguments', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('pin ');
      expect(completions).toBeDefined();
      const values = completions?.map((c) => c.value);
      expect(values).toContain('pin auto');
      expect(values).toContain('pin high');
      expect(values).not.toContain('pin balanced');
    });
  });

  describe('Handler Subcommands', () => {
    it('handle /router status', async () => {
      const { actions, ctx, cmd } = setup();

      await cmd.handler('status', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalled();
      const notifyMessage = ctx.ui.notify.mock.calls[0]?.[0] ?? '';
      expect(notifyMessage).toContain('Model Router Status:');
      expect(notifyMessage).toContain('Selected profile: balanced');
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('handle /router profile switch', async () => {
      const { actions, ctx, cmd } = setup();

      await cmd.handler(
        'profile cheap',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(actions.switchToRouterProfile).toHaveBeenCalledWith('cheap', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Switched to router profile'),
        'info',
      );
    });

    it('handle /router pin', async () => {
      const { state, actions, ctx, cmd } = setup();

      await cmd.handler('pin high', ctx as unknown as ExtensionCommandContext);
      expect(state.pinnedTierByProfile.balanced).toBe('high');
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Router pinned to high',
        'info',
      );

      await cmd.handler('pin auto', ctx as unknown as ExtensionCommandContext);
      expect(state.pinnedTierByProfile.balanced).toBeUndefined();
    });

    it('handle /router thinking', async () => {
      const { state, actions, ctx, cmd } = setup();

      await cmd.handler(
        'thinking high xhigh',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(state.thinkingByProfile.balanced?.high).toBe('xhigh');
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('handle /router disable', async () => {
      const { pi, state, actions, ctx, cmd } = setup();

      await cmd.handler('disable', ctx as unknown as ExtensionCommandContext);
      expect(pi.setModel).toHaveBeenCalledWith({
        provider: 'openai',
        id: 'gpt-4o',
      });
      expect(state.routerEnabled).toBe(false);
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('handle /router fix', async () => {
      const { state, actions, ctx, cmd } = setup();

      await cmd.handler('fix low', ctx as unknown as ExtensionCommandContext);
      expect(state.pinnedTierByProfile.balanced).toBe('low');
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('handle /router widget toggles', async () => {
      const { state, ctx, cmd } = setup();

      await cmd.handler('widget on', ctx as unknown as ExtensionCommandContext);
      expect(state.widgetEnabled).toBe(true);

      await cmd.handler(
        'widget off',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(state.widgetEnabled).toBe(false);
    });

    it('handle /router debug history control', async () => {
      const { state, ctx, cmd } = setup();

      await cmd.handler(
        'debug show',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Recent Routing Decisions'),
        'info',
      );

      await cmd.handler(
        'debug clear',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(state.debugHistory.length).toBe(0);
    });

    it('handle /router reload config', async () => {
      const { actions, ctx, cmd } = setup();

      await cmd.handler('reload', ctx as unknown as ExtensionCommandContext);
      expect(actions.reloadConfig).toHaveBeenCalledWith(ctx, {
        preserveDebug: true,
      });
      expect(actions.ensureValidActiveRouterProfile).toHaveBeenCalledWith(ctx);
    });
  });

  describe('handleStatus edge cases', () => {
    it('show error when status has extra args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'status extra',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router status (no arguments)',
        'error',
      );
    });

    it('handle status without lastDecision', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastDecision = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('status', ctx as unknown as ExtensionCommandContext);
      const notifyMessage = ctx.ui.notify.mock.calls[0]?.[0] ?? '';
      expect(notifyMessage).toContain('Model Router Status:');
      expect(notifyMessage).not.toContain('Last routed tier:');
    });

    it('show config warnings in status', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastConfigWarnings = ['Warning 1', 'Warning 2'];
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('status', ctx as unknown as ExtensionCommandContext);
      const notifyMessage = ctx.ui.notify.mock.calls[0]?.[0] ?? '';
      expect(notifyMessage).toContain('⚠️ Configuration Warnings:');
      expect(notifyMessage).toContain('Warning 1');
      expect(notifyMessage).toContain('Warning 2');
    });

    it('show maxSessionBudget in status', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.currentConfig.maxSessionBudget = 10.0;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('status', ctx as unknown as ExtensionCommandContext);
      const notifyMessage = ctx.ui.notify.mock.calls[0]?.[0] ?? '';
      expect(notifyMessage).toContain('$10.00');
    });
  });

  describe('handleProfile edge cases', () => {
    it('show current profile when no argument given', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler('profile', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Current profile: balanced'),
        'info',
      );
    });

    it('show error when profile has too many arguments', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'profile one two',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router profile [name]',
        'error',
      );
    });

    it('not notify on profile switch failure', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      actions.switchToRouterProfile.mockResolvedValue(false);
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler(
        'profile nonexistent',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(actions.switchToRouterProfile).toHaveBeenCalledWith(
        'nonexistent',
        ctx,
      );
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(
        expect.stringContaining('Switched to router profile'),
        'info',
      );
    });
  });

  describe('handlePin edge cases', () => {
    it('show error when no active profile', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.selectedProfile = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('pin high', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'No router profile is active. Select a router model first.',
        'error',
      );
    });

    it('show current pin when no arguments', async () => {
      const { actions, ctx, cmd } = setup();

      await cmd.handler('pin', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Pinned tier: auto'),
        'info',
      );
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('show error when pin has too many arguments', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'pin high extra',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router pin <high|medium|low|auto>',
        'error',
      );
    });

    it('show error when pin value is invalid', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'pin invalid',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid router pin: invalid'),
        'error',
      );
    });
  });

  describe('handleThinking branches', () => {
    it('show error when no active profile', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.selectedProfile = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler(
        'thinking high',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'No router profile is active. Select a router model first.',
        'error',
      );
    });

    it('show current thinking when no arguments', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler('thinking', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Thinking overrides:'),
        'info',
      );
    });

    it('show error with too many arguments', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'thinking high medium low',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Too many arguments for /router thinking.',
        'error',
      );
    });

    it('show error with invalid tier', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'thinking badtier high',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid tier: badtier'),
        'error',
      );
    });

    it('show error with invalid level', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'thinking badlevel',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Invalid thinking level: badlevel'),
        'error',
      );
    });

    it('apply auto to all tiers and clear overrides', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.thinkingByProfile.balanced = { high: 'xhigh', medium: 'medium' };
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler(
        'thinking auto',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(state.thinkingByProfile.balanced).toBeUndefined();
      expect(actions.persistState).toHaveBeenCalled();
      expect(actions.updateStatus).toHaveBeenCalledWith(ctx);
    });

    it('apply thinking level to specific tier', async () => {
      const { state, actions, ctx, cmd } = setup();

      await cmd.handler(
        'thinking low minimal',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(state.thinkingByProfile.balanced?.low).toBe('minimal');
      expect(actions.persistState).toHaveBeenCalled();
    });

    it('clear specific tier with auto', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.thinkingByProfile.balanced = { high: 'xhigh' };
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler(
        'thinking high auto',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(state.thinkingByProfile.balanced).toBeUndefined();
      expect(actions.persistState).toHaveBeenCalled();
    });

    it('sync pi thinking level when setting a level', async () => {
      const { actions, ctx, cmd } = setup();

      await cmd.handler(
        'thinking high',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(actions.syncPiThinkingLevel).toHaveBeenCalledWith('high');
    });

    it('restore last decision thinking when setting auto', async () => {
      const { actions, ctx, cmd } = setup();

      await cmd.handler(
        'thinking auto',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(actions.syncPiThinkingLevel).toHaveBeenCalledWith('medium');
    });

    it('warn about unsupported tiers', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.currentConfig.profiles.balanced = {
        high: {
          model: 'openai/gpt-4o',
          resolvedThinkingLevels: ['high', 'medium', 'low'],
        },
        medium: {
          model: 'openai/gpt-4o-mini',
          resolvedThinkingLevels: ['high', 'medium', 'low'],
        },
      };
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler(
        'thinking xhigh',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("may not support 'xhigh'"),
        'warning',
      );
    });

    it('not warn for off level', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.currentConfig.profiles.balanced = {
        high: {
          model: 'openai/gpt-4o',
          resolvedThinkingLevels: ['high', 'medium'],
        },
      };
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler(
        'thinking off',
        ctx as unknown as ExtensionCommandContext,
      );
      const warnCalls = ctx.ui.notify.mock.calls.filter(
        (c: unknown[]) => c[1] === 'warning',
      );
      expect(warnCalls.length).toBe(0);
    });

    it('accept "all" as explicit tier arg', async () => {
      const { state, actions, ctx, cmd } = setup();

      await cmd.handler(
        'thinking all high',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(state.thinkingByProfile.balanced?.high).toBe('high');
      expect(state.thinkingByProfile.balanced?.medium).toBe('high');
      expect(state.thinkingByProfile.balanced?.low).toBe('high');
      expect(actions.persistState).toHaveBeenCalled();
    });
  });

  describe('handleDisable edge cases', () => {
    it('show error with extra args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'disable extra',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router disable (no arguments)',
        'error',
      );
    });

    it('warn when no lastNonRouterModel', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastNonRouterModel = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('disable', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('No previous non-router model recorded'),
        'warning',
      );
    });

    it('show error when model not found in registry', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastNonRouterModel = 'unknown/model-x';
      const actions = buildMockActions();
      const ctx = buildMockCtx();
      ctx.modelRegistry.find.mockReturnValue(null);

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('disable', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Recorded non-router model is unavailable'),
        'error',
      );
    });

    it('show error when setModel fails', async () => {
      const pi = buildMockPi();
      pi.setModel.mockResolvedValue(false);
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('disable', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Failed to switch to'),
        'error',
      );
      expect(state.routerEnabled).toBe(true);
    });
  });

  describe('handleFix edge cases', () => {
    it('show error with wrong number of args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler('fix', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router fix <high|medium|low>',
        'error',
      );
    });

    it('show error with too many args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'fix high extra',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router fix <high|medium|low>',
        'error',
      );
    });

    it('show error with invalid tier', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'fix badtier',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router fix <high|medium|low>',
        'error',
      );
    });

    it('warn when no last decision', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.lastDecision = undefined;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('fix high', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'No recent routing decision to fix.',
        'warning',
      );
    });
  });

  it.each(['widget', 'debug'])(
    'rejects unknown %s options without changing state',
    async (subcommand) => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      const actions = buildMockActions();
      const ctx = buildMockCtx();
      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      await pi
        .getRegisteredCommand()
        .handler(
          `${subcommand} typo`,
          ctx as unknown as ExtensionCommandContext,
        );
      expect(state).toMatchObject({
        widgetEnabled: false,
        debugEnabled: false,
      });
      expect(actions.persistState).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Usage:'),
        'error',
      );
    },
  );

  it('does not report success when the profile shorthand switch fails', async () => {
    const pi = buildMockPi();
    const state = buildDefaultState();
    const actions = buildMockActions();
    const ctx = buildMockCtx();
    actions.switchToRouterProfile.mockResolvedValue(false);
    registerCommands(pi as unknown as ExtensionAPI, state, actions);
    await pi
      .getRegisteredCommand()
      .handler('balanced', ctx as unknown as ExtensionCommandContext);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  describe('handleWidget edge cases', () => {
    it('show error with too many args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'widget on extra',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router widget <on|off|toggle>',
        'error',
      );
    });

    it('toggle widget when no arg given', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.widgetEnabled = false;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('widget', ctx as unknown as ExtensionCommandContext);
      expect(state.widgetEnabled).toBe(true);
      expect(actions.persistState).toHaveBeenCalled();

      await cmd.handler('widget', ctx as unknown as ExtensionCommandContext);
      expect(state.widgetEnabled).toBe(false);
    });
  });

  describe('handleDebug edge cases', () => {
    it('enable debug explicitly', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.debugEnabled = false;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug on', ctx as unknown as ExtensionCommandContext);
      expect(state.debugEnabled).toBe(true);
      expect(actions.persistState).toHaveBeenCalled();
    });

    it('disable debug explicitly', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.debugEnabled = true;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug off', ctx as unknown as ExtensionCommandContext);
      expect(state.debugEnabled).toBe(false);
      expect(actions.persistState).toHaveBeenCalled();
    });

    it('toggle debug when no arg given', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.debugEnabled = false;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler('debug', ctx as unknown as ExtensionCommandContext);
      expect(state.debugEnabled).toBe(true);

      await cmd.handler('debug', ctx as unknown as ExtensionCommandContext);
      expect(state.debugEnabled).toBe(false);
    });

    it('show message when debug history is empty', async () => {
      const pi = buildMockPi();
      const state = buildDefaultState();
      state.debugHistory.length = 0;
      const actions = buildMockActions();
      const ctx = buildMockCtx();

      registerCommands(pi as unknown as ExtensionAPI, state, actions);
      const cmd = pi.getRegisteredCommand();

      await cmd.handler(
        'debug show',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'No recent routing decisions.',
        'info',
      );
    });

    it('show error with too many args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'debug on extra',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router debug <on|off|show|clear>',
        'error',
      );
    });
  });

  describe('handleReload edge cases', () => {
    it('show error with extra args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'reload extra',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router reload (no arguments)',
        'error',
      );
    });
  });

  describe('Autocomplete completions', () => {
    it('return thinking completions for first arg', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('thinking ');
      expect(completions).toBeDefined();
      const values = completions?.map((c) => c.value);
      expect(values).toContain('thinking auto');
      expect(values).toContain('thinking high');
    });

    it('completes the level after a tier that is also a thinking level', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('thinking high a');
      expect(completions?.map((c) => c.value)).toEqual(['thinking high auto']);
    });

    it('return null for thinking completions after level arg', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('thinking auto ');
      expect(completions).toBeNull();
    });

    it('return fix completions', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('fix ');
      expect(completions).toBeDefined();
      const values = completions?.map((c) => c.value);
      expect(values).toContain('fix high');
      expect(values).toContain('fix medium');
      expect(values).toContain('fix low');
    });

    it('return widget completions', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('widget ');
      expect(completions).toBeDefined();
      const values = completions?.map((c) => c.value);
      expect(values).toContain('widget on');
      expect(values).toContain('widget off');
      expect(values).toContain('widget toggle');
    });

    it('return debug completions', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('debug ');
      expect(completions).toBeDefined();
      const values = completions?.map((c) => c.value);
      expect(values).toContain('debug on');
      expect(values).toContain('debug off');
      expect(values).toContain('debug show');
      expect(values).toContain('debug clear');
    });

    it('return null for unknown subcommand completions', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('unknown ');
      expect(completions).toBeNull();
    });

    it('filter subcommand completions by prefix', () => {
      const { cmd } = setup();

      const completions = cmd.getArgumentCompletions('st');
      expect(completions).toBeDefined();
      const values = completions?.map((c) => c.value);
      expect(values).toContain('status');
      expect(values).not.toContain('profile');
    });
  });

  describe('Default handler branch', () => {
    it('show error for unknown subcommand', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'nonexistent',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Unknown router subcommand: nonexistent'),
        'error',
      );
    });

    it('treat profile name as subcommand (backward compat)', async () => {
      const { actions, ctx, cmd } = setup();

      await cmd.handler('cheap', ctx as unknown as ExtensionCommandContext);
      expect(actions.switchToRouterProfile).toHaveBeenCalledWith('cheap', ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Router enabled with profile'),
        'info',
      );
    });

    it('show error when profile name has extra args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'balanced extra',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('no extra arguments allowed'),
        'error',
      );
    });

    it('fall through to status on empty args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler('', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Model Router Status:'),
        'info',
      );
    });

    it('show help with /router help', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler('help', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Router Subcommands:'),
        'info',
      );
    });

    it('show help with /router ?', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler('?', ctx as unknown as ExtensionCommandContext);
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Router Subcommands:'),
        'info',
      );
    });

    it('show error when help has extra args', async () => {
      const { ctx, cmd } = setup();

      await cmd.handler(
        'help extra',
        ctx as unknown as ExtensionCommandContext,
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Usage: /router help (no arguments)',
        'error',
      );
    });
  });
});
