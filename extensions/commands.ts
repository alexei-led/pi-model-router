import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import {
  getUnsupportedTiers,
  isRouterPinValue,
  isRouterTier,
  isThinkingLevel,
  parseCanonicalModelRef,
  profileNames,
  ROUTER_PIN_VALUES,
  ROUTER_TIERS,
  THINKING_LEVELS,
} from './config';
import type {
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RouterTier,
  RoutingDecision,
} from './types';
import {
  formatDecision,
  formatModelRef,
  formatPinSummary,
  formatThinkingSummary,
} from './ui';

export const registerCommands = (
  pi: ExtensionAPI,
  state: {
    readonly currentConfig: RouterConfig;
    routerEnabled: boolean;
    selectedProfile: string | undefined;
    readonly pinnedTierByProfile: RouterPinByProfile;
    readonly thinkingByProfile: RouterThinkingByProfile;
    readonly lastDecision: RoutingDecision | undefined;
    lastNonRouterModel: string | undefined;
    readonly accumulatedCost: number;
    debugEnabled: boolean;
    widgetEnabled: boolean;
    readonly debugHistory: RoutingDecision[];
    readonly lastConfigWarnings: string[];
  },
  actions: {
    persistState: () => void;
    updateStatus: (ctx: ExtensionContext) => void;
    reloadConfig: (
      ctx?: ExtensionContext,
      options?: { preserveDebug?: boolean },
    ) => void;
    ensureValidActiveRouterProfile: (ctx: ExtensionContext) => Promise<void>;
    switchToRouterProfile: (
      profileName: string,
      ctx: ExtensionContext,
      strict?: boolean,
    ) => Promise<boolean>;
    syncPiThinkingLevel: (level: ThinkingLevel) => void;
  },
) => {
  const SUBCOMMAND_DETAILS = [
    { name: 'status', desc: 'Show current router status' },
    { name: 'profile', desc: 'Switch to a different router profile' },
    { name: 'pin', desc: 'Pin routing for a profile to a specific tier' },
    { name: 'thinking', desc: 'Override thinking level for a tier or profile' },
    { name: 'disable', desc: 'Disable the router and restore last model' },
    {
      name: 'fix',
      desc: 'Correct the last routing decision and pin that tier',
    },
    { name: 'widget', desc: 'Toggle the router status widget' },
    { name: 'debug', desc: 'Toggle or clear router debug history' },
    { name: 'reload', desc: 'Reload the model router configuration' },
    { name: 'help', desc: 'Show usage help for subcommands' },
  ];

  const getSubcommandCompletions = (
    prefix: string,
  ): AutocompleteItem[] | null => {
    const items = SUBCOMMAND_DETAILS.filter((s) =>
      s.name.startsWith(prefix),
    ).map((s) => ({
      value: s.name,
      label: s.name,
      description: s.desc,
    }));
    return items.length > 0 ? items : null;
  };

  const getPinCompletions = (args: string[]): AutocompleteItem[] | null => {
    // pin <tier|auto>
    if (args.length <= 1) {
      const token = args[0] ?? '';
      const items = ROUTER_PIN_VALUES.filter((value) =>
        value.startsWith(token),
      ).map((value) => ({
        value,
        label: value,
        description:
          value === 'auto'
            ? 'Restore auto-routing (clear pin) for the active profile'
            : `Pin active profile to ${value} tier`,
      }));
      return items.length > 0 ? items : null;
    }
    return null;
  };

  const getThinkingCompletions = (
    args: string[],
  ): AutocompleteItem[] | null => {
    // thinking [tier] <level|auto>
    const tierValues: RouterTier[] = [...ROUTER_TIERS];
    const levelValues = ['auto', ...THINKING_LEVELS];

    if (args.length <= 1) {
      const token = args[0] ?? '';
      return [
        ...levelValues
          .filter((v) => v.startsWith(token))
          .map((v) => ({
            value: v,
            label: v,
            description:
              v === 'auto'
                ? 'Restore default thinking level'
                : `Set thinking level to ${v}`,
          })),
        ...tierValues
          .filter((v) => v.startsWith(token))
          .map((v) => ({
            value: v,
            label: v,
            description: `Override thinking for ${v} tier`,
          })),
      ];
    }

    const tier = args[0];
    if (isRouterTier(tier)) {
      const levelPrefix = args[1] ?? '';
      return levelValues
        .filter((v) => v.startsWith(levelPrefix))
        .map((v) => ({
          value: `${tier} ${v}`,
          label: `${tier} ${v}`,
          description:
            v === 'auto'
              ? `Restore default thinking level for ${tier} tier`
              : `Set thinking level to ${v} for ${tier} tier`,
        }));
    }

    return null;
  };

  const handleStatus = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 0) {
      ctx.ui.notify('Usage: /router status (no arguments)', 'error');
      return;
    }
    const names = profileNames(state.currentConfig).join(', ');
    const lines = [
      'Model Router Status:',
      `Router enabled: ${state.routerEnabled ? 'yes' : 'off'}`,
      `Selected profile: ${state.selectedProfile ?? 'none'}`,
      `Selected profile pin: ${state.selectedProfile ? (state.pinnedTierByProfile[state.selectedProfile] ?? 'auto') : 'none'}`,
      `Pins by profile: ${formatPinSummary(state.pinnedTierByProfile)}`,
      `Thinking overrides: ${formatThinkingSummary(state.thinkingByProfile)}`,
      `Widget: ${state.widgetEnabled ? 'on' : 'off'}`,
      `Phase bias: ${state.currentConfig.phaseBias}`,
      `Session cost: $${state.accumulatedCost.toFixed(4)}` +
        (state.currentConfig.maxSessionBudget
          ? ` / $${state.currentConfig.maxSessionBudget.toFixed(2)}`
          : ''),
      `Available profiles: ${names}`,
      `Last non-router model: ${formatModelRef(state.lastNonRouterModel)}`,
      `Debug: ${state.debugEnabled ? 'on' : 'off'}`,
      `Debug history: ${state.debugHistory.length} decisions`,
    ];
    if (state.lastDecision) {
      lines.push(
        `Last routed tier: ${state.lastDecision.tier}`,
        `Last phase: ${state.lastDecision.phase}`,
        `Last model: ${state.lastDecision.targetProvider}/${state.lastDecision.targetModelId} (${state.lastDecision.thinking})`,
        `Reason: ${state.lastDecision.reasoning}`,
      );
    }
    if (state.lastConfigWarnings && state.lastConfigWarnings.length > 0) {
      lines.push(
        '',
        '⚠️ Configuration Warnings:',
        ...state.lastConfigWarnings.map((w) => `  - ${w}`),
      );
    }
    ctx.ui.notify(lines.join('\n'), 'info');
    actions.updateStatus(ctx);
  };

  const handleProfile = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 1) {
      ctx.ui.notify('Usage: /router profile [name]', 'error');
      return;
    }
    const profileName = args[0];
    if (!profileName) {
      ctx.ui.notify(
        `Current profile: ${state.selectedProfile}. Available: ${profileNames(state.currentConfig).join(', ')}`,
        'info',
      );
      return;
    }
    const success = await actions.switchToRouterProfile(profileName, ctx);
    if (success) {
      ctx.ui.notify(
        `Switched to router profile: ${state.selectedProfile}`,
        'info',
      );
    }
  };

  const handlePin = async (args: string[], ctx: ExtensionContext) => {
    const currentProfile = state.selectedProfile;
    if (!currentProfile) {
      ctx.ui.notify(
        'No router profile is active. Select a router model first.',
        'error',
      );
      return;
    }
    if (args.length === 0) {
      ctx.ui.notify(
        [
          `Profile: ${currentProfile}`,
          `Pinned tier: ${state.pinnedTierByProfile[currentProfile] ?? 'auto'}`,
          `Usage: /router pin <high|medium|low|micro|auto>`,
        ].join('\n'),
        'info',
      );
      actions.updateStatus(ctx);
      return;
    }

    if (args.length > 1) {
      ctx.ui.notify('Usage: /router pin <high|medium|low|micro|auto>', 'error');
      return;
    }

    const pinValue = args[0];

    if (!isRouterPinValue(pinValue)) {
      ctx.ui.notify(
        `Invalid router pin: ${pinValue}. Use one of: ${ROUTER_PIN_VALUES.join(', ')}`,
        'error',
      );
      return;
    }

    const nextTier: RouterTier | undefined =
      pinValue === 'auto' ? undefined : pinValue;
    if (nextTier) {
      state.pinnedTierByProfile[currentProfile] = nextTier;
    } else {
      delete state.pinnedTierByProfile[currentProfile];
    }
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      nextTier
        ? `Router pinned to ${nextTier}`
        : `Router pin cleared; heuristic routing restored`,
      'info',
    );
  };

  const handleThinking = async (args: string[], ctx: ExtensionContext) => {
    const currentProfile = state.selectedProfile;
    if (!currentProfile) {
      ctx.ui.notify(
        'No router profile is active. Select a router model first.',
        'error',
      );
      return;
    }
    if (args.length === 0) {
      ctx.ui.notify(
        [
          `Profile: ${currentProfile}`,
          `Thinking overrides: ${JSON.stringify(state.thinkingByProfile[currentProfile] ?? {})}`,
          'Usage: /router thinking <level|auto>           (applies to all tiers)',
          '   or: /router thinking <tier> <level|auto>    (applies to one tier)',
          'Note: not all tier models may support every thinking level.',
        ].join('\n'),
        'info',
      );
      return;
    }

    if (args.length > 2) {
      ctx.ui.notify('Too many arguments for /router thinking.', 'error');
      return;
    }

    let tier: RouterTier | 'all' | undefined;
    let levelValue = '';

    const levelValues = ['auto', ...THINKING_LEVELS];

    if (args.length === 1) {
      const level = args[0];
      if (!level) return;
      levelValue = level;
      tier = 'all';
    } else if (args.length === 2) {
      const requestedTier = args[0];
      const requestedLevel = args[1];
      if (!requestedTier || !requestedLevel) return;
      if (isRouterTier(requestedTier) || requestedTier === 'all') {
        tier = requestedTier === 'all' ? 'all' : requestedTier;
        levelValue = requestedLevel;
      } else {
        ctx.ui.notify(
          `Invalid tier: ${args[0]}. Use high, medium, low, or micro.`,
          'error',
        );
        return;
      }
    }

    if (tier !== 'all' && !tier) {
      ctx.ui.notify(
        `Invalid tier: ${tier}. Use high, medium, low, or micro.`,
        'error',
      );
      return;
    }
    if (!levelValues.includes(levelValue)) {
      ctx.ui.notify(
        `Invalid thinking level: ${levelValue}. Use auto or: ${THINKING_LEVELS.join(', ')}`,
        'error',
      );
      return;
    }

    const nextLevel =
      levelValue === 'auto'
        ? undefined
        : isThinkingLevel(levelValue)
          ? levelValue
          : undefined;
    let overrides = state.thinkingByProfile[currentProfile];
    if (!overrides) {
      overrides = {};
      state.thinkingByProfile[currentProfile] = overrides;
    }
    const tiers = tier === 'all' ? ROUTER_TIERS : [tier];
    for (const targetTier of tiers) {
      if (nextLevel) overrides[targetTier] = nextLevel;
      else delete overrides[targetTier];
    }
    if (Object.keys(overrides).length === 0) {
      delete state.thinkingByProfile[currentProfile];
    }

    actions.persistState();
    actions.updateStatus(ctx);
    if (nextLevel) {
      actions.syncPiThinkingLevel(nextLevel);
    } else if (state.lastDecision) {
      actions.syncPiThinkingLevel(state.lastDecision.thinking);
    }
    // Only warn when the level isn't supported by some tiers; skip for 'off' and 'auto'
    if (nextLevel && nextLevel !== 'off') {
      const activeProfile = state.currentConfig.profiles[currentProfile];
      if (!activeProfile) return;
      const unsupported = getUnsupportedTiers(activeProfile, nextLevel);
      if (unsupported.length > 0) {
        ctx.ui.notify(
          `Router thinking (${tier}) set to ${nextLevel}. ` +
            `${unsupported.join(', ')} tier${unsupported.length > 1 ? 's' : ''} may not support '${nextLevel}'.`,
          'warning',
        );
      }
    }
  };

  const handleDisable = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 0) {
      ctx.ui.notify('Usage: /router disable (no arguments)', 'error');
      return;
    }
    if (!state.lastNonRouterModel) {
      ctx.ui.notify(
        'No previous non-router model recorded. Use /model to pick a concrete model.',
        'warning',
      );
      return;
    }
    const { provider, modelId } = parseCanonicalModelRef(
      state.lastNonRouterModel,
    );
    const targetModel = ctx.modelRegistry.find(provider, modelId);
    if (!targetModel) {
      ctx.ui.notify(
        `Recorded non-router model is unavailable: ${state.lastNonRouterModel}`,
        'error',
      );
      return;
    }
    const success = await pi.setModel(targetModel);
    if (!success) {
      ctx.ui.notify(`Failed to switch to ${state.lastNonRouterModel}`, 'error');
      return;
    }
    state.routerEnabled = false;
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      `Router disabled. Restored ${state.lastNonRouterModel}`,
      'info',
    );
  };

  const handleFix = async (args: string[], ctx: ExtensionContext) => {
    if (args.length !== 1) {
      ctx.ui.notify('Usage: /router fix <high|medium|low|micro>', 'error');
      return;
    }
    const tier = args[0]?.toLowerCase();
    if (!isRouterTier(tier)) {
      ctx.ui.notify('Usage: /router fix <high|medium|low|micro>', 'error');
      return;
    }
    if (!state.lastDecision) {
      ctx.ui.notify('No recent routing decision to fix.', 'warning');
      return;
    }
    state.pinnedTierByProfile[state.lastDecision.profile] = tier;
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      `Router decision corrected. ${state.lastDecision.profile} is now pinned to ${tier}.`,
      'info',
    );
  };

  const handleWidget = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 1) {
      ctx.ui.notify('Usage: /router widget <on|off|toggle>', 'error');
      return;
    }
    const cmd = args[0]?.toLowerCase();
    if (cmd && !['on', 'off', 'toggle'].includes(cmd)) {
      ctx.ui.notify('Usage: /router widget <on|off|toggle>', 'error');
      return;
    }
    if (cmd === 'on') state.widgetEnabled = true;
    else if (cmd === 'off') state.widgetEnabled = false;
    else state.widgetEnabled = !state.widgetEnabled;
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      `Router widget ${state.widgetEnabled ? 'enabled' : 'disabled'}.`,
      'info',
    );
  };

  const handleDebug = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 1) {
      ctx.ui.notify('Usage: /router debug <on|off|show|clear>', 'error');
      return;
    }
    const cmd = args[0]?.toLowerCase();
    if (cmd && !['on', 'off', 'toggle', 'clear', 'show'].includes(cmd)) {
      ctx.ui.notify('Usage: /router debug <on|off|toggle|show|clear>', 'error');
      return;
    }
    if (cmd === 'on') state.debugEnabled = true;
    else if (cmd === 'off') state.debugEnabled = false;
    else if (cmd === 'clear') state.debugHistory.length = 0;
    else if (cmd === 'show') {
      if (state.debugHistory.length === 0) {
        ctx.ui.notify('No recent routing decisions.', 'info');
      } else {
        const history = state.debugHistory
          .map(
            (d) =>
              `[${new Date(d.timestamp).toLocaleTimeString()}] ${formatDecision(d)}`,
          )
          .join('\n');
        ctx.ui.notify(`Recent Routing Decisions:\n${history}`, 'info');
      }
      return;
    } else {
      state.debugEnabled = !state.debugEnabled;
    }
    actions.persistState();
    ctx.ui.notify(
      `Router debug ${state.debugEnabled ? 'enabled' : 'disabled'}.`,
      'info',
    );
  };

  const handleReload = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 0) {
      ctx.ui.notify('Usage: /router reload (no arguments)', 'error');
      return;
    }
    actions.reloadConfig(ctx, { preserveDebug: true });
    await actions.ensureValidActiveRouterProfile(ctx);
    ctx.ui.notify(
      `Router config reloaded. Profiles: ${profileNames(state.currentConfig).join(', ')}`,
      'info',
    );
  };

  pi.registerCommand('router', {
    description: 'Model router control center',
    getArgumentCompletions: (prefix) => {
      const trimmedLeft = prefix.trimStart();
      const hasTrailingSpace = /\s$/.test(prefix);
      const parts = trimmedLeft.length > 0 ? trimmedLeft.split(/\s+/) : [];

      if (parts.length === 0) {
        return getSubcommandCompletions('');
      }

      if (parts.length === 1 && !hasTrailingSpace) {
        const subcommand = parts[0];
        return subcommand ? getSubcommandCompletions(subcommand) : null;
      }

      const subcommand = parts[0];
      if (!subcommand) return null;
      const subArgs = parts.slice(1);
      if (hasTrailingSpace && parts.length === 1) {
        subArgs.push('');
      }

      switch (subcommand) {
        case 'profile': {
          const profilePrefix = subArgs[0] ?? '';
          const items = profileNames(state.currentConfig)
            .filter((name) => name.startsWith(profilePrefix))
            .map((name) => ({
              value: `profile ${name}`,
              label: `router/${name}`,
              description: `Switch to router profile "${name}"`,
            }));
          return items.length > 0 ? items : null;
        }
        case 'pin': {
          const completions = getPinCompletions(subArgs);
          return (
            completions?.map((c) => ({
              ...c,
              value: `pin ${c.value}`,
              description: c.description ?? `Pin routing to ${c.label}`,
            })) ?? null
          );
        }
        case 'thinking': {
          const completions = getThinkingCompletions(subArgs);
          return (
            completions?.map((c) => ({
              ...c,
              value: `thinking ${c.value}`,
              description: c.description ?? `Set thinking level to ${c.label}`,
            })) ?? null
          );
        }
        case 'fix': {
          const fixPrefix = subArgs[0] ?? '';
          const items = ROUTER_TIERS.filter((t) =>
            t.startsWith(fixPrefix.toLowerCase()),
          ).map((t) => ({
            value: `fix ${t}`,
            label: t,
            description: `Correct decision and pin to ${t} tier`,
          }));
          return items.length > 0 ? items : null;
        }
        case 'widget': {
          const widgetPrefix = subArgs[0] ?? '';
          const items = ['on', 'off', 'toggle']
            .filter((v) => v.startsWith(widgetPrefix))
            .map((v) => ({
              value: `widget ${v}`,
              label: v,
              description: `Set widget to ${v}`,
            }));
          return items.length > 0 ? items : null;
        }
        case 'debug': {
          const debugPrefix = subArgs[0] ?? '';
          const items = ['on', 'off', 'toggle', 'clear', 'show']
            .filter((v) => v.startsWith(debugPrefix))
            .map((v) => ({
              value: `debug ${v}`,
              label: v,
              description: `Router debug: ${v}`,
            }));
          return items.length > 0 ? items : null;
        }
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? [];
      const subcommand = parts[0];
      const subArgs = parts.slice(1);
      if (!subcommand) {
        await handleStatus(subArgs, ctx);
        return;
      }

      switch (subcommand) {
        case 'profile':
          await handleProfile(subArgs, ctx);
          break;
        case 'pin':
          await handlePin(subArgs, ctx);
          break;
        case 'thinking':
          await handleThinking(subArgs, ctx);
          break;
        case 'disable':
          await handleDisable(subArgs, ctx);
          break;
        case 'fix':
          await handleFix(subArgs, ctx);
          break;
        case 'widget':
          await handleWidget(subArgs, ctx);
          break;
        case 'debug':
          await handleDebug(subArgs, ctx);
          break;
        case 'reload':
          await handleReload(subArgs, ctx);
          break;
        case 'status':
          await handleStatus(subArgs, ctx);
          break;
        case 'help':
        case '?':
          if (subArgs.length > 0) {
            ctx.ui.notify('Usage: /router help (no arguments)', 'error');
            return;
          }
          ctx.ui.notify(
            [
              'Router Subcommands:',
              '  status                      Show current status, profile, pin, cost, and last decision.',
              '  profile [name]              Switch to a profile (enables router if off). Lists available if no name.',
              '  pin <tier|auto>             Force a tier (high|medium|low|micro) or set to auto.',
              '  thinking [tier] <level>     Override thinking level (off|minimal|...|max|auto). Not all tier models may support every level.',
              '  disable                     Disable the router and restore the last used non-router model.',
              '  fix <tier>                  Correct the last routing decision and pin that tier for the current profile.',
              '  widget <on|off|toggle>      Control the persistent status widget visibility.',
              '  debug <on|off|show|clear>   Control routing debug logging to notifications and history.',
              '  reload                      Hot-reload the configuration JSON from .pi/model-router.json.',
              '  help, ?                     Show this help message.',
            ].join('\n'),
            'info',
          );
          break;
        default:
          if (subcommand) {
            // Check if subcommand is actually a profile name (backwards compatible-ish with /router-on)
            if (state.currentConfig.profiles[subcommand]) {
              if (subArgs.length > 0) {
                ctx.ui.notify(
                  `Usage: /router ${subcommand} (no extra arguments allowed)`,
                  'error',
                );
                return;
              }
              if (await actions.switchToRouterProfile(subcommand, ctx)) {
                ctx.ui.notify(
                  `Router enabled with profile: ${state.selectedProfile}`,
                  'info',
                );
              }
            } else {
              ctx.ui.notify(
                `Unknown router subcommand: ${subcommand}. Try /router help`,
                'error',
              );
            }
          } else {
            await handleStatus(subArgs, ctx);
          }
          break;
      }
    },
  });
};
