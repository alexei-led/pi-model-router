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

describe('state.ts', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  const createTempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-model-router-'));
    tempDirs.push(dir);
    return dir;
  };

  it('validates, saves and loads the last profile', () => {
    const agentDir = createTempDir();
    expect(
      isRouterLastProfileState({ selectedProfile: 'p', timestamp: 1 }),
    ).toBe(true);
    expect(
      isRouterLastProfileState({ selectedProfile: '', timestamp: 1 }),
    ).toBe(false);
    expect(saveLastRouterProfile('p', agentDir)).toBe(true);
    expect(loadLastRouterProfile(agentDir)).toBe('p');
    writeFileSync(join(agentDir, 'model-router-state.json'), '{bad json');
    expect(loadLastRouterProfile(agentDir)).toBeUndefined();
  });

  it('rejects corrupted persisted optional fields', () => {
    const valid = { enabled: true, selectedProfile: 'p', timestamp: 1 };
    for (const invalid of [
      { accumulatedCost: -1 },
      { accumulatedCost: 'broken' },
      { pinByProfile: { p: 'ultra' } },
      { thinkingByProfile: { p: null } },
      { debugHistory: [null] },
      { lastDecision: { tier: 'high' } },
      { lastNonRouterModel: 'invalid' },
      { debugEnabled: 'yes' },
      { lastDecision: { ...decision, advisor: 'remote' } },
    ])
      expect(isRouterPersistedState({ ...valid, ...invalid })).toBe(false);
  });

  it('round-trips pins, thinking overrides, decisions and cost', () => {
    const state = buildPersistedState({
      routerEnabled: true,
      selectedProfile: 'p',
      pinnedTierByProfile: { p: 'medium' },
      thinkingByProfile: { p: { medium: 'medium' } },
      debugEnabled: true,
      widgetEnabled: false,
      debugHistory: [
        {
          ...decision,
          advisor: 'jev-fallback',
        } as unknown as RoutingDecision,
      ],
      lastDecision: {
        ...decision,
        advisor: 'jev-fallback',
      } as unknown as RoutingDecision,
      lastNonRouterModel: 'openai/gpt-4o',
      accumulatedCost: 0.0045,
    });
    expect(state.pinTier).toBe('medium');
    expect(state.lastDecision?.advisor).toBe('jev-fallback');
    expect(state.debugHistory?.[0]?.advisor).toBe('jev-fallback');
    expect(state.accumulatedCost).toBe(0.0045);
    expect(isRouterPersistedState(JSON.parse(JSON.stringify(state)))).toBe(
      true,
    );
  });

  it('does not copy incidental or secret decision fields', () => {
    const tainted = {
      ...decision,
      reasonCode: undefined,
      reasoning: 'secret key task',
      rawResponse: 'remote explanation',
      apiKey: 'secret',
      errorClass: 'remote-error-text',
      routingLatencyMs: Number.NaN,
      advisor: 'remote-advisor',
    } as unknown as RoutingDecision;
    const state = buildPersistedState({
      routerEnabled: true,
      selectedProfile: 'p',
      pinnedTierByProfile: {},
      thinkingByProfile: {},
      debugEnabled: true,
      widgetEnabled: true,
      debugHistory: [tainted],
      lastDecision: tainted,
      lastNonRouterModel: undefined,
      accumulatedCost: 0,
    });
    expect(state.lastDecision?.reasonCode).toBe('legacy');
    expect(state.lastDecision?.advisor).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('secret');
    expect(JSON.stringify(state)).not.toContain('remote explanation');
  });

  it('maps obsolete prompt-derived sources from old snapshots to legacy', () => {
    const restored = {
      enabled: true,
      selectedProfile: 'p',
      timestamp: 1,
      lastDecision: { ...decision, reasonCode: 'heuristic' },
    };
    expect(isRouterPersistedState(restored)).toBe(true);
    const saved = buildPersistedState({
      routerEnabled: true,
      selectedProfile: 'p',
      pinnedTierByProfile: {},
      thinkingByProfile: {},
      debugEnabled: false,
      widgetEnabled: false,
      debugHistory: [restored.lastDecision as RoutingDecision],
      lastDecision: restored.lastDecision as RoutingDecision,
      lastNonRouterModel: undefined,
      accumulatedCost: 0,
    });
    expect(saved.lastDecision?.reasonCode).toBe('legacy');
  });

  it('accepts only the fixed runtime reason codes', () => {
    for (const reasonCode of [
      'baseline',
      'pinned',
      'continuation',
      'classifier',
      'jev',
      'fallback',
      'budget',
      'legacy',
    ]) {
      expect(
        isRouterPersistedState({
          enabled: true,
          selectedProfile: 'p',
          timestamp: 1,
          lastDecision: { ...decision, reasonCode },
        }),
      ).toBe(true);
    }
    expect(
      isRouterPersistedState({
        enabled: true,
        selectedProfile: 'p',
        timestamp: 1,
        lastDecision: { ...decision, reasonCode: 'keyword' },
      }),
    ).toBe(false);
    expect(
      isRouterPersistedState({
        enabled: true,
        selectedProfile: 'p',
        timestamp: 1,
        lastDecision: { ...decision, advisor: 'remote' },
      }),
    ).toBe(false);
  });

  it('accepts old snapshots without advisor provenance', () => {
    expect(
      isRouterPersistedState({
        enabled: true,
        selectedProfile: 'p',
        timestamp: 1,
        lastDecision: decision,
      }),
    ).toBe(true);
  });
});
