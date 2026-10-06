import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import { required } from './test/fixtures';
import type {
  RouterStatusState,
  RouterUISnapshot,
  RoutingDecision,
} from './types';
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
  updateStatus,
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

const render = (
  ctx: ExtensionContext,
  state: Partial<RouterStatusState> = {},
) =>
  updateStatus(ctx, {
    routerEnabled: true,
    selectedProfile: 'p',
    pinnedTierByProfile: {},
    lastDecision: decision,
    lastNonRouterModel: undefined,
    accumulatedCost: 0,
    widgetEnabled: true,
    maxSessionBudget: undefined,
    ...state,
  });

const widget = (ctx: ExtensionContext): string[] => {
  const content = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1];
  if (typeof content === 'function')
    return content({} as TUI, ctx.ui.theme as Theme).render(120);
  return content ?? [];
};

describe('ui.ts', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'renders prototype-like profile %s without an inherited pin',
    (profile) => {
      const ctx = context();
      render(ctx, {
        selectedProfile: profile,
        lastDecision: { ...decision, profile },
      });
      const status = vi.mocked(ctx.ui.setStatus).mock.calls[0]?.[1];
      expect(status).toContain('medium');
      expect(status).not.toContain('pin:');
    },
  );

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

  it('shows observed cache usage and explicitly hypothetical costs without changing the compact footer', () => {
    const routed: RoutingDecision = {
      ...decision,
      generation: {
        transition: 'model-switch',
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
      },
    };
    const detail = formatGenerationDetail(routed);
    expect(detail).toContain('cache-read=800');
    expect(detail).toContain('reported cost=unknown');
    expect(detail).toContain('catalog/list-price, not billing');
    expect(detail).toContain('future cache warmth=unknown');
    expect(detail).toContain('stay test/old=$0.1000/$1.0000');
    expect(detail).toContain('includes output; not predicted savings');
    expect(formatDecision(routed)).toContain(detail);
    const compact = context();
    render(compact, { lastDecision: routed });
    expect(vi.mocked(compact.ui.setStatus).mock.calls[0]?.[1]).not.toContain(
      'cache',
    );
    expect(formatGenerationDetail(routed)).toContain('cache-read=800');
    const detailed = context();
    render(detailed, { lastDecision: routed, statusLine: 'detailed' });
    expect(vi.mocked(detailed.ui.setStatus).mock.calls[0]?.[1]).toContain(
      'cache r800/w0',
    );
    expect(
      formatGenerationDetail({
        ...routed,
        generation: {
          ...required(routed.generation),
          contextTruncated: true,
          shadow: undefined,
        },
      }),
    ).toContain('shadow unavailable');
  });

  it.each([
    ['jev', '🧭 Jev ✓'],
    ['jev-fallback', '🧭 Jev ↪ base'],
    ['classifier', '🧠 Classifier ✓'],
    ['classifier-fallback', '🧠 Classifier ↪ base'],
    ['bypassed', ''],
    ['none', ''],
    [undefined, ''],
  ] as const)(
    'shows advisor provenance in the footer: %s',
    (advisor, suffix) => {
      const ctx = context();
      render(ctx, {
        lastDecision: { ...decision, advisor } as unknown as RoutingDecision,
      });
      const status = vi.mocked(ctx.ui.setStatus).mock.calls[0]?.[1] ?? '';
      if (suffix) expect(status).toContain(suffix);
      else expect(status).not.toContain('Jev');
    },
  );

  it.each([
    ['pinned', 'advice skipped: pinned high'],
    ['budget', 'advice skipped: over budget'],
    ['single-candidate', 'advice skipped: only high eligible'],
    ['tool-continuation', 'advice skipped: tool turn'],
    ['no-user-turn', 'advice skipped: no user turn'],
    ['turn-advised', 'advice skipped: turn already advised'],
    [undefined, 'advice bypassed'],
  ] as const)('explains why advice was skipped: %s', (bypassReason, text) => {
    const routed = {
      ...decision,
      tier: 'high',
      advisor: 'bypassed',
      bypassReason,
    } as unknown as RoutingDecision;
    expect(formatAdvisorFooter(routed)).toContain(text);
    const ctx = context();
    render(ctx, { lastDecision: routed });
    expect(vi.mocked(ctx.ui.setStatus).mock.calls[0]?.[1]).toContain(text);
  });

  it('shows detailed advisor status without remote data', () => {
    const ctx = context();
    render(ctx, {
      lastDecision: {
        ...decision,
        advisor: 'jev-fallback',
        routingLatencyMs: 750,
        errorClass: 'deadline',
      } as unknown as RoutingDecision,
    });
    const lines = widget(ctx).join('\n');
    expect(lines).toContain('🧭 Jev ↪ base: deadline');
    expect(lines).not.toContain('Routing: 750ms');
    expect(lines).not.toContain('Routing error: deadline');
  });

  it('keeps compact feedback useful and reserves extra metrics for detailed mode', () => {
    const routed: RoutingDecision = {
      ...decision,
      advisor: 'jev-fallback',
      reuse: 'continuation',
      jev: {
        outcome: 'selected',
        latencyMs: 764,
        startedAt: 1234,
        choice: 'medium',
        selectedTier: 'high',
        selectionBasis: 'probability',
        routeProbability: 0.91,
        probabilityThreshold: 0.8,
        confidence: 0.35,
        probability: 0.48,
        threshold: 0.65,
        timeoutMs: 5000,
      },
    };
    const compact = formatAdvisorFooter(routed);
    expect(compact).toContain('medium c35% <65% → high · 764ms');
    expect(compact).toContain('reuse');
    expect(compact).not.toContain('p48%');
    expect(compact).not.toContain('HTTP');
    expect(compact.length).toBeLessThan(80);
    const detailed = formatAdvisorFooter(routed, 'detailed');
    expect(detailed).toContain('medium c35% <65% → high · 764ms · p48% @');
    expect(detailed).toContain('tool route');
    const ctx = context();
    render(ctx, { statusLine: 'detailed', lastDecision: routed });
    expect(vi.mocked(ctx.ui.setStatus).mock.calls[0]?.[1]).toContain(detailed);
    const widget = formatAdvisorDetail(routed) ?? '';
    expect(widget).toContain('confidence=35.0%');
    expect(widget).toContain('selected=high');
    expect(widget).toContain('basis=probability');
    expect(widget).toContain('route-p=91.0%');
    expect(widget).toContain('route-threshold=80.0%');
    expect(widget).toContain('budget=5000ms');
    expect(widget).not.toContain('private task text');
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

  it('renders an active route and budget status', () => {
    const ctx = context();
    render(ctx, {
      pinnedTierByProfile: { p: 'medium' },
      accumulatedCost: 0.5,
      maxSessionBudget: 10,
    });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      'router',
      '🚥 p [pin:medium] · medium → model/medium',
    );
    const lines = widget(ctx).join('\n');
    expect(lines).toContain('Router / p · medium → model · medium');
    expect(lines).toContain(
      'enabled · next pin medium · catalog $0.5000 / $10',
    );
  });

  it.each(['pinned', 'budget'] as const)(
    'does not display a stale %s route as matching a new pin',
    (reasonCode) => {
      const ctx = context();
      render(ctx, {
        pinnedTierByProfile: { p: 'high' },
        lastDecision: { ...decision, reasonCode },
      });
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '🚥 router:p [pin:high] -> waiting',
      );
    },
  );

  it('shows waiting for a mismatched profile and fallback when disabled', () => {
    const ctx = context();
    render(ctx, {
      lastDecision: { ...decision, profile: 'other' },
      widgetEnabled: false,
    });
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      'router',
      '🚥 router:p -> waiting',
    );

    const disabled = context();
    render(disabled, {
      routerEnabled: false,
      selectedProfile: 'p',
      lastDecision: undefined,
      lastNonRouterModel: 'openai/gpt-4o',
    });
    const lines = widget(disabled).join('\n');
    expect(lines).toContain('openai/gpt-4o');
    expect(lines).toContain('off');
  });

  it('does not render remote or legacy explanation text', () => {
    const ctx = context();
    const tainted = {
      ...decision,
      reasonCode: 'legacy',
      reasoning: 'private key remote explanation',
      apiKey: 'secret',
    } as unknown as RoutingDecision;
    render(ctx, { lastDecision: tainted });
    const rendered = widget(ctx).join('\n');
    expect(rendered).not.toContain('private key');
    expect(rendered).not.toContain('legacy');
    expect(rendered).not.toContain('secret');
  });
});

describe('ui.ts compact strip', () => {
  it.each([40, 60, 80, 120])(
    'uses a width-aware strip at %i columns',
    (width) => {
      const ctx = context();
      render(ctx, {
        selectedProfile: '仕事👨‍👩‍👧‍👦',
        lastDecision: {
          ...decision,
          profile: '仕事👨‍👩‍👧‍👦',
          targetModelId: '漢字🚀',
        },
      });
      const content = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1];
      if (typeof content !== 'function')
        throw new Error('Expected native widget factory');
      const component = content({} as TUI, ctx.ui.theme);
      const lines = component.render(width);
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines[0]).toContain('medium');
      component.invalidate();
      expect(component.render(width)).toEqual(lines);
    },
  );
  it('keeps the observed route visible when a new pin is pending', () => {
    const ctx = context();
    render(ctx, { pinnedTierByProfile: { p: 'high' } });
    const text = widget(ctx).join('\n');
    expect(text).toContain('medium → model');
    expect(text).toContain('next pin high');
  });
  it('shows at most three lines in detailed mode and honors widget toggle', () => {
    const ctx = context();
    render(ctx, {
      statusLine: 'detailed',
      lastDecision: {
        ...decision,
        generation: {
          transition: 'initial',
          contextTruncated: false,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          attempts: 1,
        },
      },
    });
    expect(widget(ctx)).toHaveLength(3);
    const disabled = context();
    render(disabled, { widgetEnabled: false });
    expect(disabled.ui.setWidget).toHaveBeenCalledWith('router', undefined);
  });
});

describe('ui.ts lifecycle strip', () => {
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
      expect(lines).toHaveLength(3);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(lines[0]).toContain('high → 漢字🚀fallback');
    },
  );
  it('renders choosing without a stale route, preserves widget toggles and avoids RPC', () => {
    const ctx = context();
    Object.assign(ctx, { mode: 'tui' });
    updateRouterUIStrip(ctx, snapshot, { widgetEnabled: true });
    expect(widget(ctx).join('\n')).toContain(
      'no observed generation · choosing',
    );
    updateRouterUIStrip(ctx, snapshot, { widgetEnabled: false });
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith('router', undefined);
    const rpc = context();
    Object.assign(rpc, { mode: 'rpc' });
    updateRouterUIStrip(rpc, snapshot, { widgetEnabled: true });
    expect(rpc.ui.setWidget).not.toHaveBeenCalled();
  });
});
