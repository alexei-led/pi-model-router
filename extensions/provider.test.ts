import {
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  normalizeContext,
} from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerRouterProvider, waitForRegistry } from './provider';
import { done, events, failure, message, model } from './test/fixtures';

type State = Parameters<typeof registerRouterProvider>[1];
type MutableState = { -readonly [K in keyof State]: State[K] };

const setup = () => {
  const models = [
    model(),
    model('fallback', { contextWindow: 2048 }),
    model('small', { contextWindow: 1024 }),
  ];
  const delegate = vi.fn<ExtensionContext['modelRegistry']['streamSimple']>(
    () => done(),
  );
  const registry = {
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    streamSimple: delegate,
  } as unknown as ExtensionContext['modelRegistry'];
  const state: MutableState = {
    lastRegisteredModels: '',
    currentModelRegistry: registry,
    lastExtensionContext: undefined,
    currentConfig: {
      profiles: {
        balanced: {
          high: { model: 'test/primary' },
          medium: { model: 'test/primary', fallbacks: ['test/fallback'] },
          low: { model: 'test/small' },
        },
      },
    },
    selectedProfile: undefined,
    routerEnabled: false,
    lastDecision: undefined,
    thinkingByProfile: {},
    pinnedTierByProfile: { balanced: 'medium' },
    accumulatedCost: 0,
  };
  const register = vi.fn<ExtensionAPI['registerProvider']>();
  const api = { registerProvider: register } as unknown as ExtensionAPI;
  const actions = {
    persistState: vi.fn(),
    recordDebugDecision: vi.fn(),
    getThinkingOverride: vi.fn(),
    updateStatus: vi.fn(),
    syncPiThinkingLevel: vi.fn(),
  };
  const stream = (
    context: Context = {
      messages: [{ role: 'user', content: 'implement', timestamp: 1 }],
    },
    signal?: AbortSignal,
  ) => {
    registerRouterProvider(api, state, actions);
    const config = register.mock.calls.at(-1)?.[1];
    if (!config?.streamSimple)
      throw new Error('Router provider not registered');
    return config.streamSimple(
      model('balanced', { provider: 'router', contextWindow: 8192 }),
      normalizeContext(context),
      { signal },
    );
  };
  return { models, registry, state, delegate, register, api, actions, stream };
};

const consume = async (stream: AssistantMessageEventStream) => {
  const received: AssistantMessageEvent[] = [];
  for await (const event of stream) received.push(event);
  const result = await stream.result();
  return { received, result };
};

describe('router provider', () => {
  it('delegates through the registry and accounts for completed work', async () => {
    const s = setup();
    const { result } = await consume(s.stream());
    expect(result.stopReason).toBe('stop');
    expect(s.delegate.mock.calls[0]?.[0].id).toBe('primary');
    expect(s.state.accumulatedCost).toBe(0.01);
    expect(s.state).toMatchObject({
      selectedProfile: 'balanced',
      routerEnabled: true,
    });
    expect(s.actions.persistState).toHaveBeenCalledOnce();
  });

  it('does not pass or report thinking for a non-reasoning target', async () => {
    const s = setup();
    s.models[0].reasoning = false;
    await consume(s.stream());
    expect(s.delegate.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
    expect(s.state.lastDecision?.thinking).toBe('off');
  });

  it('reports actual capacities and re-registers when thinking capabilities change', () => {
    const s = setup();
    registerRouterProvider(s.api, s.state, s.actions);
    expect(s.register.mock.calls[0]?.[1].models?.[0]).toMatchObject({
      contextWindow: 8192,
      maxTokens: 1024,
    });
    registerRouterProvider(s.api, s.state, s.actions);
    expect(s.register).toHaveBeenCalledTimes(1);
    s.state.currentConfig.profiles.balanced.high = {
      model: 'test/primary',
      resolvedThinkingLevels: ['xhigh'],
    };
    registerRouterProvider(s.api, s.state, s.actions);
    expect(s.register).toHaveBeenCalledTimes(2);
  });

  it.each(['error', 'throw', 'missing'] as const)(
    'falls back after a pre-output %s and records the actual model',
    async (kind) => {
      const s = setup();
      if (kind === 'missing') s.models.shift();
      else
        s.delegate.mockImplementationOnce(() => {
          if (kind === 'throw') throw new Error('auth failure');
          return failure();
        });
      const { result } = await consume(s.stream());
      expect(result.stopReason).toBe('stop');
      expect(s.state.lastDecision).toMatchObject({
        isFallback: true,
        targetLabel: 'test/fallback',
        targetModelId: 'fallback',
      });
      expect(s.delegate.mock.calls.at(-1)?.[0].id).toBe('fallback');
    },
  );

  it('does not leak a failed attempt start event into the fallback', async () => {
    const s = setup();
    s.delegate.mockReturnValueOnce(
      events(
        { type: 'start', partial: message() },
        {
          type: 'error',
          reason: 'error',
          error: message({ stopReason: 'error' }),
        },
      ),
    );
    const { received } = await consume(s.stream());
    expect(received.map((e) => e.type)).toEqual(['done']);
  });

  it('does not retry after output even if the iterator throws', async () => {
    const s = setup();
    let step = 0;
    s.delegate.mockReturnValueOnce({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (step++ === 0)
            return {
              done: false,
              value: {
                type: 'text_delta',
                contentIndex: 0,
                delta: 'partial',
                partial: message(),
              },
            };
          throw new Error('connection lost');
        },
      }),
    } as AssistantMessageEventStream);
    const { result, received } = await consume(s.stream());
    expect(result.stopReason).toBe('error');
    expect(result.content).toEqual(message().content);
    expect(received.filter((e) => e.type === 'text_delta')).toHaveLength(1);
    expect(s.delegate).toHaveBeenCalledOnce();
  });

  it('returns a terminal error when every stream ends without a terminal event', async () => {
    const s = setup();
    s.delegate.mockImplementation(() => events());
    const { result } = await consume(s.stream());
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('terminal');
  });

  it('preserves cancellation instead of trying another model', async () => {
    const s = setup();
    s.delegate.mockReturnValueOnce(failure('aborted'));
    expect((await consume(s.stream())).result.stopReason).toBe('aborted');
    expect(s.delegate).toHaveBeenCalledOnce();
  });

  it('does not start requests for an already cancelled turn', async () => {
    const s = setup();
    expect(
      (await consume(s.stream(undefined, AbortSignal.abort()))).result
        .stopReason,
    ).toBe('aborted');
    expect(s.delegate).not.toHaveBeenCalled();
  });

  it('resolves classifier choices against partial profiles', async () => {
    const s = setup();
    s.state.currentConfig.profiles.balanced = {
      medium: { model: 'test/primary' },
    };
    s.state.currentConfig.classifierModel = { model: 'test/small' };
    delete s.state.pinnedTierByProfile.balanced;
    s.delegate.mockReturnValueOnce(done('Tier: high\nReasoning: complex'));
    expect((await consume(s.stream())).result.stopReason).toBe('stop');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      isClassifier: true,
    });
  });

  it('keeps the prior Google model on a thinking tool continuation', async () => {
    const s = setup();
    s.models[0].provider = 'google';
    s.models[1].provider = 'google';
    s.state.currentConfig.profiles.balanced.medium = {
      model: 'google/primary',
    };
    s.state.lastDecision = {
      profile: 'balanced',
      tier: 'medium',
      phase: 'implementation',
      targetProvider: 'google',
      targetModelId: 'fallback',
      targetLabel: 'google/fallback',
      thinking: 'medium',
      timestamp: 1,
      reasoning: 'prior',
    };
    const context: Context = {
      messages: [
        {
          role: 'toolResult',
          toolCallId: 'call',
          toolName: 'read',
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
          timestamp: 1,
        },
      ],
    };
    await consume(s.stream(context));
    expect(s.delegate.mock.calls[0]?.[0].id).toBe('fallback');
  });

  it('routes images to a capable model and errors when none exists', async () => {
    const s = setup();
    s.state.pinnedTierByProfile.balanced = 'low';
    s.models[2].input = ['text'];
    const context: Context = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
          timestamp: 1,
        },
      ],
    };
    expect((await consume(s.stream(context))).result.stopReason).toBe('stop');
    expect(s.state.lastDecision?.tier).toBe('medium');
    for (const m of s.models) m.input = ['text'];
    s.delegate.mockClear();
    expect((await consume(s.stream(context))).result.stopReason).toBe('error');
    expect(s.delegate).not.toHaveBeenCalled();
  });

  it('truncates whole old turns for the actual fallback without orphaning tool results', async () => {
    const s = setup();
    s.delegate.mockReturnValueOnce(failure());
    const context: Context = {
      systemPrompt: 'Keep instructions',
      messages: [
        { role: 'user', content: 'x'.repeat(10000), timestamp: 1 },
        message({
          content: [
            { type: 'toolCall', id: 'call', name: 'read', arguments: {} },
          ],
        }),
        {
          role: 'toolResult',
          toolCallId: 'call',
          toolName: 'read',
          content: [{ type: 'text', text: 'x'.repeat(4000) }],
          timestamp: 1,
          isError: false,
        },
        { role: 'user', content: 'implement', timestamp: 1 },
      ],
    };
    await consume(s.stream(context));
    const delegated = s.delegate.mock.calls.at(-1)?.[1];
    expect(delegated?.messages.filter((m) => m.role !== 'system')).toEqual([
      context.messages[3],
    ]);
    expect(delegated?.messages[0].role).toBe('system');
    expect(context.messages).toHaveLength(4);
  });

  it('rejects unknown profiles and unavailable registries with a terminal error', async () => {
    const s = setup();
    s.state.currentConfig.profiles = {};
    expect((await consume(s.stream())).result.errorMessage).toContain(
      'Unknown router profile',
    );
    s.state.currentModelRegistry = undefined;
    s.state.registryTimeoutMs = 0;
    expect((await consume(s.stream())).result.errorMessage).toContain(
      'initialization timed out',
    );
  });
});

describe('registry readiness', () => {
  it('returns immediately when ready and waits only until the registry appears', async () => {
    const s = setup();
    expect(await waitForRegistry(s.state)).toBe(s.registry);
    s.state.currentModelRegistry = undefined;
    const pending = waitForRegistry(s.state, 100);
    s.state.currentModelRegistry = s.registry;
    expect(await pending).toBe(s.registry);
  });

  it('returns undefined on timeout and responds to cancellation during readiness', async () => {
    await expect(
      waitForRegistry({ currentModelRegistry: undefined }, 10),
    ).resolves.toBeUndefined();
    const abort = new AbortController();
    const pending = waitForRegistry(
      { currentModelRegistry: undefined },
      5000,
      abort.signal,
    );
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
