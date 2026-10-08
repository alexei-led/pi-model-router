import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
import type {
  RouterUIAdapters,
  RouterUIControlChange,
  RouterUIControls,
  RouterUIHistoryEntry,
  RouterUISnapshot,
  RouterUIView,
} from '../types';
import { ROUTER_TIERS } from '../types';
import {
  advisorName,
  budgetLines,
  formatRoute as route,
  routeMix,
  routeReason,
  routerTone,
} from './presentation';

const keys = [
  'pin',
  'baseline',
  'budget',
  'advisor',
  'timeout',
  'thinkingHigh',
  'thinkingMedium',
  'thinkingLow',
  'thinkingMicro',
] as const;
const tabs = ['Now', 'Usage', 'Settings'] as const;
const fieldNames: Record<keyof RouterUIControls, string> = {
  pin: 'Pin tier',
  baseline: 'Baseline',
  budget: 'Soft budget ($)',
  advisor: 'Classifier model',
  timeout: 'Advisor deadline (ms)',
  thinkingHigh: 'High effort',
  thinkingMedium: 'Medium effort',
  thinkingLow: 'Low effort',
  thinkingMicro: 'Micro effort',
};
const display = (value: unknown): string =>
  value === undefined ? 'default / unknown' : String(value);
const money = (value: number | undefined): string =>
  value === undefined ? 'unknown (not free)' : `$${value.toFixed(4)}`;
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

export const validateRouterUIControls = (
  controls: Readonly<RouterUIControls>,
): string | undefined => {
  if (
    controls.budget !== undefined &&
    (!Number.isFinite(controls.budget) || controls.budget <= 0)
  )
    return 'Budget must be positive and finite.';
  if (
    !Number.isFinite(controls.timeout) ||
    controls.timeout <= 0 ||
    controls.timeout > 2147483647
  )
    return 'Timeout must be positive, finite and at most 2147483647 ms.';
  return undefined;
};

export const formatRouterUIUsage = (
  history: readonly RouterUIHistoryEntry[],
): string[] => {
  const retained = history.slice(-50);
  const requests = new Map<
    string,
    NonNullable<RouterUIHistoryEntry['advice']>
  >();
  for (const entry of retained)
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
    '',
    `Unique advice requests: ${samples.length}`,
    `HTTP attempts: ${attempts.length ? attempts.reduce((sum, count) => sum + count, 0) : 'unknown'} · coverage ${attempts.length}/${samples.length}`,
    `Advice accepted: ${samples.length ? samples.filter((entry) => entry.outcome === 'selected').length + '/' + samples.length : 'unknown'}`,
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
      : tab === 'settings'
        ? [
            ...keys.map(
              (key) =>
                `${fieldNames[key]}: ${display((snapshot.pendingControls ?? snapshot.controls)[key])}`,
            ),
            'Classifier models: ' +
              snapshot.classifiers.map((model) => model.model).join(', '),
            'Advisor enabled: ' + snapshot.privacy.advisorEnabled,
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
  private focus = 0;
  private scroll = 0;
  private disposed = false;
  private unsubscribe: () => void;
  private snapshot: RouterUISnapshot;
  private usage: string[];
  private history: readonly RouterUIHistoryEntry[];
  private readonly budgetInput = new Input();
  private readonly timeoutInput = new Input();
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
    this.syncInputs();
    this.unsubscribe = adapters.subscribe(this.refresh);
    adapters.signal?.addEventListener('abort', this.abort, { once: true });
    if (adapters.signal?.aborted) this.close('close');
  }
  currentTab = () => (['now', 'usage', 'settings'] as const)[this.tab] ?? 'now';
  selectTab = (name: string): void => {
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
  private fields = (): readonly (keyof RouterUIControls)[] =>
    this.tab === 2 ? (this.advanced ? keys : ['pin']) : [];
  private actions = (): string[] => [
    ...(this.tab === 0 ? ['Why this route?'] : []),
    ...(this.tab === 2
      ? [
          this.advanced ? 'Less settings' : 'Advanced',
          ...(this.editor.dirty().length ? ['Apply', 'Discard'] : []),
          ...(this.editor.canUndo() && !this.editor.dirty().length
            ? ['Undo']
            : []),
        ]
      : []),
    'Done',
  ];
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
  };
  handleInput = (data: string): void => {
    if (this.disposed) return;
    if (matchesKey(data, 'escape') || this.interrupted(data)) {
      this.close('close');
      return;
    }
    if (this.editor.busy) return;
    const fields = this.fields();
    const field = fields[this.focus - 1];
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      const count = fields.length + this.actions().length + 1;
      this.focus =
        (this.focus + (matchesKey(data, 'tab') ? 1 : count - 1)) % count;
    } else if (
      (matchesKey(data, 'left') || matchesKey(data, 'right')) &&
      this.focus === 0
    ) {
      this.tab = (this.tab + (matchesKey(data, 'right') ? 1 : 2)) % 3;
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
      const choices =
        field === 'advisor'
          ? [
              ...new Set([
                this.editor.draft.advisor,
                ...this.snapshot.classifiers.map((model) => model.model),
              ]),
            ]
          : field.startsWith('thinking')
            ? [undefined, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']
            : ['auto', ...ROUTER_TIERS];
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
  private content = (): string[] => {
    const s = this.snapshot;
    const muted = (text: string) => this.theme.fg('muted', text);
    const heading = (text: string) => this.theme.fg('accent', text);
    if (this.tab === 0) {
      const actual = s.lifecycle === 'off' ? undefined : s.actual;
      const differs =
        s.advised &&
        (s.advised.model !== actual?.model ||
          s.advised.provider !== actual?.provider ||
          s.advised.thinking !== actual?.thinking ||
          s.advised.tier !== actual?.tier);
      return [
        muted(
          `${s.lifecycle === 'idle' ? 'Last generation' : 'Actual generation'} · ${s.lifecycle}`,
        ),
        heading(actual ? actual.model : 'unknown / no observed generation'),
        ...(actual ? [`Tier ${actual.tier} · effort ${actual.thinking}`] : []),
        this.theme.fg(routerTone(s), routeReason(s)),
        ...(differs ? [`Advised (not actual): ${route(s.advised)}`] : []),
        ...(s.pendingControls
          ? [
              this.theme.fg(
                'warning',
                `Next user turn: ${changes(s.controls, s.pendingControls)
                  .map(
                    (change) =>
                      `${fieldNames[change.key]} ${display(change.after)}`,
                  )
                  .join(' · ')} (pending)`,
              ),
            ]
          : []),
        '',
        ...budgetLines(s).map((line, i) =>
          i === 1
            ? this.theme.fg(
                s.controls.budget !== undefined &&
                  (s.accumulatedCost ?? 0) >= s.controls.budget
                  ? 'warning'
                  : 'accent',
                line,
              )
            : muted(line),
        ),
        '',
        muted(
          `Observed routes · ${Math.min(50, s.history.length)} retained decisions`,
        ),
        ...routeMix(s.history),
        ...(this.details
          ? [
              '',
              `Actual: ${route(actual)}`,
              `Advised (not actual): ${route(s.advised)}`,
              `Next pin: ${(s.pendingControls ?? s.controls).pin}`,
              'Advice is not generation. Tier is not a quality score.',
            ]
          : []),
      ];
    }
    if (this.tab === 1)
      return [
        heading('Observed routes · retained active branch'),
        ...routeMix(s.history),
        '',
        ...this.usage,
      ];
    return [
      muted('Pin / effort / baseline: this profile.'),
      muted('Advisor / deadline / budget: session-wide.'),
      muted('Apply queues the next user turn; not tool turns.'),
      ...(this.advanced
        ? [
            '',
            heading('Text-capable routes (generation rechecks fit)'),
            ...(['micro', 'low', 'medium', 'high'] as const).map(
              (tier) =>
                `${tier}: ${s.eligible[tier] ? route(s.eligible[tier]) : 'not eligible / unknown'}`,
            ),
            '',
            heading('Advisor authorization · read-only'),
            'Advisor enabled: ' + s.privacy.advisorEnabled,
            'Selected model approved: ' +
              Boolean(
                this.editor.draft.advisor &&
                  s.privacy.approvedModels.includes(this.editor.draft.advisor),
              ),
            'Approved models: ' +
              (s.privacy.approvedModels.join(', ') || 'none'),
            'Models come from Pi classifier registry; Pi owns authentication.',
            'Selecting an advisor does not grant consent.',
            'Recent text can contain private data. Filtering is not redaction.',
            'Advisor failure → baseline, never a second advisor.',
            'Soft budget excludes advice; not a spending cap.',
            'Session overrides only. No config file writes.',
          ]
        : [
            muted(
              'Pins persist until cleared. Advanced: advisor, budget, effort.',
            ),
          ]),
    ];
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
    this.focus = Math.min(this.focus, fields.length + this.actions().length);
    const color = (selected: boolean, text: string): string =>
      this.theme.fg(selected ? 'accent' : 'muted', text);
    const header = [
      this.theme.fg('accent', `Router / ${this.snapshot.profile}`),
      tabs
        .map((tab, i) =>
          color(
            i === this.tab,
            `${this.focus === 0 && i === this.tab ? '›' : ''}${tab}`,
          ),
        )
        .join(' | '),
    ];
    const status =
      validateRouterUIControls(this.editor.draft) ??
      (this.editor.dirty().length
        ? 'Draft pending · next user turn'
        : this.editor.message || 'Browse only · no changes');
    const footer = [
      ...(this.tab === 2 &&
      (this.editor.dirty().length || this.editor.message || this.editor.busy)
        ? [
            this.theme.fg(
              this.editor.dirty().length ? 'warning' : 'muted',
              this.editor.busy ? 'Applying…' : status,
            ),
          ]
        : []),
      this.actions()
        .map((action, i) =>
          color(
            this.focus === fields.length + i + 1,
            `${this.focus === fields.length + i + 1 ? '›' : ''}${action}`,
          ),
        )
        .join(' | '),
      this.theme.fg('dim', 'Esc close · Tab focus · ←→ tabs/value · PgUp/Dn'),
    ];
    const body = this.editor
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
              `${selected ? '›' : ' '}${fieldNames[field]}: ${field === 'advisor' ? advisorName(this.editor.draft.advisor ?? 'not configured') : display(this.editor.draft[field])}`,
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
    body.push(...this.content().flatMap((line) => wrapTextWithAnsi(line, w)));
    if (height < 7) {
      header.splice(0, header.length);
      const action = this.actions()[this.focus - fields.length - 1];
      footer.splice(
        0,
        footer.length,
        this.theme.fg(
          action ? 'accent' : 'muted',
          action
            ? `›${action} · Enter · Tab · Esc`
            : `Tab: ${this.actions().join('/')} · Esc`,
        ),
      );
    }
    if (this.wide && height >= 7)
      height = Math.min(height, header.length + body.length + footer.length);
    const bodyHeight = Math.max(1, height - header.length - footer.length);
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - bodyHeight));
    // Keep focused controls visible without resetting manually scrolled read-only content.
    if (this.focus > 0 && this.focus <= fields.length) {
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
    } finally {
      component?.dispose();
    }
  }
  return undefined;
};
