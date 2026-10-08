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
import { normalizeConfig } from './config';
import { registerRouterProvider, waitForRegistry } from './provider';
import {
  done,
  events,
  failure,
  message,
  model,
  required,
  typeSafeClassifierRegistry,
} from './test/fixtures';
import type { AdvisorConfig, RouterRequestObservation } from './types';

type State = Parameters<typeof registerRouterProvider>[1];
type MutableState = { -readonly [K in keyof State]: State[K] };
const advisorOf = (decision: State['lastDecision']) => decision?.advisor;

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
    ...typeSafeClassifierRegistry(),
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    streamSimple: delegate,
  } as unknown as ExtensionContext['modelRegistry'];
  const state: MutableState = {
    lastRegisteredModels: '',
    currentModelRegistry: registry,
    lastExtensionContext: {
      sessionManager: {
        getBranch: () => [{ id: 'user-turn', type: 'message' }],
      },
      ui: { setHiddenThinkingLabel: vi.fn() },
    } as unknown as ExtensionContext,
    currentConfig: normalizeConfig({
      profiles: {
        balanced: {
          high: { model: 'test/primary' },
          medium: { model: 'test/primary', fallbacks: ['test/fallback'] },
          low: { model: 'test/small' },
        },
      },
    }).config,
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
    updateStatus: vi.fn(),
    syncPiThinkingLevel: vi.fn(),
    beginRequest: vi.fn<
      NonNullable<Parameters<typeof registerRouterProvider>[2]['beginRequest']>
    >(() => () => undefined),
  };
  const stream = (
    context: Context = {
      messages: [{ role: 'user', content: 'implement', timestamp: 1 }],
    },
    signal?: AbortSignal,
    sessionId?: string,
  ) => {
    registerRouterProvider(api, state, actions);
    const config = register.mock.calls.at(-1)?.[1];
    if (!config?.streamSimple)
      throw new Error('Router provider not registered');
    const streamOptions = {
      ...(signal ? { signal } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    return config.streamSimple(
      model('balanced', { provider: 'router', contextWindow: 8192 }),
      normalizeContext(context),
      streamOptions,
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
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'routes prototype-like profile %s using only explicit pins and overrides',
    async (name) => {
      const s = setup();
      s.state.currentConfig = normalizeConfig({
        profiles: {
          [name]: {
            medium: { model: 'test/primary' },
            low: { model: 'test/small' },
          },
        },
      }).config;
      s.state.pinnedTierByProfile = {};
      s.state.thinkingByProfile = {};
      registerRouterProvider(s.api, s.state, s.actions);
      const config = s.register.mock.calls.at(-1)?.[1];
      if (!config?.streamSimple) throw new Error('Missing router stream');
      const generate = config.streamSimple;
      const run = () =>
        consume(
          generate(
            model(name, { provider: 'router' }),
            normalizeContext(userContext()),
            {},
          ),
        );
      expect((await run()).result.stopReason).toBe('stop');
      expect(s.state.lastDecision?.reasonCode).toBe('baseline');
      s.state.pinnedTierByProfile[name] = 'low';
      s.state.thinkingByProfile[name] = { low: 'off' };
      expect((await run()).result.stopReason).toBe('stop');
      expect(s.state.lastDecision).toMatchObject({
        tier: 'low',
        thinking: 'off',
      });
      delete s.state.pinnedTierByProfile[name];
      delete s.state.thinkingByProfile[name];
      expect((await run()).result.stopReason).toBe('stop');
      expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
        'primary',
        'small',
        'primary',
      ]);
    },
  );

  it('rejects inherited profile names that are not configured', async () => {
    const s = setup();
    registerRouterProvider(s.api, s.state, s.actions);
    const config = s.register.mock.calls.at(-1)?.[1];
    if (!config?.streamSimple) throw new Error('Missing router stream');
    const { result } = await consume(
      config.streamSimple(
        model('toString', { provider: 'router' }),
        normalizeContext(userContext()),
        {},
      ),
    );
    expect(result.errorMessage).toBe('Unknown router profile: toString');
    expect(s.delegate).not.toHaveBeenCalled();
  });

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
    expect(advisorOf(s.state.lastDecision)).toBe('none');
    expect(s.actions.persistState).toHaveBeenCalledOnce();
  });

  it('accounts for charged pre-content failures before falling back', async () => {
    const s = setup();
    s.delegate.mockReturnValueOnce(failure());
    const { result } = await consume(s.stream());
    expect(result.stopReason).toBe('stop');
    expect(s.delegate).toHaveBeenCalledTimes(2);
    expect(s.state.accumulatedCost).toBe(0.02);
    expect(s.state.lastDecision?.generation).toMatchObject({
      attempts: 2,
      reportedCostUsd: 0.02,
    });
  });

  it('accounts for all failed terminal attempts even when the chain fails', async () => {
    const s = setup();
    s.delegate.mockImplementation(() => failure());
    expect((await consume(s.stream())).result.stopReason).toBe('error');
    expect(s.state.accumulatedCost).toBe(0.02);
    expect(s.actions.persistState).toHaveBeenCalledOnce();
  });

  it('records the decision, flagged as failed, when every fallback in the chain fails', async () => {
    const s = setup();
    s.delegate.mockImplementation(() => failure());
    expect((await consume(s.stream())).result.stopReason).toBe('error');
    expect(s.actions.recordDebugDecision).toHaveBeenCalledOnce();
    expect(s.actions.recordDebugDecision).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'medium', isGenerationFailed: true }),
    );
    // The thrown error's message (the delegate's remote text) must not leak
    // into the persisted decision sink.
    const recorded = JSON.stringify(
      s.actions.recordDebugDecision.mock.calls[0],
    );
    expect(recorded).not.toContain('request failed');
  });

  it('does not flag a successful generation as failed', async () => {
    const s = setup();
    expect((await consume(s.stream())).result.stopReason).toBe('stop');
    expect(s.actions.recordDebugDecision).toHaveBeenCalledOnce();
    expect(
      s.actions.recordDebugDecision.mock.calls[0]?.[0].isGenerationFailed,
    ).toBeUndefined();
  });

  it('marks aggregate cost unknown when an attempt ends without usage', async () => {
    const s = setup();
    s.delegate.mockImplementationOnce(() => {
      throw new Error('no terminal usage');
    });
    await consume(s.stream());
    expect(s.state.accumulatedCost).toBe(0.01);
    expect(s.state.lastDecision?.generation).toMatchObject({
      attempts: 2,
      reportedCostUsd: undefined,
    });
  });

  it('does not report a partial chain total as complete when the final attempt has no usage', async () => {
    const s = setup();
    s.delegate.mockReturnValueOnce(failure()).mockImplementationOnce(() => {
      throw new Error('no terminal usage');
    });
    expect((await consume(s.stream())).result.stopReason).toBe('error');
    expect(s.state.accumulatedCost).toBe(0.01);
    expect(s.state.lastDecision?.generation).toMatchObject({
      attempts: 2,
      reportedCostUsd: undefined,
    });
  });

  it('keeps shadow economics observational even when switching cold is more expensive', async () => {
    const s = setup();
    required(s.models[0]).cost = {
      input: 10,
      output: 20,
      cacheRead: 1,
      cacheWrite: 12.5,
    };
    required(s.models[2]).cost = {
      input: 2,
      output: 4,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    };
    s.state.pinnedTierByProfile.balanced = 'low';
    const response = message({
      model: 'small',
      usage: {
        input: 100000,
        output: 2000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 102000,
        cost: {
          input: 0.2,
          output: 0.008,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0.208,
        },
      },
    });
    s.delegate.mockReturnValueOnce(
      events({ type: 'done', reason: 'stop', message: response }),
    );
    await consume(
      s.stream({
        messages: [message(), { role: 'user', content: 'next', timestamp: 2 }],
      }),
    );
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls[0]?.[0].id).toBe('small');
    expect(s.state.lastDecision).toMatchObject({
      reasonCode: 'pinned',
      tier: 'low',
      generation: {
        transition: 'model-switch',
        contextTruncated: false,
        shadow: {
          previousModel: 'test/primary',
          stayAllReadUsd: expect.closeTo(0.14, 10),
          switchAllNewUsd: 0.258,
        },
      },
    });
  });

  it('suppresses shadow estimates after router-side context truncation', async () => {
    const s = setup();
    for (const target of s.models)
      target.cost = { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 };
    s.state.pinnedTierByProfile.balanced = 'low';
    await consume(
      s.stream({
        messages: [
          { role: 'user', content: 'old'.repeat(2000), timestamp: 1 },
          message(),
          { role: 'user', content: 'new', timestamp: 2 },
        ],
      }),
    );
    expect(s.delegate.mock.calls[0]?.[1].messages).toHaveLength(1);
    expect(s.state.lastDecision?.generation).toMatchObject({
      contextTruncated: true,
      shadow: undefined,
    });
  });

  it('uses only the current transcript for the previous model after a branch change', async () => {
    const s = setup();
    await consume(s.stream());
    s.state.pinnedTierByProfile.balanced = 'low';
    await consume(
      s.stream({
        messages: [{ role: 'user', content: 'new branch', timestamp: 2 }],
      }),
    );
    expect(s.state.lastDecision?.generation).toMatchObject({
      transition: 'initial',
      shadow: undefined,
    });
  });

  it('persists usage even when the final UI update fails', async () => {
    const s = setup();
    s.actions.updateStatus.mockImplementation(() => {
      throw new Error('stale UI');
    });
    await consume(s.stream());
    expect(s.actions.persistState).toHaveBeenCalledOnce();
    expect(s.state.accumulatedCost).toBe(0.01);
  });

  it('does not pass or report thinking for a non-reasoning target', async () => {
    const s = setup();
    required(s.models[0]).reasoning = false;
    const { result } = await consume(s.stream());
    expect(result.stopReason).toBe('stop');
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
    expect(s.state.lastDecision?.thinking).toBe('off');
  });

  it('canonicalizes padded fallbacks and defaults their omitted effort to off', async () => {
    const s = setup();
    s.state.currentConfig = normalizeConfig({
      profiles: {
        balanced: {
          medium: { model: 'test / primary', fallbacks: ['test / fallback'] },
        },
      },
    }).config;
    required(s.models[1]).reasoning = false;
    s.delegate.mockReturnValueOnce(failure());
    const { result } = await consume(s.stream());
    expect(result.stopReason).toBe('stop');
    expect(s.delegate).toHaveBeenCalledTimes(2);
    expect(s.delegate.mock.calls[1]?.[2]?.reasoning).toBeUndefined();
    expect(s.state.lastDecision).toMatchObject({
      targetLabel: 'test/fallback',
      thinking: 'off',
    });
  });

  it('delegates normalized canonical models without resolving alias collisions again', async () => {
    const s = setup();
    required(s.models[0]).provider = 'openai';
    required(s.models[0]).id = 'model-a';
    s.state.currentConfig = normalizeConfig({
      models: {
        primary: { model: 'openai/model-a' },
        'openai/model-a': { model: 'anthropic/model-b' },
      },
      profiles: { balanced: { medium: { model: 'primary' } } },
    }).config;

    const { result } = await consume(s.stream(userContext('any text')));
    expect(result.stopReason).toBe('stop');
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls[0]?.[0]).toMatchObject({
      provider: 'openai',
      id: 'model-a',
    });
    expect(s.state.lastDecision).toMatchObject({
      targetProvider: 'openai',
      targetModelId: 'model-a',
    });
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
    required(s.models[0]).thinkingLevelMap = { xhigh: 'xhigh' };
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
    const observe = vi.fn<(event: RouterRequestObservation) => void>();
    s.actions.beginRequest.mockReturnValue(observe);
    expect((await consume(s.stream())).result.stopReason).toBe('aborted');
    expect(observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: 'cancelled' }),
    );
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

  it('does not trust an orphan Google tool result or call a classifier for it', async () => {
    const s = setup();
    enableAdvisors(s);
    delete s.state.pinnedTierByProfile.balanced;
    await consume(
      s.stream({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'orphan',
            toolName: 'read',
            content: [],
            isError: false,
            timestamp: 2,
          },
        ],
      }),
    );
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.state.lastDecision?.reasonCode).not.toBe('continuation');
  });

  it('routes images to a capable model and errors when none exists', async () => {
    const s = setup();
    s.state.pinnedTierByProfile.balanced = 'low';
    required(s.models[2]).input = ['text'];
    const context: Context = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
          timestamp: 1,
        },
      ],
    };
    expect((await consume(s.stream(context))).result.stopReason).toBe('error');
    expect(s.delegate).not.toHaveBeenCalled();
    for (const m of s.models) m.input = ['text'];
    s.delegate.mockClear();
    expect((await consume(s.stream(context))).result.stopReason).toBe('error');
    expect(s.delegate).not.toHaveBeenCalled();
  });

  it('truncates whole old turns for the actual fallback without orphaning tool results', async () => {
    const s = setup();
    s.delegate.mockReturnValueOnce(failure());
    const context: Context = {
      systemPrompt: 's'.repeat(8000),
      messages: [
        { role: 'user', content: 'x'.repeat(300), timestamp: 1 },
        message({
          content: [
            { type: 'toolCall', id: 'call', name: 'read', arguments: {} },
          ],
        }),
        {
          role: 'toolResult',
          toolCallId: 'call',
          toolName: 'read',
          content: [{ type: 'text', text: 'x'.repeat(300) }],
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
    expect(delegated?.messages[0]?.role).toBe('system');
    expect(context.messages).toHaveLength(4);
  });

  describe('context-window fit', () => {
    // 'small' has a 1024-token window: 921 tokens at the 0.9 fill.
    const fitSetup = () => {
      const s = setup();
      s.state.currentConfig = normalizeConfig({
        profiles: {
          balanced: {
            baselineTier: 'low',
            high: { model: 'test/primary' },
            low: { model: 'test/small' },
          },
        },
      }).config;
      delete s.state.pinnedTierByProfile.balanced;
      return s;
    };
    const large = () => userContext('x'.repeat(4000));
    const grownByUsage = (): Context => ({
      messages: [
        { role: 'user', content: 'first', timestamp: 1 },
        message({
          usage: { ...message().usage, input: 3000, totalTokens: 3001 },
        }),
        { role: 'user', content: 'next', timestamp: 2 },
      ],
    });

    it.each([
      ['keeps the baseline when the request fits', userContext(), 'small'],
      ['skips a baseline window too small for the text', large(), 'primary'],
      [
        'skips a baseline window too small for the last usage',
        grownByUsage(),
        'primary',
      ],
    ])('%s', async (_name, context, target) => {
      const s = fitSetup();
      await consume(s.stream(context));
      expect(s.delegate.mock.calls.at(-1)?.[0].id).toBe(target);
      expect(s.delegate.mock.calls.at(-1)?.[1].messages).toHaveLength(
        context.messages.length,
      );
    });

    it('honors a pin to a small window and truncates instead', async () => {
      const s = fitSetup();
      s.state.pinnedTierByProfile.balanced = 'low';
      const context: Context = {
        messages: [
          { role: 'user', content: 'x'.repeat(4000), timestamp: 1 },
          message(),
          { role: 'user', content: 'implement', timestamp: 2 },
        ],
      };
      await consume(s.stream(context));
      expect(s.delegate.mock.calls.at(-1)?.[0].id).toBe('small');
      expect(s.delegate.mock.calls.at(-1)?.[1].messages).toHaveLength(1);
    });

    it('offers the advisor only routes that fit', async () => {
      const s = fitSetup();
      enableAdvisors(s);
      await consume(s.stream(large()));
      expect(vi.mocked(s.registry.classify)).not.toHaveBeenCalled();
      expect(s.state.lastDecision).toMatchObject({
        tier: 'high',
        bypassReason: 'single-candidate',
      });
    });
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

describe('four-level provider routing', () => {
  const mechanicalContext: Context = {
    messages: [{ role: 'user', content: 'git status --short', timestamp: 1 }],
  };

  it('delegates a single configured route without an advisor call', async () => {
    const s = setup();
    s.state.currentConfig.profiles.balanced = {
      micro: { model: 'test/small' },
    };
    delete s.state.pinnedTierByProfile.balanced;
    enableAdvisors(s);
    await consume(s.stream(mechanicalContext));
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls[0]?.[0].id).toBe('small');
    expect(s.delegate.mock.calls[0]?.[2]?.reasoning).toBeUndefined();
    expect(s.state.lastDecision).toMatchObject({
      tier: 'micro',
      thinking: 'off',
    });
    expect(advisorOf(s.state.lastDecision)).toBe('bypassed');
  });

  it.each(['micro', 'low', 'medium', 'high'] as const)(
    'validates the pinned image route without lifting it: %s',
    async (tier) => {
      const s = setup();
      const profile = required(s.state.currentConfig.profiles.balanced);
      profile.micro = { model: 'test/small' };
      profile.low = { model: 'test/small' };
      profile.medium = { model: 'test/small' };
      s.state.pinnedTierByProfile.balanced = tier;
      required(s.models[2]).input = ['text'];
      required(s.models[0]).input = ['text', 'image'];
      const result = await consume(
        s.stream({
          messages: [
            {
              role: 'user',
              timestamp: 1,
              content: [
                { type: 'text', text: 'pwd' },
                { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
              ],
            },
          ],
        }),
      );
      if (tier === 'high') {
        expect(result.result.stopReason).toBe('stop');
        expect(s.delegate).toHaveBeenCalledOnce();
        expect(s.delegate.mock.calls[0]?.[0].id).toBe('primary');
        expect(s.state.lastDecision?.tier).toBe('high');
      } else {
        expect(result.result.stopReason).toBe('error');
        expect(s.delegate).not.toHaveBeenCalled();
      }
    },
  );

  it('uses a micro image-capable fallback without raising the tier', async () => {
    const s = setup();
    required(s.state.currentConfig.profiles.balanced).micro = {
      model: 'test/small',
      fallbacks: ['test/fallback'],
    };
    s.state.pinnedTierByProfile.balanced = 'micro';
    required(s.models[2]).input = ['text'];
    required(s.models[1]).input = ['text', 'image'];
    await consume(
      s.stream({
        messages: [
          {
            role: 'user',
            timestamp: 1,
            content: [
              { type: 'text', text: 'pwd' },
              { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            ],
          },
        ],
      }),
    );
    expect(s.delegate.mock.calls[0]?.[0].id).toBe('fallback');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'micro',
      thinking: 'off',
    });
  });

  it('supports partial profiles and reports only unavailable pinned routes', async () => {
    const s = setup();
    s.state.currentConfig.profiles.balanced = {
      low: { model: 'test/small' },
    };
    s.state.pinnedTierByProfile.balanced = 'low';
    await consume(s.stream());
    expect(s.state.lastDecision).toMatchObject({
      tier: 'low',
      reasonCode: 'pinned',
    });
    s.state.pinnedTierByProfile.balanced = 'high';
    s.delegate.mockClear();
    const { result } = await consume(s.stream());
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('Pinned tier "high"');
    expect(s.delegate).not.toHaveBeenCalled();
  });
});

const userContext = (text = 'implement a parser', timestamp = 1): Context => ({
  messages: [{ role: 'user', content: text, timestamp }],
});

const classifierModel = {
  type: 'classifier' as const,
  provider: 'typesafe',
  id: 'jev-latest',
  name: 'Jev',
  api: 'typesafe-system-one' as const,
  baseUrl: 'https://api.typesafe.ai/v1/',
  input: ['text'] as 'text'[],
  contextWindow: 64000,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const classifierConfig: AdvisorConfig = {
  enabled: true,
  model: 'typesafe/jev-latest',
  timeoutMs: 1500,
  confidenceThreshold: 0.65,
  probabilityThreshold: 0.8,
  maxStateTokens: 3000,
  maxRetries: 1,
};
const enableAdvisors = (s: ReturnType<typeof setup>) => {
  s.state.currentConfig.advisor = { ...classifierConfig };
  required(s.state.currentConfig.profiles.balanced).advisor = {
    models: ['typesafe/jev-latest'],
  };
  s.registry.findOfType = (() =>
    classifierModel) as unknown as ExtensionContext['modelRegistry']['findOfType'];
  s.registry.classify = vi.fn<ExtensionContext['modelRegistry']['classify']>(
    async (target, context) => {
      const criteria = required(context.questions.route);
      const choice =
        Object.keys(criteria.criteria).find((id) => id.startsWith('medium|')) ??
        '';
      return {
        api: target.api,
        provider: target.provider,
        model: target.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        answers: {
          route: {
            type: 'choice',
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(
              Object.keys(criteria.criteria).map((id) => [
                id,
                id === choice ? 1 : 0,
              ]),
            ),
          },
        },
      };
    },
  );
  delete s.state.pinnedTierByProfile.balanced;
};
const configureChoice = (s: ReturnType<typeof setup>, tier: string) => {
  enableAdvisors(s);
  s.registry.classify = vi.fn<ExtensionContext['modelRegistry']['classify']>(
    async (target, context) => {
      const q = required(context.questions.route);
      const ids = Object.keys(q.criteria);
      const choice =
        ids.find((id) => id.startsWith(tier + '|')) ?? ids[0] ?? '';
      return {
        api: target.api,
        provider: target.provider,
        model: target.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        answers: {
          route: {
            type: 'choice',
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(
              ids.map((id) => [id, id === choice ? 1 : 0]),
            ),
          },
        },
      };
    },
  );
};

describe('Pi classifier provider integration', () => {
  it('routes with an explicitly approved Pi classifier and reuses advice on the turn', async () => {
    const s = setup();
    configureChoice(s, 'high');
    await consume(s.stream(userContext()));
    expect(vi.mocked(s.registry.classify)).toHaveBeenCalledOnce();
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      reasonCode: 'classifier',
      advisor: 'classifier',
      isClassifier: true,
    });
    await consume(s.stream(userContext()));
    expect(s.registry.classify).toHaveBeenCalledOnce();
  });
  it('does not classify when profile consent omits the selected configured classifier', async () => {
    const s = setup();
    enableAdvisors(s);
    required(s.state.currentConfig.profiles.balanced).advisor = { models: [] };
    await consume(s.stream(userContext()));
    expect(vi.mocked(s.registry.classify)).not.toHaveBeenCalled();
    expect(s.state.lastDecision?.reasonCode).toBe('baseline');
  });
  it('invalidates same-turn advice when exact profile consent is revoked', async () => {
    const s = setup();
    configureChoice(s, 'high');
    const context = userContext();
    await consume(s.stream(context));
    expect(vi.mocked(s.registry.classify)).toHaveBeenCalledOnce();
    required(s.state.currentConfig.profiles.balanced).advisor = { models: [] };
    await consume(s.stream(context));
    expect(vi.mocked(s.registry.classify)).toHaveBeenCalledOnce();
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      reasonCode: 'baseline',
      advisor: 'classifier-fallback',
    });
  });
  it('reuses the classified route through a valid tool continuation', async () => {
    const s = setup();
    configureChoice(s, 'high');
    const user = userContext();
    const toolCall = message({
      content: [
        { type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} },
      ],
      stopReason: 'toolUse',
    });
    s.delegate.mockReturnValueOnce(
      events({
        type: 'done',
        reason: 'toolUse',
        message: toolCall,
      }),
    );
    await consume(s.stream(user));
    await consume(
      s.stream({
        messages: [
          ...user.messages,
          toolCall,
          {
            role: 'toolResult',
            toolCallId: 'tool-1',
            toolName: 'read',
            content: [{ type: 'text', text: 'fixture' }],
            isError: false,
            timestamp: 2,
          },
        ],
      }),
    );
    expect(vi.mocked(s.registry.classify)).toHaveBeenCalledOnce();
    expect(s.delegate).toHaveBeenCalledTimes(2);
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      reasonCode: 'continuation',
      reuse: 'continuation',
    });
  });
  it('falls back directly to a local baseline on invalid advice', async () => {
    const s = setup();
    enableAdvisors(s);
    s.registry.classify = async (target) => ({
      api: target.api,
      provider: target.provider,
      model: target.id,
      timestamp: 1,
      stopReason: 'error',
      errorMessage: 'private provider detail',
      answers: {},
    });
    await consume(s.stream(userContext()));
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      reasonCode: 'baseline',
      advisor: 'classifier-fallback',
      errorClass: 'advisor-unavailable',
    });
    expect(
      JSON.stringify(s.actions.recordDebugDecision.mock.calls),
    ).not.toContain('private provider detail');
  });
  it('aborts advice without starting baseline generation', async () => {
    const s = setup();
    enableAdvisors(s);
    s.registry.classify = vi.fn<ExtensionContext['modelRegistry']['classify']>(
      (_model, _context, options) =>
        new Promise((resolve) =>
          options?.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                api: 'typesafe-system-one',
                provider: 'typesafe',
                model: 'jev-latest',
                timestamp: 1,
                stopReason: 'aborted',
                answers: {},
              }),
            { once: true },
          ),
        ),
    );
    const controller = new AbortController();
    const pending = consume(s.stream(userContext(), controller.signal));
    await vi.waitFor(() =>
      expect(vi.mocked(s.registry.classify)).toHaveBeenCalledOnce(),
    );
    controller.abort();
    expect((await pending).result.stopReason).toBe('aborted');
    expect(s.delegate).not.toHaveBeenCalled();
  });
  it('bypasses advice for a pin and a single available tier', async () => {
    const s = setup();
    enableAdvisors(s);
    s.state.pinnedTierByProfile.balanced = 'low';
    await consume(s.stream());
    expect(s.registry.classify).not.toHaveBeenCalled();
    s.state.pinnedTierByProfile.balanced = undefined;
    s.state.currentConfig.profiles.balanced = { low: { model: 'test/small' } };
    await consume(s.stream());
    expect(s.registry.classify).not.toHaveBeenCalled();
  });
});
