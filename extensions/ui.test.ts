import { describe, it, expect, vi } from 'vitest';
import {
  formatDecision,
  formatPinSummary,
  formatThinkingSummary,
  formatModelRef,
  updateStatus,
} from './ui';
import type { RoutingDecision, RouterConfig } from './types';

describe('ui.ts', () => {
  describe('formatDecision', () => {
    it('should format routing decision correctly', () => {
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasoning: 'Exploratory prompts',
        thinking: 'high',
        timestamp: Date.now(),
      };
      const formatted = formatDecision(decision);
      expect(formatted).toBe(
        'balanced: high -> google/gemini-2.5-pro [high] (Exploratory prompts)',
      );
    });
  });

  describe('formatPinSummary', () => {
    it('should format pin configurations sorted alphabetically', () => {
      const pins = {
        cheap: 'low' as const,
        balanced: 'medium' as const,
      };
      expect(formatPinSummary(pins)).toBe('balanced:medium, cheap:low');
    });

    it('should return none if empty', () => {
      expect(formatPinSummary({})).toBe('none');
    });
  });

  describe('formatThinkingSummary', () => {
    it('should format thinking configurations sorted alphabetically', () => {
      const thinking = {
        balanced: { high: 'xhigh' as const, medium: 'low' as const },
        cheap: { low: 'off' as const },
      };
      expect(formatThinkingSummary(thinking)).toBe(
        'balanced(high:xhigh,medium:low), cheap(low:off)',
      );
    });

    it('should return none if empty', () => {
      expect(formatThinkingSummary({})).toBe('none');
    });
  });

  describe('formatModelRef', () => {
    it('should return model name or none', () => {
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

    it('should update status to router:off if disabled', () => {
      const ctx = buildMockCtx() as any;
      updateStatus(
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

      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '[dim]router:off[/dim]',
      );
      expect(ctx.ui.setWidget).toHaveBeenCalledWith('router', undefined);
    });

    it('should update status to waiting if router is enabled but no last decision matches', () => {
      const ctx = buildMockCtx() as any;
      updateStatus(
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
        '[dim]router:balanced -> waiting[/dim]',
      );
    });

    it('should display last routed decision information when active profile matches', () => {
      const ctx = buildMockCtx() as any;
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasoning: 'planning keywords',
        thinking: 'high',
        timestamp: Date.now(),
      };

      updateStatus(
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

      // Check Status
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        'router',
        '[dim]router:balanced [pin:high] -> high -> google/gemini-2.5-pro (xhigh)[/dim]',
      );

      // Check Widget Lines
      expect(ctx.ui.setWidget).toHaveBeenCalled();
      const widgetCalls = ctx.ui.setWidget.mock.calls[0];
      expect(widgetCalls[0]).toBe('router');
      const widgetLines = widgetCalls[1];
      expect(widgetLines).toContain('[dim]Router: enabled[/dim]');
      expect(widgetLines).toContain('[dim]Profile: balanced (active)[/dim]');
      expect(widgetLines).toContain('[dim]Pin: high[/dim]');
      expect(widgetLines).toContain('[dim]Cost: $0.0050 / $10.00[/dim]');
      expect(widgetLines).toContain(
        '[dim]Route: high -> google/gemini-2.5-pro (xhigh)[/dim]',
      );
      expect(widgetLines).toContain('[dim]Phase: planning[/dim]');
    });
  });
});
