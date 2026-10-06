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
  RouterUIRoute,
  RouterUISnapshot,
} from '../types';
import { ROUTER_TIERS } from '../types';

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
const tabs = ['Now', 'Routing', 'Classifier', 'Usage'] as const;
const route = (value: RouterUIRoute | undefined): string =>
  value
    ? `${value.tier} → ${value.provider}/${value.model} · ${value.thinking}`
    : 'unknown / no observed generation';
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
    `Retained active-branch history: ${retained.length} decisions (at most 50), not session lifetime.`,
    `Known generation cost: ${costs.length ? money(costs.reduce((sum, cost) => sum + cost, 0)) : 'unknown'} · coverage ${costs.length}/${retained.length} (partial/catalog, not invoice).`,
    `Generation attempts: ${generationAttempts.length ? generationAttempts.reduce((sum, count) => sum + count, 0) : 'unknown'} · coverage ${generationAttempts.length}/${retained.length} decisions.`,
    `Unique advice requests: ${samples.length} · local request-ID dedupe.`,
    `HTTP attempts: ${attempts.length ? attempts.reduce((sum, count) => sum + count, 0) : 'unknown'} · coverage ${attempts.length}/${samples.length} requests.`,
    `Advice accepted: ${samples.filter((entry) => entry.outcome === 'selected').length}/${samples.length} requests · deadline: ${samples.filter((entry) => entry.outcome === 'deadline').length} · abstained: ${samples.filter((entry) => entry.outcome === 'uncertain').length}.`,
    `Median advisory latency: ${median === undefined ? 'unknown' : `${Math.round(median)} ms`} · samples ${latencies.length}/${samples.length}.`,
    `Route reuses: ${retained.filter((entry) => entry.reuse !== undefined).length} (not new requests).`,
    `Advice without local IDs: ${retained.filter((entry) => entry.advice && !entry.advice.requestId).length} excluded from request totals.`,
    `Advisor known cost: ${advisorCosts.length ? money(advisorCosts.reduce((sum, cost) => sum + cost, 0)) : 'unknown (not free)'} · coverage ${advisorCosts.length}/${samples.length}. Excluded from generation budget.`,
    ...ROUTER_TIERS.map(
      (tier) =>
        `${tier}: ${retained.filter((entry) => entry.actual?.tier === tier).length} observed actual routes`,
    ),
    `Unknown actual route: ${retained.filter((entry) => !entry.actual).length}`,
    'Host totals overlap these observations: never add them together. No savings estimate.',
  ];
};

export const formatRouterUISnapshot = (
  snapshot: RouterUISnapshot,
  tab: 'now' | 'routing' | 'classifier' | 'usage' = 'now',
): string =>
  [
    `Router / ${snapshot.profile} · ${snapshot.lifecycle}`,
    `Actual: ${route(snapshot.actual)}`,
    `Advised (not actual): ${route(snapshot.advised)}`,
    `Next user turn: pin ${snapshot.controls.pin} · baseline ${snapshot.controls.baseline} · ${snapshot.controls.advisor} · ${snapshot.controls.timeout} ms`,
    ...(snapshot.pendingControls
      ? [
          `Pending: pin ${snapshot.pendingControls.pin} · ${snapshot.pendingControls.advisor} (actual unchanged)`,
        ]
      : []),
    ...(tab === 'usage'
      ? formatRouterUIUsage(snapshot.history)
      : tab === 'classifier'
        ? [
            `Selected advisor: ${snapshot.controls.advisor}`,
            `Deadline: ${snapshot.controls.timeout} ms`,
            `TypeSafe approval: ${display(snapshot.privacy.jevApproved)}`,
            `Cloudflare approval: ${display(snapshot.privacy.cloudflareApproved)}`,
            `Host auth capability: ${snapshot.privacy.auth}`,
            'Credentials and consent are read-only. Cloudflare selection does not grant approval.',
            'Failure → eligible baseline; never a second advisor.',
          ]
        : tab === 'routing'
          ? [
              ...keys.map(
                (key) => `${key}: ${display(snapshot.controls[key])}`,
              ),
              ...ROUTER_TIERS.map(
                (tier) => `${tier}: ${route(snapshot.eligible[tier])}`,
              ),
              'Session drafts activate on the next user turn. No configuration file writes.',
            ]
          : [
              `Advisor outcome: ${snapshot.advice?.outcome ?? 'not observed'}`,
              ...(snapshot.failure ? [`Failure: ${snapshot.failure}`] : []),
            ]),
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
  currentTab = () =>
    (['now', 'routing', 'classifier', 'usage'] as const)[this.tab] ?? 'now';
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
    this.tab === 1
      ? [
          'pin',
          'baseline',
          'budget',
          'thinkingHigh',
          'thinkingMedium',
          'thinkingLow',
          'thinkingMicro',
        ]
      : this.tab === 2
        ? ['advisor', 'timeout']
        : [];
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
      this.focus =
        (this.focus + (matchesKey(data, 'tab') ? 1 : fields.length + 4)) %
        (fields.length + 5);
    } else if (
      (matchesKey(data, 'left') || matchesKey(data, 'right')) &&
      this.focus === 0
    ) {
      this.tab = (this.tab + (matchesKey(data, 'right') ? 1 : 3)) % 4;
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
          ? ['jev', 'clef', 'clef-flash']
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
      const action = this.focus - fields.length - 1;
      if (action === 0)
        void this.editor.apply().then(() => {
          if (!this.disposed) {
            this.syncInputs();
            this.refresh();
          }
        });
      if (action === 1) {
        this.editor.discard();
        this.syncInputs();
      }
      if (action === 2)
        void this.editor.undo().then(() => {
          if (!this.disposed) {
            this.syncInputs();
            this.refresh();
          }
        });
      if (action === 3) {
        this.close('close');
        return;
      }
    }
    this.tui.requestRender();
  };
  private content = (): string[] => {
    const s = this.snapshot;
    if (this.tab === 0)
      return [
        `State: ${s.lifecycle} · source: ${s.reason ?? 'pending'}`,
        ...(s.failure ? [`Failure: ${s.failure}`] : []),
        `Actual generation: ${route(s.actual)}`,
        `Advised (not actual): ${route(s.advised)}`,
        `Advisor: ${s.advice?.advisor ?? 'unknown'} · ${s.advice?.outcome ?? 'not observed'} · ${s.advice?.latencyMs === undefined ? 'latency unknown' : `${Math.round(s.advice.latencyMs)} ms`}`,
        'Next user turn (actual remains unchanged):',
        `Pin: ${s.controls.pin} · baseline: ${s.controls.baseline}`,
        `Advisor: ${s.controls.advisor} · deadline: ${s.controls.timeout} ms`,
        `Generation budget: ${s.controls.budget === undefined ? 'not configured' : money(s.controls.budget)}`,
        `Thinking: ${ROUTER_TIERS.map((tier) => `${tier}=${s.controls[({ high: 'thinkingHigh', medium: 'thinkingMedium', low: 'thinkingLow', micro: 'thinkingMicro' } as const)[tier]] ?? 'configured'}`).join(' · ')}`,
        ...(s.pendingControls
          ? [
              'Applied pending controls:',
              ...keys
                .filter((key) => s.pendingControls?.[key] !== s.controls[key])
                .map((key) => `${key}: ${display(s.pendingControls?.[key])}`),
            ]
          : []),
        'Pins persist until cleared; they are not one-shot.',
        'Recent retained decisions:',
        ...s.history
          .slice(-8)
          .reverse()
          .map(
            (entry) =>
              `${route(entry.actual)} · ${entry.reuse ? `reuse ${entry.reuse}` : (entry.advice?.outcome ?? 'baseline / unknown')}`,
          ),
      ];
    if (this.tab === 1)
      return [
        'Pin/thinking/baseline are profile-scoped. Advisor/budget are session-wide. No file writes.',
        'Soft generation budget excludes advisor costs; not a spending cap.',
        'Text-capable routes (generation rechecks input/context):',
        ...ROUTER_TIERS.map(
          (tier) =>
            `${tier}: ${s.eligible[tier] ? route(s.eligible[tier]) : 'not eligible / unknown'}`,
        ),
      ];
    if (this.tab === 2)
      return [
        'Jev: TypeSafe / user-configured model pin',
        'Clef: cloudflare-workers-ai/@cf/cloudflare/clef',
        'Clef Flash: cloudflare-workers-ai/@cf/cloudflare/clef-flash',
        `TypeSafe profile approval: ${display(s.privacy.jevApproved)}`,
        `Cloudflare profile approval: ${display(s.privacy.cloudflareApproved)}`,
        `Host auth capability: ${s.privacy.auth} (not backend-login attestation)`,
        'Selecting Cloudflare does not consent. Credentials and approval are read-only.',
        'Bounded recent dialogue/tool output can contain private data. Filtering is not redaction.',
        'Failure → eligible baseline; never a second advisor.',
      ];
    return this.usage;
  };
  render = (width: number): string[] => {
    if (this.tui.terminal.columns >= 100 !== this.wide) {
      queueMicrotask(() => this.close('resize'));
    }
    const framed = width >= 8 && this.tui.terminal.rows >= 11;
    const w = Math.max(1, width - (framed ? 4 : 0));
    // A non-overlay custom component replaces the editor, not Pi's footer/widgets.
    const chromeRows = this.wide ? 2 : 8;
    const height = Math.max(
      1,
      this.tui.terminal.rows - chromeRows - (framed ? 2 : 0),
    );
    const fields = this.fields();
    const color = (selected: boolean, text: string): string =>
      this.theme.fg(selected ? 'accent' : 'muted', text);
    const header = [
      this.theme.fg('accent', `Router inspector / ${this.snapshot.profile}`),
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
      this.theme.fg('warning', this.editor.busy ? 'Applying…' : status),
      ['Apply', 'Discard', 'Undo', 'Done']
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
        body.push(color(true, `›${field}:`), ...input.render(w));
      } else {
        body.push(
          ...wrapTextWithAnsi(
            color(
              selected,
              `${selected ? '›' : ' '}${field}: ${display(this.editor.draft[field])}`,
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
      footer.splice(
        0,
        footer.length,
        this.theme.fg('dim', 'Tab focus · Esc close'),
      );
    }
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
  initialTab: 'now' | 'routing' | 'classifier' | 'usage' = 'now',
): Promise<string | undefined> => {
  if (ctx.mode !== 'tui')
    return formatRouterUISnapshot(adapters.getSnapshot(), initialTab);
  const editor = new RouterUIDraft(adapters);
  let terminal: TUI['terminal'] | undefined;
  let repeat = true;
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
    } finally {
      component?.dispose();
    }
  }
  return undefined;
};
