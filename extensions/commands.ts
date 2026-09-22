import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import {
  getUnsupportedTiers,
  isRouterPinValue,
  isThinkingLevel,
  parseCanonicalModelRef,
  profileNames,
  ROUTER_PIN_VALUES,
  ROUTER_TIERS,
  THINKING_LEVELS,
} from './config';
import { DEFAULT_JEV_CONTEXT } from './constants';
import { preservesRouteCoverage } from './routing';
import type {
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
} from './types';
import {
  formatAdvisorDetail,
  formatDecision,
  formatDecisionSource,
  formatJevStats,
  formatModelRef,
  formatPinSummary,
  formatThinkingSummary,
} from './ui';

/** One verb per concern; state is shown by the verb that changes it. */
const VERBS = [
  { name: 'pin', desc: 'Pin the active profile to a tier, or auto' },
  { name: 'thinking', desc: 'Override thinking for every tier, or auto' },
  { name: 'log', desc: 'Recent decisions and Jev stats; on, off or clear' },
  { name: 'widget', desc: 'Toggle the status widget' },
  { name: 'off', desc: 'Leave the router and restore the previous model' },
  { name: 'reload', desc: 'Reload model-router.json' },
  { name: 'help', desc: 'Show usage' },
] as const;

/** Removed verbs answer with the replacement instead of acting. */
const RETIRED_VERBS: Record<string, string> = {
  status: '/router',
  profile: '/router <profile>',
  disable: '/router off',
  fix: '/router pin <tier>',
  debug: '/router log',
  '?': '/router help',
};

const LOG_ACTIONS = ['on', 'off', 'clear'] as const;
const THINKING_VALUES = ['auto', ...THINKING_LEVELS] as const;

const USAGE = [
  '/router                        status',
  '/router <profile>              switch profile (enables the router)',
  '/router off                    leave the router; restore the previous model',
  '/router pin <tier|auto>        pin the active profile to high|medium|low|micro, or clear',
  '/router thinking <level|auto>  override thinking for every tier, or clear',
  '/router log [on|off|clear]     recent decisions and Jev stats; control collection',
  '/router widget                 toggle the status widget',
  '/router reload                 reload model-router.json',
  '/router help                   this text',
].join('\n');

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
  const usage = (ctx: ExtensionContext, line: string) =>
    ctx.ui.notify(`Usage: ${line}`, 'error');

  const activeProfile = (ctx: ExtensionContext): string | undefined => {
    if (!state.selectedProfile)
      ctx.ui.notify(
        'No router profile is active. Run /router <profile> first.',
        'error',
      );
    return state.selectedProfile;
  };

  const showStatus = (ctx: ExtensionContext) => {
    const profile = state.selectedProfile;
    const config = state.currentConfig;
    const jev = config.jev;
    const context = jev?.context ?? DEFAULT_JEV_CONTEXT;
    const cost =
      `$${state.accumulatedCost.toFixed(4)}` +
      (config.maxSessionBudget
        ? ` / $${config.maxSessionBudget.toFixed(2)}`
        : '');
    const lines = [
      `Router: ${state.routerEnabled ? 'on' : 'off'} · profile ${profile ?? 'none'} · available: ${profileNames(config).join(', ')}`,
      `Pin: ${formatPinSummary(state.pinnedTierByProfile)} · thinking override: ${formatThinkingSummary(state.thinkingByProfile)}`,
      `Baseline: ${profile ? (config.profiles[profile]?.baselineTier ?? 'automatic') : 'none'} · cost: ${cost} · widget: ${state.widgetEnabled ? 'on' : 'off'} · log: ${state.debugEnabled ? 'on' : 'off'} (${state.debugHistory.length} decisions)`,
      jev
        ? `Jev: ${jev.enabled ? 'enabled' : 'disabled'} · profile opt-in: ${profile && config.profiles[profile]?.jev?.enabled ? 'yes' : 'no'} · budget ${jev.timeoutMs}ms · context ${context.previousTurns} turns / ≈${context.maxHistoryTokens} history / ${context.toolResults} ≈${context.maxToolTokens} tool / ≈${jev.maxStateTokens} state tokens`
        : 'Jev: not configured',
      `Previous model: ${formatModelRef(state.lastNonRouterModel)}`,
      ...formatJevStats(state.debugHistory),
    ];
    const last = state.lastDecision;
    if (last) {
      const source = formatDecisionSource(last);
      const advisor = formatAdvisorDetail(last);
      lines.push(
        `Last: ${last.tier} → ${last.targetProvider}/${last.targetModelId} (${last.thinking})${source ? ` · ${source}` : ''}`,
        ...(advisor ? [advisor] : []),
      );
    }
    if (state.lastConfigWarnings.length > 0)
      lines.push(
        '',
        '⚠️ Configuration warnings:',
        ...state.lastConfigWarnings.map((warning) => `  - ${warning}`),
      );
    ctx.ui.notify(lines.join('\n'), 'info');
    actions.updateStatus(ctx);
  };

  const handleProfile = async (name: string, ctx: ExtensionContext) => {
    if (await actions.switchToRouterProfile(name, ctx))
      ctx.ui.notify(`Router profile: ${state.selectedProfile}`, 'info');
  };

  const handleOff = async (ctx: ExtensionContext) => {
    if (!state.lastNonRouterModel) {
      ctx.ui.notify(
        'No previous non-router model recorded. Use /model to pick one.',
        'warning',
      );
      return;
    }
    const { provider, modelId } = parseCanonicalModelRef(
      state.lastNonRouterModel,
    );
    const target = ctx.modelRegistry.find(provider, modelId);
    if (!target) {
      ctx.ui.notify(
        `Previous model is unavailable: ${state.lastNonRouterModel}`,
        'error',
      );
      return;
    }
    if (!(await pi.setModel(target))) {
      ctx.ui.notify(`Failed to switch to ${state.lastNonRouterModel}`, 'error');
      return;
    }
    state.routerEnabled = false;
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(`Router off. Restored ${state.lastNonRouterModel}`, 'info');
  };

  const handlePin = (args: string[], ctx: ExtensionContext) => {
    const profile = activeProfile(ctx);
    if (!profile) return;
    const value = args[0]?.toLowerCase();
    if (args.length === 0) {
      ctx.ui.notify(
        `Pin: ${state.pinnedTierByProfile[profile] ?? 'auto'} (profile ${profile})`,
        'info',
      );
      return;
    }
    if (args.length > 1 || !isRouterPinValue(value)) {
      usage(ctx, `/router pin <${ROUTER_PIN_VALUES.join('|')}>`);
      return;
    }
    if (value === 'auto') delete state.pinnedTierByProfile[profile];
    else state.pinnedTierByProfile[profile] = value;
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      value === 'auto'
        ? 'Router pin cleared; baseline routing restored'
        : `Router pinned to ${value}`,
      'info',
    );
  };

  const handleThinking = (args: string[], ctx: ExtensionContext) => {
    const profile = activeProfile(ctx);
    if (!profile) return;
    const value = args[0]?.toLowerCase();
    if (args.length === 0) {
      ctx.ui.notify(
        `Thinking override: ${formatThinkingSummary(state.thinkingByProfile)}`,
        'info',
      );
      return;
    }
    if (
      args.length > 1 ||
      !value ||
      !THINKING_VALUES.some((level) => level === value)
    ) {
      usage(ctx, `/router thinking <${THINKING_VALUES.join('|')}>`);
      return;
    }
    const level = isThinkingLevel(value) ? value : undefined;
    const config = state.currentConfig.profiles[profile];
    if (
      level &&
      config &&
      preservesRouteCoverage(
        config,
        (provider, id) => ctx.modelRegistry.find(provider, id),
        Object.fromEntries(ROUTER_TIERS.map((tier) => [tier, level])),
      ) === false
    ) {
      ctx.ui.notify(
        `Router thinking unchanged: '${level}' leaves no eligible route.`,
        'warning',
      );
      return;
    }
    if (level)
      state.thinkingByProfile[profile] = Object.fromEntries(
        ROUTER_TIERS.map((tier) => [tier, level]),
      );
    else delete state.thinkingByProfile[profile];
    actions.persistState();
    actions.updateStatus(ctx);
    if (level) actions.syncPiThinkingLevel(level);
    else if (state.lastDecision)
      actions.syncPiThinkingLevel(state.lastDecision.thinking);
    const unsupported =
      level && level !== 'off' && config
        ? getUnsupportedTiers(config, level)
        : [];
    ctx.ui.notify(
      level
        ? `Router thinking set to ${level}${unsupported.length > 0 ? `; ${unsupported.join(', ')} may not support it and will be skipped when unsupported` : ''}`
        : 'Router thinking override cleared',
      unsupported.length > 0 ? 'warning' : 'info',
    );
  };

  const handleLog = (args: string[], ctx: ExtensionContext) => {
    const action = args[0]?.toLowerCase();
    if (args.length > 1 || (action && !LOG_ACTIONS.some((a) => a === action))) {
      usage(ctx, `/router log [${LOG_ACTIONS.join('|')}]`);
      return;
    }
    if (action === 'on' || action === 'off') {
      state.debugEnabled = action === 'on';
      actions.persistState();
      ctx.ui.notify(`Router log ${action}`, 'info');
      return;
    }
    if (action === 'clear') {
      state.debugHistory.length = 0;
      actions.persistState();
      ctx.ui.notify('Router log cleared', 'info');
      return;
    }
    const header = state.debugEnabled
      ? 'Log: on'
      : 'Log: off; /router log on collects new decisions';
    const history = state.debugHistory.map(
      (decision) =>
        `[${new Date(decision.timestamp).toLocaleTimeString()}] ${formatDecision(decision)}`,
    );
    ctx.ui.notify(
      [
        header,
        ...formatJevStats(state.debugHistory),
        ...(history.length > 0
          ? ['Recent decisions:', ...history]
          : ['No recent routing decisions.']),
      ].join('\n'),
      'info',
    );
  };

  const handleWidget = (ctx: ExtensionContext) => {
    state.widgetEnabled = !state.widgetEnabled;
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      `Router widget ${state.widgetEnabled ? 'on' : 'off'}`,
      'info',
    );
  };

  const handleReload = async (ctx: ExtensionContext) => {
    actions.reloadConfig(ctx, { preserveDebug: true });
    await actions.ensureValidActiveRouterProfile(ctx);
    ctx.ui.notify(
      `Router config reloaded. Profiles: ${profileNames(state.currentConfig).join(', ')}`,
      'info',
    );
  };

  const items = (
    values: readonly string[],
    token: string,
    describe: (value: string) => string,
    prefix = '',
  ): AutocompleteItem[] | null => {
    const matches = values
      .filter((value) => value.startsWith(token))
      .map((value) => ({
        value: `${prefix}${value}`,
        label: value,
        description: describe(value),
      }));
    return matches.length > 0 ? matches : null;
  };

  pi.registerCommand('router', {
    description: 'Model router: profile, pin, thinking, log',
    getArgumentCompletions: (prefix) => {
      const text = prefix.trimStart();
      const parts = text.length > 0 ? text.split(/\s+/) : [];
      const trailing = /\s$/.test(prefix);
      if (parts.length === 0 || (parts.length === 1 && !trailing)) {
        const token = parts[0] ?? '';
        const profiles = items(
          profileNames(state.currentConfig),
          token,
          (name) => `Switch to profile ${name}`,
        );
        const verbs = items(
          VERBS.map((verb) => verb.name),
          token,
          (name) => VERBS.find((verb) => verb.name === name)?.desc ?? name,
        );
        const all = [...(profiles ?? []), ...(verbs ?? [])];
        return all.length > 0 ? all : null;
      }
      const [verb, ...rest] = parts;
      const token = trailing && rest.length === 0 ? '' : (rest[0] ?? '');
      if (rest.length > 1) return null;
      switch (verb) {
        case 'pin':
          return items(
            ROUTER_PIN_VALUES,
            token,
            (value) =>
              value === 'auto'
                ? 'Clear the pin for the active profile'
                : `Pin the active profile to ${value}`,
            'pin ',
          );
        case 'thinking':
          return items(
            THINKING_VALUES,
            token,
            (value) =>
              value === 'auto'
                ? 'Clear the thinking override'
                : `Set thinking to ${value} for every tier`,
            'thinking ',
          );
        case 'log':
          return items(
            LOG_ACTIONS,
            token,
            (value) =>
              ({
                on: 'Collect decisions',
                off: 'Stop collecting decisions',
                clear: 'Forget collected decisions',
              })[value] ?? value,
            'log ',
          );
        default:
          return null;
      }
    },
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
      const [verb, ...rest] = parts;
      if (!verb) {
        showStatus(ctx);
        return;
      }
      const noArgs = (line: string) => {
        if (rest.length > 0) {
          usage(ctx, line);
          return false;
        }
        return true;
      };
      switch (verb) {
        case 'pin':
          handlePin(rest, ctx);
          return;
        case 'thinking':
          handleThinking(rest, ctx);
          return;
        case 'log':
          handleLog(rest, ctx);
          return;
        case 'widget':
          if (noArgs('/router widget')) handleWidget(ctx);
          return;
        case 'off':
          if (noArgs('/router off')) await handleOff(ctx);
          return;
        case 'reload':
          if (noArgs('/router reload')) await handleReload(ctx);
          return;
        case 'help':
          if (noArgs('/router help')) ctx.ui.notify(USAGE, 'info');
          return;
        default:
          break;
      }
      if (Object.hasOwn(state.currentConfig.profiles, verb)) {
        if (noArgs(`/router ${verb}`)) await handleProfile(verb, ctx);
        return;
      }
      const replacement = RETIRED_VERBS[verb];
      ctx.ui.notify(
        replacement
          ? `/router ${verb} was removed; use ${replacement}`
          : `Unknown router command: ${verb}. Try /router help`,
        'error',
      );
    },
  });
};
