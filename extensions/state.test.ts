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
  snapshotDecision,
} from './state';
import { required } from './test/fixtures';
import type { GenerationDiagnostics, RoutingDecision } from './types';

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
      { accumulatedCost: Number.NaN },
      { pinByProfile: { p: 'ultra' } },
      { thinkingByProfile: { p: null } },
      { thinkingByProfile: { p: { high: 'invalid' } } },
      { debugHistory: [null] },
      { lastDecision: { tier: 'high' } },
      { lastNonRouterModel: 'invalid' },
      { debugEnabled: 'yes' },
      { lastDecision: { ...decision, advisor: 'remote' } },
      { modeOverride: 'thrifty' },
      { lastDecision: { ...decision, escalatedFrom: 'ultra' } },
      { lastDecision: { ...decision, costRecovery: 'invalid' } },
    ])
      expect(isRouterPersistedState({ ...valid, ...invalid })).toBe(false);
  });

  it('round-trips the session mode and decision mode fields', () => {
    const routed: RoutingDecision = {
      ...decision,
      reasonCode: 'escalation',
      escalatedFrom: 'low',
      mode: 'cost',
      modeSource: 'session',
      modeLever: 'model',
      modeSourceTier: 'low',
    };
    const state = buildPersistedState({
      routerEnabled: true,
      selectedProfile: 'p',
      pinnedTierByProfile: {},
      thinkingByProfile: {},
      modeOverride: 'cost',
      debugEnabled: true,
      widgetEnabled: true,
      debugHistory: [routed],
      lastDecision: routed,
      lastNonRouterModel: undefined,
      accumulatedCost: 0,
    });
    const restored = JSON.parse(JSON.stringify(state));
    expect(isRouterPersistedState(restored)).toBe(true);
    expect(restored.modeOverride).toBe('cost');
    expect(snapshotDecision(restored.lastDecision)).toMatchObject({
      reasonCode: 'escalation',
      escalatedFrom: 'low',
      mode: 'cost',
      modeSource: 'session',
      modeLever: 'model',
      modeSourceTier: 'low',
    });
    expect(
      snapshotDecision({
        ...routed,
        mode: 'thrifty',
        modeSource: 'repo',
        modeLever: 'votes',
      } as unknown as RoutingDecision),
    ).toMatchObject({
      mode: undefined,
      modeSource: undefined,
      modeLever: undefined,
    });
  });

  it('omits the mode override when none is set', () => {
    const state = buildPersistedState({
      routerEnabled: true,
      selectedProfile: 'p',
      pinnedTierByProfile: {},
      thinkingByProfile: {},
      debugEnabled: false,
      widgetEnabled: false,
      debugHistory: [],
      lastDecision: undefined,
      lastNonRouterModel: undefined,
      accumulatedCost: 0,
    });
    expect('modeOverride' in state).toBe(false);
  });

  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'persists unpinned prototype-like profile %s without inherited values',
    (name) => {
      const state = buildPersistedState({
        routerEnabled: true,
        selectedProfile: name,
        pinnedTierByProfile: {},
        thinkingByProfile: {},
        debugEnabled: false,
        widgetEnabled: false,
        debugHistory: [],
        lastDecision: undefined,
        lastNonRouterModel: undefined,
        accumulatedCost: 0,
      });
      expect(state.pinTier).toBeUndefined();
      expect(state.pinByProfile).toEqual({});
      expect(isRouterPersistedState(JSON.parse(JSON.stringify(state)))).toBe(
        true,
      );
    },
  );

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
          advisor: 'classifier-fallback',
        } as unknown as RoutingDecision,
      ],
      lastDecision: {
        ...decision,
        advisor: 'classifier-fallback',
      } as unknown as RoutingDecision,
      lastNonRouterModel: 'openai/gpt-4o',
      accumulatedCost: 0.0045,
    });
    expect(state.pinTier).toBe('medium');
    expect(state.lastDecision?.advisor).toBe('classifier-fallback');
    expect(state.debugHistory?.[0]?.advisor).toBe('classifier-fallback');
    expect(state.accumulatedCost).toBe(0.0045);
    expect(isRouterPersistedState(JSON.parse(JSON.stringify(state)))).toBe(
      true,
    );
  });

  it('persists only validated Jev trace fields, including original request time on reuse', () => {
    const tainted = {
      ...decision,
      reuse: 'continuation',
      classification: {
        outcome: 'selected',
        selectedTier: 'high',
        selectionBasis: 'probability',
        routeProbability: 0.91,
        probabilityThreshold: 0.8,
        model: 'jev-latest',
        requestId: '00000000-0000-4000-8000-000000000001',
        startedAt: 1234,
        latencyMs: 764,
        choice: 'high',
        probability: 0.48,
        confidence: 0.35,
        threshold: 0.65,
        timeoutMs: 5000,
        candidateCount: 4,
        estimatedInputTokens: 700,
        actualInputTokens: 640,
        context: {
          currentRequestTokens: 3,
          historyTokens: 25,
          toolTokens: 23,
          historyTurns: 2,
          toolResults: 1,
          truncatedBlocks: 1,
          raw: 'secret-history',
        },
        httpStatus: 200,
        explanation: 'secret-task',
        apiKey: 'secret-key',
      },
    } as RoutingDecision;
    const copy = snapshotDecision(tainted);
    expect(copy).toMatchObject({
      reuse: 'continuation',
      classification: {
        requestId: '00000000-0000-4000-8000-000000000001',
        startedAt: 1234,
        latencyMs: 764,
        choice: 'high',
        selectedTier: 'high',
        selectionBasis: 'probability',
        routeProbability: 0.91,
        probabilityThreshold: 0.8,
        confidence: 0.35,
        probability: 0.48,
        estimatedInputTokens: 700,
        actualInputTokens: 640,
        context: {
          currentRequestTokens: 3,
          historyTokens: 25,
          toolTokens: 23,
          historyTurns: 2,
          toolResults: 1,
          truncatedBlocks: 1,
        },
      },
    });
    expect(JSON.stringify(copy)).not.toContain('secret');
    const invalid = {
      ...tainted,
      classification: {
        ...tainted.classification,
        model: 'secret-key',
        requestId: 'secret-key',
        confidence: 2,
        choice: 'remote-text',
        selectedTier: 'remote-text',
        selectionBasis: 'remote-basis',
        routeProbability: 2,
        context: { currentRequestTokens: -1 },
      },
      reuse: 'remote-text',
    } as unknown as RoutingDecision;
    const sanitized = snapshotDecision(invalid);
    expect(sanitized.classification?.model).toBeUndefined();
    expect(sanitized.classification?.requestId).toBeUndefined();
    expect(sanitized.classification?.context).toBeUndefined();
    expect(sanitized.classification?.confidence).toBeUndefined();
    expect(sanitized.classification?.choice).toBeUndefined();
    expect(sanitized.classification?.selectedTier).toBeUndefined();
    expect(sanitized.classification?.selectionBasis).toBeUndefined();
    expect(sanitized.classification?.routeProbability).toBeUndefined();
    expect(sanitized.reuse).toBeUndefined();
  });

  it('persists bounded switch-cost diagnostics and proposed route identity only', () => {
    const snapshot = snapshotDecision({
      ...decision,
      proposedRoute: {
        tier: 'high',
        model: 'test/proposed',
        thinking: 'high',
        activity: 'debug',
      },
      switchCost: {
        reason: 'cost-held',
        horizonRequests: 5,
        stayUsd: 0.02,
        switchUsd: 0.08,
        incrementalUsd: 0.06,
        confidenceOverride: false,
      },
    });
    expect(snapshot.proposedRoute).toEqual({
      tier: 'high',
      model: 'test/proposed',
      thinking: 'high',
      activity: 'debug',
    });
    expect(snapshot.switchCost).toMatchObject({
      reason: 'cost-held',
      horizonRequests: 5,
    });
    expect(
      snapshotDecision({
        ...decision,
        switchCost: {
          reason: 'remote text',
          horizonRequests: 5,
          confidenceOverride: false,
        } as never,
      }).switchCost,
    ).toBeUndefined();
  });

  it('persists only allowlisted generation metrics and rejects malformed estimates', () => {
    const generation: GenerationDiagnostics = {
      transition: 'model-switch',
      contextTruncated: false,
      attempts: 2,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      reportedCostUsd: 0.01,
      shadow: {
        previousModel: 'test/old',
        stayAllReadUsd: 0.1,
        stayAllNewUsd: 1,
        switchAllReadUsd: 0.05,
        switchAllNewUsd: 0.5,
      },
    };
    const tainted = {
      ...generation,
      sessionId: 'secret-session',
      apiKey: 'secret-key',
      shadow: { ...required(generation.shadow), explanation: 'secret-prompt' },
    };
    const copy = snapshotDecision({ ...decision, generation: tainted });
    expect(copy.generation).toEqual(generation);
    expect(JSON.stringify(copy)).not.toContain('secret');
    generation.inputTokens = 200;
    expect(copy.generation?.inputTokens).toBe(100);
    for (const invalid of [Number.NaN, -1, Number.POSITIVE_INFINITY, 0.5]) {
      expect(
        snapshotDecision({
          ...decision,
          generation: { ...generation, inputTokens: invalid },
        }).generation,
      ).toBeUndefined();
      const malformed = {
        ...generation,
        shadow: { ...generation.shadow, stayAllReadUsd: invalid },
      } as GenerationDiagnostics;
      if (invalid !== 0.5)
        expect(
          snapshotDecision({ ...decision, generation: malformed }).generation
            ?.shadow,
        ).toBeUndefined();
    }
    expect(
      snapshotDecision({
        ...decision,
        generation: { ...generation, contextTruncated: true },
      }).generation?.shadow,
    ).toBeUndefined();
    expect(
      snapshotDecision({
        ...decision,
        generation: { ...generation, transition: 'same-model' },
      }).generation?.shadow,
    ).toBeUndefined();
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
      bypassReason: 'remote-reason',
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
    expect(state.lastDecision?.bypassReason).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('secret');
    expect(JSON.stringify(state)).not.toContain('remote explanation');
    expect(
      snapshotDecision({
        ...decision,
        advisor: 'bypassed',
        bypassReason: 'single-candidate',
      }),
    ).toMatchObject({ advisor: 'bypassed', bypassReason: 'single-candidate' });
  });

  it('round-trips the all-fallbacks-failed flag through the persisted-state validator', () => {
    const failed = snapshotDecision({ ...decision, isGenerationFailed: true });
    expect(failed.isGenerationFailed).toBe(true);
    expect(
      isRouterPersistedState({
        enabled: true,
        selectedProfile: 'p',
        timestamp: 1,
        lastDecision: failed,
      }),
    ).toBe(true);
    expect(
      isRouterPersistedState({
        enabled: true,
        selectedProfile: 'p',
        timestamp: 1,
        lastDecision: { ...decision, isGenerationFailed: 'yes' },
      }),
    ).toBe(false);
  });

  it('maps obsolete prompt-derived sources from old snapshots to legacy', () => {
    const restored = {
      enabled: true,
      selectedProfile: 'p',
      timestamp: 1,
      lastPhase: 'planning',
      lastDecision: {
        ...decision,
        phase: 'implementation',
        reasonCode: 'heuristic',
      },
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

  it('accepts historical phase metadata and omits it from new snapshots', () => {
    const historicalDecision = {
      ...decision,
      phase: 'planning',
    } as unknown as RoutingDecision;
    const historical = {
      enabled: true,
      selectedProfile: 'p',
      timestamp: 1,
      lastPhase: 'implementation',
      lastDecision: historicalDecision,
      debugHistory: [historicalDecision],
    };
    expect(isRouterPersistedState(historical)).toBe(true);
    expect(snapshotDecision(historicalDecision)).not.toHaveProperty('phase');
    const saved = buildPersistedState({
      routerEnabled: true,
      selectedProfile: 'p',
      pinnedTierByProfile: {},
      thinkingByProfile: {},
      debugEnabled: false,
      widgetEnabled: false,
      debugHistory: [historicalDecision],
      lastDecision: historicalDecision,
      lastNonRouterModel: undefined,
      accumulatedCost: 0,
    });
    expect(saved).not.toHaveProperty('lastPhase');
    expect(saved.lastDecision).not.toHaveProperty('phase');
    expect(saved.debugHistory?.[0]).not.toHaveProperty('phase');
  });

  it('accepts only the fixed runtime reason codes', () => {
    for (const reasonCode of [
      'baseline',
      'pinned',
      'continuation',
      'classifier',
      'classifier',
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

describe('activity snapshots and native ownership', () => {
  it('keeps only allowlisted activity identity and numeric diagnostics', () => {
    const copy = snapshotDecision({
      ...decision,
      activity: 'code',
      routeCell: 'docs',
      classification: {
        outcome: 'selected',
        latencyMs: 1,
        activity: 'code',
        activityConfidence: 0.9,
        activityOutcome: 'selected',
        activityResponseIssue: 'missing-answer',
      },
    });
    expect(copy).toMatchObject({
      activity: 'code',
      routeCell: 'docs',
      classification: {
        activity: 'code',
        activityConfidence: 0.9,
        activityOutcome: 'selected',
        activityResponseIssue: 'missing-answer',
      },
    });
    const invalid = JSON.parse(
      JSON.stringify({
        ...copy,
        activity: 'secret',
        routeCell: 'secret',
        classification: {
          ...copy.classification,
          activity: 'secret',
          activityConfidence: 2,
          activityOutcome: 'secret',
          activityResponseIssue: 'secret',
          explanation: 'private',
        },
      }),
    ) as RoutingDecision;
    expect(snapshotDecision(invalid)).toMatchObject({
      activity: undefined,
      routeCell: undefined,
      classification: { outcome: 'selected', latencyMs: 1 },
    });
    expect(JSON.stringify(snapshotDecision(invalid))).not.toMatch(
      /secret|private/,
    );
  });

  it('validates native owner and activity fields without accepting remote identity', () => {
    const state = {
      enabled: true,
      selectedProfile: 'p',
      timestamp: 1,
      ownerSessionId: 'native-id',
      lastDecision: { ...decision, activity: 'docs', routeCell: 'code' },
    };
    expect(isRouterPersistedState(state)).toBe(true);
    for (const ownerSessionId of ['', 1, null])
      expect(isRouterPersistedState({ ...state, ownerSessionId })).toBe(false);
    expect(
      isRouterPersistedState({
        ...state,
        lastDecision: { ...decision, activity: 'unknown' },
      }),
    ).toBe(false);
    expect(
      isRouterPersistedState({
        ...state,
        lastDecision: { ...decision, routeCell: 'uncertain' },
      }),
    ).toBe(false);
  });
});

it('persists the local recovery diagnostic but never incidental recovery scope or provider text', () => {
  const raw = {
    ...decision,
    costRecovery: true,
    reasonCode: 'cost-recovery' as const,
    recoveryScope: {
      config: { token: 'fixture-private' },
      branch: ['branch-private'],
    },
  };
  const saved = snapshotDecision(raw);
  expect(saved.costRecovery).toBe(true);
  expect(saved.reasonCode).toBe('cost-recovery');
  expect(JSON.stringify(saved)).not.toMatch(
    /fixture-private|branch-private|recoveryScope/u,
  );
  Reflect.set(raw, 'costRecovery', 'provider explanation');
  expect(snapshotDecision(raw).costRecovery).toBeUndefined();
});
