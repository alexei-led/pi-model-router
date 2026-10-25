import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import type {
  RouterUIAdapters,
  RouterUIControls,
  RouterUIControlTransaction,
  RouterUISnapshot,
} from '../types';
import {
  formatRouterUISnapshot,
  formatRouterUIUsage,
  openRouterInspector,
  RouterUIDraft,
  RouterUIInspector,
} from './inspector';

const controls: RouterUIControls = {
  pin: 'auto',
  baseline: 'medium',
  budget: 5,
  advisor: undefined,
  timeout: 1500,
  reviewEveryRequests: 4,
  costHorizon: 5,
  costSensitivity: 0.5,
  strongAdviceConfidence: 0.9,
  thinkingHigh: undefined,
  thinkingMedium: undefined,
  thinkingLow: undefined,
  thinkingMicro: undefined,
};
const fixture = () => {
  let snapshot: RouterUISnapshot = {
    profile: '仕事👨‍👩‍👧‍👦',
    lifecycle: 'generating',
    mode: { mode: 'balanced', source: 'default' },
    policySources: {
      costHorizon: 'config',
      costSensitivity: 'config',
      strongAdviceConfidence: 'config',
    },
    controls: { ...controls },
    actual: {
      tier: 'medium',
      provider: 'test',
      model: '漢字-é-🚀',
      thinking: 'high',
    },
    eligible: {},
    activityRouting: 'on',
    activityCells: [],
    routeCells: [],
    history: [],
    loggingEnabled: false,
    classifiers: [],
    chatModels: [],
    privacy: {
      advisorEnabled: false,
      approvedModels: [],
      auth: 'unknown',
    },
  };
  const callbacks = new Set<() => void>();
  const unsubscribe = vi.fn();
  const adapters: RouterUIAdapters = {
    getSnapshot: () => snapshot,
    subscribe: (callback) => {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
        unsubscribe();
      };
    },
    applyRoutes: vi.fn(async () => 'applied' as const),
    applyControls: vi.fn(async (transaction: RouterUIControlTransaction) => {
      const current = snapshot.pendingControls ?? snapshot.controls;
      if (
        transaction.changes.some(
          (change) => current[change.key] !== change.before,
        )
      )
        return 'conflict';
      const next = { ...current };
      for (const change of transaction.changes)
        Object.assign(next, { [change.key]: change.after });
      snapshot = { ...snapshot, pendingControls: next };
      for (const callback of callbacks) callback();
      return 'applied';
    }),
  };
  const update = (patch: Partial<RouterUISnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const callback of callbacks) callback();
  };
  let tint = '';
  const theme = {
    fg: (_color: string, text: string) => tint + text,
    bg: (_color: string, text: string) => text,
  } as Theme;
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender: vi.fn(),
  } as unknown as TUI;
  const done = vi.fn();
  const draft = new RouterUIDraft(adapters);
  const panel = new RouterUIInspector(tui, theme, adapters, draft, done, false);
  return {
    adapters,
    update,
    unsubscribe,
    theme,
    tui,
    done,
    draft,
    panel,
    tint: (value: string) => {
      tint = value;
    },
  };
};

describe('Signal Panel', () => {
  it.each([11, 12, 15])(
    'keeps focused draft actions visible at %i terminal rows',
    async (rows) => {
      const f = fixture();
      Object.assign(f.tui.terminal, { rows });
      f.panel.selectTab('settings');
      f.panel.handleInput('\t');
      f.panel.handleInput('\x1b[C');
      expect(f.draft.dirty()).not.toHaveLength(0);
      f.panel.handleInput('\t');
      f.panel.handleInput('\t');
      f.panel.handleInput('\t');
      const lines = f.panel.render(40);
      expect(lines.join('\n')).toContain('›Apply');
      expect(lines.join('\n')).toContain('Enter');
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(rows - 8);
      f.panel.handleInput('\r');
      await Promise.resolve();
      await Promise.resolve();
      expect(f.adapters.getSnapshot().pendingControls?.pin).toBe('high');
      f.panel.dispose();
    },
  );

  it('keeps the framed route row and its padding on the panel background', () => {
    const f = fixture();
    Object.assign(f.theme, {
      bg: (color: string, text: string) =>
        `\x1b[${color === 'toolPendingBg' ? '47' : '42'}m${text}\x1b[49m`,
    });
    const row = f.panel.render(80).find((line) => line.includes('effort high'));
    expect(row).toBeDefined();
    let background = 'default';
    const cells: string[] = [];
    for (const chunk of (row ?? '').split('\x1b')) {
      const sgr = /^\[(\d+)m/u.exec(chunk);
      if (sgr) background = sgr[1] === '49' ? 'default' : (sgr[1] ?? 'default');
      const text = sgr ? chunk.slice(sgr[0].length) : chunk;
      cells.push(...Array.from(text, () => background));
    }
    expect(cells).toEqual(Array(cells.length).fill('47'));
    f.panel.dispose();
  });

  it('shows queued route changes in Now without changing the actual model', () => {
    const f = fixture();
    f.update({ pendingRoutes: true });
    const text = f.panel.render(80).join('\n');
    expect(text).toContain('route edits queued');
    expect(text).toContain('actual unchanged');
    expect(text).toContain('漢字');
    f.panel.dispose();
  });

  it('uses five sections with no edit actions while browsing', () => {
    const f = fixture();
    const text = f.panel.render(80).join('\n');
    expect(text).toContain('Now');
    expect(text).toContain('Usage');
    expect(text).toContain('Settings');
    expect(text).toContain('Classifier');
    expect(text).toContain('Routes');
    expect(text).not.toContain('Apply');
    expect(text).not.toContain('Discard');
    f.panel.dispose();
  });
  it('shows adaptive review and switch-policy controls in Advanced settings', () => {
    const f = fixture();
    f.panel.selectTab('settings');
    f.panel.advanced = true;
    const text = f.panel.render(80).join('\n');
    expect(text).not.toContain('Classifier review interval');
    expect(text).toContain('Cost comparison horizon');
    expect(text).toContain('Switch-cost sensitivity');
    expect(text).toContain('Strong-advice override threshold');
    f.panel.selectTab('classifier');
    expect(f.panel.render(80).join('\n')).toContain(
      'Classifier review interval',
    );
    f.panel.dispose();
  });
  it('starts Settings with only pin visible until Advanced is opened', () => {
    const f = fixture();
    f.panel.selectTab('settings');
    const text = f.panel.render(80).join('\n');
    expect(text).toContain('Pin tier');
    expect(text).toContain('Advanced');
    expect(text).not.toContain('thinkingHigh');
    f.panel.dispose();
  });
});

describe('ui/inspector.ts', () => {
  it.each([40, 60, 80, 120])(
    'fits Unicode at %i columns and short heights',
    (width) => {
      const f = fixture();
      for (const tab of [0, 1, 2]) {
        if (tab) f.panel.handleInput('\x1b[C');
        const lines = f.panel.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.length).toBeLessThanOrEqual(22);
      }
      Object.assign(f.tui.terminal, { rows: 5 });
      expect(f.panel.render(width).length).toBeLessThanOrEqual(3);
      f.panel.dispose();
    },
  );
  it('paints complete rows with explicit theme text color for light backgrounds', () => {
    const f = fixture();
    const fg = vi.spyOn(f.theme, 'fg');
    const rows = f.panel.render(60);
    expect(rows.every((row) => visibleWidth(row) === 60)).toBe(true);
    expect(fg).toHaveBeenCalledWith(
      'text',
      expect.stringContaining('Actual generation'),
    );
    f.panel.dispose();
  });
  it('accepts existing positive fractional deadlines without blocking unrelated edits', async () => {
    const f = fixture();
    f.update({ controls: { ...controls, timeout: 1500.5 } });
    const draft = new RouterUIDraft(f.adapters);
    draft.draft.pin = 'high';
    await draft.apply();
    expect(f.adapters.getSnapshot().pendingControls).toMatchObject({
      pin: 'high',
      timeout: 1500.5,
    });
    f.panel.dispose();
  });
  it('honors the requested text-mode section', async () => {
    const f = fixture();
    const custom = vi.fn();
    const ctx = { mode: 'rpc', ui: { custom } } as unknown as ExtensionContext;
    expect(await openRouterInspector(ctx, f.adapters, 'settings')).toContain(
      'Approved models: none',
    );
    expect(await openRouterInspector(ctx, f.adapters, 'settings')).toContain(
      'High effort (all activities):',
    );
    expect(await openRouterInspector(ctx, f.adapters, 'usage')).toContain(
      'Retained active-branch history:',
    );
    expect(custom).not.toHaveBeenCalled();
    f.panel.dispose();
  });
  it('does not mutate controls while browsing; drafts persist between tabs', () => {
    const f = fixture();
    f.panel.handleInput('1');
    expect(f.panel.render(80).join('\n')).toContain('Actual generation');
    f.panel.selectTab('settings');
    f.panel.handleInput('\t'); // pin
    f.panel.handleInput('\r');
    expect(f.draft.draft.pin).toBe('high');
    expect(f.adapters.getSnapshot().controls.pin).toBe('auto');
    f.panel.handleInput('[Z'); // back to tabs
    f.panel.selectTab('usage');
    expect(f.panel.render(80).join('\n')).toContain(
      'Retained generation decisions',
    );
    f.panel.selectTab('settings');
    expect(f.panel.render(80).join('\n')).toContain('Pin tier: high');
    expect(f.draft.draft.pin).toBe('high');
    expect(f.adapters.applyControls).not.toHaveBeenCalled();
    f.panel.dispose();
  });
  it('apply queues next controls, not actual; discard resets and undo preserves outside changes', async () => {
    const f = fixture();
    const actual = f.adapters.getSnapshot().actual;
    f.draft.draft.pin = 'high';
    f.draft.draft.advisor = 'clef';
    await f.draft.apply();
    expect(f.adapters.getSnapshot().actual).toEqual(actual);
    expect(f.adapters.getSnapshot().pendingControls?.advisor).toBe('clef');
    expect(f.adapters.getSnapshot().privacy.advisorEnabled).toBe(false);
    expect(f.draft.message).toContain('next user turn');
    f.update({
      pendingControls: {
        ...(f.adapters.getSnapshot().pendingControls as RouterUIControls),
        advisor: 'clef-flash',
        budget: 30,
      },
    });
    await f.draft.undo();
    expect(f.adapters.getSnapshot().pendingControls?.pin).toBe('auto');
    expect(f.adapters.getSnapshot().pendingControls?.advisor).toBe(
      'clef-flash',
    );
    expect(f.adapters.getSnapshot().pendingControls?.budget).toBe(30);
    f.draft.draft.pin = 'low';
    f.draft.discard();
    expect(f.draft.draft.pin).toBe('auto');
    f.panel.dispose();
  });
  it('conflicts do not silently replace external controls and invalid edits do not apply', async () => {
    const f = fixture();
    f.draft.draft.pin = 'high';
    f.update({ controls: { ...controls, pin: 'low' } });
    await f.draft.apply();
    expect(f.draft.message).toContain('outside editor');
    f.draft.draft.budget = 0;
    await f.draft.apply();
    expect(f.draft.message).toContain('Budget');
    expect(f.adapters.applyControls).toHaveBeenCalledTimes(1);
    f.panel.dispose();
  });
  it('close and lifecycle abort dispose once, ignore stale callbacks and resolve done', () => {
    const f = fixture();
    f.panel.handleInput('\x1b');
    f.panel.handleInput('\x1b');
    expect(f.done).toHaveBeenCalledOnce();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    f.update({ lifecycle: 'cancelled' });
    expect(f.done).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const panel = new RouterUIInspector(
      f.tui,
      f.theme,
      { ...f.adapters, signal: controller.signal },
      f.draft,
      f.done,
      false,
    );
    controller.abort();
    panel.dispose();
    expect(f.done).toHaveBeenCalledTimes(2);
  });
  it('rebuilds theme output on invalidation and refreshes observations separately from drafts', () => {
    const f = fixture();
    expect(f.panel.render(80).join('\n')).not.toContain('LIGHT');
    f.tint('LIGHT');
    f.panel.invalidate();
    expect(f.panel.render(80).join('\n')).toContain('LIGHT');
    f.draft.draft.pin = 'high';
    f.update({
      lifecycle: 'fallback',
      advised: {
        tier: 'high',
        model: 'primary',
        provider: 'test',
        thinking: 'high',
      },
    });
    const text = f.panel.render(80).join('\n');
    expect(text).toContain('Actual generation · fallback');
    expect(text).toContain('Proposed · high');
    expect(text).toContain('base · medium · effort high');
    expect(f.draft.draft.pin).toBe('high');
    f.panel.dispose();
  });
  it.each([
    'choosing',
    'timeout',
    'continuation',
    'fallback',
    'budget',
    'cancelled',
    'off',
    'idle',
  ] as const)('labels %s with unknown observations honestly', (lifecycle) => {
    const f = fixture();
    f.update({ lifecycle, actual: undefined, advice: undefined });
    expect(formatRouterUISnapshot(f.adapters.getSnapshot())).toContain(
      lifecycle,
    );
    expect(f.panel.render(80).join('\n')).toContain('unknown');
    f.panel.dispose();
  });
  it('counts retained requests separately from HTTP attempts and reuse with unknown costs', () => {
    const advice = {
      advisor: 'clef' as const,
      outcome: 'deadline' as const,
      requestId: 'local',
      httpAttempts: 2,
    };
    const history = [
      {
        advice,
        generationCostUsd: 0.2,
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 70,
        cacheWriteTokens: 10,
        actual: {
          tier: 'medium' as const,
          activity: 'code' as const,
          provider: 'test',
          model: 'm',
          thinking: 'high' as const,
        },
      },
      { advice, reuse: 'continuation' as const },
      {
        advice: {
          advisor: 'classifier' as const,
          outcome: 'selected' as const,
        },
      },
    ];
    const text = formatRouterUIUsage(history).join('\n');
    expect(text).toContain('Unique advice requests: 1');
    expect(text).toContain('HTTP attempts: 2');
    expect(text).toContain('Route reuses: 1');
    expect(text).toContain('coverage 1/3');
    expect(text).toContain('unknown (not free)');
    expect(text).toContain('Cache-read share, last observed request: 70%');
    expect(text).toContain('Catalog cost / request:');
    expect(text).toContain('Observed activity labels: code 1');
    expect(
      formatRouterUIUsage(Array.from({ length: 70 }, () => ({}))).join('\n'),
    ).toContain('50 decisions');
  });
  it('text/RPC never invokes a terminal factory', async () => {
    const f = fixture();
    const custom = vi.fn();
    const ctx = { mode: 'rpc', ui: { custom } } as unknown as ExtensionContext;
    expect(await openRouterInspector(ctx, f.adapters)).toContain(
      'Terminal inspector requires TUI',
    );
    expect(custom).not.toHaveBeenCalled();
    f.panel.dispose();
  });
  it('scrolls read-only usage and handles responsive reopening', async () => {
    const f = fixture();
    f.panel.selectTab('usage');
    Object.assign(f.tui.terminal, { rows: 10 });
    const before = f.panel.render(40).join('\n');
    f.panel.handleInput('\x1b[6~');
    expect(f.panel.render(40).join('\n')).not.toBe(before);
    Object.assign(f.tui.terminal, { columns: 120 });
    f.panel.render(56);
    await Promise.resolve();
    expect(f.done).toHaveBeenCalledWith('resize');
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it('numeric controls use native Input and retain invalid drafts without applying', () => {
    const f = fixture();
    f.panel.selectTab('settings');
    f.panel.advanced = true;
    for (let i = 0; i < 4; i++) f.panel.handleInput('\t');
    f.panel.handleInput('\x0b'); // Input starts at column zero: delete to end
    f.panel.handleInput('0');
    expect(f.draft.draft.budget).toBe(0);
    expect(f.panel.render(40).join('\n')).toContain('Budget must');
    expect(f.adapters.applyControls).not.toHaveBeenCalled();
    f.panel.dispose();
  });
  it('undo does not discard a new unapplied draft', async () => {
    const f = fixture();
    f.draft.draft.pin = 'high';
    await f.draft.apply();
    f.draft.draft.budget = 20;
    await f.draft.undo();
    expect(f.draft.draft.budget).toBe(20);
    expect(f.adapters.getSnapshot().pendingControls?.pin).toBe('high');
    expect(f.draft.message).toContain('discard');
    f.panel.dispose();
  });
  it('profile replacement completes the interaction and unsubscribes', () => {
    const f = fixture();
    f.update({ profile: 'other' });
    expect(f.done).toHaveBeenCalledWith('close');
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it('entry uses the custom completion callback and corrects initial wide layout from the real TUI', async () => {
    const f = fixture();
    f.panel.dispose();
    Object.assign(f.tui.terminal, { columns: 120 });
    const layouts: boolean[] = [];
    type Factory = (
      tui: TUI,
      theme: Theme,
      bindings: { matches: () => boolean },
      done: (result: 'close' | 'resize') => void,
    ) => RouterUIInspector;
    const custom = vi.fn(
      (factory: Factory, options: { overlay: boolean }) =>
        new Promise<'close' | 'resize'>((resolve) => {
          layouts.push(options.overlay);
          const panel = factory(
            f.tui,
            f.theme,
            { matches: () => false },
            resolve,
          );
          panel.render(options.overlay ? 56 : 120);
          queueMicrotask(() => panel.handleInput('\x1b'));
        }),
    );
    const ctx = { mode: 'tui', ui: { custom } } as unknown as ExtensionContext;
    expect(await openRouterInspector(ctx, f.adapters)).toBeUndefined();
    expect(layouts.at(-1)).toBe(true);
    expect(f.unsubscribe).toHaveBeenCalledTimes(layouts.length + 1);
  });
  it('entry guarantees cleanup when the host custom interaction rejects', async () => {
    const f = fixture();
    f.panel.dispose();
    type Factory = (
      tui: TUI,
      theme: Theme,
      bindings: { matches: () => boolean },
      done: (result: 'close' | 'resize') => void,
    ) => RouterUIInspector;
    const custom = vi.fn(async (factory: Factory) => {
      factory(f.tui, f.theme, { matches: () => false }, () => {});
      throw new Error('host stopped');
    });
    const ctx = { mode: 'tui', ui: { custom } } as unknown as ExtensionContext;
    await expect(openRouterInspector(ctx, f.adapters)).rejects.toThrow(
      'host stopped',
    );
    expect(f.unsubscribe).toHaveBeenCalledTimes(2);
  });
});

describe('native editable route cells in Routes', () => {
  const routeCells: RouterUISnapshot['routeCells'] = [
    {
      activity: 'code',
      tier: 'medium',
      current: {
        state: 'inherited',
        model: 'test/base',
        thinking: 'medium',
        fallbacks: ['test/backup', 'test/last'],
      },
      generic: {
        state: 'inherited',
        model: 'test/base',
        thinking: 'medium',
        fallbacks: ['test/backup', 'test/last'],
      },
      effectiveThinking: 'medium',
    },
    {
      activity: 'debug',
      tier: 'medium',
      current: {
        state: 'override',
        model: 'test/debug',
        thinking: 'low',
        fallbacks: [],
      },
      generic: {
        state: 'inherited',
        model: 'test/base',
        thinking: 'medium',
        fallbacks: ['test/backup', 'test/last'],
      },
      effectiveThinking: 'high',
      tierEffortOverride: 'high',
    },
  ];
  const chatModels: RouterUISnapshot['chatModels'] = [
    {
      model: 'openai/physical-chat',
      name: 'Physical chat',
      efforts: ['off', 'low', 'medium', 'high'],
    },
    {
      model: 'router/auto',
      name: 'Virtual router',
      efforts: ['off', 'medium'],
    },
  ];
  const openRoutes = (panel: RouterUIInspector) => {
    panel.selectTab('routes');
    panel.handleInput('\t');
    panel.handleInput('\r');
  };
  const browseRoutePages = (
    panel: RouterUIInspector,
    width: number,
  ): string => {
    const pages: string[] = [];
    for (let i = 0; i < 20; i++) {
      const text = panel.render(width).join('\n');
      if (text === pages.at(-1)) break;
      pages.push(text);
      panel.handleInput('\x1b[6~');
    }
    return pages.join('\n');
  };

  it('provides a searchable physical model picker and supported cell-effort selector', async () => {
    const f = fixture();
    f.update({ routeCells, chatModels });
    openRoutes(f.panel);
    const overview = browseRoutePages(f.panel, 56);
    expect(overview).toContain('Routes · sparse per-cell session overrides');
    expect(overview).toContain('Configured effort: low');
    expect(overview).toContain('Mapped configured effort: high');
    expect(overview).toContain('applies to every');
    expect(overview).toContain('activity; clear it to use this cell effort.');
    f.panel.handleInput('\t'); // Model
    f.panel.handleInput('\r'); // native model selector
    expect(f.panel.render(56).join('\n')).toContain('openai/physical-chat');
    expect(f.panel.render(56).join('\n')).not.toContain('router/auto');
    for (const key of 'physical-chat') f.panel.handleInput(key);
    f.panel.handleInput('\t'); // native SelectList results
    f.panel.handleInput('\r'); // select model, draft only
    expect(f.draft.routeState('debug', 'medium')).toMatchObject({
      state: 'override',
      model: 'openai/physical-chat',
    });
    expect(f.adapters.applyRoutes).not.toHaveBeenCalled();
    f.panel.handleInput('\t'); // Effort
    f.panel.handleInput('\r'); // supported effort choices
    expect(f.panel.render(56).join('\n')).toContain(
      'Choose an effort supported by this model',
    );
    f.panel.handleInput('\r'); // keep the selected supported low effort
    expect(f.draft.routeState('debug', 'medium').thinking).toBe('low');
    f.panel.handleInput('\t'); // Reset
    f.panel.handleInput('\t'); // Apply routes
    f.panel.handleInput('\r');
    await Promise.resolve();
    expect(f.adapters.applyRoutes).toHaveBeenCalledOnce();
    const transaction = vi.mocked(f.adapters.applyRoutes).mock.calls[0]?.[0];
    expect(transaction?.changes[0]?.after).toMatchObject({
      model: 'openai/physical-chat',
      thinking: 'low',
      fallbacks: [],
    });
    expect(f.adapters.getSnapshot().actual?.model).toBe('漢字-é-🚀');
    f.panel.dispose();
  });

  it('clears an override back to generic inheritance without applying while browsing', async () => {
    const f = fixture();
    f.update({ routeCells, chatModels });
    openRoutes(f.panel);
    expect(f.panel.render(56).join('\n')).toContain('Cell: debug/medium');
    f.panel.handleInput('\t'); // Model
    f.panel.handleInput('\t'); // Effort
    f.panel.handleInput('\t'); // Reset to generic
    f.panel.handleInput('\r');
    expect(f.draft.routeState('debug', 'medium')).toMatchObject({
      state: 'inherited',
      model: 'test/base',
      thinking: 'medium',
      fallbacks: ['test/backup', 'test/last'],
    });
    expect(f.adapters.applyRoutes).not.toHaveBeenCalled();
    expect(f.adapters.getSnapshot().actual?.model).toBe('漢字-é-🚀');
    f.panel.handleInput('\t'); // Apply routes
    f.panel.handleInput('\r');
    await Promise.resolve();
    expect(
      vi.mocked(f.adapters.applyRoutes).mock.calls[0]?.[0].changes[0]?.after,
    ).toBeUndefined();
    f.panel.dispose();
  });

  it.each([40, 60, 80, 120])(
    'keeps native route controls within %i columns at short heights and uses theme colors',
    (columns) => {
      const f = fixture();
      f.panel.dispose();
      Object.assign(f.tui.terminal, { columns, rows: 11 });
      f.update({ routeCells, chatModels });
      const panel = new RouterUIInspector(
        f.tui,
        f.theme,
        f.adapters,
        f.draft,
        f.done,
        columns >= 100,
      );
      openRoutes(panel);
      const fg = vi.spyOn(f.theme, 'fg');
      const width = columns >= 100 ? 56 : columns;
      const lines = panel.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(11);
      expect(fg).toHaveBeenCalledWith(
        'accent',
        expect.stringContaining('Routes'),
      );
      panel.handleInput('\r'); // cell picker
      expect(
        panel.render(width).every((line) => visibleWidth(line) <= width),
      ).toBe(true);
      panel.handleInput('\x1b');
      panel.handleInput('\x1b');
    },
  );
});

describe('read-only activity routes in Routes', () => {
  const cells: RouterUISnapshot['activityCells'] = [
    {
      activity: 'code',
      configured: { tier: 'medium', model: 'test/code', thinking: 'high' },
      fallbacks: ['test/code-backup'],
      availability: 'eligible',
      eligible: {
        tier: 'medium',
        provider: 'test',
        model: 'code',
        thinking: 'medium',
      },
    },
    {
      activity: 'docs',
      configured: { tier: 'micro', model: 'test/docs', thinking: 'off' },
      fallbacks: [],
      availability: 'unavailable',
    },
  ];
  const openAdvanced = (panel: RouterUIInspector) => {
    panel.selectTab('routes');
  };
  const readPages = (panel: RouterUIInspector, width: number): string => {
    const pages: string[] = [];
    for (let i = 0; i < 30; i++) {
      const text = panel.render(width).join('\n');
      if (text === pages.at(-1)) break;
      pages.push(text);
      panel.handleInput('\x1b[6~');
    }
    return pages.join('\n');
  };

  it('shows mode/count in Settings and promotes the override list into Routes', () => {
    const f = fixture();
    f.update({ activityCells: cells });
    f.panel.selectTab('settings');
    const normal = f.panel.render(80).join('\n');
    expect(normal).toContain(
      'Activity routing: on · 2 activity cells · session Routes editor',
    );
    expect(normal).not.toContain('code/medium');
    expect(normal).not.toContain(' | Apply');
    openAdvanced(f.panel);
    const advanced = readPages(f.panel, 80);
    expect(advanced).toContain('Configured activity overrides · not actual');
    expect(advanced).toContain('code/medium: configured test/code');
    expect(advanced).toContain('requested effort high');
    expect(advanced).toContain('Text eligible: test/code · effort medium');
    expect(advanced).toContain('configured fallbacks:');
    expect(advanced).toContain('test/code-backup');
    expect(advanced).toContain('No text-eligible attempt');
    expect(advanced).toContain(
      'Unlisted cells use generic tiers, if configured.',
    );
    expect(advanced).toContain('Generic text-capable routes · not actual');
    expect(advanced).toContain(
      'Generation rechecks input, context and authentication.',
    );
    expect(f.draft.dirty()).toEqual([]);
    expect(f.adapters.applyControls).not.toHaveBeenCalled();
    expect(f.adapters.getSnapshot().actual?.model).toBe('漢字-é-🚀');
    f.panel.dispose();
  });

  it.each([40, 60, 80, 120])(
    'wraps/scrolls the read-only list at %i columns without adding controls',
    (columns) => {
      const f = fixture();
      f.panel.dispose();
      Object.assign(f.tui.terminal, { columns, rows: 24 });
      f.update({ activityCells: cells });
      const wide = columns >= 100;
      const width = wide ? 56 : columns;
      const panel = new RouterUIInspector(
        f.tui,
        f.theme,
        f.adapters,
        f.draft,
        f.done,
        wide,
      );
      openAdvanced(panel);
      const before = panel.render(width).join('\n');
      const text = readPages(panel, width);
      expect(text).toContain('code/medium: configured test/code');
      expect(text).toContain('docs/micro: configured test/docs');
      expect(text).toContain('No text-eligible attempt');
      expect(text).not.toBe(before);
      for (const line of text.split('\n'))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(panel.render(width).length).toBeLessThanOrEqual(
        24 - (wide ? 2 : 8),
      );
      panel.selectTab('settings');
      panel.handleInput('\t');
      expect(panel.render(width).join('\n')).toContain('›Pin tier');
      panel.selectTab('routes');
      panel.handleInput('\x1b[Z'); // Done: no editable cells in this fixture
      expect(panel.render(width).join('\n')).toContain('›Done');
      expect(f.adapters.applyControls).not.toHaveBeenCalled();
      expect(f.draft.dirty()).toEqual([]);
      panel.handleInput('\x1b');
      expect(f.done).toHaveBeenCalledWith('close');
    },
  );

  it('refreshes disabled mode and preserves declarations while leaving actual generation untouched', () => {
    const f = fixture();
    f.update({ activityCells: cells });
    openAdvanced(f.panel);
    readPages(f.panel, 80);
    f.update({
      activityRouting: 'off',
      activityCells: cells.map((cell) => ({
        activity: cell.activity,
        configured: cell.configured,
        fallbacks: cell.fallbacks,
        availability: 'disabled',
      })),
    });
    f.panel.selectTab('routes'); // reset scroll/focus
    const text = readPages(f.panel, 80);
    expect(text).toContain('Activity routing: off');
    expect(text).toContain('Excluded (activity routing off)');
    expect(text).toContain('configured test/code');
    expect(text).not.toContain('Text eligible:');
    expect(f.adapters.getSnapshot().actual?.model).toBe('漢字-é-🚀');
    expect(f.adapters.applyControls).not.toHaveBeenCalled();
    f.panel.dispose();
  });

  it('includes the same read-only details in non-TUI settings without invoking a terminal', async () => {
    const f = fixture();
    f.update({ activityCells: cells });
    const custom = vi.fn();
    const ctx = { mode: 'rpc', ui: { custom } } as unknown as ExtensionContext;
    const text = await openRouterInspector(ctx, f.adapters, 'settings');
    expect(text).toContain('Activity routing: on');
    expect(text).toContain('Configured activity overrides · not actual');
    expect(text).toContain('code/medium: configured test/code');
    expect(custom).not.toHaveBeenCalled();
    expect(f.adapters.applyControls).not.toHaveBeenCalled();
    f.panel.dispose();
  });
});

describe('five-tab routing observability', () => {
  it('cycles every tab and keeps the active tab visible at narrow widths', () => {
    const f = fixture();
    const views = ['now', 'routes', 'classifier', 'usage', 'settings'] as const;
    for (const view of views) {
      expect(f.panel.currentTab()).toBe(view);
      const text = f.panel.render(32).join('\n');
      expect(text.toLowerCase()).toContain(view);
      f.panel.handleInput('\x1b[C');
    }
    expect(f.panel.currentTab()).toBe('now');
    f.panel.handleInput('\x1b[D');
    expect(f.panel.currentTab()).toBe('settings');
    expect(f.adapters.applyControls).not.toHaveBeenCalled();
    f.panel.dispose();
  });

  it('explains classifier approval without Advanced or credential access', () => {
    const f = fixture();
    Object.assign(f.tui.terminal, { rows: 60 });
    f.update({
      controls: { ...controls, advisor: 'typesafe/jev-1.14.0' },
      classifiers: [
        { model: 'typesafe/jev-1.14.0', name: 'Jev 1.14', textInput: true },
      ],
      privacy: { advisorEnabled: true, approvedModels: [], auth: 'unknown' },
    });
    f.panel.selectTab('classifier');
    const text = f.panel.render(80).join('\n');
    expect(text).toContain('typesafe/jev-1.14.0');
    expect(text).toContain('Not approved');
    expect(text).toContain('No classifier calls observed');
    expect(text).toContain('read-only');
    expect(f.adapters.applyControls).not.toHaveBeenCalled();
    f.panel.dispose();
  });

  it('makes logging-off explicit and hides technical usage counters until Details', () => {
    const f = fixture();
    Object.assign(f.tui.terminal, { rows: 60 });
    f.update({ loggingEnabled: false });
    f.panel.selectTab('usage');
    const compact = f.panel.render(80).join('\n');
    expect(compact).toContain('History collection is off');
    expect(compact).toContain('/router log on');
    expect(compact).not.toContain('HTTP attempts:');
    f.panel.handleInput('\t');
    f.panel.handleInput('\r');
    expect(f.panel.render(80).join('\n')).toContain('HTTP attempts:');
    f.panel.dispose();
  });
});

describe('classifier catalog navigation', () => {
  it('cycles every registered classifier in both directions without reordering choices', () => {
    const f = fixture();
    const models = ['a/first', 'b/second', 'z/current'];
    f.update({
      controls: { ...controls, advisor: 'z/current' },
      classifiers: models.map((model) => ({
        model,
        name: model,
        textInput: true,
      })),
    });
    Object.assign(f.draft.base, { advisor: 'z/current' });
    Object.assign(f.draft.draft, { advisor: 'z/current' });
    f.panel.selectTab('classifier');
    f.panel.handleInput('\t');
    for (const expected of [
      undefined,
      'a/first',
      'b/second',
      'z/current',
      undefined,
    ]) {
      f.panel.handleInput('\x1b[C');
      expect(f.draft.draft.advisor).toBe(expected);
    }
    f.panel.handleInput('\x1b[D');
    expect(f.draft.draft.advisor).toBe('z/current');
    expect(f.adapters.applyControls).not.toHaveBeenCalled();
    f.panel.dispose();
  });
});

describe('route metadata and classifier input safety', () => {
  it('confirming an unchanged route preserves an override with distinct metadata', () => {
    const f = fixture();
    f.update({
      routeCells: [
        {
          activity: 'code',
          tier: 'medium',
          current: {
            state: 'override',
            revision: 'special-capabilities',
            model: 'test/a',
            thinking: 'medium',
            fallbacks: [],
          },
          generic: {
            state: 'inherited',
            revision: 'generic-capabilities',
            model: 'test/a',
            thinking: 'medium',
            fallbacks: [],
          },
        },
      ],
    });
    f.draft.editRoute('code', 'medium', {
      model: 'test/a',
      thinking: 'medium',
    });
    expect(f.draft.dirtyRoutes()).toEqual([]);
    expect(f.draft.routeState('code', 'medium')).toMatchObject({
      state: 'override',
      revision: 'special-capabilities',
    });
    expect(f.adapters.applyRoutes).not.toHaveBeenCalled();
    f.panel.dispose();
  });
  it('does not offer non-text classifiers and offers none as an explicit session selection', () => {
    const f = fixture();
    f.update({
      controls: { ...controls, advisor: 'fixture/text' },
      classifiers: [
        { model: 'fixture/image-only', name: 'Image-only', textInput: false },
        { model: 'fixture/text', name: 'Text', textInput: true },
      ],
    });
    Object.assign(f.draft.base, { advisor: 'fixture/text' });
    Object.assign(f.draft.draft, { advisor: 'fixture/text' });
    f.panel.selectTab('classifier');
    f.panel.handleInput('\t');
    f.panel.handleInput('\x1b[C');
    expect(f.draft.draft.advisor).toBeUndefined();
    f.panel.handleInput('\x1b[C');
    expect(f.draft.draft.advisor).toBe('fixture/text');
    f.panel.dispose();
  });
});

it.each([true, false])(
  'reset-to-generic suppresses a built-in cell when the physical pair is identical=%s',
  async (identical) => {
    const f = fixture();
    f.update({
      routeCells: [
        {
          activity: 'code',
          tier: 'high',
          current: {
            state: 'builtin',
            model: 'test/strong',
            thinking: 'high',
            fallbacks: [],
          },
          generic: {
            state: 'inherited',
            model: identical ? 'test/strong' : 'test/base',
            thinking: 'high',
            fallbacks: [],
          },
        },
      ],
    });
    f.draft.resetRoute('code', 'high');
    expect(f.draft.routeState('code', 'high')).toMatchObject({
      state: 'inherited',
      model: identical ? 'test/strong' : 'test/base',
    });
    expect(f.adapters.applyRoutes).not.toHaveBeenCalled();
    await f.draft.applyRoutes();
    expect(f.adapters.applyRoutes).toHaveBeenCalledOnce();
    expect(
      vi.mocked(f.adapters.applyRoutes).mock.calls[0]?.[0].changes[0]?.after,
    ).toBeUndefined();
    f.panel.dispose();
  },
);

it('exposes session mode beside pin and keeps Apply/Undo scoped to the queued change', async () => {
  const f = fixture();
  f.panel.selectTab('settings');
  expect(f.panel.render(80).join('\n')).toContain(
    'Session mode: inherit (project/profile)',
  );
  f.panel.handleInput('\t');
  f.panel.handleInput('\t');
  f.panel.handleInput('\x1b[C');
  expect(f.draft.draft.mode).toBe('cost');
  expect(f.panel.render(80).join('\n')).toContain(
    'Draft mode: inherit (project/profile) → cost',
  );
  expect(f.panel.render(80).join('\n')).toContain('Session mode: cost');
  await f.draft.apply();
  expect(f.adapters.getSnapshot().pendingControls?.mode).toBe('cost');
  expect(f.adapters.getSnapshot().mode.mode).toBe('balanced');
  await f.draft.undo();
  expect(f.adapters.getSnapshot().pendingControls?.mode).toBeUndefined();
  expect(f.adapters.getSnapshot().actual?.model).toBe('漢字-é-🚀');
  f.panel.dispose();
});
