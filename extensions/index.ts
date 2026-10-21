import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { registerCommands } from './commands';
import { loadRouterConfig, profileNames, resolveProfileName } from './config';
import { MAX_DEBUG_HISTORY } from './constants';
import { registerRouterProvider } from './provider';
import { effortAdjustments, preservesRouteCoverage } from './routing';
import {
  buildPersistedState,
  isRouterPersistedState,
  loadLastRouterProfile,
  saveLastRouterProfile,
  snapshotDecision,
} from './state';
import type {
  RouterConfig,
  RouterMode,
  RouterPersistedState,
  RouterPinByProfile,
  RouterThinkingByProfile,
  RoutingDecision,
} from './types';
import { ROUTER_TIERS } from './types';
import { openRouterInspector, updateRouterUIStrip } from './ui';
import { createRouterUIRuntime } from './ui/runtime';

const hasExplicitCliModel = () =>
  process.argv
    .slice(2)
    .some((arg) => arg === '--model' || arg.startsWith('--model='));

const routerExtension = (pi: ExtensionAPI) => {
  let ownerSessionId: string | undefined;
  let requestEpoch = 0;
  let ownerController = new AbortController();
  let currentConfig: RouterConfig = { profiles: {} };
  let currentModelRegistry: ExtensionContext['modelRegistry'] | undefined;
  let currentCwd = process.cwd();
  let lastDecision: RoutingDecision | undefined;
  let debugEnabled = false;
  let routerEnabled = false;
  let selectedProfile: string | undefined;
  let widgetEnabled = true;
  let lastRegisteredModels = '';
  let disposeProvider: (() => void) | undefined;
  let clearProviderReviews: (() => void) | undefined;
  const pinnedTierByProfile: RouterPinByProfile = {};
  const thinkingByProfile: RouterThinkingByProfile = {};
  let modeOverride: RouterMode | undefined;
  let debugHistory: RoutingDecision[] = [];
  let lastNonRouterModel: string | undefined;
  let accumulatedCost = 0;
  let lastExtensionContext: ExtensionContext | undefined;
  let lastConfigWarnings: string[] = [];
  let lastPersistedSnapshot: string | undefined;
  let isInitialized = false;
  let isInternalModelSwitch = false;
  let isInternalThinkingChange = false;
  const pendingThinkingChanges: Array<{
    previousLevel: ThinkingLevel;
    level: ThinkingLevel;
  }> = [];
  let ignoreStartupThinkingEvent = false;

  const ownsContext = (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId?.();
    return ownerSessionId === undefined || id === ownerSessionId;
  };

  const runtimeState = {
    get requestEpoch() {
      return requestEpoch;
    },
    get ownerSignal() {
      return ownerController.signal;
    },
    get clearProviderReviews() {
      return clearProviderReviews;
    },
    set clearProviderReviews(value: (() => void) | undefined) {
      clearProviderReviews = value;
    },
    get disposeProvider() {
      return disposeProvider;
    },
    set disposeProvider(value: (() => void) | undefined) {
      disposeProvider = value;
    },
    get lastRegisteredModels() {
      return lastRegisteredModels;
    },
    set lastRegisteredModels(value: string) {
      lastRegisteredModels = value;
    },
    get currentConfig() {
      return currentConfig;
    },
    set currentConfig(value: RouterConfig) {
      currentConfig = value;
    },
    get currentModelRegistry() {
      return currentModelRegistry;
    },
    get lastExtensionContext() {
      return lastExtensionContext;
    },
    get selectedProfile() {
      return selectedProfile;
    },
    set selectedProfile(value: string | undefined) {
      selectedProfile = value;
    },
    get routerEnabled() {
      return routerEnabled;
    },
    set routerEnabled(value: boolean) {
      if (routerEnabled && !value) clearProviderReviews?.();
      routerEnabled = value;
    },
    get lastDecision() {
      return lastDecision;
    },
    set lastDecision(value: RoutingDecision | undefined) {
      lastDecision = value;
    },
    thinkingByProfile,
    pinnedTierByProfile,
    get modeOverride() {
      return modeOverride;
    },
    set modeOverride(value: RouterMode | undefined) {
      modeOverride = value;
    },
    get accumulatedCost() {
      return accumulatedCost;
    },
    set accumulatedCost(value: number) {
      accumulatedCost = value;
    },
    get debugEnabled() {
      return debugEnabled;
    },
    set debugEnabled(value: boolean) {
      debugEnabled = value;
    },
    get widgetEnabled() {
      return widgetEnabled;
    },
    set widgetEnabled(value: boolean) {
      widgetEnabled = value;
    },
    get debugHistory() {
      return debugHistory;
    },
    get lastNonRouterModel() {
      return lastNonRouterModel;
    },
    set lastNonRouterModel(value: string | undefined) {
      lastNonRouterModel = value;
    },
    get lastConfigWarnings() {
      return lastConfigWarnings;
    },
  };

  const routerUI = createRouterUIRuntime(runtimeState, () => {
    if (lastExtensionContext) actions.updateStatus(lastExtensionContext);
  });

  const setModelInternally = async (
    model: NonNullable<ExtensionContext['model']>,
  ) => {
    const epoch = requestEpoch;
    isInternalModelSwitch = true;
    try {
      return await pi.setModel(model);
    } catch {
      // Extension context may be stale after session teardown.
      return false;
    } finally {
      if (epoch === requestEpoch) isInternalModelSwitch = false;
    }
  };

  const setThinkingLevelInternally = (level: ThinkingLevel) => {
    let previousLevel: ThinkingLevel;
    try {
      previousLevel = pi.getThinkingLevel();
    } catch {
      return; // The session runtime may already be torn down.
    }
    const change = { previousLevel, level };
    pendingThinkingChanges.push(change);
    isInternalThinkingChange = true;
    try {
      pi.setThinkingLevel(level);
      change.level = pi.getThinkingLevel();
    } catch {
      // Extension context may be stale after session teardown.
      change.level = change.previousLevel;
    } finally {
      isInternalThinkingChange = false;
      if (change.level === change.previousLevel) {
        const index = pendingThinkingChanges.indexOf(change);
        if (index >= 0) pendingThinkingChanges.splice(index, 1);
      }
    }
  };

  const recordDebugDecision = (decision: RoutingDecision) => {
    routerUI.recordAdvice(decision);
    if (!debugEnabled) return;
    debugHistory = [...debugHistory, snapshotDecision(decision)].slice(
      -MAX_DEBUG_HISTORY,
    );
  };

  const persistState = () => {
    const state = buildPersistedState({
      routerEnabled,
      selectedProfile,
      pinnedTierByProfile,
      thinkingByProfile,
      debugEnabled,
      widgetEnabled,
      debugHistory,
      lastDecision,
      lastNonRouterModel,
      accumulatedCost,
      modeOverride,
    });
    const snapshot = JSON.stringify({
      ...state,
      timestamp: 0,
      lastDecision: state.lastDecision
        ? { ...state.lastDecision, timestamp: 0 }
        : undefined,
    });
    if (snapshot === lastPersistedSnapshot) {
      return;
    }
    try {
      pi.appendEntry('router-state', {
        ...state,
        ...(ownerSessionId ? { ownerSessionId } : {}),
      });
    } catch {
      // Defensive fallback: the session_shutdown event may fire after this
      // code runs (due to event loop ordering), so isActive can still be
      // true even though the runtime is already stale.
      return;
    }
    lastPersistedSnapshot = snapshot;
  };

  const actions = {
    persistState,
    clearDebugHistory: (ctx: ExtensionContext) => {
      debugHistory = [];
      persistState();
      actions.updateStatus(ctx);
    },
    syncPiThinkingLevel: setThinkingLevelInternally,
    updateStatus: (ctx: ExtensionContext) => {
      updateRouterUIStrip(ctx, routerUI.adapters.getSnapshot(), {
        widgetEnabled,
        statusLine: currentConfig.ui?.statusLine,
      });
      routerUI.publish();
    },
    reloadConfig: (
      ctx?: ExtensionContext,
      options?: { preserveDebug?: boolean; deferStatus?: boolean },
    ) => {
      ownerController.abort();
      ownerController = new AbortController();
      requestEpoch += 1;
      isInternalModelSwitch = false;
      pendingThinkingChanges.length = 0;
      routerUI.reset();
      const loaded = loadRouterConfig(currentCwd);
      currentConfig = loaded.config;
      lastConfigWarnings = loaded.warnings;
      if (!options?.preserveDebug) {
        debugEnabled = currentConfig.debug ?? false;
      }
      selectedProfile = resolveProfileName(currentConfig, selectedProfile);
      actions.registerRouterProvider();
      if (ctx) {
        if (!options?.deferStatus) actions.updateStatus(ctx);
        if (lastConfigWarnings.length > 0) {
          ctx.ui.notify(
            `Router Configuration Warnings:\n${lastConfigWarnings.join('\n')}`,
            'warning',
          );
        }
      }
    },
    ensureValidActiveRouterProfile: async (ctx: ExtensionContext) => {
      if (ctx.model?.provider !== 'router') {
        return;
      }
      if (Object.hasOwn(currentConfig.profiles, ctx.model.id)) {
        selectedProfile = ctx.model.id;
        routerEnabled = true;
        return;
      }

      ctx.ui.notify(
        `Router profile "${ctx.model.id}" is no longer configured.`,
        'warning',
      );
      routerEnabled = false;
      selectedProfile = undefined;
    },
    switchToRouterProfile: async (
      profileName: string,
      ctx: ExtensionContext,
      strict = true,
    ) => {
      if (!Object.hasOwn(currentConfig.profiles, profileName)) {
        if (strict) {
          ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        }
        return false;
      }

      // Ensure the provider is registered with current capacities for this profile
      actions.registerRouterProvider();

      const routerModel = ctx.modelRegistry.find('router', profileName);
      if (!routerModel) {
        ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        return false;
      }
      if (ctx.model && ctx.model.provider !== 'router') {
        lastNonRouterModel = `${ctx.model.provider}/${ctx.model.id}`;
      }
      const success = await setModelInternally(routerModel);
      if (!success) {
        ctx.ui.notify(`Failed to switch to router/${profileName}`, 'error');
        return false;
      }
      selectedProfile = profileName;
      routerEnabled = true;
      saveLastRouterProfile(profileName);
      persistState();
      actions.updateStatus(ctx);
      return true;
    },
    registerRouterProvider: () => {
      registerRouterProvider(pi, runtimeState, {
        persistState,
        recordDebugDecision,
        updateStatus: actions.updateStatus,
        syncPiThinkingLevel: setThinkingLevelInternally,
        beginRequest: routerUI.beginRequest,
      });
    },
  };

  actions.reloadConfig();

  const restorePersistedControls = (
    savedState: RouterPersistedState,
    hasExplicitStartupModel: boolean,
  ) => {
    if (!hasExplicitStartupModel) {
      selectedProfile = resolveProfileName(
        currentConfig,
        savedState.selectedProfile,
      );
      routerEnabled = savedState.enabled && selectedProfile !== undefined;
    }
    if (savedState.pinByProfile) {
      Object.assign(pinnedTierByProfile, savedState.pinByProfile);
    }
    if (savedState.thinkingByProfile) {
      Object.assign(
        thinkingByProfile,
        structuredClone(savedState.thinkingByProfile),
      );
    }
    modeOverride = savedState.modeOverride;
    if (savedState.pinTier && selectedProfile) {
      pinnedTierByProfile[selectedProfile] = savedState.pinTier;
    }
    debugEnabled = savedState.debugEnabled ?? debugEnabled;
    widgetEnabled = savedState.widgetEnabled ?? widgetEnabled;
    debugHistory = savedState.debugHistory
      ? savedState.debugHistory.map(snapshotDecision).slice(-MAX_DEBUG_HISTORY)
      : [];
    if (!hasExplicitStartupModel) {
      lastNonRouterModel = savedState.lastNonRouterModel ?? lastNonRouterModel;
    }
    accumulatedCost = savedState.accumulatedCost ?? 0;
  };

  const restoreStateFromSession = async (
    ctx: ExtensionContext,
    startReason: SessionStartEvent['reason'],
  ) => {
    const nextOwner = ctx.sessionManager.getSessionId?.();
    if (
      ownerSessionId !== nextOwner ||
      startReason === 'new' ||
      startReason === 'fork'
    ) {
      selectedProfile = undefined;
      lastNonRouterModel = undefined;
    }
    ownerSessionId = nextOwner;
    lastPersistedSnapshot = undefined;
    ignoreStartupThinkingEvent =
      startReason === 'startup' ||
      startReason === 'new' ||
      startReason === 'reload' ||
      startReason === 'fork';
    lastExtensionContext = ctx;
    currentModelRegistry = ctx.modelRegistry;
    currentCwd = ctx.cwd;
    actions.reloadConfig(ctx);
    const restoringEpoch = requestEpoch;
    const hasExplicitStartupModel =
      startReason === 'startup' && hasExplicitCliModel();

    routerEnabled = ctx.model?.provider === 'router';
    selectedProfile =
      ctx.model?.provider === 'router'
        ? resolveProfileName(currentConfig, ctx.model.id)
        : resolveProfileName(currentConfig, selectedProfile);
    // Clear in-place to keep references intact
    for (const key of Object.keys(pinnedTierByProfile)) {
      delete pinnedTierByProfile[key];
    }
    for (const key of Object.keys(thinkingByProfile)) {
      delete thinkingByProfile[key];
    }
    widgetEnabled = true;
    // Owner-fenced restore below is the only way an override returns.
    modeOverride = undefined;
    debugHistory = [];
    accumulatedCost = 0;
    lastNonRouterModel =
      ctx.model && ctx.model.provider !== 'router'
        ? `${ctx.model.provider}/${ctx.model.id}`
        : lastNonRouterModel;
    lastDecision = undefined;

    await actions.ensureValidActiveRouterProfile(ctx);
    if (restoringEpoch !== requestEpoch || !ownsContext(ctx)) return;

    const savedState = ctx.sessionManager
      .getBranch()
      .map((entry) =>
        entry.type === 'custom' && entry.customType === 'router-state'
          ? entry.data
          : undefined,
      )
      .findLast(
        (value): value is RouterPersistedState =>
          isRouterPersistedState(value) &&
          (value.ownerSessionId === undefined
            ? startReason !== 'fork'
            : value.ownerSessionId === ownerSessionId),
      );

    if (savedState) {
      restorePersistedControls(savedState, hasExplicitStartupModel);
      if (!hasExplicitStartupModel)
        lastDecision = savedState.lastDecision
          ? snapshotDecision(savedState.lastDecision)
          : undefined;
    } else if (
      ctx.model?.provider === 'router' &&
      (startReason === 'startup' || startReason === 'new') &&
      !hasExplicitStartupModel
    ) {
      const lastProfile = resolveProfileName(
        currentConfig,
        loadLastRouterProfile(),
      );
      if (lastProfile) {
        selectedProfile = lastProfile;
        routerEnabled = true;
      }
    }

    if (routerEnabled && selectedProfile) {
      const routerModel = ctx.modelRegistry.find('router', selectedProfile);
      if (routerModel) {
        const success = await setModelInternally(routerModel);
        if (restoringEpoch !== requestEpoch || !ownsContext(ctx)) return;
        if (!success) {
          ctx.ui.notify(
            `Failed to restore router/${selectedProfile} after relaunch.`,
            'warning',
          );
          routerEnabled = false;
        } else if (lastDecision) {
          // Sync pi's thinking level display with the router's last decision
          setThinkingLevelInternally(lastDecision.thinking);
        }
      } else {
        ctx.ui.notify(
          `Unable to restore router/${selectedProfile}; model is unavailable.`,
          'warning',
        );
        routerEnabled = false;
        ctx.ui.setHiddenThinkingLabel?.();
      }
    } else {
      ctx.ui.setHiddenThinkingLabel?.();
    }

    persistState();
    actions.updateStatus(ctx);
  };

  registerCommands(pi, runtimeState, actions, async (ctx, tab) => {
    const text = await openRouterInspector(ctx, routerUI.adapters, tab);
    if (!text) return;
    if (ctx.mode === 'print') process.stderr.write(`${text}\n`);
    else if (ctx.mode === 'json')
      pi.sendMessage(
        {
          customType: 'router-inspector',
          content: text,
          display: true,
          details: undefined,
        },
        { triggerTurn: false },
      );
    else ctx.ui.notify(text, 'info');
  });

  pi.on('before_agent_start', async (_event, ctx) => {
    if (!ownsContext(ctx)) return;
    const epoch = requestEpoch;
    if (!routerUI.activatePending()) {
      ctx.ui.notify(
        'Pending router controls discarded: configuration changed or route became unavailable.',
        'warning',
      );
    } else {
      actions.registerRouterProvider();
      const selected = ctx.model;
      const refreshed =
        selected?.provider === 'router'
          ? ctx.modelRegistry.find('router', selected.id)
          : undefined;
      if (
        selected &&
        refreshed &&
        (selected.contextWindow !== refreshed.contextWindow ||
          selected.maxTokens !== refreshed.maxTokens ||
          selected.reasoning !== refreshed.reasoning ||
          JSON.stringify(selected.thinkingLevelMap) !==
            JSON.stringify(refreshed.thinkingLevelMap))
      ) {
        await setModelInternally(refreshed);
        if (epoch !== requestEpoch || !ownsContext(ctx)) return;
      }
    }
    persistState();
    actions.updateStatus(ctx);
  });
  pi.on('session_shutdown', (_event, ctx) => {
    if (!ownsContext(ctx)) return;
    ownerController.abort();
    requestEpoch += 1;
    routerUI.reset();
  });

  pi.on('session_start', async (event, ctx) => {
    isInitialized = true;
    await restoreStateFromSession(ctx, event.reason);
    if (!ownsContext(ctx)) return;
    if (debugEnabled) {
      ctx.ui.notify(
        `Router initialized with profiles: ${profileNames(currentConfig).join(', ')}`,
        'info',
      );
    }
  });

  // SDK consumers must instantiate a fresh extension factory for each native session.
  // Foreign events from an inherited runtime cannot take ownership without session_start.
  const ensureInitializedFromContext = (ctx: ExtensionContext): boolean => {
    if (!ownsContext(ctx)) return false;
    if (!currentModelRegistry) {
      ownerSessionId = ctx.sessionManager.getSessionId?.();
      currentModelRegistry = ctx.modelRegistry;
      lastExtensionContext = ctx;
      currentCwd = ctx.cwd;
      actions.reloadConfig(ctx);
    }
    return true;
  };

  pi.on('turn_start', async (_event, ctx) => {
    if (!ensureInitializedFromContext(ctx)) return;
    ignoreStartupThinkingEvent = false;
  });

  pi.on('model_select', async (event, ctx) => {
    // Ensure the model registry is captured even if session_start hasn't fired
    // (e.g. in subagent contexts spawned by pi-dynamic-workflows).
    if (!ensureInitializedFromContext(ctx)) return;
    if (!isInitialized || isInternalModelSwitch) return;
    const epoch = requestEpoch;
    if (event.model.provider === 'router') {
      const profileName = resolveProfileName(currentConfig, event.model.id);
      if (!profileName) {
        ctx.ui.notify(`Unknown router profile: ${event.model.id}`, 'error');
        return;
      }

      // If the selected model has stale capacities (e.g. from the initial registration),
      // re-apply the model from the registry to force a TUI refresh.
      const registryModel = ctx.modelRegistry.find('router', profileName);
      if (
        registryModel &&
        (registryModel.contextWindow !== event.model.contextWindow ||
          registryModel.maxTokens !== event.model.maxTokens)
      ) {
        await setModelInternally(registryModel);
        if (epoch !== requestEpoch || !ownsContext(ctx)) return;
      }

      routerEnabled = true;
      selectedProfile = profileName;
      actions.registerRouterProvider();
      saveLastRouterProfile(profileName);
    } else {
      runtimeState.routerEnabled = false;
      lastNonRouterModel = `${event.model.provider}/${event.model.id}`;
      ctx.ui.setHiddenThinkingLabel?.();
    }
    persistState();
    actions.updateStatus(ctx);
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (!ensureInitializedFromContext(ctx)) return;
    const epoch = requestEpoch;
    if (routerEnabled && selectedProfile && ctx.model?.provider !== 'router') {
      const routerModel = ctx.modelRegistry.find('router', selectedProfile);
      if (routerModel) {
        await setModelInternally(routerModel);
        if (epoch !== requestEpoch || !ownsContext(ctx)) return;
      }
    }
    persistState();
    actions.updateStatus(ctx);
  });

  pi.on('thinking_level_select', (event, ctx) => {
    if (!ensureInitializedFromContext(ctx)) return;
    if (isInternalModelSwitch) return;
    if (isInternalThinkingChange) {
      pendingThinkingChanges.pop();
      return;
    }
    // Pi emits without awaiting extension handlers; earlier handlers can delay this echo.
    const internalChange = pendingThinkingChanges.findIndex(
      (change) =>
        change.previousLevel === event.previousLevel &&
        change.level === event.level,
    );
    if (internalChange >= 0) {
      pendingThinkingChanges.splice(internalChange, 1);
      return;
    }
    if (!isInitialized || !routerEnabled || !selectedProfile) return;
    if (ignoreStartupThinkingEvent) {
      ignoreStartupThinkingEvent = false;
      return;
    }

    // User changed pi's thinking level (e.g. via shift+tab).
    // Apply as an all-tier thinking override for the active router profile.
    const overrides = Object.hasOwn(thinkingByProfile, selectedProfile)
      ? { ...thinkingByProfile[selectedProfile] }
      : {};
    for (const t of ROUTER_TIERS) {
      overrides[t] = event.level;
    }
    const activeProfile = currentConfig.profiles[selectedProfile];
    if (!activeProfile) return;
    if (
      preservesRouteCoverage(
        activeProfile,
        (provider, id) => ctx.modelRegistry.find(provider, id),
        overrides,
        currentConfig.activityRouting !== 'off',
      ) === false
    ) {
      actions.syncPiThinkingLevel(event.previousLevel);
      ctx.ui.notify(
        `Router thinking unchanged: '${event.level}' leaves no eligible route.`,
        'warning',
      );
      return;
    }
    thinkingByProfile[selectedProfile] = overrides;
    persistState();
    actions.updateStatus(ctx);
    const adjusted = effortAdjustments(
      activeProfile,
      (provider, id) => ctx.modelRegistry.find(provider, id),
      event.level,
      currentConfig.activityRouting !== 'off',
    );
    if (adjusted.length > 0)
      ctx.ui.notify(
        `Router thinking (all) set to ${event.level}; ${adjusted.join(', ')}`,
        'info',
      );
  });
};

export default routerExtension;
