import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import type { RouterUISnapshot, RoutingDecision } from './types';
import {
  formatAdvisorDetail,
  formatAdvisorFooter,
  formatDecision,
  formatGenerationDetail,
  formatJevStats,
  formatModelRef,
  formatPinSummary,
  formatThinkingSummary,
  updateRouterUIStrip,
} from './ui';

const decision: RoutingDecision = {
  profile: 'p',
  tier: 'medium',
  phase: 'implementation',
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
    expect(detail).toContain('reported cost=unknown');
    expect(detail).toContain('catalog/list-price, not billing');
    expect(detail).toContain('future cache warmth=unknown');
    expect(detail).toContain('stay test/old=$0.1000/$1.0000');
    expect(detail).toContain('not predicted savings');
    expect(formatDecision({ ...decision, generation })).toContain(detail);
    const truncated = formatGenerationDetail({
      ...decision,
      generation: { ...generation, contextTruncated: true, shadow: undefined },
    });
    expect(truncated).toContain('context truncated');
    expect(truncated).toContain('shadow unavailable');
  });

  it('formats only fixed local decision metadata', () => {
    expect(formatDecision(decision)).toBe(
      'p: medium -> test/model [medium] (baseline)',
    );
    expect(
      formatDecision({
        ...decision,
        advisor: 'jev',
      } as unknown as RoutingDecision),
    ).toContain('[🧭 Jev ✓]');
    expect(formatModelRef('openai/gpt-4o')).toBe('openai/gpt-4o');
    expect(formatModelRef(undefined)).toBe('none');
  });

  it('renders a [failed] marker for a debugHistory entry flagged as a total generation failure', () => {
    expect(formatDecision({ ...decision, isGenerationFailed: true })).toBe(
      'p: medium -> test/model [medium] [failed] (baseline)',
    );
  });

  it('labels uncertainty once in compact mode', () => {
    const footer = formatAdvisorFooter({
      ...decision,
      advisor: 'jev-fallback',
      jev: {
        outcome: 'uncertain',
        choice: 'uncertain',
        confidence: 0.73,
        latencyMs: 860,
      },
    });
    expect(footer).toContain('no tier chosen → baseline · 860ms');
    expect(footer).not.toContain('uncertain');
    expect(footer).not.toContain('73%');
    const detail = formatAdvisorDetail({
      ...decision,
      advisor: 'jev-fallback',
      jev: {
        outcome: 'uncertain',
        choice: 'uncertain',
        confidence: 0.73,
        latencyMs: 860,
        threshold: 0.65,
      },
    });
    expect(detail).toContain('could not judge the required capability');
    expect(detail).toContain('abstention-confidence=73.0%');
    expect(detail).not.toContain('threshold');
  });

  it.each([
    ['deadline', ': timeout → baseline · 5.0s'],
    ['network-error', ': network error → baseline'],
    ['invalid-response', ': invalid response → baseline'],
    ['http-error', ': HTTP 429 → baseline'],
    ['cancelled', ': cancelled'],
    ['input-too-large', ': estimated request too large → baseline'],
  ] as const)(
    'explains %s without exposing raw error data',
    (outcome, expected) => {
      expect(
        formatAdvisorFooter({
          ...decision,
          advisor: 'jev-fallback',
          jev: { outcome, latencyMs: 5000, httpStatus: 429 },
        }),
      ).toContain(expected);
    },
  );

  it('counts unique requests, not shared calls, cached calls or tool continuations', () => {
    const first: RoutingDecision = {
      ...decision,
      jev: {
        requestId: '00000000-0000-4000-8000-000000000001',
        outcome: 'selected',
        choice: 'high',
        latencyMs: 100,
      },
    };
    const second: RoutingDecision = {
      ...decision,
      jev: {
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
        jev: { outcome: 'selected', choice: 'low', latencyMs: 200 },
      },
    ];
    const stats = formatJevStats(history).join('\n');
    expect(stats).toContain('2 unique HTTP requests in 8 retained decisions');
    expect(stats).toContain('selected: 1/2 (50.0%)');
    expect(stats).toContain('deadline: 1/2 (50.0%)');
    expect(stats).toContain('high=1');
    expect(stats).toContain('low=0');
    expect(stats).toContain('2550ms');
    expect(stats).toContain('1 decisions without request IDs excluded');
    expect(stats).not.toContain('00000000');
    expect(formatJevStats([]).join('\n')).toContain('Median Jev latency: n/a');
    expect(formatJevStats([]).join('\n')).not.toContain('NaN');
  });

  it('shows context composition without persisting or rendering input text', () => {
    const detail = formatAdvisorDetail({
      ...decision,
      advisor: 'jev',
      jev: {
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
    expect(detail).toContain('Jev usage=640 input tokens');
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

describe('ui.ts lifecycle strip', () => {
  it('preserves model identity before optional advisor detail in a narrow footer', () => {
    const previous = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: 40,
    });
    try {
      const ctx = context();
      Object.assign(ctx, { mode: 'tui' });
      updateRouterUIStrip(
        ctx,
        {
          ...snapshot,
          lifecycle: 'idle',
          actual: {
            provider: 'test',
            model: 'model-medium',
            tier: 'medium',
            thinking: 'medium',
          },
          advice: {
            advisor: 'clef-flash',
            outcome: 'selected',
            latencyMs: 1000,
          },
        },
        { widgetEnabled: false },
      );
      const text = vi.mocked(ctx.ui.setStatus).mock.calls.at(-1)?.[1] ?? '';
      expect(text).toContain('model-medium');
      expect(visibleWidth(text)).toBeLessThanOrEqual(40);
    } finally {
      if (previous) Object.defineProperty(process.stdout, 'columns', previous);
      else Reflect.deleteProperty(process.stdout, 'columns');
    }
  });

  it.each(['jev', 'clef', 'clef-flash', 'classifier'] as const)(
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
      expect(widget(ctx).join('\n')).toContain('actual-model');
      expect(widget(ctx).join('\n')).toContain('42 ms');
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
    expect(widget(ctx)[0]).toContain('actual-medium');
    expect(widget(ctx)[1]).toContain('Next user turn: pin high');
  });
  it('falls back to one footer status when the widget is hidden', () => {
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(ctx, snapshot, { widgetEnabled: false });
    expect(ctx.ui.setWidget).toHaveBeenCalledWith('router', undefined);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      'router',
      expect.stringContaining('choosing'),
    );
  });

  const snapshot: RouterUISnapshot = {
    profile: 'p',
    lifecycle: 'choosing',
    controls: {
      pin: 'auto',
      baseline: 'medium',
      budget: undefined,
      advisor: 'jev',
      timeout: 1500,
      thinkingHigh: undefined,
      thinkingMedium: undefined,
      thinkingLow: undefined,
      thinkingMicro: undefined,
    },
    eligible: {},
    history: [],
    privacy: {
      jevApproved: undefined,
      cloudflareApproved: undefined,
      auth: 'unknown',
    },
  };
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
    expect(widget(ctx).join('\n')).toContain(
      'Choosing route · no generation started',
    );
    updateRouterUIStrip(ctx, snapshot, { widgetEnabled: false });
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith('router', undefined);
    const rpc = context();
    Object.assign(rpc, { mode: 'rpc' });
    updateRouterUIStrip(rpc, snapshot, { widgetEnabled: true });
    expect(rpc.ui.setWidget).not.toHaveBeenCalled();
  });
});
