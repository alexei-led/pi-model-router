import { normalizeContext } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import routerExtension from './index';
import { done, model } from './test/fixtures';
import type { RouterConfig } from './types';
import * as ui from './ui';

const stateMocks = vi.hoisted(() => ({
  advisors: {} as Pick<RouterConfig, 'jev' | 'classifierModel'>,
  loadLastRouterProfile: vi.fn(),
  saveLastRouterProfile: vi.fn(),
}));

vi.mock('./state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state')>()),
  loadLastRouterProfile: stateMocks.loadLastRouterProfile,
  saveLastRouterProfile: stateMocks.saveLastRouterProfile,
}));

vi.mock('./config', async (importOriginal) => {
  const configModule = await importOriginal<typeof import('./config')>();
  return {
    ...configModule,
    loadRouterConfig: () => {
      return configModule.normalizeConfig({
        ...stateMocks.advisors,
        profiles: {
          balanced: {
            jev: { enabled: true },
            high: { model: 'openai/gpt-4o' },
            medium: { model: 'openai/gpt-4o-mini' },
            micro: { model: 'openai/tiny', thinking: 'off' },
          },
          alternate: {
            high: { model: 'anthropic/claude-opus-4' },
            medium: { model: 'anthropic/claude-sonnet-4' },
          },
        },
      });
    },
  };
});

describe('index.ts (orchestrator)', () => {
  type EventHandler = (
    event: Record<string, unknown>,
    ctx: ReturnType<typeof buildMockCtx>,
  ) => unknown;
  let mockPi: ReturnType<typeof buildMockPi>;
  let eventListeners: Record<string, EventHandler[]> = {};
  const handlersFor = (event: string): EventHandler[] => {
    const handlers = eventListeners[event];
    if (!handlers) throw new Error(`Missing ${event} handler`);
    return handlers;
  };

  const buildMockPi = () => {
    const api = {
      registerProvider: vi.fn(),
      registerCommand: vi.fn(),
      setModel: vi.fn().mockResolvedValue(true),
      setThinkingLevel: vi.fn(),
      appendEntry: vi.fn(),
      on: vi.fn().mockImplementation((event: string, handler: EventHandler) => {
        eventListeners[event] ??= [];
        eventListeners[event].push(handler);
      }),
    };
    return api as typeof api & ExtensionAPI;
  };

  beforeEach(() => {
    eventListeners = {};
    stateMocks.advisors = {};
    stateMocks.loadLastRouterProfile.mockReset();
    stateMocks.loadLastRouterProfile.mockReturnValue(undefined);
    stateMocks.saveLastRouterProfile.mockReset();
    stateMocks.saveLastRouterProfile.mockReturnValue(true);
    mockPi = buildMockPi();
  });

  const buildMockCtx = () => ({
    cwd: '/mock/cwd',
    modelRegistry: {
      find: vi
        .fn()
        .mockImplementation((provider: string, id: string) =>
          model(id, { provider }),
        ),
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'key' }),
    },
    model: { provider: 'router', id: 'balanced' },
    sessionManager: {
      getBranch: () => [] as unknown[],
    },
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setHiddenThinkingLabel: vi.fn(),
      theme: { fg: (_color: string, text: string) => text },
      notify: vi.fn(),
    },
  });

  const notifyDiagnostics = async (ctx: ReturnType<typeof buildMockCtx>) => {
    const command = mockPi.registerCommand.mock.calls.find(
      ([name]) => name === 'router',
    )?.[1] as Parameters<ExtensionAPI['registerCommand']>[1] | undefined;
    if (!command) throw new Error('Missing router command');
    for (const args of ['status', 'debug show'])
      await command.handler(args, ctx as unknown as ExtensionCommandContext);
    expect(ctx.ui.notify).toHaveBeenCalled();
  };

  it('passes only public status fields across the UI boundary', async () => {
    stateMocks.advisors = {
      jev: {
        enabled: true,
        apiKey: 'private-key-sentinel',
        endpoint: 'https://private-endpoint.example/v1/systemone',
        model: 'jev-1.13.0',
        timeoutMs: 750,
        confidenceThreshold: 0.65,
        maxStateChars: 12000,
        mode: 'advisory',
      },
    };
    const status = vi.spyOn(ui, 'updateStatus');
    try {
      routerExtension(mockPi);
      const ctx = buildMockCtx();
      for (const handler of handlersFor('session_start'))
        await handler({}, ctx);
      expect(status).toHaveBeenCalled();
      for (const [, projection] of status.mock.calls) {
        expect(projection).toHaveProperty('maxSessionBudget');
        expect(projection).not.toHaveProperty('currentConfig');
        expect(JSON.stringify(projection)).not.toContain(
          'private-key-sentinel',
        );
        expect(JSON.stringify(projection)).not.toContain('private-endpoint');
      }
    } finally {
      status.mockRestore();
    }
  });

  it('restores micro pins and thinking overrides without migration', async () => {
    routerExtension(mockPi);
    const ctx = buildMockCtx();
    ctx.sessionManager.getBranch = () => [
      {
        type: 'custom',
        customType: 'router-state',
        data: {
          enabled: true,
          selectedProfile: 'balanced',
          pinTier: 'micro',
          thinkingByProfile: { balanced: { micro: 'off' } },
          timestamp: 1,
        },
      },
    ];
    for (const handler of handlersFor('session_start')) {
      await handler({}, ctx);
    }
    expect(mockPi.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      pinTier: 'micro',
      thinkingByProfile: { balanced: { micro: 'off' } },
    });
  });

  it.each(['classifier', 'jev'] as const)(
    'persists only safe %s metadata through real provider and appendEntry callbacks',
    async (source) => {
      const privateText = 'private-key remote task text explanation';
      if (source === 'classifier')
        stateMocks.advisors = {
          classifierModel: { model: 'openai/classifier' },
        };
      else
        stateMocks.advisors = {
          jev: {
            enabled: true,
            apiKey: privateText,
            endpoint: 'https://api.typesafe.ai/v1/systemone',
            model: 'jev-1.13.0',
            timeoutMs: 750,
            confidenceThreshold: 0.65,
            maxStateChars: 12000,
            mode: 'advisory',
          },
        };
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        const id = 'high|openai%2Fgpt-4o|medium';
        return new Response(
          JSON.stringify({
            answers: {
              route: {
                type: 'choice',
                choice: id,
                confidence: 1,
                probabilities: { [id]: 1, uncertain: 0 },
                reasoning: privateText,
              },
            },
          }),
        );
      });
      vi.stubGlobal('fetch', fetch);
      try {
        routerExtension(mockPi);
        const ctx = buildMockCtx();
        ctx.modelRegistry.find.mockImplementation(
          (provider: string, id: string) => model(id, { provider }),
        );
        const delegate = vi.fn(() => done());
        if (source === 'classifier')
          delegate.mockReturnValueOnce(
            done(`Tier: high\nReasoning: ${privateText}`),
          );
        Object.assign(ctx.modelRegistry, { streamSimple: delegate });
        for (const handler of handlersFor('session_start'))
          await handler({ reason: 'new' }, ctx);
        const provider = mockPi.registerProvider.mock.calls.at(-1)?.[1];
        const stream = provider?.streamSimple?.(
          model('balanced', { provider: 'router' }),
          normalizeContext({
            messages: [
              {
                role: 'user',
                content: `design security. ${privateText}`,
                timestamp: 1,
              },
            ],
          }),
        );
        if (!stream) throw new Error('Missing registered router stream');
        for await (const _event of stream) {
          /* Drain the actual provider callback. */
        }
        expect((await stream.result()).stopReason).toBe('stop');
        const expectedSource = source === 'jev' ? 'baseline' : source;
        expect(mockPi.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
          lastDecision: { reasonCode: expectedSource },
          debugHistory: [{ reasonCode: expectedSource }],
        });
        await notifyDiagnostics(ctx);
        const output = JSON.stringify([
          ctx.ui.notify.mock.calls,
          mockPi.appendEntry.mock.calls,
          ctx.ui.setStatus.mock.calls,
          ctx.ui.setWidget.mock.calls,
        ]);
        for (const text of [
          privateText,
          'typesafe.ai',
          'reasoning',
          'apiKey',
          'endpoint',
        ])
          expect(output).not.toContain(text);
        expect(delegate).toHaveBeenCalledTimes(source === 'classifier' ? 2 : 1);
        expect(fetch).toHaveBeenCalledTimes(source === 'jev' ? 1 : 0);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    undefined,
    'custom-rule',
    'micro-mechanical',
    'heuristic',
    'safety-floor',
    'budget-floor-conflict',
  ])(
    'sanitizes historical source %s at append, notification and status boundaries',
    async (reasonCode) => {
      routerExtension(mockPi);
      const ctx = buildMockCtx();
      const leaked =
        'private-key https://remote.invalid task transcript classifier explanation';
      const oldDecision = {
        profile: 'balanced',
        tier: 'high',
        phase: 'planning',
        targetProvider: 'openai',
        targetModelId: 'gpt-4o',
        targetLabel: 'openai/gpt-4o',
        thinking: 'high',
        timestamp: 1,
        reasonCode,
        reasoning: leaked,
        apiKey: leaked,
        endpoint: leaked,
        rawResponse: leaked,
      };
      const saved = {
        enabled: true,
        selectedProfile: 'balanced',
        timestamp: 1,
        pinByProfile: { balanced: 'high' },
        thinkingByProfile: { balanced: { high: 'high' } },
        accumulatedCost: 1.25,
        debugEnabled: true,
        lastDecision: oldDecision,
        debugHistory: [oldDecision],
        widgetEnabled: true,
      };
      ctx.sessionManager.getBranch = () => [
        { type: 'custom', customType: 'router-state', data: saved },
      ];
      for (const handler of handlersFor('session_start'))
        await handler({ reason: 'switch' }, ctx);
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          pinByProfile: { balanced: 'high' },
          thinkingByProfile: { balanced: { high: 'high' } },
          accumulatedCost: 1.25,
          debugEnabled: true,
          widgetEnabled: true,
          lastDecision: expect.objectContaining({ reasonCode: 'legacy' }),
          debugHistory: [expect.objectContaining({ reasonCode: 'legacy' })],
        }),
      );
      for (const handler of handlersFor('thinking_level_select'))
        await handler({ level: 'low' }, ctx);
      await notifyDiagnostics(ctx);
      const output = JSON.stringify([
        ctx.ui.notify.mock.calls,
        mockPi.appendEntry.mock.calls,
        ctx.ui.setStatus.mock.calls,
        ctx.ui.setWidget.mock.calls,
      ]);
      for (const text of [
        'private-key',
        'remote.invalid',
        'task transcript',
        'classifier explanation',
        'reasoning',
        'rawResponse',
      ])
        expect(output).not.toContain(text);
      expect(saved.lastDecision.reasoning).toBe(leaked);
    },
  );

  it('does not restore an unknown reason code into the append or UI paths', async () => {
    routerExtension(mockPi);
    const ctx = buildMockCtx();
    ctx.sessionManager.getBranch = () => [
      {
        type: 'custom',
        customType: 'router-state',
        data: {
          enabled: true,
          selectedProfile: 'balanced',
          timestamp: 1,
          lastDecision: {
            profile: 'balanced',
            tier: 'high',
            phase: 'planning',
            targetProvider: 'openai',
            targetModelId: 'gpt-4o',
            targetLabel: 'openai/gpt-4o',
            thinking: 'high',
            timestamp: 1,
            reasonCode: 'private-key',
            reasoning: 'legacy-looking text',
          },
        },
      },
    ];
    for (const handler of handlersFor('session_start'))
      await handler({ reason: 'switch' }, ctx);
    expect(JSON.stringify(mockPi.appendEntry.mock.calls)).not.toContain(
      'private-key',
    );
    expect(
      mockPi.appendEntry.mock.calls.at(-1)?.[1].lastDecision,
    ).toBeUndefined();
  });

  it('keeps restored branch snapshots immutable when thinking changes', async () => {
    routerExtension(mockPi);
    const ctx = buildMockCtx();
    const saved = {
      enabled: true,
      selectedProfile: 'balanced',
      timestamp: 1,
      thinkingByProfile: { balanced: Object.freeze({ high: 'high' }) },
    };
    ctx.sessionManager.getBranch = () => [
      { type: 'custom', customType: 'router-state', data: saved },
    ];
    for (const handler of handlersFor('session_start'))
      await handler({ reason: 'switch' }, ctx);
    const before = structuredClone(mockPi.appendEntry.mock.calls.at(-1)?.[1]);
    for (const handler of handlersFor('thinking_level_select'))
      await handler({ level: 'low' }, ctx);
    expect(saved.thinkingByProfile.balanced.high).toBe('high');
    expect(mockPi.appendEntry.mock.calls[0]?.[1]).toEqual(before);
    expect(mockPi.appendEntry.mock.calls.at(-1)?.[1]).toMatchObject({
      thinkingByProfile: { balanced: { high: 'low' } },
    });
  });

  it('persists identical initial state separately on a new branch', async () => {
    routerExtension(mockPi);
    for (const handler of handlersFor('session_start')) {
      await handler({ reason: 'new' }, buildMockCtx());
      await handler({ reason: 'new' }, buildMockCtx());
    }
    expect(mockPi.appendEntry).toHaveBeenCalledTimes(2);
  });

  it('initialize and register commands, provider, and event hooks', () => {
    routerExtension(mockPi);

    expect(mockPi.registerProvider).toHaveBeenCalledWith(
      'router',
      expect.any(Object),
    );
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      'router',
      expect.any(Object),
    );
    expect(mockPi.on).toHaveBeenCalledWith(
      'session_start',
      expect.any(Function),
    );
    expect(mockPi.on).toHaveBeenCalledWith(
      'model_select',
      expect.any(Function),
    );
    expect(mockPi.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
  });

  it('restore state from session on session_start hook', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();
    mockCtx.sessionManager.getBranch = () => [
      {
        type: 'custom',
        customType: 'router-state',
        data: {
          enabled: true,
          selectedProfile: 'balanced',
          pinByProfile: { balanced: 'high' },
          thinkingByProfile: {},
          debugEnabled: true,
          widgetEnabled: true,
          accumulatedCost: 0.012,
          timestamp: Date.now(),
        },
      },
      {
        type: 'custom',
        customType: 'other-extension-state',
        data: {
          enabled: false,
          selectedProfile: 'other',
          timestamp: Date.now(),
        },
      },
    ];

    const sessionStartHandlers = eventListeners.session_start || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }

    expect(mockCtx.ui.setStatus).toHaveBeenCalled();
    expect(mockPi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'router', id: 'balanced' }),
    );
  });

  it('handle model select hook', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();

    const sessionStartHandlers = eventListeners.session_start || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }

    const modelSelectHandlers = eventListeners.model_select || [];
    for (const handler of modelSelectHandlers) {
      await handler({ model: { provider: 'router', id: 'balanced' } }, mockCtx);
    }

    expect(mockCtx.ui.setStatus).toHaveBeenCalled();
    expect(stateMocks.saveLastRouterProfile).toHaveBeenCalledWith('balanced');
  });

  it('enforce router model on turn_end hook', async () => {
    routerExtension(mockPi);

    const mockCtx = buildMockCtx();

    const sessionStartHandlers = eventListeners.session_start || [];
    for (const handler of sessionStartHandlers) {
      await handler({}, mockCtx);
    }

    const modelSelectHandlers = eventListeners.model_select || [];
    for (const handler of modelSelectHandlers) {
      await handler({ model: { provider: 'router', id: 'balanced' } }, mockCtx);
    }

    mockCtx.model = { provider: 'openai', id: 'gpt-4o' };

    const turnEndHandlers = eventListeners.turn_end || [];
    for (const handler of turnEndHandlers) {
      await handler({}, mockCtx);
    }

    expect(mockPi.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'router', id: 'balanced' }),
    );
  });

  describe('model_select event', () => {
    it('set routerEnabled=false, record lastNonRouterModel, and call setHiddenThinkingLabel for non-router model', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      mockPi.appendEntry.mockClear();

      const modelSelectHandlers = eventListeners.model_select || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          { model: { provider: 'anthropic', id: 'claude-3-5-sonnet' } },
          mockCtx,
        );
      }

      expect(mockCtx.ui.setHiddenThinkingLabel).toHaveBeenCalled();

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
          lastNonRouterModel: 'anthropic/claude-3-5-sonnet',
        }),
      );
    });

    it('be a no-op before session_start (isInitialized=false)', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      mockPi.appendEntry.mockClear();
      mockCtx.ui.setStatus.mockClear();

      const modelSelectHandlers = eventListeners.model_select || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          { model: { provider: 'anthropic', id: 'claude-3-5-sonnet' } },
          mockCtx,
        );
      }

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
      expect(mockCtx.ui.setHiddenThinkingLabel).not.toHaveBeenCalled();
    });
  });

  describe('thinking_level_select event', () => {
    it.each(['max', 'minimal'])(
      'rejects unsupported %s selection atomically and restores Pi display',
      async (level) => {
        routerExtension(mockPi);
        const ctx = buildMockCtx();
        ctx.modelRegistry.find.mockImplementation((provider, id) =>
          model(id, {
            provider,
            thinkingLevelMap: { max: null, minimal: null },
          }),
        );
        for (const handler of handlersFor('session_start'))
          await handler({}, ctx);
        mockPi.appendEntry.mockClear();
        for (const handler of handlersFor('thinking_level_select'))
          handler({ level, previousLevel: 'medium' }, ctx);
        expect(mockPi.appendEntry).not.toHaveBeenCalled();
        expect(mockPi.setThinkingLevel).toHaveBeenLastCalledWith('medium');
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining('leaves no eligible route'),
          'warning',
        );
      },
    );

    it.each(['thinking', 'image'] as const)(
      'preserves configured %s coverage when selecting thinking',
      async (capability) => {
        routerExtension(mockPi);
        const ctx = buildMockCtx();
        ctx.modelRegistry.find.mockImplementation((provider, id) =>
          model(id, {
            provider,
            input:
              capability === 'image' && id === 'gpt-4o'
                ? ['text']
                : ['text', 'image'],
            thinkingLevelMap: { low: null },
          }),
        );
        for (const handler of handlersFor('session_start'))
          await handler({}, ctx);
        mockPi.appendEntry.mockClear();
        for (const handler of handlersFor('thinking_level_select'))
          handler({ level: 'low', previousLevel: 'medium' }, ctx);
        expect(mockPi.appendEntry).not.toHaveBeenCalled();
        expect(mockPi.setThinkingLevel).toHaveBeenLastCalledWith('medium');
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining('unchanged'),
          'warning',
        );
      },
    );

    it('apply thinking level as all-tier override for active profile', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      mockPi.appendEntry.mockClear();

      const thinkingHandlers = eventListeners.thinking_level_select || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'high' }, mockCtx);
      }

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          thinkingByProfile: {
            balanced: {
              high: 'high',
              medium: 'high',
              low: 'high',
              micro: 'high',
            },
          },
        }),
      );
    });

    it('ignore Pi startup thinking selection but keep user changes', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({ reason: 'startup' }, mockCtx);
      }

      mockPi.appendEntry.mockClear();
      const thinkingHandlers = eventListeners.thinking_level_select || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'medium', previousLevel: 'off' }, mockCtx);
      }
      expect(mockPi.appendEntry).not.toHaveBeenCalled();

      for (const handler of thinkingHandlers) {
        handler({ level: 'high', previousLevel: 'medium' }, mockCtx);
      }
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          thinkingByProfile: {
            balanced: {
              high: 'high',
              medium: 'high',
              low: 'high',
              micro: 'high',
            },
          },
        }),
      );
    });

    it('be ignored when router is not enabled', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      mockPi.appendEntry.mockClear();

      const thinkingHandlers = eventListeners.thinking_level_select || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'medium' }, mockCtx);
      }

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });

    it('be ignored before initialization', () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      mockPi.appendEntry.mockClear();

      const thinkingHandlers = eventListeners.thinking_level_select || [];
      for (const handler of thinkingHandlers) {
        handler({ level: 'low' }, mockCtx);
      }

      expect(mockPi.appendEntry).not.toHaveBeenCalled();
    });
  });

  describe('restoreStateFromSession edge cases', () => {
    it('handle fresh session with no saved router-state entries', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => [];

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      expect(mockPi.setModel).toHaveBeenCalled();
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: true,
          selectedProfile: 'balanced',
        }),
      );
    });

    it('restore the last profile for a new startup session', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('alternate');
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.modelRegistry.find = vi
        .fn()
        .mockImplementation((provider: string, id: string) => ({
          provider,
          id,
        }));

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({ reason: 'startup' }, mockCtx);
      }

      expect(mockPi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'router', id: 'alternate' }),
      );
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: true,
          selectedProfile: 'alternate',
        }),
      );
    });

    it('preserve an explicit CLI model selection', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('alternate');
      routerExtension(mockPi);

      const originalArgv = process.argv;
      process.argv = [...originalArgv, '--model=router/balanced'];
      try {
        const mockCtx = buildMockCtx();
        mockCtx.sessionManager.getBranch = () => [
          {
            type: 'custom',
            customType: 'router-state',
            data: {
              enabled: true,
              selectedProfile: 'alternate',
              lastNonRouterModel: 'anthropic/claude-sonnet-4',
              timestamp: Date.now(),
            },
          },
        ];
        const sessionStartHandlers = eventListeners.session_start || [];
        for (const handler of sessionStartHandlers) {
          await handler({ reason: 'startup' }, mockCtx);
        }
      } finally {
        process.argv = originalArgv;
      }

      expect(stateMocks.loadLastRouterProfile).not.toHaveBeenCalled();
      expect(mockPi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'router', id: 'balanced' }),
      );
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: true,
          selectedProfile: 'balanced',
        }),
      );
    });

    it('not enable the router when Pi starts on a non-router model', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('alternate');
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };
      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({ reason: 'startup' }, mockCtx);
      }

      expect(stateMocks.loadLastRouterProfile).not.toHaveBeenCalled();
      expect(mockPi.setModel).not.toHaveBeenCalled();
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({ enabled: false }),
      );
    });

    it('ignore a last profile that is no longer configured', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('removed');
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({ reason: 'startup' }, mockCtx);
      }

      expect(mockPi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'router', id: 'balanced' }),
      );
      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({ selectedProfile: 'balanced' }),
      );
    });

    it('prefer branch state over the cross-session profile', async () => {
      stateMocks.loadLastRouterProfile.mockReturnValue('alternate');
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({ reason: 'startup' }, mockCtx);
      }

      expect(mockPi.setModel).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'router', id: 'balanced' }),
      );
      expect(stateMocks.loadLastRouterProfile).not.toHaveBeenCalled();
    });

    it('handle failed model restoration (setModel returns false)', async () => {
      mockPi.setModel = vi.fn().mockResolvedValue(false);
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinByProfile: {},
            thinkingByProfile: {},
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Failed to restore router/balanced'),
        'warning',
      );

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
        }),
      );
    });

    it('handle router model unavailable in registry', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.modelRegistry.find = vi.fn().mockReturnValue(undefined);
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinByProfile: {},
            thinkingByProfile: {},
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      expect(mockCtx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Unable to restore router/balanced'),
        'warning',
      );

      expect(mockCtx.ui.setHiddenThinkingLabel).toHaveBeenCalled();

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          enabled: false,
        }),
      );
    });

    it('migrate legacy pinTier field to pinByProfile', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinTier: 'medium',
            pinByProfile: {},
            thinkingByProfile: {},
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      expect(mockPi.appendEntry).toHaveBeenCalledWith(
        'router-state',
        expect.objectContaining({
          pinByProfile: expect.objectContaining({ balanced: 'medium' }),
        }),
      );
    });

    it('sync thinking level when lastDecision exists on successful restore', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      const decision = {
        profile: 'balanced',
        tier: 'high' as const,
        phase: 'planning' as const,
        targetProvider: 'openai',
        targetModelId: 'gpt-4o',
        targetLabel: 'openai/gpt-4o',
        reasoning: 'test',
        thinking: 'high' as const,
        timestamp: Date.now(),
      };
      mockCtx.sessionManager.getBranch = () => [
        {
          type: 'custom',
          customType: 'router-state',
          data: {
            enabled: true,
            selectedProfile: 'balanced',
            pinByProfile: {},
            thinkingByProfile: {},
            lastDecision: decision,
            timestamp: Date.now(),
          },
        },
      ];

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      expect(mockPi.setThinkingLevel).toHaveBeenCalledWith('high');
    });
  });

  describe('turn_end event', () => {
    it('persist state and update status but NOT restore model when router is not enabled', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();
      mockCtx.model = { provider: 'openai', id: 'gpt-4o' };

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      mockPi.setModel.mockClear();
      mockPi.appendEntry.mockClear();
      mockCtx.ui.setStatus.mockClear();

      const turnEndHandlers = eventListeners.turn_end || [];
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }

      expect(mockPi.setModel).not.toHaveBeenCalled();

      expect(mockCtx.ui.setStatus).toHaveBeenCalled();
    });
  });

  describe('persistState deduplication', () => {
    it('only call appendEntry once when state has not changed between turn_end calls', async () => {
      routerExtension(mockPi);

      const mockCtx = buildMockCtx();

      const sessionStartHandlers = eventListeners.session_start || [];
      for (const handler of sessionStartHandlers) {
        await handler({}, mockCtx);
      }

      const modelSelectHandlers = eventListeners.model_select || [];
      for (const handler of modelSelectHandlers) {
        await handler(
          { model: { provider: 'router', id: 'balanced' } },
          mockCtx,
        );
      }

      mockPi.appendEntry.mockClear();

      const turnEndHandlers = eventListeners.turn_end || [];
      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }
      const callsAfterFirst = mockPi.appendEntry.mock.calls.length;

      for (const handler of turnEndHandlers) {
        await handler({}, mockCtx);
      }
      const callsAfterSecond = mockPi.appendEntry.mock.calls.length;

      expect(callsAfterSecond).toBe(callsAfterFirst);
    });
  });

  describe('ensureInitializedFromContext', () => {
    it('initialize registry and context on first turn_start, but not overwrite on subsequent events', async () => {
      routerExtension(mockPi);

      const mockCtx1 = buildMockCtx();
      mockCtx1.cwd = '/mock/cwd1';

      const turnStartHandlers = eventListeners.turn_start || [];
      for (const handler of turnStartHandlers) {
        await handler({}, mockCtx1);
      }

      expect(mockCtx1.ui.setStatus).toHaveBeenCalled();
      mockCtx1.ui.setStatus.mockClear();

      const mockCtx2 = buildMockCtx();
      mockCtx2.cwd = '/mock/cwd2';
      const turnStartHandler = turnStartHandlers[0];
      if (!turnStartHandler) throw new Error('Missing turn_start handler');
      await turnStartHandler({}, mockCtx2);
      expect(mockCtx2.ui.setStatus).not.toHaveBeenCalled();
    });
  });
});
