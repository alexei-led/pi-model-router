import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { RouterStatusState, RoutingDecision } from './types';
import {
  formatAdvisorDetail,
  formatAdvisorFooter,
  formatDecision,
  formatJevStats,
  formatModelRef,
  formatPinSummary,
  formatThinkingSummary,
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

describe('ui.ts', () => {
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
    const lines = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1] ?? [];
    expect(lines).toContain('🧭 Jev ↪ base · deadline · 750ms');
    expect(lines).not.toContain('Routing: 750ms');
    expect(lines).not.toContain('Routing error: deadline');
  });

  it('keeps compact feedback useful and reserves extra metrics for detailed mode', () => {
    const routed: RoutingDecision = {
      ...decision,
      advisor: 'jev-fallback',
      reuse: 'continuation',
      jev: {
        outcome: 'low-confidence',
        latencyMs: 764,
        startedAt: 1234,
        choice: 'high',
        confidence: 0.35,
        probability: 0.48,
        threshold: 0.65,
        timeoutMs: 5000,
        contextChars: 113,
      },
    };
    const compact = formatAdvisorFooter(routed);
    expect(compact).toContain('high c35% <65% → baseline · 764ms');
    expect(compact).toContain('reuse');
    expect(compact).not.toContain('p48%');
    expect(compact).not.toContain('HTTP');
    expect(compact.length).toBeLessThan(80);
    const detailed = formatAdvisorFooter(routed, 'detailed');
    expect(detailed).toContain('high c35% <65% → baseline · 764ms · p48% @');
    expect(detailed).toContain('tool route');
    const ctx = context();
    render(ctx, { statusLine: 'detailed', lastDecision: routed });
    expect(vi.mocked(ctx.ui.setStatus).mock.calls[0]?.[1]).toContain(detailed);
    const widget = JSON.stringify(vi.mocked(ctx.ui.setWidget).mock.calls);
    expect(widget).toContain('confidence=35.0%');
    expect(widget).toContain('budget=5000ms');
    expect(widget).toContain('context=113 chars');
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
    const lines = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1];
    expect(lines).toContain('Router: enabled');
    expect(lines).toContain('Route: medium -> test/model (medium)');
    expect(lines).toContain('Source: baseline');
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
    const lines = vi.mocked(disabled.ui.setWidget).mock.calls[0]?.[1];
    expect(lines).toContain('Fallback: openai/gpt-4o');
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
    const rendered = JSON.stringify(vi.mocked(ctx.ui.setWidget).mock.calls);
    expect(rendered).not.toContain('private key');
    expect(rendered).not.toContain('legacy');
    expect(rendered).not.toContain('secret');
  });
});
