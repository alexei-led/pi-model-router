import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import {
  Input,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type {
  RouterUIAdapters,
  RouterUIControlChange,
  RouterUIControls,
  RouterUIHistoryEntry,
  RouterUIRouteCell,
  RouterUIRouteCellChange,
  RouterUIRouteCellState,
  RouterUIRouteSelection,
  RouterUISnapshot,
  RouterUIView,
} from '../types';
import { ROUTER_ACTIVITIES, ROUTER_TIERS, ROUTER_UI_VIEWS } from '../types';
import { validateRouterUIControls } from './controls';
import {
  activityRouteLines,
  activityRoutingSummary,
  advisorName,
  budgetLines,
  classifierLines,
  formatMode,
  historyStatus,
  policySourceNote,
  formatRoute as route,
  routeMix,
  routeReason,
  routerTone,
  routeTimeline,
  textBar,
  usageSummary,
} from './presentation';

const keys = [
  'pin',
  'baseline',
  'budget',
  'advisor',
  'timeout',
  'reviewEveryRequests',
  'costHorizon',
  'costSensitivity',
  'strongAdviceConfidence',
  'thinkingHigh',
  'thinkingMedium',
  'thinkingLow',
  'thinkingMicro',
] as const;
const tabs = ROUTER_UI_VIEWS.map(
  (view) => view[0]?.toUpperCase() + view.slice(1),
);
const classifierFields = ['advisor', 'timeout', 'reviewEveryRequests'] as const;
const fieldNames: Record<keyof RouterUIControls, string> = {
  pin: 'Pin tier',
  baseline: 'Baseline',
  budget: 'Soft budget ($)',
  advisor: 'Classifier model',
  timeout: 'Advisor deadline (ms)',
  reviewEveryRequests: 'Classifier review interval',
  costHorizon: 'Cost comparison horizon',
  costSensitivity: 'Switch-cost sensitivity',
  strongAdviceConfidence: 'Strong-advice override threshold',
  thinkingHigh: 'High effort (all activities)',
  thinkingMedium: 'Medium effort (all activities)',
  thinkingLow: 'Low effort (all activities)',
  thinkingMicro: 'Micro effort (all activities)',
};
const display = (value: unknown): string =>
  value === undefined ? 'default / unknown' : String(value);
const money = (value: number | undefined): string =>
  value === undefined ? 'unknown (not free)' : `$${value.toFixed(4)}`;
const controlDisplay = (key: keyof RouterUIControls, value: unknown): string =>
  key === 'reviewEveryRequests' && value === 0
    ? 'off'
    : key === 'reviewEveryRequests' || key === 'costHorizon'
      ? `${String(value)} requests`
      : (key === 'costSensitivity' || key === 'strongAdviceConfidence') &&
          typeof value === 'number'
        ? `${Math.round(value * 100)}%`
        : display(value);
const controlChoices = (
  field: keyof RouterUIControls,
  snapshot: RouterUISnapshot,
  draft: RouterUIControls,
): (string | number | undefined)[] => {
  const choices: (string | number | undefined)[] =
    field === 'advisor'
      ? [
          undefined,
          ...new Set(
            snapshot.classifiers
              .filter((model) => model.textInput)
              .map((model) => model.model),
          ),
        ]
      : field.startsWith('thinking')
        ? [undefined, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']
        : field === 'reviewEveryRequests'
          ? [0, 2, 4, 8]
          : field === 'costHorizon'
            ? [1, 3, 5, 10]
            : field === 'costSensitivity' || field === 'strongAdviceConfidence'
              ? [0, 0.25, 0.5, 0.75, 0.9, 0.95, 1]
              : ['auto', ...ROUTER_TIERS];
  return choices.includes(draft[field]) ? choices : [draft[field], ...choices];
};

const routeCellKey = (
  activity: RouterUIRouteCell['activity'],
  tier: RouterUIRouteCell['tier'],
) => `${activity}/${tier}`;
const cloneRouteState = (
  route: RouterUIRouteCellState,
): RouterUIRouteCellState => ({ ...route, fallbacks: [...route.fallbacks] });
const routeStateEqual = (
  left: RouterUIRouteCellState,
  right: RouterUIRouteCellState,
): boolean =>
  left.state === right.state &&
  left.model === right.model &&
  left.thinking === right.thinking &&
  left.fallbacks.length === right.fallbacks.length &&
  left.fallbacks.every(
    (fallback, index) => fallback === right.fallbacks[index],
  );
const routeTargetEqual = (
  left: RouterUIRouteCellState,
  right: RouterUIRouteCellState,
): boolean =>
  left.model === right.model &&
  left.thinking === right.thinking &&
  left.fallbacks.length === right.fallbacks.length &&
  left.fallbacks.every(
    (fallback, index) => fallback === right.fallbacks[index],
  );
const routeStateForChange = (
  change: RouterUIRouteCellChange,
  cell: RouterUIRouteCell,
): RouterUIRouteCellState =>
  change.after
    ? {
        state: 'override',
        model: change.after.model,
        thinking: change.after.thinking,
        fallbacks: [...(change.after.fallbacks ?? change.before.fallbacks)],
      }
    : cloneRouteState(cell.generic);
const changes = (
  before: Readonly<RouterUIControls>,
  after: Readonly<RouterUIControls>,
): RouterUIControlChange[] =>
  keys
    .filter((key) => before[key] !== after[key])
    .map(
      (key) =>
        ({
          key,
          before: before[key],
          after: after[key],
        }) as RouterUIControlChange,
    );

export const formatRouterUIUsage = (
  history: readonly RouterUIHistoryEntry[],
): string[] => {
  const observations = history.slice(-50);
  const retained = observations.filter((entry) => !entry.reviewOnly);
  const requests = new Map<
    string,
    NonNullable<RouterUIHistoryEntry['advice']>
  >();
  for (const entry of observations)
    if (entry.advice?.requestId && !requests.has(entry.advice.requestId))
      requests.set(entry.advice.requestId, entry.advice);
  const samples = [...requests.values()];
  const costs = retained.flatMap((entry) =>
    entry.generationCostUsd === undefined ? [] : [entry.generationCostUsd],
  );
  const attempts = samples.flatMap((entry) =>
    entry.httpAttempts === undefined ? [] : [entry.httpAttempts],
  );
  const advisorCosts = samples.flatMap((entry) =>
    entry.costUsd === undefined ? [] : [entry.costUsd],
  );
  const generationAttempts = retained.flatMap((entry) =>
    entry.generationAttempts === undefined ? [] : [entry.generationAttempts],
  );
  const latestUsage = [...retained]
    .reverse()
    .find(
      (entry) =>
        entry.inputTokens !== undefined &&
        entry.cacheReadTokens !== undefined &&
        entry.cacheWriteTokens !== undefined,
    );
  const inputTotal = latestUsage
    ? (latestUsage.inputTokens ?? 0) +
      (latestUsage.cacheReadTokens ?? 0) +
      (latestUsage.cacheWriteTokens ?? 0)
    : 0;
  const cacheReadShare =
    latestUsage && inputTotal > 0
      ? (latestUsage.cacheReadTokens ?? 0) / inputTotal
      : undefined;
  const costSamples = costs.slice(-12);
  const maxCost = Math.max(...costSamples, 0);
  const spark = costSamples.length
    ? costSamples
        .map(
          (value) =>
            '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((value / (maxCost || 1)) * 7))],
        )
        .join('')
    : 'unknown';
  const activityCounts = ROUTER_ACTIVITIES.flatMap((activity) => {
    const count = retained.filter(
      (entry) => entry.actual?.activity === activity,
    ).length;
    return count ? [`${activity} ${count}`] : [];
  });
  const latencies = samples
    .flatMap((entry) =>
      entry.latencyMs === undefined ? [] : [entry.latencyMs],
    )
    .sort((a, b) => a - b);
  const median = latencies.length
    ? ((latencies[Math.floor(latencies.length / 2)] ?? 0) +
        (latencies[Math.floor((latencies.length - 1) / 2)] ?? 0)) /
      2
    : undefined;
  return [
    `Retained active-branch history: ${retained.length} decisions`,
    'At most 50; not session lifetime.',
    '',
    `Known generation cost: ${costs.length ? money(costs.reduce((sum, cost) => sum + cost, 0)) : 'unknown'} · coverage ${costs.length}/${retained.length}`,
    'Catalog only, not an invoice.',
    `Generation attempts: ${generationAttempts.length ? generationAttempts.reduce((sum, count) => sum + count, 0) : 'unknown'} · coverage ${generationAttempts.length}/${retained.length}`,
    `Cache-read share, last observed request: ${cacheReadShare === undefined ? 'unknown' : `${Math.round(cacheReadShare * 100)}%`} · measured, not forecast ${cacheReadShare === undefined ? '' : textBar(cacheReadShare)}`,
    `Catalog cost / request: ${spark} · ${costSamples.length} known samples · not a savings prediction`,
    `Observed activity labels: ${activityCounts.join(' · ') || 'unknown'} · no inferred phase`,
    '',
    `Unique advice requests: ${samples.length}`,
    `HTTP attempts: ${attempts.length ? attempts.reduce((sum, count) => sum + count, 0) : 'unknown'} · coverage ${attempts.length}/${samples.length}`,
    `Advice accepted: ${samples.length ? `${samples.filter((entry) => entry.outcome === 'selected').length}/${samples.length}` : 'unknown'}`,
    `Timeouts: ${samples.filter((entry) => entry.outcome === 'deadline').length} · abstained: ${samples.filter((entry) => entry.outcome === 'uncertain').length}`,
    `Median advisory latency: ${median === undefined ? 'unknown' : `${Math.round(median)} ms`} · samples ${latencies.length}/${samples.length}`,
    `Route reuses: ${retained.filter((entry) => entry.reuse !== undefined).length} (not new requests)`,
    `Advice without local IDs: ${retained.filter((entry) => entry.advice && !entry.advice.requestId).length} excluded`,
    '',
    `Advisor known cost: ${advisorCosts.length ? money(advisorCosts.reduce((sum, cost) => sum + cost, 0)) : 'unknown (not free)'} · coverage ${advisorCosts.length}/${samples.length}`,
    'Advice excluded from generation budget.',
    'Host totals overlap. Do not add; no savings estimate.',
  ];
};

export const formatRouterUISnapshot = (
  snapshot: RouterUISnapshot,
  tab: RouterUIView = 'now',
): string =>
  [
    `Router / ${snapshot.profile} · ${snapshot.lifecycle}`,
    `Actual: ${route(snapshot.actual)}`,
    routeReason(snapshot),
    `Mode: ${formatMode(snapshot)}`,
    ...(snapshot.pendingControls
      ? [
          `Next user turn: pin ${snapshot.pendingControls.pin} (pending; actual unchanged)`,
        ]
      : []),
    ...(tab === 'usage'
      ? [
          ...routeMix(snapshot.history),
          ...formatRouterUIUsage(snapshot.history),
        ]
      : tab === 'classifier'
        ? classifierLines(snapshot)
        : tab === 'routes'
          ? [
              activityRoutingSummary(snapshot),
              'Configured activity overrides · not actual',
              ...activityRouteLines(snapshot),
              'Generation rechecks input, context and authentication.',
            ]
          : tab === 'settings'
            ? [
                activityRoutingSummary(snapshot),
                'TUI Routes edits one activity/tier cell; session overrides queue next user turn.',
                'Configured activity overrides · not actual',
                ...activityRouteLines(snapshot),
                'Text eligibility only; generation rechecks input, context and authentication.',
                ...keys.map(
                  (key) =>
                    `${fieldNames[key]}: ${display((snapshot.pendingControls ?? snapshot.controls)[key])}${policySourceNote(snapshot, key)}`,
                ),
                'Classifier models: ' +
                  snapshot.classifiers.map((model) => model.model).join(', '),
                `Advisor enabled: ${snapshot.privacy.advisorEnabled}`,
                'Approved models: ' +
                  (snapshot.privacy.approvedModels.join(', ') || 'none'),
                'Credentials and consent are read-only. Selecting an advisor does not grant approval.',
                'Session edits activate on the next user turn. No configuration file writes.',
              ]
            : [...budgetLines(snapshot)]),
    'Terminal inspector requires TUI mode. Use /router help for text-mode commands.',
  ].join('\n');

export class RouterUIDraft {
  readonly profile: string;
  base: RouterUIControls;
  draft: RouterUIControls;
  message = '';
  busy = false;
  private undoChanges: RouterUIControlChange[] = [];
  private routeChanges = new Map<string, RouterUIRouteCellChange>();
  constructor(private readonly adapters: RouterUIAdapters) {
    const snapshot = adapters.getSnapshot();
    this.profile = snapshot.profile;
    this.base = { ...(snapshot.pendingControls ?? snapshot.controls) };
    this.draft = { ...this.base };
  }
  discard = (): void => {
    const snapshot = this.adapters.getSnapshot();
    this.base = { ...(snapshot.pendingControls ?? snapshot.controls) };
    this.draft = { ...this.base };
    this.message = 'Draft discarded. Actual route unchanged.';
  };
  dirty = (): RouterUIControlChange[] => changes(this.base, this.draft);
  routeState = (
    activity: RouterUIRouteCell['activity'],
    tier: RouterUIRouteCell['tier'],
  ): RouterUIRouteCellState => {
    const cell = this.adapters
      .getSnapshot()
      .routeCells.find(
        (entry) => entry.activity === activity && entry.tier === tier,
      );
    if (!cell) return { state: 'missing', fallbacks: [] };
    const change = this.routeChanges.get(routeCellKey(activity, tier));
    return change
      ? routeStateForChange(change, cell)
      : cloneRouteState(cell.pending ?? cell.current);
  };
  editRoute = (
    activity: RouterUIRouteCell['activity'],
    tier: RouterUIRouteCell['tier'],
    selection: RouterUIRouteSelection,
  ): void => {
    const snapshot = this.adapters.getSnapshot();
    const cell = snapshot.routeCells.find(
      (entry) => entry.activity === activity && entry.tier === tier,
    );
    if (!cell) return;
    const key = routeCellKey(activity, tier);
    const existing = this.routeChanges.get(key);
    const before = cloneRouteState(
      existing?.before ?? cell.pending ?? cell.current,
    );
    const current = this.routeState(activity, tier);
    const after: RouterUIRouteSelection = {
      model: selection.model,
      thinking: selection.thinking,
      fallbacks: [...(selection.fallbacks ?? current.fallbacks)],
    };
    const nextState: RouterUIRouteCellState = {
      state: 'override',
      model: after.model,
      thinking: after.thinking,
      fallbacks: [...(after.fallbacks ?? [])],
    };
    if (routeTargetEqual(current, nextState)) return;
    if (routeStateEqual(nextState, before)) {
      this.routeChanges.delete(key);
      return;
    }
    if (routeTargetEqual(nextState, cell.generic)) {
      if (routeStateEqual(cell.generic, before)) this.routeChanges.delete(key);
      else
        this.routeChanges.set(key, {
          activity,
          tier,
          before,
          after: undefined,
        });
      return;
    }
    this.routeChanges.set(key, { activity, tier, before, after });
  };
  resetRoute = (
    activity: RouterUIRouteCell['activity'],
    tier: RouterUIRouteCell['tier'],
  ): void => {
    const snapshot = this.adapters.getSnapshot();
    const cell = snapshot.routeCells.find(
      (entry) => entry.activity === activity && entry.tier === tier,
    );
    if (!cell) return;
    const key = routeCellKey(activity, tier);
    const existing = this.routeChanges.get(key);
    const before = cloneRouteState(
      existing?.before ?? cell.pending ?? cell.current,
    );
    if (before.state !== 'override') {
      this.routeChanges.delete(key);
      return;
    }
    if (routeStateEqual(before, cell.generic)) this.routeChanges.delete(key);
    else
      this.routeChanges.set(key, { activity, tier, before, after: undefined });
  };
  dirtyRoutes = (): RouterUIRouteCellChange[] =>
    [...this.routeChanges.values()].filter((change) => {
      const cell = this.adapters
        .getSnapshot()
        .routeCells.find(
          (entry) =>
            entry.activity === change.activity && entry.tier === change.tier,
        );
      return (
        cell &&
        !routeStateEqual(routeStateForChange(change, cell), change.before)
      );
    });
  discardRoutes = (): void => {
    this.routeChanges.clear();
    this.message = 'Route draft discarded. Actual route unchanged.';
  };
  applyRoutes = async (): Promise<void> => {
    if (this.busy) return;
    const patch = this.dirtyRoutes();
    if (!patch.length) {
      this.message = 'No route changes.';
      return;
    }
    if (this.adapters.getSnapshot().profile !== this.profile) {
      this.message = 'Profile changed: reopen inspector.';
      return;
    }
    this.busy = true;
    try {
      const result = await this.adapters.applyRoutes({
        profile: this.profile,
        changes: patch,
      });
      if (result === 'conflict') {
        this.message = 'Routes changed outside editor. Discard and retry.';
        return;
      }
      if (result === 'invalid') {
        this.message =
          'Route target is unknown/ineligible or would remove route coverage.';
        return;
      }
      this.routeChanges.clear();
      this.message =
        'Routes queued for next user turn. Actual route unchanged.';
    } catch {
      this.message = 'Routes could not be applied.';
    } finally {
      this.busy = false;
    }
  };
  canUndo = (): boolean => this.undoChanges.length > 0;
  apply = async (): Promise<void> => {
    if (this.busy) return;
    const invalid = validateRouterUIControls(this.draft);
    if (invalid) {
      this.message = invalid;
      return;
    }
    const patch = this.dirty();
    if (!patch.length) {
      this.message = 'No changes.';
      return;
    }
    await this.submit('apply', patch);
  };
  undo = async (): Promise<void> => {
    if (this.busy || !this.undoChanges.length) return;
    if (this.dirty().length) {
      this.message = 'Apply or discard the draft before undo.';
      return;
    }
    const current = this.adapters.getSnapshot();
    const controls = current.pendingControls ?? current.controls;
    // Only reverse fields still equal to this editor's last applied values.
    const patch = this.undoChanges
      .filter((change) => controls[change.key] === change.after)
      .map(
        (change) =>
          ({
            key: change.key,
            before: change.after,
            after: change.before,
          }) as RouterUIControlChange,
      );
    if (!patch.length) {
      this.message = 'Undo skipped: controls changed outside this editor.';
      this.undoChanges = [];
      return;
    }
    await this.submit('undo', patch);
  };
  private submit = async (
    action: 'apply' | 'undo',
    patch: RouterUIControlChange[],
  ): Promise<void> => {
    if (this.adapters.getSnapshot().profile !== this.profile) {
      this.message = 'Profile changed: reopen inspector.';
      return;
    }
    this.busy = true;
    try {
      const result = await this.adapters.applyControls({
        profile: this.profile,
        action,
        changes: patch,
      });
      if (result === 'conflict') {
        this.message = 'Controls changed outside editor. Discard and retry.';
        return;
      }
      this.undoChanges = action === 'apply' ? patch : [];
      this.discard();
      this.message = 'Queued for next user turn. Actual route unchanged.';
    } catch {
      this.message = 'Controls could not be applied.';
    } finally {
      this.busy = false;
    }
  };
}

/** No listeners or rendering outside the custom interaction. */
export class RouterUIInspector implements Component {
  focused = false;
  private tab = 0;
  advanced = false;
  details = false;
  usageDetails = false;
  private focus = 0;
  private scroll = 0;
  private disposed = false;
  private unsubscribe: () => void;
  private snapshot: RouterUISnapshot;
  private usage: string[];
  private history: readonly RouterUIHistoryEntry[];
  private readonly budgetInput = new Input();
  private readonly timeoutInput = new Input();
  private readonly routeSearchInput: Input;
  private routesOpen = false;
  private routeFocus = 0;
  private routeSelectionInitialized = false;
  private routeCellSelection: {
    activity: RouterUIRouteCell['activity'];
    tier: RouterUIRouteCell['tier'];
  } = { activity: 'code', tier: 'medium' };
  private routeModal: 'cells' | 'models' | 'efforts' | undefined;
  private routeList: SelectList | undefined;
  private routeSearchFocused = true;
  private readonly abort = (): void => this.close('close');
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly adapters: RouterUIAdapters,
    readonly editor: RouterUIDraft,
    private readonly done: (result: 'close' | 'resize') => void,
    private readonly wide: boolean,
    private readonly interrupted: (data: string) => boolean = (data) =>
      matchesKey(data, 'ctrl+c'),
  ) {
    this.snapshot = adapters.getSnapshot();
    this.history = this.snapshot.history;
    this.usage = formatRouterUIUsage(this.history);
    this.routeSearchInput = new Input({
      placeholder: 'Search physical chat models',
      placeholderStyle: (text) => this.theme.fg('dim', text),
    });
    const initialCell =
      this.snapshot.routeCells.find(
        (cell) => (cell.pending ?? cell.current).state === 'override',
      ) ?? this.snapshot.routeCells[0];
    if (initialCell) {
      this.routeCellSelection = {
        activity: initialCell.activity,
        tier: initialCell.tier,
      };
      this.routeSelectionInitialized = true;
    }
    this.syncInputs();
    this.unsubscribe = adapters.subscribe(this.refresh);
    adapters.signal?.addEventListener('abort', this.abort, { once: true });
    if (adapters.signal?.aborted) this.close('close');
  }
  currentTab = (): RouterUIView => ROUTER_UI_VIEWS[this.tab] ?? 'now';
  routeEditorState = () => ({
    open: this.routesOpen,
    cell: { ...this.routeCellSelection },
  });
  restoreRouteEditor = (
    open: boolean,
    cell: typeof this.routeCellSelection,
  ): void => {
    this.routesOpen = open;
    this.routeCellSelection = { ...cell };
    this.routeFocus = 0;
  };
  selectTab = (name: string): void => {
    this.routesOpen = false;
    this.closeRouteModal();
    this.tab = Math.max(
      0,
      tabs.findIndex((tab) => tab.toLowerCase() === name),
    );
    this.focus = 0;
    this.scroll = 0;
  };
  refresh = (): void => {
    if (this.disposed) return;
    this.snapshot = this.adapters.getSnapshot();
    if (
      !this.routeSelectionInitialized ||
      !this.snapshot.routeCells.some(
        (cell) =>
          cell.activity === this.routeCellSelection.activity &&
          cell.tier === this.routeCellSelection.tier,
      )
    ) {
      const initialCell =
        this.snapshot.routeCells.find(
          (cell) => (cell.pending ?? cell.current).state === 'override',
        ) ?? this.snapshot.routeCells[0];
      if (initialCell) {
        this.routeCellSelection = {
          activity: initialCell.activity,
          tier: initialCell.tier,
        };
        this.routeSelectionInitialized = true;
      }
    }
    if (this.snapshot.profile !== this.editor.profile) {
      this.close('close');
      return;
    }
    if (this.history !== this.snapshot.history) {
      this.history = this.snapshot.history;
      this.usage = formatRouterUIUsage(this.history);
    }
    this.tui.requestRender();
  };
  private syncInputs = (): void => {
    this.budgetInput.setValue(
      this.editor.draft.budget === undefined
        ? ''
        : String(this.editor.draft.budget),
    );
    this.timeoutInput.setValue(String(this.editor.draft.timeout));
  };
  private fields = (): readonly (keyof RouterUIControls)[] => {
    if (this.routesOpen) return [];
    if (this.currentTab() === 'classifier') return classifierFields;
    if (this.currentTab() !== 'settings') return [];
    return this.advanced
      ? keys.filter((key) => !classifierFields.some((field) => field === key))
      : ['pin'];
  };
  private actions = (): string[] => [
    ...(this.currentTab() === 'now' ? ['Why this route?'] : []),
    ...(this.currentTab() === 'routes' && this.snapshot.routeCells.length
      ? ['Edit cell']
      : []),
    ...(this.currentTab() === 'usage'
      ? [this.usageDetails ? 'Less detail' : 'Details']
      : []),
    ...(this.currentTab() === 'settings'
      ? [this.advanced ? 'Less settings' : 'Advanced']
      : []),
    ...(['settings', 'classifier'].includes(this.currentTab())
      ? [
          ...(this.editor.dirty().length ? ['Apply', 'Discard'] : []),
          ...(this.editor.canUndo() && !this.editor.dirty().length
            ? ['Undo']
            : []),
        ]
      : []),
    'Done',
  ];
  private selectedRouteCell = (): RouterUIRouteCell | undefined =>
    this.snapshot.routeCells.find(
      (cell) =>
        cell.activity === this.routeCellSelection.activity &&
        cell.tier === this.routeCellSelection.tier,
    );
  private routeSelectTheme = () => ({
    selectedPrefix: (text: string) => this.theme.fg('accent', text),
    selectedText: (text: string) => this.theme.fg('accent', text),
    description: (text: string) => this.theme.fg('muted', text),
    scrollInfo: (text: string) => this.theme.fg('dim', text),
    noMatch: (text: string) => this.theme.fg('warning', text),
  });
  private closeRouteModal = (): void => {
    this.routeModal = undefined;
    this.routeList = undefined;
    this.routeSearchFocused = true;
    this.scroll = 0;
  };
  private openCellPicker = (): void => {
    const cells = this.snapshot.routeCells;
    this.routeModal = 'cells';
    this.scroll = 0;
    this.routeList = new SelectList(
      cells.map((cell) => {
        const state = this.editor.routeState(cell.activity, cell.tier);
        return {
          value: routeCellKey(cell.activity, cell.tier),
          label: routeCellKey(cell.activity, cell.tier),
          description: `${state.state} · ${state.model ?? 'not configured'} · effort ${state.thinking ?? '—'}`,
        };
      }),
      8,
      this.routeSelectTheme(),
    );
    const index = cells.findIndex(
      (cell) =>
        cell.activity === this.routeCellSelection.activity &&
        cell.tier === this.routeCellSelection.tier,
    );
    if (index >= 0) this.routeList.setSelectedIndex(index);
    this.routeList.onSelect = (item) => {
      const selected = cells.find(
        (cell) => routeCellKey(cell.activity, cell.tier) === item.value,
      );
      if (selected)
        this.routeCellSelection = {
          activity: selected.activity,
          tier: selected.tier,
        };
      this.closeRouteModal();
      this.routeFocus = 0;
    };
    this.routeList.onCancel = this.closeRouteModal;
  };
  private physicalChatModels = () =>
    this.snapshot.chatModels.filter((model) => {
      const provider = model.model.slice(0, model.model.indexOf('/'));
      return provider.length > 0 && provider !== 'router';
    });
  private rebuildModelList = (): void => {
    const query = this.routeSearchInput.getValue().trim().toLocaleLowerCase();
    const models = this.physicalChatModels().filter(
      (model) =>
        !query ||
        model.model.toLocaleLowerCase().includes(query) ||
        model.name.toLocaleLowerCase().includes(query),
    );
    this.routeList = new SelectList(
      models.map((model) => ({
        value: model.model,
        label: model.model,
        description: model.name,
      })),
      8,
      this.routeSelectTheme(),
    );
    const current = this.editor.routeState(
      this.routeCellSelection.activity,
      this.routeCellSelection.tier,
    ).model;
    const selected = models.findIndex((model) => model.model === current);
    if (selected >= 0) this.routeList.setSelectedIndex(selected);
    this.routeList.onSelect = (item) => {
      const model = models.find((entry) => entry.model === item.value);
      if (!model) return;
      const currentState = this.editor.routeState(
        this.routeCellSelection.activity,
        this.routeCellSelection.tier,
      );
      const tierEffort =
        this.routeCellSelection.tier === 'micro'
          ? 'off'
          : this.routeCellSelection.tier;
      const thinking = model.efforts.includes(
        currentState.thinking ?? tierEffort,
      )
        ? (currentState.thinking ?? tierEffort)
        : model.efforts.includes(tierEffort)
          ? tierEffort
          : model.efforts[0];
      if (!thinking) {
        this.editor.message = 'Selected model has no supported effort levels.';
        this.closeRouteModal();
        return;
      }
      this.editor.editRoute(
        this.routeCellSelection.activity,
        this.routeCellSelection.tier,
        {
          model: model.model,
          thinking,
          fallbacks: currentState.fallbacks,
        },
      );
      this.closeRouteModal();
      this.routeFocus = 1;
    };
    this.routeList.onCancel = this.closeRouteModal;
  };
  private openModelPicker = (): void => {
    this.routeModal = 'models';
    this.scroll = 0;
    this.routeSearchInput.setValue('');
    this.routeSearchFocused = true;
    this.rebuildModelList();
  };
  private openEffortPicker = (): void => {
    const current = this.editor.routeState(
      this.routeCellSelection.activity,
      this.routeCellSelection.tier,
    );
    const model = this.physicalChatModels().find(
      (entry) => entry.model === current.model,
    );
    if (!model) {
      this.editor.message = 'Choose a registered physical chat model first.';
      return;
    }
    this.routeModal = 'efforts';
    this.scroll = 0;
    this.routeList = new SelectList(
      model.efforts.map((effort) => ({
        value: effort,
        label: effort,
        description: `${model.model} supports ${effort}`,
      })),
      8,
      this.routeSelectTheme(),
    );
    const selected = model.efforts.indexOf(current.thinking ?? 'off');
    if (selected >= 0) this.routeList.setSelectedIndex(selected);
    this.routeList.onSelect = (item) => {
      const effort = model.efforts.find((entry) => entry === item.value);
      if (effort)
        this.editor.editRoute(
          this.routeCellSelection.activity,
          this.routeCellSelection.tier,
          {
            model: model.model,
            thinking: effort,
            fallbacks: current.fallbacks,
          },
        );
      this.closeRouteModal();
      this.routeFocus = 2;
    };
    this.routeList.onCancel = this.closeRouteModal;
  };
  private routeActions = (): string[] => [
    'Cell',
    'Model',
    'Effort',
    'Reset to generic',
    'Apply routes',
    'Discard routes',
    'Back to Routes',
  ];
  private handleRouteInput = (data: string): void => {
    if (matchesKey(data, 'escape')) {
      if (this.routeModal) this.closeRouteModal();
      else {
        this.routesOpen = false;
        this.focus =
          this.actions().indexOf('Edit cell') + this.fields().length + 1;
      }
      this.tui.requestRender();
      return;
    }
    if (this.interrupted(data)) {
      this.close('close');
      return;
    }
    if (this.routeModal) {
      if (
        this.routeModal === 'models' &&
        (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab'))
      ) {
        this.routeSearchFocused = !this.routeSearchFocused;
      } else if (this.routeModal === 'models' && this.routeSearchFocused) {
        if (matchesKey(data, 'return')) this.routeSearchFocused = false;
        else {
          const before = this.routeSearchInput.getValue();
          this.routeSearchInput.handleInput(data);
          if (before !== this.routeSearchInput.getValue())
            this.rebuildModelList();
        }
      } else if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
        if (this.routeModal === 'models') this.routeSearchFocused = true;
      } else this.routeList?.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (
      matchesKey(data, 'pageUp') ||
      matchesKey(data, 'pageDown') ||
      matchesKey(data, 'up') ||
      matchesKey(data, 'down')
    ) {
      const upwards = matchesKey(data, 'pageUp') || matchesKey(data, 'up');
      const page = matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown');
      this.scroll = Math.max(
        0,
        this.scroll + (upwards ? -1 : 1) * (page ? 5 : 1),
      );
    } else if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const actions = this.routeActions();
      this.routeFocus =
        (this.routeFocus + (matchesKey(data, 'tab') ? 1 : actions.length - 1)) %
        actions.length;
    } else if (matchesKey(data, 'return')) {
      switch (this.routeFocus) {
        case 0:
          this.openCellPicker();
          break;
        case 1:
          this.openModelPicker();
          break;
        case 2:
          this.openEffortPicker();
          break;
        case 3:
          this.editor.resetRoute(
            this.routeCellSelection.activity,
            this.routeCellSelection.tier,
          );
          break;
        case 4:
          void this.editor.applyRoutes().then(() => {
            if (!this.disposed) this.refresh();
          });
          break;
        case 5:
          this.editor.discardRoutes();
          break;
        case 6:
          this.routesOpen = false;
          this.focus =
            this.actions().indexOf('Edit cell') + this.fields().length + 1;
          break;
      }
    }
    this.tui.requestRender();
  };
  private routeContent = (width: number): string[] => {
    if (this.routeModal === 'models') {
      this.routeSearchInput.focused = this.focused && this.routeSearchFocused;
      return [
        this.theme.fg('accent', 'Select physical chat model · searchable'),
        this.theme.fg('muted', 'Logical router models are excluded.'),
        ...this.routeSearchInput.render(width),
        ...(this.routeSearchFocused
          ? [this.theme.fg('dim', 'Type to filter · Tab/Enter to results')]
          : [this.theme.fg('dim', 'Tab to search · Enter selects · Esc back')]),
        ...(this.routeList?.render(width) ?? []),
      ];
    }
    if (this.routeModal === 'cells')
      return [
        this.theme.fg('accent', 'Choose activity / tier cell'),
        this.theme.fg(
          'dim',
          'Sparse cells inherit the generic route until specialized.',
        ),
        ...(this.routeList?.render(width) ?? []),
      ];
    if (this.routeModal === 'efforts')
      return [
        this.theme.fg('accent', 'Choose an effort supported by this model'),
        ...(this.routeList?.render(width) ?? []),
      ];
    const cell = this.selectedRouteCell();
    const state = this.editor.routeState(
      this.routeCellSelection.activity,
      this.routeCellSelection.tier,
    );
    const current = cell?.current;
    const effective = cell?.effectiveThinking;
    const pending = cell?.pending;
    const draft = this.editor
      .dirtyRoutes()
      .some(
        (change) =>
          change.activity === this.routeCellSelection.activity &&
          change.tier === this.routeCellSelection.tier,
      );
    const tierOverride = cell?.tierEffortOverride;
    const nextTierOverride = cell?.pendingTierEffortOverride;
    const selected = (index: number, label: string) =>
      this.theme.fg(
        this.routeFocus === index ? 'accent' : 'muted',
        `${this.routeFocus === index ? '›' : ' '} ${label}`,
      );
    return [
      this.theme.fg('accent', 'Routes · sparse per-cell session overrides'),
      this.theme.fg(
        'muted',
        'Actual generation is unchanged until the next user turn.',
      ),
      selected(
        0,
        `Cell: ${routeCellKey(this.routeCellSelection.activity, this.routeCellSelection.tier)}`,
      ),
      selected(1, `Model: ${state.model ?? 'not configured'}`),
      selected(2, `Configured effort: ${state.thinking ?? 'not configured'}`),
      `Cell state: ${state.state}${pending ? ' · queued' : ''}${draft ? ' · draft' : ''}`,
      `Current configuration: ${current?.model ?? 'not configured'} · effort ${current?.thinking ?? '—'} · ${current?.state ?? 'missing'}`,
      `Effective effort now: ${effective ?? 'unknown / unavailable'}`,
      ...(tierOverride
        ? [
            this.theme.fg(
              'warning',
              `${this.routeCellSelection.tier} effort override ${tierOverride} applies to every activity; clear it to use this cell effort.`,
            ),
          ]
        : []),
      ...(nextTierOverride !== tierOverride
        ? [
            `After queued controls: tier-wide effort ${nextTierOverride ?? 'auto'}.`,
          ]
        : []),
      ...(pending
        ? [
            `Next-user-boundary route: ${pending.model ?? 'not configured'} · effort ${pending.thinking ?? '—'} · ${pending.state}`,
          ]
        : []),
      `Ordered fallbacks retained: ${state.fallbacks.join(' → ') || 'none'}`,
      selected(3, 'Reset to generic / inherit'),
      selected(4, 'Apply routes'),
      selected(5, 'Discard route draft'),
      selected(6, 'Back to Routes'),
      ...(draft
        ? [this.theme.fg('warning', 'Draft changes are not applied.')]
        : []),
      this.theme.fg(
        'dim',
        'Tab focus · Enter select · Esc back · model list excludes router recursion',
      ),
    ];
  };
  private close = (result: 'close' | 'resize'): void => {
    if (this.disposed) return;
    this.dispose();
    this.done(result);
  };
  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.adapters.signal?.removeEventListener('abort', this.abort);
  };
  invalidate = (): void => {
    this.budgetInput.invalidate();
    this.timeoutInput.invalidate();
    this.routeSearchInput.invalidate();
    this.routeList?.invalidate();
  };
  handleInput = (data: string): void => {
    if (this.disposed) return;
    if (this.routesOpen) {
      if (this.editor.busy && !matchesKey(data, 'escape')) return;
      this.handleRouteInput(data);
      return;
    }
    if (matchesKey(data, 'escape') || this.interrupted(data)) {
      this.close('close');
      return;
    }
    if (this.editor.busy) return;
    const fields = this.fields();
    const field = fields[this.focus - 1];
    if (this.focus === 0 && /^[1-5]$/u.test(data)) {
      this.selectTab(ROUTER_UI_VIEWS[Number(data) - 1] ?? 'now');
    } else if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const count = fields.length + this.actions().length + 1;
      this.focus =
        (this.focus + (matchesKey(data, 'tab') ? 1 : count - 1)) % count;
    } else if (
      (matchesKey(data, 'left') || matchesKey(data, 'right')) &&
      this.focus === 0
    ) {
      this.selectTab(
        ROUTER_UI_VIEWS[
          (this.tab + (matchesKey(data, 'right') ? 1 : tabs.length - 1)) %
            tabs.length
        ] ?? 'now',
      );
      this.scroll = 0;
    } else if (
      matchesKey(data, 'pageUp') ||
      matchesKey(data, 'pageDown') ||
      (!field && (matchesKey(data, 'up') || matchesKey(data, 'down')))
    ) {
      this.scroll = Math.max(
        0,
        this.scroll +
          (matchesKey(data, 'up') || matchesKey(data, 'pageUp') ? -1 : 1) *
            (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
              ? 5
              : 1),
      );
    } else if (field === 'budget' || field === 'timeout') {
      const input = field === 'budget' ? this.budgetInput : this.timeoutInput;
      input.handleInput(data);
      if (field === 'budget')
        this.editor.draft.budget = input.getValue().trim()
          ? Number(input.getValue())
          : undefined;
      else this.editor.draft.timeout = Number(input.getValue());
    } else if (
      field &&
      (matchesKey(data, 'return') ||
        matchesKey(data, 'right') ||
        matchesKey(data, 'left'))
    ) {
      const choices = controlChoices(field, this.snapshot, this.editor.draft);
      const value =
        choices[
          (choices.indexOf(this.editor.draft[field]) +
            (matchesKey(data, 'left') ? choices.length - 1 : 1)) %
            choices.length
        ];
      Object.assign(this.editor.draft, { [field]: value });
    } else if (matchesKey(data, 'return')) {
      const action = this.actions()[this.focus - fields.length - 1];
      if (action === 'Why this route?') this.details = !this.details;
      if (action === 'Advanced' || action === 'Less settings') {
        this.advanced = !this.advanced;
        this.focus = this.advanced ? 2 : 1;
        this.scroll = 0;
      }
      if (action === 'Details' || action === 'Less detail')
        this.usageDetails = !this.usageDetails;
      if (action === 'Edit cell') {
        this.routesOpen = true;
        this.routeFocus = 0;
        this.scroll = 0;
      }
      if (action === 'Apply')
        void this.editor.apply().then(() => {
          if (!this.disposed) {
            this.syncInputs();
            this.refresh();
          }
        });
      if (action === 'Discard') {
        this.editor.discard();
        this.syncInputs();
      }
      if (action === 'Undo')
        void this.editor.undo().then(() => {
          if (!this.disposed) {
            this.syncInputs();
            this.refresh();
          }
        });
      if (action === 'Done') {
        this.close('close');
        return;
      }
    }
    this.tui.requestRender();
  };
  private routeOverview = (): string[] => {
    const s = this.snapshot;
    const order = ['micro', 'low', 'medium', 'high'] as const;
    const dirty = this.editor.dirtyRoutes();
    return [
      this.theme.fg('accent', 'Configured routes · not actual generation'),
      activityRoutingSummary(s),
      '',
      'Activity'.padEnd(9) +
        ['micro', 'low', 'med', 'high'].map((tier) => tier.padEnd(6)).join(''),
      ...ROUTER_ACTIVITIES.map(
        (activity) =>
          activity.padEnd(9) +
          order
            .map((tier) => {
              const cell = s.routeCells.find(
                (entry) => entry.activity === activity && entry.tier === tier,
              );
              const state = this.editor.routeState(activity, tier);
              const marker =
                state.state === 'override'
                  ? 'O'
                  : state.state === 'inherited'
                    ? 'I'
                    : '—';
              const draft = dirty.some(
                (entry) => entry.activity === activity && entry.tier === tier,
              );
              return (
                marker +
                (draft ? '*' : '') +
                (cell?.pending ? '+' : '')
              ).padEnd(6);
            })
            .join(''),
      ),
      '',
      'I inherited · O override · — missing',
      '* draft · + queued for next user turn',
      'Edit cell opens model, effort and ordered fallback details.',
      '',
      'Generic text-capable routes · not actual',
      ...order.map(
        (tier) =>
          tier +
          ': ' +
          (s.eligible[tier]
            ? route(s.eligible[tier])
            : 'not eligible / unknown'),
      ),
      'Generation rechecks input, context and authentication.',
      '',
      'Configured activity overrides · not actual',
      ...activityRouteLines(s),
    ];
  };
  private content = (): string[] => {
    const s = this.snapshot;
    const muted = (text: string) => this.theme.fg('muted', text);
    if (this.currentTab() === 'routes') return this.routeOverview();
    if (this.currentTab() === 'classifier')
      return classifierLines(s, this.editor.draft.advisor);
    if (this.currentTab() === 'usage')
      return [
        ...usageSummary(s),
        ...(s.history.length ? ['', ...routeMix(s.history)] : []),
        ...(this.usageDetails ? ['', ...this.usage] : []),
      ];
    if (this.currentTab() === 'now') {
      const actual = s.lifecycle === 'off' ? undefined : s.actual;
      const differs =
        s.advised &&
        (s.advised.model !== actual?.model ||
          s.advised.provider !== actual?.provider ||
          s.advised.thinking !== actual?.thinking ||
          s.advised.tier !== actual?.tier ||
          s.advised.activity !== actual?.activity ||
          s.advised.routeCell !== actual?.routeCell);
      return [
        muted(
          (s.lifecycle === 'idle' ? 'Last generation' : 'Actual generation') +
            ' · ' +
            s.lifecycle,
        ),
        this.theme.fg(
          'accent',
          actual
            ? `${actual.provider}/${actual.model}`
            : 'unknown / no observed generation',
        ),
        ...(actual
          ? [
              this.theme.fg(
                'success',
                (actual.activity ?? 'generic') +
                  ' · ' +
                  actual.tier +
                  ' · effort ' +
                  actual.thinking,
              ),
            ]
          : []),
        this.theme.fg(routerTone(s), routeReason(s)),
        muted(`Mode: ${formatMode(s)} · /router mode`),
        ...(differs
          ? [this.theme.fg('warning', `Proposed · ${route(s.advised)}`)]
          : []),
        ...(s.pendingRoutes
          ? [
              this.theme.fg(
                'warning',
                'Next user turn: route edits queued (pending; actual unchanged)',
              ),
            ]
          : []),
        ...(s.pendingControls
          ? [
              this.theme.fg(
                'warning',
                'Next user turn: ' +
                  changes(s.controls, s.pendingControls)
                    .map(
                      (change) =>
                        `${fieldNames[change.key]} ${display(change.after)}`,
                    )
                    .join(' · ') +
                  ' (pending)',
              ),
            ]
          : []),
        '',
        'Switch history · retained active branch',
        historyStatus(s),
        ...routeTimeline(s.history),
        ...(this.details
          ? [
              '',
              ...budgetLines(s),
              `Actual: ${route(actual)}`,
              `Advised (not actual): ${route(s.advised)}`,
              `Next pin: ${(s.pendingControls ?? s.controls).pin}`,
              'Advice is not generation. Tier is not a quality score.',
            ]
          : []),
      ];
    }
    return [
      muted(`Mode: ${formatMode(s)} · change with /router mode`),
      muted(activityRoutingSummary(s)),
      muted('Pin / effort / baseline: this profile.'),
      muted('Budget / switch policy: session-wide.'),
      muted('Classifier selection and deadline: Classifier tab.'),
      muted('Apply queues the next user turn; not tool turns.'),
      ...(this.advanced
        ? [
            ...budgetLines(s),
            'Session overrides only. No config file writes.',
            'Pins persist until cleared. Credentials and consent remain in user configuration.',
          ]
        : [
            muted(
              'Pins persist until cleared. Advanced: budget, effort and switch policy.',
            ),
          ]),
    ];
  };
  private statusMessage = (): string => {
    if (this.routesOpen) {
      if (this.editor.dirtyRoutes().length)
        return 'Route draft pending · actual route unchanged';
      return this.editor.message || 'Browse routes · no changes';
    }
    return (
      validateRouterUIControls(this.editor.draft) ??
      (this.editor.dirty().length
        ? 'Draft pending · next user turn'
        : this.editor.message || 'Browse only · no changes')
    );
  };
  render = (width: number): string[] => {
    if (this.tui.terminal.columns >= 100 !== this.wide) {
      queueMicrotask(() => this.close('resize'));
    }
    const framed = width >= 8 && this.tui.terminal.rows >= 11;
    const w = Math.max(1, width - (framed ? 4 : 0));
    // A non-overlay custom component replaces the editor, not Pi's footer/widgets.
    const chromeRows = this.wide ? 2 : 8;
    let height = Math.max(
      1,
      this.tui.terminal.rows - chromeRows - (framed ? 2 : 0),
    );
    const fields = this.fields();
    const actions = this.routesOpen ? this.routeActions() : this.actions();
    if (this.routesOpen)
      this.routeFocus = Math.min(this.routeFocus, actions.length - 1);
    else this.focus = Math.min(this.focus, fields.length + actions.length);
    const color = (selected: boolean, text: string): string =>
      this.theme.fg(selected ? 'accent' : 'muted', text);
    const header = [
      this.theme.fg('accent', `Router / ${this.snapshot.profile}`),
      visibleWidth(tabs.join(' | ')) + 1 <= w
        ? tabs
            .map((tab, i) =>
              color(
                i === this.tab,
                `${!this.routesOpen && this.focus === 0 && i === this.tab ? '›' : ''}${tab}`,
              ),
            )
            .join(' | ')
        : color(
            true,
            `${this.tab + 1}/${tabs.length} ${tabs[this.tab]} · ←→ tabs`,
          ),
    ];
    const status = this.statusMessage();
    const actionIndex = this.routesOpen
      ? this.routeFocus
      : this.focus - fields.length - 1;
    const actionBar = actions
      .map((action, i) =>
        color(i === actionIndex, `${i === actionIndex ? '›' : ''}${action}`),
      )
      .join(' | ');
    const footer = [
      ...((
        this.routesOpen
          ? this.editor.dirtyRoutes().length ||
            this.editor.message ||
            this.editor.busy
          : ['settings', 'classifier'].includes(this.currentTab()) &&
            (this.editor.dirty().length ||
              this.editor.message ||
              this.editor.busy)
      )
        ? [
            this.theme.fg(
              (
                this.routesOpen
                  ? this.editor.dirtyRoutes().length
                  : this.editor.dirty().length
              )
                ? 'warning'
                : 'muted',
              this.editor.busy ? 'Applying…' : status,
            ),
          ]
        : []),
      visibleWidth(actionBar) > w && actions[actionIndex]
        ? color(true, `›${actions[actionIndex]} · Tab actions`)
        : actionBar,
      this.theme.fg(
        'dim',
        this.routesOpen
          ? this.routeModal === 'models'
            ? 'Tab search/results · Enter choose · Esc back'
            : 'Esc back · Tab focus · Enter select · actual generation unchanged'
          : 'Esc close · Tab focus · ←→ tabs/value · 1–5 tabs · PgUp/Dn',
      ),
    ];
    const body = this.routesOpen
      ? this.routeContent(w).flatMap((line) => wrapTextWithAnsi(line, w))
      : this.editor
          .dirty()
          .flatMap((change) =>
            wrapTextWithAnsi(
              `Draft ${change.key}: ${display(change.before)} → ${display(change.after)}`,
              w,
            ),
          );
    let selectedStart = 0;
    let selectedHeight = 1;
    for (const [i, field] of fields.entries()) {
      const selected = this.focus === i + 1;
      const start = body.length;
      if ((field === 'budget' || field === 'timeout') && selected) {
        const input = field === 'budget' ? this.budgetInput : this.timeoutInput;
        input.focused = this.focused;
        body.push(color(true, `›${fieldNames[field]}:`), ...input.render(w));
      } else {
        body.push(
          ...wrapTextWithAnsi(
            color(
              selected,
              `${selected ? '›' : ' '}${fieldNames[field]}: ${field === 'advisor' ? advisorName(this.editor.draft.advisor ?? 'none (session)') : controlDisplay(field, this.editor.draft[field])}${policySourceNote(this.snapshot, field)}`,
            ),
            w,
          ),
        );
      }
      if (selected) {
        selectedStart = start;
        selectedHeight = body.length - start;
      }
    }
    if (!this.routesOpen)
      body.push(...this.content().flatMap((line) => wrapTextWithAnsi(line, w)));
    if (height < 7) {
      header.splice(0, header.length);
      const action =
        actions[
          this.routesOpen ? this.routeFocus : this.focus - fields.length - 1
        ];
      footer.splice(
        0,
        footer.length,
        this.theme.fg(
          action ? 'accent' : 'muted',
          action
            ? `›${action} · Enter · Tab · Esc`
            : `Tab: ${actions.join('/')} · Esc`,
        ),
      );
    }
    if (this.wide && height >= 7)
      height = Math.min(height, header.length + body.length + footer.length);
    const bodyHeight = Math.max(1, height - header.length - footer.length);
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - bodyHeight));
    // Keep focused controls visible without resetting manually scrolled read-only content.
    if (!this.routesOpen && this.focus > 0 && this.focus <= fields.length) {
      if (selectedStart < this.scroll) this.scroll = selectedStart;
      if (selectedStart + selectedHeight > this.scroll + bodyHeight)
        this.scroll = Math.max(0, selectedStart + selectedHeight - bodyHeight);
    }
    const viewport = body.slice(this.scroll, this.scroll + bodyHeight);
    if (framed) while (viewport.length < bodyHeight) viewport.push('');
    const result = [...header, ...viewport, ...footer]
      .slice(-height)
      .map((line) => truncateToWidth(line, w));
    if (!framed) return result;
    const border = (left: string, right: string) =>
      this.theme.fg('borderMuted', left + '─'.repeat(width - 2) + right);
    return [
      border('╭', '╮'),
      ...result.map((line) =>
        this.theme.bg(
          'toolPendingBg',
          this.theme.fg(
            'text',
            `│ ${line}${' '.repeat(Math.max(0, w - visibleWidth(line)))} │`,
          ),
        ),
      ),
      border('╰', '╯'),
    ];
  };
}

/** Returns explicit text outside TUI; parent owns how to emit it. */
export const openRouterInspector = async (
  ctx: ExtensionContext,
  adapters: RouterUIAdapters,
  initialTab: RouterUIView = 'now',
): Promise<string | undefined> => {
  if (ctx.mode !== 'tui')
    return formatRouterUISnapshot(adapters.getSnapshot(), initialTab);
  const editor = new RouterUIDraft(adapters);
  let terminal: TUI['terminal'] | undefined;
  let repeat = true;
  let advanced = false;
  let details = false;
  let usageDetails = false;
  const initialRouteCell =
    adapters
      .getSnapshot()
      .routeCells.find(
        (cell) => (cell.pending ?? cell.current).state === 'override',
      ) ?? adapters.getSnapshot().routeCells[0];
  let routeEditor = {
    open: false,
    cell: {
      activity: initialRouteCell?.activity ?? ('code' as const),
      tier: initialRouteCell?.tier ?? ('medium' as const),
    },
  };
  while (repeat && !adapters.signal?.aborted) {
    let component: RouterUIInspector | undefined;
    const wide = (terminal?.columns ?? process.stdout.columns ?? 80) >= 100;
    try {
      const result = await ctx.ui.custom<'close' | 'resize'>(
        (tui, theme, keybindings, done) => {
          terminal = tui.terminal;
          component = new RouterUIInspector(
            tui,
            theme,
            adapters,
            editor,
            done,
            wide,
            (data) => keybindings.matches(data, 'app.interrupt'),
          );
          component.selectTab(initialTab);
          component.advanced = advanced;
          component.details = details;
          component.usageDetails = usageDetails;
          component.restoreRouteEditor(routeEditor.open, routeEditor.cell);
          return component;
        },
        {
          // Narrow uses Pi's custom screen; resize reopens preserving the shared draft.
          overlay: wide,
          overlayOptions: () => ({
            anchor: 'top-right',
            width: 56,
            maxHeight: '100%',
            margin: 1,
          }),
        },
      );
      repeat = result === 'resize';
      initialTab = component?.currentTab() ?? initialTab;
      advanced = component?.advanced ?? advanced;
      details = component?.details ?? details;
      usageDetails = component?.usageDetails ?? usageDetails;
      routeEditor = component?.routeEditorState() ?? routeEditor;
    } finally {
      component?.dispose();
    }
  }
  return undefined;
};
