import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import {
  isRouterPinValue,
  isThinkingLevel,
  parseCanonicalModelRef,
  profileNames,
  ROUTER_PIN_VALUES,
  ROUTER_TIERS,
  THINKING_LEVELS,
} from './config';
import { ROUTER_COMMANDS as VERBS } from './constants';
import { effortAdjustments, preservesRouteCoverage } from './routing';
import type {
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RouterUIView,
  RoutingDecision,
} from './types';
import {
  formatClassifierStats,
  formatDecision,
  formatDecisionSource,
  formatPinSummary,
  formatThinkingSummary,
} from './ui';

/** Removed verbs answer with the replacement instead of acting. */
const RETIRED_VERBS: Record<string, string> = {
  disable: '/router off',
  fix: '/router pin <tier>',
  debug: '/router log',
  '?': '/router help',
};

const LOG_ACTIONS = ['on', 'off', 'clear'] as const;
const THINKING_VALUES = ['auto', ...THINKING_LEVELS] as const;

const USAGE = [
  '/router                        overview (text outside TUI)',
  '/router status                 short text status',
  '/router usage                  retained usage and known costs',
  '/router settings               session controls',
  '/router profile <name>         switch profile (enables the router)',
  '/router off                    leave the router; restore the previous model',
  '/router pin <tier|auto>        pin the active profile to high|medium|low|micro, or clear',
  '/router thinking <level|auto>  override thinking for every tier, or clear',
  '/router log [on|off|clear]     recent decisions and advisor stats; control collection',
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
  openUI?: (ctx: ExtensionContext, tab: RouterUIView) => Promise<void>,
) => {
  const usage = (ctx: ExtensionContext, line: string) =>
    ctx.ui.notify(`Usage: ${line}`, 'error');

  const activeProfile = (ctx: ExtensionContext): string | undefined => {
    if (!state.selectedProfile)
      ctx.ui.notify(
        'No router profile is active. Run /router profile <name> first.',
        'error',
      );
    return state.selectedProfile;
  };

  const showStatus = (ctx: ExtensionContext) => {
    const profile = state.selectedProfile;
    const config = state.currentConfig;
    const cost =
      `$${state.accumulatedCost.toFixed(4)}` +
      (config.maxSessionBudget
        ? ` / $${config.maxSessionBudget.toFixed(2)} soft budget`
        : '');
    const last =
      state.lastDecision?.profile === profile ? state.lastDecision : undefined;
    const lines = [
      `Router: ${state.routerEnabled ? 'on' : 'off'} · profile ${profile ?? 'none'} · available: ${profileNames(config).join(', ')}`,
      `Pin: ${formatPinSummary(state.pinnedTierByProfile)} · effort: ${formatThinkingSummary(state.thinkingByProfile)}`,
      `Recorded catalog cost: ${cost} (not billing; excludes advice)`,
      ...(last && state.routerEnabled
        ? [
            `Last: ${last.tier} → ${last.targetProvider}/${last.targetModelId} (${last.thinking}) · ${formatDecisionSource(last)}`,
          ]
        : []),
      'Details: /router · /router usage · /router settings',
      ...state.lastConfigWarnings,
    ];
    const text = lines.join('\n');
    if (ctx.mode === 'print') process.stderr.write(`${text}\n`);
    else if (ctx.mode === 'json')
      pi.sendMessage(
        {
          customType: 'router-status',
          content: text,
          display: true,
          details: undefined,
        },
        { triggerTurn: false },
      );
    else ctx.ui.notify(text, 'info');
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
      const pin = Object.hasOwn(state.pinnedTierByProfile, profile)
        ? state.pinnedTierByProfile[profile]
        : undefined;
      ctx.ui.notify(`Pin: ${pin ?? 'auto'} (profile ${profile})`, 'info');
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
    const adjusted =
      level && config
        ? effortAdjustments(
            config,
            (provider, id) => ctx.modelRegistry.find(provider, id),
            level,
          )
        : [];
    ctx.ui.notify(
      level
        ? `Router thinking set to ${level}${adjusted.length > 0 ? `; ${adjusted.join(', ')}` : ''}`
        : 'Router thinking override cleared',
      'info',
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
        ...formatClassifierStats(state.debugHistory),
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
    description: 'Router: overview, usage, settings, profile and pin',
    getArgumentCompletions: (prefix) => {
      const text = prefix.trimStart();
      const parts = text.length > 0 ? text.split(/\s+/) : [];
      const trailing = /\s$/.test(prefix);
      if (parts.length === 0 || (parts.length === 1 && !trailing)) {
        const token = parts[0] ?? '';
        const verbs = items(
          VERBS.map((verb) => verb.name),
          token,
          (name) => VERBS.find((verb) => verb.name === name)?.desc ?? name,
        );
        const all = verbs ?? [];
        return all.length > 0 ? all : null;
      }
      const [verb, ...rest] = parts;
      const token = trailing && rest.length === 0 ? '' : (rest[0] ?? '');
      if (rest.length > 1) return null;
      switch (verb) {
        case 'profile':
          return items(
            profileNames(state.currentConfig),
            token,
            (name) => `Switch to profile ${name}`,
            'profile ',
          );
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
        if (openUI) await openUI(ctx, 'now');
        else showStatus(ctx);
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
        case 'status':
          if (noArgs('/router status')) showStatus(ctx);
          return;
        case 'usage':
        case 'settings':
          if (noArgs(`/router ${verb}`)) {
            if (openUI) await openUI(ctx, verb);
            else showStatus(ctx);
          }
          return;
        case 'profile':
          if (rest.length !== 1) usage(ctx, '/router profile <name>');
          else await handleProfile(rest[0] ?? '', ctx);
          return;
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
        ctx.ui.notify(
          `Use /router profile ${verb} to select this profile.`,
          'error',
        );
        return;
      }
      const replacement = Object.hasOwn(RETIRED_VERBS, verb)
        ? RETIRED_VERBS[verb]
        : undefined;
      ctx.ui.notify(
        replacement
          ? `/router ${verb} was removed; use ${replacement}`
          : `Unknown router command: ${verb}. Try /router help`,
        'error',
      );
    },
  });
};
