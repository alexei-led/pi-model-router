import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type { RouterStatusState, RoutingDecision } from './types';
import {
  formatDecision,
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
    expect(lines).toContain('🧭 Jev ↪ base · 750ms');
    expect(lines).not.toContain('Routing: 750ms');
    expect(lines).not.toContain('Routing error: deadline');
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
      '🚥 router:p [pin:medium] -> medium -> test/model (medium)',
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
