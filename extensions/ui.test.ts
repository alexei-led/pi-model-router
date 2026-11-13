import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import type { RouterUISnapshot, RoutingDecision } from './types';
import {
  formatAdvisorDetail,
  formatClassifierStats,
  formatDecision,
  formatGenerationDetail,
  formatModelRef,
  formatPinSummary,
  formatThinkingSummary,
  updateRouterUIStrip,
} from './ui';

const decision: RoutingDecision = {
  profile: 'p',
  tier: 'medium',
  targetProvider: 'test',
  targetModelId: 'model',
  targetLabel: 'test/model',
  thinking: 'medium',
  reasonCode: 'baseline',
  timestamp: 1,
};

const context = () =>
  ({
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
    },
  }) as unknown as ExtensionContext;

const widget = (ctx: ExtensionContext): string[] => {
  const content = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1];
  if (typeof content === 'function')
    return content({} as TUI, ctx.ui.theme as Theme).render(120);
  return content ?? [];
};

describe('ui.ts', () => {
  it('keeps cache and hypothetical cost diagnostics in the log, not the status strip', () => {
    const generation = {
      transition: 'model-switch' as const,
      contextTruncated: false,
      attempts: 1,
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      shadow: {
        previousModel: 'test/old',
        stayAllReadUsd: 0.1,
        stayAllNewUsd: 1,
        switchAllReadUsd: 0.05,
        switchAllNewUsd: 0.5,
      },
    };
    const detail = formatGenerationDetail({ ...decision, generation });
    expect(detail).toContain('cache-read=800');
    expect(detail).toContain('cost unknown (catalog)');
    expect(detail).not.toContain('future cache warmth');
    expect(detail).toContain(
      'same tokens, all read / all new: stay test/old $0.1000 / $1.0000, switch $0.0500 / $0.5000',
    );
    expect(detail).toContain('not predicted savings');
    expect(
      formatGenerationDetail({
        ...decision,
        generation: { ...generation, reportedCostUsd: 0.0042 },
      }),
    ).toContain('cost $0.0042 (catalog)');
    expect(formatDecision({ ...decision, generation })).toContain(detail);
    const truncated = formatGenerationDetail({
      ...decision,
      generation: { ...generation, contextTruncated: true, shadow: undefined },
    });
    expect(truncated).toContain('context truncated');
    expect(truncated).toContain('same-token comparison unavailable');
  });

  it('formats only fixed local decision metadata', () => {
    expect(formatDecision(decision)).toBe(
      'p: medium → test/model [medium] (baseline)',
    );
    expect(
      formatDecision({
        ...decision,
        advisor: 'classifier',
      } as unknown as RoutingDecision),
    ).toContain('[classifier ✓]');
    expect(formatModelRef('openai/gpt-4o')).toBe('openai/gpt-4o');
    expect(formatModelRef(undefined)).toBe('none');
  });

  it('renders a [failed] marker for a debugHistory entry flagged as a total generation failure', () => {
    expect(formatDecision({ ...decision, isGenerationFailed: true })).toBe(
      'p: medium → test/model [medium] [failed] (baseline)',
    );
  });

  it.each([
    ['none', 'baseline only'],
    ['classifier', 'classifier ✓'],
    ['classifier-fallback', 'classifier · baseline kept'],
  ] as const)('labels the %s advisor outcome as %s', (advisor, label) => {
    expect(formatAdvisorDetail({ ...decision, advisor })).toBe(label);
  });

  it('formats the classifier deadline as a short duration', () => {
    const detail = formatAdvisorDetail({
      ...decision,
      advisor: 'classifier-fallback',
      classification: { outcome: 'deadline', latencyMs: 412, timeoutMs: 10000 },
    });
    expect(detail).toContain('deadline=10 s');
    expect(detail).not.toContain('10000ms');
    expect(detail?.endsWith('412 ms')).toBe(true);
  });

  it('labels uncertainty once in the detail', () => {
    const detail = formatAdvisorDetail({
      ...decision,
      advisor: 'classifier-fallback',
      classification: {
        outcome: 'uncertain',
        choice: 'uncertain',
        confidence: 0.73,
        latencyMs: 860,
        threshold: 0.65,
      },
    });
    expect(detail).toContain('could not judge the required capability');
    expect(detail).toContain('abstention-confidence=73%');
    expect(detail).not.toContain('threshold');
  });

  it.each([
    'deadline',
    'network-error',
    'invalid-response',
    'http-error',
    'cancelled',
    'input-too-large',
  ] as const)(
    'explains %s with fixed codes and no raw error data',
    (outcome) => {
      const detail = formatAdvisorDetail({
        ...decision,
        advisor: 'classifier-fallback',
        classification: { outcome, latencyMs: 5000, httpStatus: 429 },
      });
      expect(detail).toBe(
        `classifier · baseline kept · ${outcome} · HTTP 429 · Transient Classifier limit; retries are bounded by the advisory budget. · 5 s`,
      );
    },
  );

  it('counts unique requests, not shared calls, cached calls or tool continuations', () => {
    const first: RoutingDecision = {
      ...decision,
      classification: {
        requestId: '00000000-0000-4000-8000-000000000001',
        outcome: 'selected',
        choice: 'high',
        latencyMs: 100,
      },
    };
    const second: RoutingDecision = {
      ...decision,
      classification: {
        requestId: '00000000-0000-4000-8000-000000000002',
        outcome: 'deadline',
        latencyMs: 5000,
      },
    };
    const history: RoutingDecision[] = [
      first,
      { ...first, reuse: 'shared' },
      { ...first, reuse: 'same-turn' },
      { ...first, reuse: 'continuation' },
      second,
      { ...second, reuse: 'continuation' },
      decision,
      {
        ...decision,
        classification: { outcome: 'selected', choice: 'low', latencyMs: 200 },
      },
    ];
    const stats = formatClassifierStats(history).join('\n');
    expect(stats).toContain('2 unique advice requests in 8 retained decisions');
    expect(stats).toContain('selected: 1/2 (50%)');
    expect(stats).toContain('deadline: 1/2 (50%)');
    expect(stats).toContain('Advised tiers: micro=0, low=0, medium=0, high=1.');
    expect(stats).toContain('Median classifier latency: 2.5 s');
    expect(stats).toContain('1 decisions without request IDs excluded');
    expect(stats).not.toContain('00000000');
    expect(formatClassifierStats([]).join('\n')).toContain(
      'Median classifier latency: n/a',
    );
    expect(formatClassifierStats([]).join('\n')).not.toContain('NaN');
  });

  it('shows context composition without persisting or rendering input text', () => {
    const detail = formatAdvisorDetail({
      ...decision,
      advisor: 'classifier',
      classification: {
        outcome: 'selected',
        latencyMs: 100,
        estimatedInputTokens: 700,
        actualInputTokens: 640,
        context: {
          currentRequestTokens: 20,
          historyTokens: 225,
          toolTokens: 50,
          historyTurns: 2,
          toolResults: 1,
          truncatedBlocks: 1,
        },
      },
    });
    expect(detail).toContain(
      'state≈295 tokens: 20 current + 225 dialogue/2 turns + 50 tool/1 results; truncated=1',
    );
    expect(detail).toContain('request≈700 tokens');
    expect(detail).toContain('Classifier usage=640 input tokens');
  });

  it('formats sorted pins and thinking overrides', () => {
    expect(formatPinSummary({ cheap: 'low', p: 'medium' })).toBe(
      'cheap:low, p:medium',
    );
    expect(formatThinkingSummary({ p: { medium: 'low' } })).toBe(
      'p(medium:low)',
    );
  });
});

const withColumns = (columns: number, run: () => void) => {
  const previous = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    value: columns,
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(process.stdout, 'columns', previous);
    else Reflect.deleteProperty(process.stdout, 'columns');
  }
};

describe('ui.ts lifecycle strip', () => {
  const sonnet = {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    tier: 'medium' as const,
    activity: 'code' as const,
    thinking: 'medium' as const,
  };
  const footer = (
    state: Partial<RouterUISnapshot>,
    preferences: Parameters<typeof updateRouterUIStrip>[2] = {
      widgetEnabled: false,
    },
  ): string => {
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(ctx, { ...snapshot, ...state }, preferences);
    return vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)?.[1] ?? '';
  };

  it.each([
    [80, '▂▄▆ Sonnet 5.5 · medium  code'],
    [40, '▂▄▆ Sonnet 5.5 · medium  code'],
    [24, '▂▄▆ Sonnet 5.5 · medium'],
  ])(
    'keeps the footer core and drops the activity first at %i columns',
    (columns, expected) => {
      withColumns(columns, () => {
        const text = footer({ lifecycle: 'idle', actual: sonnet });
        expect(text).toBe(expected);
        expect(visibleWidth(text)).toBeLessThanOrEqual(Math.min(columns, 40));
      });
    },
  );

  it('never grows the footer past 40 columns on a wide terminal', () => {
    withColumns(200, () => {
      const text = footer({
        lifecycle: 'generating',
        pendingRoutes: true,
        actual: {
          ...sonnet,
          model: 'a-very-long-model-identifier-for-testing',
        },
      });
      expect(visibleWidth(text)).toBeLessThanOrEqual(40);
    });
  });

  it.each([
    ['pending routes', { pendingRoutes: true }, '⏵'],
    ['fallback', { lifecycle: 'fallback' as const }, '!'],
    ['timeout', { lifecycle: 'timeout' as const }, '!'],
    ['budget', { lifecycle: 'budget' as const }, '!'],
    ['failed', { lifecycle: 'failed' as const }, '!'],
  ])('marks the footer for %s with %s only', (_name, state, marker) => {
    withColumns(80, () => {
      expect(footer({ lifecycle: 'idle', actual: sonnet, ...state })).toBe(
        `${marker} ▂▄▆ Sonnet 5.5 · medium  code`,
      );
    });
  });

  it('shows no marker, mode text or status words on a calm footer', () => {
    withColumns(80, () => {
      const text = footer({
        lifecycle: 'idle',
        actual: sonnet,
        mode: { mode: 'cost', source: 'session' },
        switchCost: {
          reason: 'cost-held',
          horizonRequests: 5,
          confidenceOverride: false,
        },
        advice: { advisor: 'classifier', outcome: 'selected', latencyMs: 9 },
      });
      expect(text).toBe('▂▄▆ Sonnet 5.5 · medium  code');
    });
  });

  it('names the profile when no route has been observed', () => {
    withColumns(80, () => {
      expect(footer({ lifecycle: 'idle' })).toBe('Router · p');
    });
  });

  it('shows provider/model on the detailed footer and cuts it at 40 columns', () => {
    withColumns(80, () => {
      const text = footer(
        { lifecycle: 'idle', actual: sonnet },
        { widgetEnabled: false, statusLine: 'detailed' },
      );
      expect(text.startsWith('▂▄▆ anthropic/claude-sonnet-5-5')).toBe(true);
      expect(visibleWidth(text)).toBeLessThanOrEqual(40);
    });
  });

  it('clears the footer and the widget when the router is off', () => {
    for (const widgetEnabled of [true, false]) {
      const ctx = context();
      Object.assign(ctx, { mode: 'tui' });
      updateRouterUIStrip(
        ctx,
        { ...snapshot, lifecycle: 'off', actual: sonnet },
        { widgetEnabled },
      );
      expect(ctx.ui.setStatus).toHaveBeenLastCalledWith('router', undefined);
      expect(ctx.ui.setWidget).toHaveBeenLastCalledWith('router', undefined);
    }
  });

  it.each(['classifier', 'clef', 'clef-flash', 'classifier'] as const)(
    'shows %s advice through one persistent surface and leaves other statuses alone',
    (advisor) => {
      const ctx = context();
      Object.assign(ctx, { mode: 'tui' });
      updateRouterUIStrip(
        ctx,
        {
          ...snapshot,
          lifecycle: 'generating',
          actual: {
            tier: 'medium',
            provider: 'test',
            model: 'actual-model',
            thinking: 'high',
          },
          advice: { advisor, outcome: 'selected', latencyMs: 42 },
        },
        { widgetEnabled: true },
      );
      expect(ctx.ui.setStatus).toHaveBeenCalledExactlyOnceWith(
        'router',
        undefined,
      );
      expect(widget(ctx)).toEqual([
        '▂▄▆ Actual Model · high  = fits',
        'p · balanced (default) · classifier 42 ms',
      ]);
      updateRouterUIStrip(
        ctx,
        { ...snapshot, lifecycle: 'off' },
        { widgetEnabled: true },
      );
      expect(ctx.ui.setWidget).toHaveBeenLastCalledWith('router', undefined);
    },
  );
  it('keeps actual generation separate from pending controls', () => {
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(
      ctx,
      {
        ...snapshot,
        lifecycle: 'generating',
        actual: {
          tier: 'medium',
          provider: 'test',
          model: 'actual-medium',
          thinking: 'medium',
        },
        pendingControls: { ...snapshot.controls, pin: 'high' },
      },
      { widgetEnabled: true },
    );
    expect(widget(ctx)).toEqual([
      '▂▄▆ Actual Medium · medium  = baseline',
      '⏵ next turn: pin high · p · balanced (default)',
    ]);
  });

  it.each([
    ['pin', { pin: 'high' as const }, undefined, '⏵ next turn: pin high'],
    ['setting', { budget: 3 }, undefined, '⏵ next turn: settings changed'],
    ['route edits', undefined, true, '⏵ next turn: route edits queued'],
  ])(
    'labels queued %s changes on the second widget line',
    (_name, patch, pendingRoutes, label) => {
      const ctx = context();
      Object.assign(ctx, { mode: 'tui' });
      updateRouterUIStrip(
        ctx,
        {
          ...snapshot,
          lifecycle: 'generating',
          actual: sonnet,
          ...(patch
            ? { pendingControls: { ...snapshot.controls, ...patch } }
            : {}),
          ...(pendingRoutes ? { pendingRoutes } : {}),
        },
        { widgetEnabled: true },
      );
      expect(widget(ctx)[1]).toBe(`${label} · p · balanced (default)`);
    },
  );

  it('keeps cost off the widget, including in detailed mode', () => {
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(
      ctx,
      {
        ...snapshot,
        lifecycle: 'generating',
        accumulatedCost: 1.24,
        actual: sonnet,
        controls: { ...snapshot.controls, budget: 5 },
      },
      { widgetEnabled: true, statusLine: 'detailed' },
    );
    const text = widget(ctx).join('\n');
    expect(text).not.toContain('$');
    expect(text).not.toContain('recorded');
    expect(widget(ctx)[0]).toBe(
      '▂▄▆ anthropic/claude-sonnet-5-5 · medium  code  = baseline',
    );
  });

  it.each([
    [120, '▂▄▆ Sonnet 5.5 · medium  code  = baseline'],
    [36, '▂▄▆ Sonnet 5.5 · medium  = baseline'],
    [24, '▂▄▆ Sonnet 5.5 · medium'],
  ])(
    'drops activity, then reason, then cuts the widget core at %i columns',
    (width, expected) => {
      const ctx = context();
      Object.assign(ctx, { mode: 'tui' });
      updateRouterUIStrip(
        ctx,
        { ...snapshot, lifecycle: 'idle', actual: sonnet },
        { widgetEnabled: true },
      );
      const content = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1];
      if (typeof content !== 'function')
        throw new Error('Expected strip component');
      expect(content({} as TUI, ctx.ui.theme as Theme).render(width)[0]).toBe(
        expected,
      );
    },
  );

  it('logs the mode, its lever and an escalation', () => {
    expect(
      formatDecision({
        ...decision,
        reasonCode: 'escalation',
        escalatedFrom: 'low',
        mode: 'cost',
        modeSource: 'project',
        modeLever: 'model',
        modeSourceTier: 'low',
      }),
    ).toContain(
      '(escalation) {mode cost (project) · model lever from low} {escalated from low}',
    );
    expect(
      formatDecision({
        ...decision,
        mode: 'balanced',
        modeSource: 'default',
        modeLever: 'none',
      }),
    ).toContain('{mode balanced (default)}');
  });

  it('falls back to one footer status when the widget is hidden', () => {
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(ctx, snapshot, { widgetEnabled: false });
    expect(ctx.ui.setWidget).toHaveBeenCalledWith('router', undefined);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith('router', 'Router · p');
  });

  const snapshot: RouterUISnapshot = {
    profile: 'p',
    lifecycle: 'choosing',
    mode: { mode: 'balanced', source: 'default' },
    policySources: {
      costHorizon: 'config',
      costSensitivity: 'config',
      strongAdviceConfidence: 'config',
    },
    controls: {
      pin: 'auto',
      baseline: 'medium',
      budget: undefined,
      advisor: 'classifier',
      timeout: 1500,
      reviewEveryRequests: 4,
      costHorizon: 5,
      costSensitivity: 0.5,
      strongAdviceConfidence: 0.9,
      thinkingHigh: undefined,
      thinkingMedium: undefined,
      thinkingLow: undefined,
      thinkingMicro: undefined,
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
  it('shows the mode and its source in the widget only, never in the footer', () => {
    const moded: RouterUISnapshot = {
      ...snapshot,
      mode: { mode: 'cost', source: 'session' },
    };
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(ctx, moded, { widgetEnabled: true });
    expect(widget(ctx).join('\n')).toContain('p · cost (session)');
    const prior = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    try {
      for (const columns of [80, 60]) {
        Object.defineProperty(process.stdout, 'columns', {
          configurable: true,
          value: columns,
        });
        const footer = context();
        Object.assign(footer, { mode: 'tui' });
        updateRouterUIStrip(footer, moded, { widgetEnabled: false });
        const text =
          vi.mocked(footer.ui.setStatus).mock.calls.at(-1)?.[1] ?? '';
        expect(text).toBe('Router · p');
      }
    } finally {
      if (prior) Object.defineProperty(process.stdout, 'columns', prior);
      else Reflect.deleteProperty(process.stdout, 'columns');
    }
  });

  it('shows a mode bypass in the widget', () => {
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(
      ctx,
      {
        ...snapshot,
        mode: { mode: 'cost', source: 'profile' },
        modeBypass: 'pin',
      },
      { widgetEnabled: true },
    );
    expect(widget(ctx).join('\n')).toContain(
      'cost (profile) · bypassed by pin',
    );
  });

  it('cuts the core only when even it does not fit', () => {
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(
      ctx,
      { ...snapshot, lifecycle: 'idle', actual: sonnet },
      { widgetEnabled: true },
    );
    const content = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1];
    if (typeof content !== 'function')
      throw new Error('Expected strip component');
    const line = content({} as TUI, ctx.ui.theme as Theme).render(12)[0] ?? '';
    expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    expect(line.startsWith('▂▄▆ Sonne')).toBe(true);
    expect(line).not.toContain('baseline');
  });

  it.each([40, 60, 80, 120])(
    'prioritizes actual routes and fits %i columns',
    (width) => {
      const ctx = context();
      Object.assign(ctx, { mode: 'tui' });
      updateRouterUIStrip(
        ctx,
        {
          ...snapshot,
          lifecycle: 'fallback',
          actual: {
            tier: 'high',
            provider: 'test',
            model: '漢字🚀fallback',
            thinking: 'high',
          },
        },
        { widgetEnabled: true, statusLine: 'detailed' },
      );
      const content = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1];
      if (typeof content !== 'function')
        throw new Error('Expected strip component');
      const lines = content({} as TUI, ctx.ui.theme).render(width);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines[0]).toContain('漢字🚀fallback');
      expect(lines[0]).toContain('fallback');
    },
  );
  it('renders choosing without a stale route, preserves widget toggles and avoids RPC', () => {
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(ctx, snapshot, { widgetEnabled: true });
    expect(widget(ctx)).toEqual([
      'Router · p  … choosing',
      'p · balanced (default)',
    ]);
    updateRouterUIStrip(ctx, snapshot, { widgetEnabled: false });
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith('router', undefined);
    const rpc = context();
    Object.assign(rpc, { mode: 'rpc' });
    updateRouterUIStrip(rpc, snapshot, { widgetEnabled: true });
    expect(rpc.ui.setWidget).not.toHaveBeenCalled();
  });
});

it('logs sanitized activity diagnostics and keeps availability distinct from inference', () => {
  expect(
    formatDecision({ ...decision, activity: 'docs', routeCell: 'docs' }),
  ).toContain('activity=docs');
  expect(formatDecision({ ...decision, routeCell: 'code' })).toContain(
    'availability-cell=code',
  );
  expect(
    formatAdvisorDetail({
      ...decision,
      advisor: 'classifier',
      classification: {
        outcome: 'selected',
        latencyMs: 1,
        activity: 'docs',
        activityOutcome: 'selected',
      },
    }),
  ).toContain('activity=docs (selected)');
  const current = formatAdvisorDetail({
    ...decision,
    activity: 'ops',
    advisor: 'classifier',
    classification: {
      outcome: 'selected',
      latencyMs: 1,
      activity: 'code',
      activityOutcome: 'selected',
      phase: 'verify',
      phaseOutcome: 'selected',
    },
  });
  expect(current).toContain('goal=code (selected)');
  expect(current).toContain('phase=verify (selected)');
});
