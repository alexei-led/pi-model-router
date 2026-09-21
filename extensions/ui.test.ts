import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import type {
  RouterConfig,
  RouterStatusState,
  RouterThinkingByProfile,
  RoutingDecision,
} from './types';
import {
  formatDecision,
  formatModelRef,
  formatPinSummary,
  formatThinkingSummary,
  updateStatus,
} from './ui';

describe('ui.ts', () => {
  describe('formatDecision', () => {
    it('format routing decision correctly', () => {
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasonCode: 'heuristic',
        thinking: 'high',
        timestamp: Date.now(),
      };
      const formatted = formatDecision(decision);
      expect(formatted).toBe(
        'balanced: high -> google/gemini-2.5-pro [high] (heuristic)',
      );
    });
  });

  describe('formatPinSummary', () => {
    it('format pin configurations sorted alphabetically', () => {
      const pins = {
        cheap: 'low' as const,
        balanced: 'medium' as const,
      };
      expect(formatPinSummary(pins)).toBe('balanced:medium, cheap:low');
    });

    it('return none if empty', () => {
      expect(formatPinSummary({})).toBe('none');
    });
  });

  describe('formatThinkingSummary', () => {
    it('format thinking configurations sorted alphabetically', () => {
      const thinking = {
        balanced: { high: 'xhigh' as const, medium: 'low' as const },
        cheap: { low: 'off' as const },
      };
      expect(formatThinkingSummary(thinking)).toBe(
        'balanced(high:xhigh,medium:low), cheap(low:off)',
      );
    });

    it('return none if empty', () => {
      expect(formatThinkingSummary({})).toBe('none');
    });
  });

  describe('formatModelRef', () => {
    it('return model name or none', () => {
      expect(formatModelRef('openai/gpt-4o')).toBe('openai/gpt-4o');
      expect(formatModelRef(undefined)).toBe('none');
    });
  });

  describe('updateStatus', () => {
    const mockTheme = {
      fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
    };

    const buildMockCtx = () => ({
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        theme: mockTheme,
      },
    });

    const mockConfig: RouterConfig = {
      maxSessionBudget: 10.0,
      profiles: {},
    };

    const renderStatus = (
      ctx: ExtensionContext,
      routerEnabled: boolean,
      selectedProfile: string | undefined,
      pinnedTierByProfile: RouterStatusState['pinnedTierByProfile'],
      _thinkingByProfile: RouterThinkingByProfile,
      lastDecision: RoutingDecision | undefined,
      lastNonRouterModel: string | undefined,
      accumulatedCost: number,
      widgetEnabled: boolean,
      currentConfig: RouterConfig,
    ) =>
      updateStatus(ctx, {
        routerEnabled,
        selectedProfile,
        pinnedTierByProfile,
        lastDecision,
        lastNonRouterModel,
        accumulatedCost,
        widgetEnabled,
        maxSessionBudget: currentConfig.maxSessionBudget,
      });

    it('remove status if disabled', () => {
      const ctx = buildMockCtx() as unknown as ExtensionContext;
      renderStatus(
        ctx,
        false,
        'balanced',
        {},
        {},
        undefined,
        undefined,
        0,
        false,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith('router', undefined);
      expect(ctx.ui.setWidget).toHaveBeenCalledWith('router', undefined);
    });

    it('update status to waiting if router is enabled but no last decision matches', () => {
      const ctx = buildMockCtx() as unknown as ExtensionContext;
      renderStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        undefined,
        undefined,
        0,
        false,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '🚥 router:balanced -> waiting',
      );
    });

    it('display last routed decision information when active profile matches', () => {
      const ctx = buildMockCtx() as unknown as ExtensionContext;
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasonCode: 'heuristic',
        thinking: 'high',
        timestamp: Date.now(),
      };

      renderStatus(
        ctx,
        true,
        'balanced',
        { balanced: 'high' },
        { balanced: { high: 'xhigh' } },
        decision,
        undefined,
        0.005,
        true,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '🚥 router:balanced [pin:high] -> high -> google/gemini-2.5-pro (high)',
      );

      expect(ctx.ui.setWidget).toHaveBeenCalled();
      const widgetCalls = vi.mocked(ctx.ui.setWidget).mock.calls[0];
      if (!widgetCalls) throw new Error('Missing widget call');
      expect(widgetCalls[0]).toBe('router');
      const widgetLines = Array.isArray(widgetCalls[1]) ? widgetCalls[1] : [];
      expect(widgetLines).toContain('[dim]Router: enabled[/dim]');
      expect(widgetLines).toContain('[dim]Profile: balanced (active)[/dim]');
      expect(widgetLines).toContain('[dim]Pin: high[/dim]');
      expect(widgetLines).toContain('[dim]Cost: $0.0050 / $10.00[/dim]');
      expect(widgetLines).toContain(
        '[dim]Route: high -> google/gemini-2.5-pro (high)[/dim]',
      );
      expect(widgetLines).toContain('[dim]Phase: planning[/dim]');
    });

    it('display fallback model when router is disabled and lastNonRouterModel is set', () => {
      const ctx = buildMockCtx() as unknown as ExtensionContext;
      renderStatus(
        ctx,
        false,
        'balanced',
        {},
        {},
        undefined,
        'anthropic/claude-3.5-sonnet',
        0.1,
        true,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith('router', undefined);

      const widgetCalls = vi.mocked(ctx.ui.setWidget).mock.calls[0];
      if (!widgetCalls) throw new Error('Missing widget call');
      const widgetLines = Array.isArray(widgetCalls[1]) ? widgetCalls[1] : [];
      expect(widgetLines).toContain('[dim]Router: disabled[/dim]');
      expect(widgetLines).toContain(
        '[dim]Fallback: anthropic/claude-3.5-sonnet[/dim]',
      );
    });

    it('show pins line when multiple profiles have pins', () => {
      const ctx = buildMockCtx() as unknown as ExtensionContext;
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'medium',
        phase: 'implementation',
        targetProvider: 'openai',
        targetModelId: 'gpt-4o-mini',
        targetLabel: 'openai/gpt-4o-mini',
        reasonCode: 'heuristic',
        thinking: 'medium',
        timestamp: Date.now(),
      };

      renderStatus(
        ctx,
        true,
        'balanced',
        { balanced: 'medium', cheap: 'low' },
        {},
        decision,
        undefined,
        0,
        true,
        mockConfig,
      );

      const widgetCalls = vi.mocked(ctx.ui.setWidget).mock.calls[0];
      if (!widgetCalls) throw new Error('Missing widget call');
      const widgetLines = Array.isArray(widgetCalls[1]) ? widgetCalls[1] : [];
      expect(widgetLines).toContain(
        '[dim]Pins: balanced:medium, cheap:low[/dim]',
      );
    });

    it('show waiting when active profile does not match lastDecision profile', () => {
      const ctx = buildMockCtx() as unknown as ExtensionContext;
      const decision: RoutingDecision = {
        profile: 'other-profile',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasonCode: 'heuristic',
        thinking: 'high',
        timestamp: Date.now(),
      };

      renderStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        decision,
        undefined,
        0,
        false,
        mockConfig,
      );

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '🚥 router:balanced -> waiting',
      );
    });

    it('omit budget denominator from widget when maxSessionBudget is undefined', () => {
      const ctx = buildMockCtx() as unknown as ExtensionContext;
      const noBudgetConfig: RouterConfig = {
        profiles: {},
      };
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'medium',
        phase: 'implementation',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-flash',
        targetLabel: 'google/gemini-2.5-flash',
        reasonCode: 'heuristic',
        thinking: 'medium',
        timestamp: Date.now(),
      };

      renderStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        decision,
        undefined,
        0.5,
        true,
        noBudgetConfig,
      );

      const widgetLines = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1];
      const lines = Array.isArray(widgetLines) ? widgetLines : [];
      const costLine = lines.find((l: string) => l.includes('Cost'));
      expect(costLine).toBe('[dim]Cost: $0.5000[/dim]');
    });

    it('omit budget denominator when maxSessionBudget is 0 (falsy)', () => {
      const ctx = buildMockCtx() as unknown as ExtensionContext;
      const zeroBudgetConfig: RouterConfig = {
        maxSessionBudget: 0,
        profiles: {},
      };
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'medium',
        phase: 'implementation',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-flash',
        targetLabel: 'google/gemini-2.5-flash',
        reasonCode: 'heuristic',
        thinking: 'medium',
        timestamp: Date.now(),
      };

      renderStatus(
        ctx,
        true,
        'balanced',
        {},
        {},
        decision,
        undefined,
        0,
        true,
        zeroBudgetConfig,
      );

      const widgetLines = vi.mocked(ctx.ui.setWidget).mock.calls[0]?.[1];
      const lines = Array.isArray(widgetLines) ? widgetLines : [];
      const costLine = lines.find((l: string) => l.includes('Cost'));
      expect(costLine).toBe('[dim]Cost: $0.0000[/dim]');
    });
  });
});

describe('four-tier rendering', () => {
  it.each(['micro', 'low', 'medium', 'high'] as const)(
    'renders %s saved decisions, pins and effort',
    (tier) => {
      const decision: RoutingDecision = {
        profile: 'p',
        tier,
        phase:
          tier === 'high'
            ? 'planning'
            : tier === 'medium'
              ? 'implementation'
              : 'lightweight',
        targetProvider: 'test',
        targetModelId: 'model',
        targetLabel: 'test/model',
        thinking: tier === 'micro' ? 'off' : tier,
        reasonCode: 'heuristic',
        timestamp: 1,
      };
      const ctx = {
        ui: {
          setStatus: vi.fn(),
          setWidget: vi.fn(),
          theme: { fg: (_color: string, text: string) => text },
        },
      };
      updateStatus(ctx as unknown as ExtensionContext, {
        routerEnabled: true,
        selectedProfile: 'p',
        pinnedTierByProfile: { p: tier },
        lastDecision: decision,
        lastNonRouterModel: undefined,
        accumulatedCost: 0,
        widgetEnabled: true,
        maxSessionBudget: undefined,
      });
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        expect.stringContaining(
          `-> ${tier} -> test/model (${decision.thinking})`,
        ),
      );
      expect(ctx.ui.setWidget.mock.calls[0]?.[1]).toContain(
        `Route: ${tier} -> test/model (${decision.thinking})`,
      );
      expect(formatPinSummary({ p: tier })).toBe(`p:${tier}`);
      expect(formatThinkingSummary({ p: { [tier]: decision.thinking } })).toBe(
        `p(${tier}:${decision.thinking})`,
      );
    },
  );
});

describe('local floor status', () => {
  it.each(['pinned', 'pin-safety-floor', 'budget-floor-conflict'] as const)(
    'shows the actual route rather than waiting when the floor rejects a pin: %s',
    (reasonCode) => {
      const ctx = { ui: { setStatus: vi.fn(), setWidget: vi.fn() } };
      updateStatus(ctx as unknown as ExtensionContext, {
        routerEnabled: true,
        selectedProfile: 'p',
        pinnedTierByProfile: { p: 'micro' },
        lastDecision: {
          profile: 'p',
          tier: 'high',
          phase: 'planning',
          targetProvider: 'test',
          targetModelId: 'model',
          targetLabel: 'test/model',
          thinking: 'high',
          timestamp: 1,
          reasonCode,
        },
        lastNonRouterModel: undefined,
        accumulatedCost: 0,
        widgetEnabled: false,
        maxSessionBudget: undefined,
      });
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        expect.stringContaining('[pin:micro] -> high -> test/model'),
      );
    },
  );
});

describe('safe source rendering', () => {
  it('never displays old or invalid reason text, incidental remote metadata, or legacy', () => {
    const decision = {
      profile: 'p',
      tier: 'high',
      phase: 'planning',
      targetProvider: 'test',
      targetModelId: 'model',
      targetLabel: 'test/model',
      thinking: 'high',
      timestamp: 1,
      reasoning: 'private key and remote explanation',
      reasonCode: 'legacy',
      endpoint: 'https://remote.invalid',
      apiKey: 'private key',
      rawResponse: 'remote explanation',
    } as unknown as RoutingDecision;
    expect(formatDecision(decision)).toBe('p: high -> test/model [high]');
    const ctx = {
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        theme: { fg: (_color: string, text: string) => text },
      },
    };
    updateStatus(ctx as unknown as ExtensionContext, {
      routerEnabled: true,
      selectedProfile: 'p',
      pinnedTierByProfile: {},
      lastDecision: decision,
      lastNonRouterModel: undefined,
      accumulatedCost: 0,
      widgetEnabled: true,
      maxSessionBudget: undefined,
    });
    const rendered = JSON.stringify(ctx.ui.setWidget.mock.calls);
    for (const text of ['private key', 'remote', 'legacy'])
      expect(rendered).not.toContain(text);
    expect(
      formatDecision({
        ...decision,
        reasonCode: 'secret',
      } as unknown as RoutingDecision),
    ).not.toContain('secret');
  });
  it('shows fixed source, latency and error class without remote text', () => {
    const ctx = {
      ui: {
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        theme: { fg: (_color: string, text: string) => text },
      },
    };
    updateStatus(ctx as unknown as ExtensionContext, {
      routerEnabled: true,
      selectedProfile: 'p',
      pinnedTierByProfile: {},
      lastNonRouterModel: undefined,
      accumulatedCost: 0,
      widgetEnabled: true,
      maxSessionBudget: undefined,
      lastDecision: {
        profile: 'p',
        tier: 'medium',
        phase: 'implementation',
        targetProvider: 'test',
        targetModelId: 'model',
        targetLabel: 'test/model',
        thinking: 'medium',
        timestamp: 1,
        reasonCode: 'heuristic',
        routingLatencyMs: 1500,
        errorClass: 'deadline',
      },
    });
    expect(ctx.ui.setWidget.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        'Source: heuristic',
        'Routing: 1500ms',
        'Routing error: deadline',
      ]),
    );
  });
});
