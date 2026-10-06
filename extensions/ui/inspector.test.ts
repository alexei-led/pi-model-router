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
  validateRouterUIControls,
} from './inspector';

const controls: RouterUIControls = {
  pin: 'auto',
  baseline: 'medium',
  budget: 5,
  advisor: 'jev',
  timeout: 1500,
  thinkingHigh: undefined,
  thinkingMedium: undefined,
  thinkingLow: undefined,
  thinkingMicro: undefined,
};
const fixture = () => {
  let snapshot: RouterUISnapshot = {
    profile: '仕事👨‍👩‍👧‍👦',
    lifecycle: 'generating',
    controls: { ...controls },
    actual: {
      tier: 'medium',
      provider: 'test',
      model: '漢字-é-🚀',
      thinking: 'high',
    },
    eligible: {},
    history: [],
    privacy: {
      jevApproved: undefined,
      cloudflareApproved: false,
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

  it('uses three sections with no edit actions while browsing', () => {
    const f = fixture();
    const text = f.panel.render(80).join('\n');
    expect(text).toContain('Now');
    expect(text).toContain('Usage');
    expect(text).toContain('Settings');
    expect(text).not.toContain('Classifier');
    expect(text).not.toContain('Apply');
    expect(text).not.toContain('Discard');
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
      'Cloudflare approval: false',
    );
    expect(await openRouterInspector(ctx, f.adapters, 'settings')).toContain(
      'High effort:',
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
    expect(f.panel.render(80).join('\n')).toContain('retained');
    f.panel.selectTab('settings');
    expect(f.panel.render(80).join('\n')).toContain('Pin tier: high');
    expect(f.draft.draft.pin).toBe('high');
    expect(f.adapters.applyControls).not.toHaveBeenCalled();
    f.panel.dispose();
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid budget %s',
    (budget) => {
      expect(validateRouterUIControls({ ...controls, budget })).toContain(
        'Budget',
      );
    },
  );
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2147483648])(
    'rejects invalid timeout %s',
    (timeout) => {
      expect(validateRouterUIControls({ ...controls, timeout })).toContain(
        'Timeout',
      );
    },
  );
  it('allows uncapped positive finite budgets and Node timer maximum', () => {
    expect(
      validateRouterUIControls({
        ...controls,
        budget: 1e100,
        timeout: 2147483647,
      }),
    ).toBeUndefined();
  });
  it('apply queues next controls, not actual; discard resets and undo preserves outside changes', async () => {
    const f = fixture();
    const actual = f.adapters.getSnapshot().actual;
    f.draft.draft.pin = 'high';
    f.draft.draft.advisor = 'clef';
    await f.draft.apply();
    expect(f.adapters.getSnapshot().actual).toEqual(actual);
    expect(f.adapters.getSnapshot().pendingControls?.advisor).toBe('clef');
    expect(f.adapters.getSnapshot().privacy.cloudflareApproved).toBe(false);
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
    expect(text).toContain('Advised (not actual): high');
    expect(text).toContain('Tier medium');
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
      { advice, generationCostUsd: 0.2 },
      { advice, reuse: 'continuation' as const },
      { advice: { advisor: 'jev' as const, outcome: 'selected' as const } },
    ];
    const text = formatRouterUIUsage(history).join('\n');
    expect(text).toContain('Unique advice requests: 1');
    expect(text).toContain('HTTP attempts: 2');
    expect(text).toContain('Route reuses: 1');
    expect(text).toContain('coverage 1/3');
    expect(text).toContain('unknown (not free)');
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
    for (let i = 0; i < 3; i++) f.panel.handleInput('\t');
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
