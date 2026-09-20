import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildPersistedState,
  isRouterLastProfileState,
  isRouterPersistedState,
  loadLastRouterProfile,
  saveLastRouterProfile,
} from './state';
import type { RoutingDecision } from './types';

describe('state.ts', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  const createTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-model-router-'));
    tempDirs.push(dir);
    return dir;
  };

  describe('last router profile', () => {
    it('validate last-profile state', () => {
      expect(
        isRouterLastProfileState({
          selectedProfile: 'balanced',
          timestamp: Date.now(),
        }),
      ).toBe(true);
      expect(
        isRouterLastProfileState({ selectedProfile: '', timestamp: 1 }),
      ).toBe(false);
      expect(isRouterLastProfileState({ selectedProfile: 'balanced' })).toBe(
        false,
      );
    });

    it('save and load the last profile', () => {
      const agentDir = createTempDir();

      expect(saveLastRouterProfile('balanced', agentDir)).toBe(true);
      expect(loadLastRouterProfile(agentDir)).toBe('balanced');
    });

    it('ignore missing or malformed state', () => {
      const agentDir = createTempDir();

      expect(loadLastRouterProfile(agentDir)).toBeUndefined();
      writeFileSync(join(agentDir, 'model-router-state.json'), '{bad json');
      expect(loadLastRouterProfile(agentDir)).toBeUndefined();
    });

    it('return false when the state cannot be written', () => {
      const missingDir = join(createTempDir(), 'missing');

      expect(saveLastRouterProfile('balanced', missingDir)).toBe(false);
    });
  });

  describe('isRouterPersistedState', () => {
    it('return false for non-objects or null', () => {
      expect(isRouterPersistedState(null)).toBe(false);
      expect(isRouterPersistedState('string')).toBe(false);
      expect(isRouterPersistedState(123)).toBe(false);
    });

    it('return false if required properties are missing or wrong type', () => {
      expect(isRouterPersistedState({ enabled: true })).toBe(false);
      expect(
        isRouterPersistedState({
          enabled: 'yes',
          selectedProfile: 'p',
          timestamp: 123,
        }),
      ).toBe(false);
    });

    it('return true for valid persisted state objects', () => {
      const state = {
        enabled: true,
        selectedProfile: 'balanced',
        timestamp: Date.now(),
      };
      expect(isRouterPersistedState(state)).toBe(true);
    });
  });

  describe('buildPersistedState', () => {
    it('build a state object matching the interface requirements', () => {
      const decision: RoutingDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'google',
        targetModelId: 'gemini-2.5-pro',
        targetLabel: 'google/gemini-2.5-pro',
        reasoning: 'Rules matched',
        thinking: 'high',
        timestamp: Date.now(),
      };

      const state = buildPersistedState({
        routerEnabled: true,
        selectedProfile: 'balanced',
        pinnedTierByProfile: { balanced: 'high' },
        thinkingByProfile: { balanced: { high: 'xhigh' } },
        debugEnabled: true,
        widgetEnabled: false,
        debugHistory: [decision],
        lastDecision: decision,
        lastNonRouterModel: 'openai/gpt-4o',
        accumulatedCost: 0.0045,
      });

      expect(state.enabled).toBe(true);
      expect(state.selectedProfile).toBe('balanced');
      expect(state.pinTier).toBe('high');
      expect(state.pinByProfile).toEqual({ balanced: 'high' });
      expect(state.thinkingByProfile).toEqual({ balanced: { high: 'xhigh' } });
      expect(state.debugEnabled).toBe(true);
      expect(state.widgetEnabled).toBe(false);
      expect(state.debugHistory).toEqual([decision]);
      expect(state.lastPhase).toBe('planning');
      expect(state.lastDecision).toEqual(decision);
      expect(state.lastNonRouterModel).toBe('openai/gpt-4o');
      expect(state.accumulatedCost).toBe(0.0045);
      expect(state.timestamp).toBeGreaterThan(0);
    });

    it('handle undefined selectedProfile', () => {
      const state = buildPersistedState({
        routerEnabled: false,
        selectedProfile: undefined,
        pinnedTierByProfile: {},
        thinkingByProfile: {},
        debugEnabled: false,
        widgetEnabled: false,
        debugHistory: [],
        lastDecision: undefined,
        lastNonRouterModel: undefined,
        accumulatedCost: 0,
      });
      expect(state.selectedProfile).toBe('');
      expect(state.pinTier).toBeUndefined();
    });
  });
});

describe('four-tier snapshots', () => {
  it.each(['micro', 'low', 'medium', 'high'] as const)(
    'round-trips %s pins, effort and decisions without a migration',
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
        reasoning: 'legacy local reason',
        timestamp: 1,
      };
      const withExtraFields = {
        ...decision,
        rawResponse: 'must not be copied',
      };
      const state = buildPersistedState({
        routerEnabled: true,
        selectedProfile: 'p',
        pinnedTierByProfile: { p: tier },
        thinkingByProfile: { p: { [tier]: decision.thinking } },
        debugEnabled: true,
        widgetEnabled: true,
        debugHistory: [withExtraFields],
        lastDecision: withExtraFields,
        lastNonRouterModel: undefined,
        accumulatedCost: 0,
      });
      const restored: unknown = JSON.parse(JSON.stringify(state));
      expect(isRouterPersistedState(restored)).toBe(true);
      expect(state.pinTier).toBe(tier);
      expect(state.lastDecision).toMatchObject(decision);
      expect(JSON.stringify(state)).not.toContain('must not be copied');
    },
  );
});
