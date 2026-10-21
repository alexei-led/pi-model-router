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
import { registerRouterProvider } from './provider';
import { waitForRegistry } from './provider-runtime';
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

  it('records failed fallback decisions without persisting remote error text', async () => {
    const s = setup();
    s.delegate.mockImplementation(() => failure());
    expect((await consume(s.stream())).result.stopReason).toBe('error');
    expect(s.actions.recordDebugDecision).toHaveBeenCalledOnce();
    expect(s.actions.recordDebugDecision).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'medium', isGenerationFailed: true }),
    );
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

  it('buffers a physical start event until content while preserving event order', async () => {
    const s = setup();
    const partial = message({
      content: [],
      model: 'primary',
      stopReason: 'pending',
    });
    const response = message({ content: [{ type: 'text', text: 'answer' }] });
    s.delegate.mockReturnValueOnce(
      events(
        { type: 'start', partial },
        {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'answer',
          partial: response,
        },
        { type: 'done', reason: 'stop', message: response },
      ),
    );
    const { received, result } = await consume(s.stream());
    expect(received.map((event) => event.type)).toEqual([
      'start',
      'text_delta',
      'done',
    ]);
    expect(received[0]).toMatchObject({
      type: 'start',
      partial: { provider: 'test', model: 'primary' },
    });
    expect(result).toMatchObject({ provider: 'test', model: 'primary' });
  });

  it('keeps explicit fallback order and records the final physical model', async () => {
    const s = setup();
    s.state.currentConfig = normalizeConfig({
      profiles: {
        balanced: {
          medium: {
            model: 'test/primary',
            fallbacks: ['test/small', 'test/fallback'],
          },
        },
      },
    }).config;
    s.delegate
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(
        events({
          type: 'done',
          reason: 'stop',
          message: message({ model: 'fallback' }),
        }),
      );
    const { result } = await consume(s.stream());
    expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
      'primary',
      'small',
      'fallback',
    ]);
    expect(result).toMatchObject({ provider: 'test', model: 'fallback' });
    expect(s.state.lastDecision).toMatchObject({
      targetProvider: 'test',
      targetModelId: 'fallback',
      targetLabel: 'test/fallback',
      isFallback: true,
      reasonCode: 'fallback',
    });
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

  it('reports a terminal error after visible content as failed without retrying or persisting it', async () => {
    const s = setup();
    const remoteError = 'synthetic provider error details';
    const partial = message({
      content: [{ type: 'text', text: 'partial' }],
      stopReason: 'pending',
    });
    s.delegate.mockReturnValueOnce(
      events(
        {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'partial',
          partial,
        },
        {
          type: 'error',
          reason: 'error',
          error: message({
            content: [{ type: 'text', text: 'partial' }],
            stopReason: 'error',
            errorMessage: remoteError,
          }),
        },
      ),
    );
    const observe = vi.fn<(event: RouterRequestObservation) => void>();
    s.actions.beginRequest.mockReturnValue(observe);

    const { received, result } = await consume(s.stream());

    expect(s.delegate).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe('error');
    expect(received.at(-1)).toMatchObject({
      type: 'error',
      reason: 'error',
      error: { errorMessage: remoteError },
    });
    expect(observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ stage: 'failed' }),
    );
    expect(s.actions.recordDebugDecision).toHaveBeenCalledOnce();
    expect(s.actions.persistState).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(s.actions.recordDebugDecision.mock.calls),
    ).not.toContain(remoteError);
    expect(JSON.stringify(s.state.lastDecision)).not.toContain(remoteError);
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
    const smallWindowSetup = () => {
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
      const s = smallWindowSetup();
      await consume(s.stream(context));
      expect(s.delegate.mock.calls.at(-1)?.[0].id).toBe(target);
      expect(s.delegate.mock.calls.at(-1)?.[1].messages).toHaveLength(
        context.messages.length,
      );
    });

    it('honors a pin to a small window and truncates instead', async () => {
      const s = smallWindowSetup();
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
      const s = smallWindowSetup();
      enableAdvisors(s);
      await consume(s.stream(large()));
      expect(vi.mocked(s.registry.classify)).not.toHaveBeenCalled();
      expect(s.state.lastDecision).toMatchObject({
        tier: 'high',
        bypassReason: 'single-candidate',
      });
    });

    it('revalidates classifier advice against the current context-window fit', async () => {
      const s = smallWindowSetup();
      enableAdvisors(s);
      const context: Context = {
        messages: [
          { role: 'user', content: 'review earlier work', timestamp: 1 },
          message(),
          {
            role: 'user',
            content: 'continue with the current change',
            timestamp: 2,
          },
        ],
      };
      let resolveClassification:
        | ((response: ClassifierResponse) => void)
        | undefined;
      const classify = vi.fn<Classify>(
        () =>
          new Promise((resolve) => {
            resolveClassification = resolve;
          }),
      );
      s.registry.classify = classify;
      const pending = consume(s.stream(context));
      await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
      const call = classify.mock.calls[0];
      if (!call) throw new Error('Classifier request did not start');
      const candidateIds = Object.keys(
        required(call[1].questions.route).criteria,
      );
      expect(candidateIds.some((id) => id.startsWith('high|'))).toBe(true);
      expect(candidateIds.some((id) => id.startsWith('low|'))).toBe(true);
      const primary = required(
        s.models.find((target) => target.id === 'primary'),
      );
      primary.contextWindow = 1;
      const resolve = resolveClassification;
      if (!resolve) throw new Error('Classifier response resolver was not set');
      resolve(classifierResponse(call[0], call[1], 'high'));

      const { result } = await pending;
      expect(result.stopReason).toBe('stop');
      expect(s.state.lastDecision).toMatchObject({
        tier: 'low',
        targetLabel: 'test/small',
        reasonCode: 'baseline',
        advisor: 'classifier-fallback',
      });
      expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
        'small',
      ]);
      expect(s.delegate.mock.calls[0]?.[1].messages).toEqual(context.messages);
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
  reviewEveryRequests: 4,
  confidenceThreshold: 0.65,
  probabilityThreshold: 0.8,
  maxStateTokens: 3000,
  maxRetries: 1,
};
type Classify = ExtensionContext['modelRegistry']['classify'];
type ClassifierResponse = Awaited<ReturnType<Classify>>;
const classifierResponse = (
  target: Parameters<Classify>[0],
  context: Parameters<Classify>[1],
  tier: string,
): ClassifierResponse => {
  const criteria = required(context.questions.route).criteria;
  const ids = Object.keys(criteria);
  const choice = ids.find((id) => id.startsWith(`${tier}|`)) ?? '';
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
        ids.find((id) => id.startsWith(`${tier}|`)) ?? ids[0] ?? '';
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
  it('routes varied prompt texts through the same local baseline without advice', async () => {
    const s = setup();
    s.models.push(model('tiny'));
    s.state.currentConfig = normalizeConfig({
      profiles: {
        balanced: {
          high: { model: 'test/primary' },
          medium: { model: 'test/fallback' },
          low: { model: 'test/small' },
          micro: { model: 'test/tiny' },
        },
      },
    }).config;
    delete s.state.pinnedTierByProfile.balanced;
    const classify = vi.fn<ExtensionContext['modelRegistry']['classify']>();
    s.registry.classify = classify;
    const prompts = [
      'pwd',
      'Design a migration plan.',
      'да, сделай',
      '¿Puedes ayudar?',
      '!!!',
      'Refactor the parser and add boundary tests.',
    ];
    for (const [index, prompt] of prompts.entries()) {
      const { result } = await consume(
        s.stream(userContext(prompt, index + 1)),
      );
      expect(result.stopReason).toBe('stop');
      expect(s.state.lastDecision).toMatchObject({
        tier: 'medium',
        reasonCode: 'baseline',
        advisor: 'none',
      });
    }
    expect(s.state.pinnedTierByProfile.balanced).toBeUndefined();
    expect(s.state.currentConfig.maxSessionBudget).toBeUndefined();
    expect(s.state.currentConfig.advisor).toBeUndefined();
    expect(classify).not.toHaveBeenCalled();
    expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual(
      prompts.map(() => 'fallback'),
    );
  });

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
  it('shares same-turn classification while one cancelled waiter leaves the other active', async () => {
    const s = setup();
    enableAdvisors(s);
    let resolveClassification:
      | ((result: ClassifierResponse) => void)
      | undefined;
    let classifierSignal: AbortSignal | undefined;
    const classify = vi.fn<Classify>(
      (_target, _context, options) =>
        new Promise((resolve) => {
          resolveClassification = resolve;
          classifierSignal = options?.signal;
        }),
    );
    s.registry.classify = classify;
    const context = userContext('same turn', 10);
    const cancelled = new AbortController();
    const active = new AbortController();
    const first = consume(s.stream(context, cancelled.signal));
    const second = consume(s.stream(context, active.signal));
    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
    cancelled.abort();
    expect((await first).result.stopReason).toBe('aborted');
    expect(classifierSignal?.aborted).toBe(false);
    expect(s.delegate).not.toHaveBeenCalled();
    const call = classify.mock.calls[0];
    const resolve = resolveClassification;
    if (!call || !resolve) throw new Error('Classifier request did not start');
    resolve(classifierResponse(call[0], call[1], 'high'));
    expect((await second).result.stopReason).toBe('stop');
    expect(classify).toHaveBeenCalledOnce();
    expect(s.delegate).toHaveBeenCalledOnce();
  });

  it('aborts the shared classifier transport when the final same-turn waiter leaves', async () => {
    const s = setup();
    enableAdvisors(s);
    let classifierSignal: AbortSignal | undefined;
    const classify = vi.fn<Classify>(
      (_target, _context, options) =>
        new Promise(() => {
          classifierSignal = options?.signal;
        }),
    );
    s.registry.classify = classify;
    const context = userContext('same turn', 10);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const first = consume(s.stream(context, firstAbort.signal));
    const second = consume(s.stream(context, secondAbort.signal));
    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
    firstAbort.abort();
    expect((await first).result.stopReason).toBe('aborted');
    expect(classifierSignal?.aborted).toBe(false);
    secondAbort.abort();
    expect((await second).result.stopReason).toBe('aborted');
    expect(classifierSignal?.aborted).toBe(true);
    expect(classify).toHaveBeenCalledOnce();
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

describe('activity matrix provider routing', () => {
  const activitySetup = () => {
    const s = setup();
    s.models.push(model('code'), model('code-backup'), model('docs'));
    s.state.pinnedTierByProfile = {};
    s.state.currentConfig = normalizeConfig({
      advisor: { enabled: true, model: 'typesafe/jev-latest' },
      profiles: {
        balanced: {
          advisor: { models: ['typesafe/jev-latest'] },
          high: { model: 'test/primary', thinking: 'high' },
          medium: {
            model: 'test/primary',
            thinking: 'medium',
            fallbacks: ['test/fallback'],
          },
          low: { model: 'test/small', thinking: 'low' },
          activities: {
            code: {
              medium: { model: 'test/code', fallbacks: ['test/code-backup'] },
            },
            docs: {
              medium: { model: 'test/docs', thinking: 'low', fallbacks: [] },
            },
          },
        },
      },
    }).config;
    const answer = {
      tier: 'medium',
      activity: 'code',
      confidence: 0.95,
      invalidActivity: false,
      fail: false,
    };
    const classify = vi.fn<ExtensionContext['modelRegistry']['classify']>(
      async (classifier, context) => {
        if (answer.fail) throw new Error('private-response');
        const routeQuestion = context.questions.route;
        const routeId =
          routeQuestion?.type === 'choice'
            ? (Object.keys(routeQuestion.criteria).find((id) =>
                id.startsWith(`${answer.tier}|`),
              ) ?? 'uncertain')
            : undefined;
        const answers = {
          ...(routeId
            ? {
                route: {
                  type: 'choice' as const,
                  choice: routeId,
                  confidence: 0.95,
                  probabilities: { [routeId]: 1 },
                },
              }
            : {}),
          ...(context.questions.activity && !answer.invalidActivity
            ? {
                activity: {
                  type: 'choice' as const,
                  choice: answer.activity,
                  confidence: answer.confidence,
                  probabilities: { [answer.activity]: 1 },
                },
              }
            : {}),
        };
        return {
          api: classifier.api,
          provider: classifier.provider,
          model: classifier.id,
          timestamp: 1,
          stopReason: 'stop',
          answers,
        };
      },
    );
    s.registry.classify = classify;
    return {
      ...s,
      answer,
      classify,
      profile: required(s.state.currentConfig.profiles.balanced),
    };
  };

  it('asks separate route/activity questions in one classify operation and uses only the selected cell fallbacks', async () => {
    const s = activitySetup();
    s.delegate.mockImplementation((target) =>
      target.id === 'code' ? failure() : done(),
    );
    await consume(s.stream());
    expect(s.classify).toHaveBeenCalledOnce();
    expect(
      Object.keys(required(s.classify.mock.calls[0]?.[1]).questions),
    ).toEqual(['route', 'activity']);
    expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
      'code',
      'code-backup',
    ]);
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      activity: 'code',
      routeCell: 'code',
      targetModelId: 'code-backup',
      isFallback: true,
    });
    await consume(s.stream());
    expect(s.classify).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls.at(-1)?.[0].id).toBe('code-backup');
    expect(s.state.lastDecision?.reuse).toBe('same-turn');
  });

  it('reuses the actual cell on tool continuations and reconsiders each user-role steering message', async () => {
    const s = activitySetup();
    s.delegate.mockImplementation((target) =>
      target.id === 'code'
        ? failure()
        : events({
            type: 'done',
            reason: 'toolUse',
            message: message({
              model: target.id,
              stopReason: 'toolUse',
              content: [
                {
                  type: 'toolCall',
                  name: 'read',
                  id: 'cell-tool',
                  arguments: {},
                },
              ],
            }),
          }),
    );
    const user = { role: 'user' as const, content: 'implement', timestamp: 1 };
    await consume(s.stream({ messages: [user] }));
    const assistant = message({
      model: 'code-backup',
      stopReason: 'toolUse',
      content: [
        { type: 'toolCall', name: 'read', id: 'cell-tool', arguments: {} },
      ],
    });
    const continued: Context = {
      messages: [
        user,
        assistant,
        {
          role: 'toolResult',
          toolCallId: 'cell-tool',
          toolName: 'read',
          content: [{ type: 'text', text: 'evidence' }],
          isError: false,
          timestamp: 2,
        },
      ],
    };
    s.answer.activity = 'docs';
    await consume(s.stream(continued));
    expect(s.classify).toHaveBeenCalledOnce();
    expect(s.state.lastDecision).toMatchObject({
      reuse: 'continuation',
      routeCell: 'code',
      targetModelId: 'code-backup',
    });
    await consume(
      s.stream({
        messages: [
          ...continued.messages,
          { role: 'user', content: 'write the guide instead', timestamp: 3 },
        ],
      }),
    );
    expect(s.classify).toHaveBeenCalledTimes(2);
    expect(s.state.lastDecision).toMatchObject({
      activity: 'docs',
      routeCell: 'docs',
      targetModelId: 'docs',
    });
  });

  it('reviews current-loop context in the background and applies fresh activity advice on the next request', async () => {
    const s = activitySetup();
    s.state.currentConfig.advisor = {
      ...required(s.state.currentConfig.advisor),
      context: {
        previousTurns: 2,
        maxHistoryTokens: 500,
        maxToolTokens: 250,
        currentLoopMessages: 8,
        toolResults: 'last',
      },
    };
    s.delegate.mockImplementation((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            {
              type: 'text',
              text: 'The retry implementation is complete; checking results.',
            },
            {
              type: 'toolCall',
              name: 'read',
              id: `adaptive-${target.id}`,
              arguments: {},
            },
          ],
        }),
      }),
    );
    const firstUser = {
      role: 'user' as const,
      content: 'Implement retry handling and document it.',
      timestamp: 10,
    };
    const messages: Context['messages'] = [firstUser];
    const first = await consume(s.stream({ messages }));
    messages.push(first.result);
    const firstCall = first.result.content.find(
      (part) => part.type === 'toolCall',
    );
    if (firstCall?.type !== 'toolCall')
      throw new Error('Expected fixture tool call');
    messages.push({
      role: 'toolResult',
      toolCallId: firstCall.id,
      toolName: firstCall.name,
      content: [{ type: 'text', text: 'Retry regression passes.' }],
      isError: false,
      timestamp: 11,
    });
    s.answer.activity = 'docs';
    const immediate = s.classify.getMockImplementation();
    if (!immediate) throw new Error('Missing fixture classifier');
    let releaseReview: (() => void) | undefined;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    s.classify.mockImplementationOnce(async (...args) => {
      const result = immediate(...args);
      await reviewGate;
      return result;
    });
    let last: Awaited<ReturnType<typeof consume>> | undefined;
    for (let continuation = 0; continuation < 3; continuation += 1) {
      last = await consume(s.stream({ messages }));
      messages.push(last.result);
      const call = last.result.content.find((part) => part.type === 'toolCall');
      if (call?.type !== 'toolCall')
        throw new Error('Expected fixture tool call');
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [
          { type: 'text', text: `Recent tool evidence ${continuation}` },
        ],
        isError: false,
        timestamp: 12 + continuation,
      });
    }
    expect(s.classify).toHaveBeenCalledTimes(2);
    expect(last?.result.stopReason).toBe('toolUse');
    const reviewPayload = required(s.classify.mock.calls[1]?.[1]);
    expect(JSON.stringify(reviewPayload.state)).not.toContain(
      'Retry regression passes.',
    );
    expect(JSON.stringify(reviewPayload.state)).toContain(
      'Recent tool evidence 1',
    );
    releaseReview?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const applied = await consume(s.stream({ messages }));
    expect(applied.result.model).toBe('docs');
    expect(s.state.lastDecision).toMatchObject({
      activity: 'docs',
      routeCell: 'docs',
      targetModelId: 'docs',
    });
    expect(s.classify).toHaveBeenCalledTimes(2);
  });

  it('holds a pricey activity switch but keeps the actual route and visible proposal distinct', async () => {
    const s = activitySetup();
    s.state.currentConfig.switchPolicy = {
      horizonRequests: 1,
      costSensitivity: 1,
      strongAdviceConfidence: 0.9,
      escalationHoldTurns: 2,
    };
    s.state.currentConfig.advisor = {
      ...required(s.state.currentConfig.advisor),
      context: {
        previousTurns: 2,
        maxHistoryTokens: 500,
        maxToolTokens: 250,
        currentLoopMessages: 8,
        toolResults: 'last',
      },
    };
    s.models[s.models.findIndex((entry) => entry.id === 'code')] = model(
      'code',
      {
        cost: { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0.1 },
      },
    );
    s.models[s.models.findIndex((entry) => entry.id === 'docs')] = model(
      'docs',
      {
        cost: { input: 100, output: 100, cacheRead: 10, cacheWrite: 125 },
      },
    );
    s.delegate.mockImplementation((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            {
              type: 'text',
              text: 'Implementation is passing; documentation remains.',
            },
            {
              type: 'toolCall',
              name: 'read',
              id: `cost-${target.id}`,
              arguments: {},
            },
          ],
        }),
      }),
    );
    const messages: Context['messages'] = [
      {
        role: 'user',
        content: 'Implement retry handling and update the guide.',
        timestamp: 30,
      },
    ];
    const advance = async () => {
      const response = await consume(s.stream({ messages }));
      messages.push(response.result);
      const call = response.result.content.find(
        (part) => part.type === 'toolCall',
      );
      if (call?.type !== 'toolCall')
        throw new Error('Expected fixture tool call');
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'Current implementation evidence.' }],
        isError: false,
        timestamp: 31 + messages.length,
      });
      return response.result;
    };
    await advance();
    s.answer.activity = 'docs';
    s.answer.confidence = 0.8;
    await advance();
    await advance();
    const reviewRequest = await advance();
    expect(reviewRequest.stopReason).toBe('toolUse');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const applied = await advance();
    expect(applied.model).toBe('code');
    expect(s.state.lastDecision).toMatchObject({
      activity: 'code',
      targetModelId: 'code',
      proposedRoute: { activity: 'docs', model: 'test/docs' },
      switchCost: { reason: 'cost-held', confidenceOverride: false },
    });
    expect((await advance()).model).toBe('code');
    expect(s.state.lastDecision?.proposedRoute).toBeUndefined();
    expect(s.state.lastDecision?.switchCost).toBeUndefined();
  });

  it('does not let activity abstention override a cost-sensitive hold in an activity-only review', async () => {
    const s = activitySetup();
    delete s.profile.high;
    delete s.profile.low;
    s.profile.activities = {
      docs: { medium: { model: 'test/docs', thinking: 'off', fallbacks: [] } },
    };
    s.state.currentConfig.advisor = {
      ...required(s.state.currentConfig.advisor),
      reviewEveryRequests: 2,
    };
    s.state.currentConfig.switchPolicy = {
      horizonRequests: 1,
      costSensitivity: 1,
      strongAdviceConfidence: 0.9,
      escalationHoldTurns: 2,
    };
    s.models[s.models.findIndex((m) => m.id === 'docs')] = model('docs', {
      cost: { input: 0.1, output: 0.1, cacheRead: 0.01, cacheWrite: 0.1 },
    });
    s.models[s.models.findIndex((m) => m.id === 'primary')] = model('primary', {
      cost: { input: 100, output: 100, cacheRead: 10, cacheWrite: 125 },
    });
    const messages: Context['messages'] = [
      {
        role: 'user',
        content: 'Complete the current task.',
        timestamp: 60,
      },
    ];
    s.delegate.mockImplementation((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            {
              type: 'toolCall',
              name: 'read',
              id: `abstention-${messages.length}`,
              arguments: {},
            },
          ],
        }),
      }),
    );
    const advance = async () => {
      const response = await consume(s.stream({ messages }));
      messages.push(response.result);
      const call = response.result.content.find((p) => p.type === 'toolCall');
      if (call?.type !== 'toolCall')
        throw new Error('Expected fixture tool call');
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'Current evidence' }],
        isError: false,
        timestamp: messages.length + 60,
      });
      return response.result;
    };
    s.answer.activity = 'docs';
    await advance();
    s.answer.activity = 'uncertain';
    s.answer.confidence = 0.99;
    await advance();
    await vi.waitFor(() =>
      expect(
        s.actions.recordDebugDecision.mock.calls.some(
          ([decision]) =>
            decision.reviewOnly &&
            decision.classification?.activityOutcome === 'uncertain',
        ),
      ).toBe(true),
    );
    expect((await advance()).model).toBe('docs');
    expect(s.state.lastDecision).toMatchObject({
      targetModelId: 'docs',
      switchCost: { reason: 'cost-held', confidenceOverride: false },
    });
  });

  it('can disable in-loop classifier reviews independently of initial-turn advice', async () => {
    const s = activitySetup();
    s.state.currentConfig.advisor = {
      ...required(s.state.currentConfig.advisor),
      reviewEveryRequests: 0,
    };
    s.delegate.mockImplementation((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            {
              type: 'toolCall',
              name: 'read',
              id: `disabled-${target.id}`,
              arguments: {},
            },
          ],
        }),
      }),
    );
    const user = {
      role: 'user' as const,
      content: 'Implement the change.',
      timestamp: 50,
    };
    const messages: Context['messages'] = [user];
    const advance = async () => {
      const response = await consume(s.stream({ messages }));
      messages.push(response.result);
      const call = response.result.content.find(
        (part) => part.type === 'toolCall',
      );
      if (call?.type !== 'toolCall')
        throw new Error('Expected fixture tool call');
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'done' }],
        isError: false,
        timestamp: 51 + messages.length,
      });
    };
    await advance();
    await advance();
    await advance();
    await advance();
    await advance();
    expect(s.classify).toHaveBeenCalledOnce();
  });

  it('discards a background review that missed its next-request window', async () => {
    const s = activitySetup();
    s.delegate.mockImplementation((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            { type: 'text', text: 'Work is progressing.' },
            {
              type: 'toolCall',
              name: 'read',
              id: `fresh-${target.id}`,
              arguments: {},
            },
          ],
        }),
      }),
    );
    const messages: Context['messages'] = [
      {
        role: 'user',
        content: 'Implement retry handling and update docs.',
        timestamp: 40,
      },
    ];
    const advance = async () => {
      const response = await consume(s.stream({ messages }));
      messages.push(response.result);
      const call = response.result.content.find(
        (part) => part.type === 'toolCall',
      );
      if (call?.type !== 'toolCall')
        throw new Error('Expected fixture tool call');
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'tool evidence' }],
        isError: false,
        timestamp: 41 + messages.length,
      });
      return response.result;
    };
    await advance();
    s.answer.activity = 'docs';
    const immediate = s.classify.getMockImplementation();
    if (!immediate) throw new Error('Missing fixture classifier');
    let releaseReview: (() => void) | undefined;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    s.classify.mockImplementationOnce(async (...args) => {
      const result = immediate(...args);
      await reviewGate;
      return result;
    });
    await advance();
    await advance();
    await advance();
    expect(s.classify).toHaveBeenCalledTimes(2);
    expect((await advance()).model).toBe('code');
    expect((await advance()).model).toBe('code');
    releaseReview?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect((await advance()).model).toBe('code');
    await advance();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect((await advance()).model).toBe('docs');
    expect(s.classify).toHaveBeenCalledTimes(3);
    const reviewRecords = s.actions.recordDebugDecision.mock.calls
      .map(([decision]) => decision)
      .filter((decision) => decision.reviewOnly);
    expect(reviewRecords).toHaveLength(2);
    expect(
      reviewRecords.every((decision) => decision.generation === undefined),
    ).toBe(true);
    expect(
      reviewRecords.every(
        (decision) => decision.classification?.requestId !== undefined,
      ),
    ).toBe(true);
  });

  it('raises and lowers tier within one tool loop from fresh classifier reviews', async () => {
    const s = activitySetup();
    s.state.currentConfig.advisor = {
      ...required(s.state.currentConfig.advisor),
      reviewEveryRequests: 2,
    };
    s.delegate.mockImplementation((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            { type: 'text', text: 'Current work is progressing.' },
            {
              type: 'toolCall',
              name: 'read',
              id: `phase-${target.id}`,
              arguments: {},
            },
          ],
        }),
      }),
    );
    const messages: Context['messages'] = [
      {
        role: 'user',
        content: 'Implement and verify the retry behavior.',
        timestamp: 20,
      },
    ];
    const advance = async () => {
      const response = await consume(s.stream({ messages }));
      messages.push(response.result);
      const call = response.result.content.find(
        (part) => part.type === 'toolCall',
      );
      if (call?.type !== 'toolCall')
        throw new Error('Expected fixture tool call');
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'step result' }],
        isError: false,
        timestamp: 21 + messages.length,
      });
      return response.result;
    };
    await advance();
    s.answer.tier = 'high';
    await advance();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const up = await advance();
    expect(up.model).toBe('primary');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      targetModelId: 'primary',
    });
    s.answer.tier = 'low';
    await advance();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const down = await advance();
    expect(down.model).toBe('small');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'low',
      targetModelId: 'small',
    });
    expect(s.classify).toHaveBeenCalledTimes(3);
  });

  it.each(['off', 'identical', 'ineligible', 'overridden-effort'] as const)(
    'preserves the old route-only question for %s activity behavior',
    async (mode) => {
      const s = activitySetup();
      if (mode === 'off') s.state.currentConfig.activityRouting = 'off';
      else if (mode === 'identical')
        s.profile.activities = { code: { medium: required(s.profile.medium) } };
      else if (mode === 'ineligible')
        s.profile.activities = { code: { medium: { model: 'missing/model' } } };
      else {
        s.profile.activities = {
          code: {
            medium: {
              ...s.profile.medium,
              model: 'test/primary',
              thinking: 'high',
            },
          },
        };
        s.state.thinkingByProfile.balanced = { medium: 'off' };
      }
      await consume(s.stream());
      expect(
        Object.keys(required(s.classify.mock.calls[0]?.[1]).questions),
      ).toEqual(['route']);
      expect(s.state.lastDecision?.targetModelId).toBe('primary');
      expect(s.state.lastDecision?.activity).toBeUndefined();
    },
  );

  it.each(['invalid', 'uncertain', 'low-confidence'] as const)(
    'keeps valid tier advice but uses generic for %s activity',
    async (mode) => {
      const s = activitySetup();
      s.answer.tier = 'high';
      if (mode === 'invalid') s.answer.invalidActivity = true;
      if (mode === 'uncertain') s.answer.activity = 'uncertain';
      if (mode === 'low-confidence') s.answer.confidence = 0.1;
      await consume(s.stream());
      expect(s.state.lastDecision).toMatchObject({
        tier: 'high',
        targetModelId: 'primary',
        advisor: 'classifier',
      });
      expect(s.state.lastDecision?.activity).toBeUndefined();
      expect(s.state.lastDecision?.routeCell).toBeUndefined();
    },
  );

  it('uses a generic-first baseline without consent and never treats availability provenance as classification', async () => {
    const s = activitySetup();
    s.profile.advisor = { models: [] };
    await consume(s.stream());
    expect(s.classify).not.toHaveBeenCalled();
    expect(s.state.lastDecision?.targetModelId).toBe('primary');
    s.models.splice(
      s.models.findIndex((m) => m.id === 'primary'),
      1,
    );
    s.models.splice(
      s.models.findIndex((m) => m.id === 'fallback'),
      1,
    );
    s.profile.low = undefined;
    await consume(
      s.stream({
        messages: [{ role: 'user', content: 'another', timestamp: 2 }],
      }),
    );
    expect(s.state.lastDecision).toMatchObject({
      targetModelId: 'code',
      routeCell: 'code',
      reasonCode: 'baseline',
    });
    expect(s.state.lastDecision?.activity).toBeUndefined();
  });

  it('offers activity-only tiers but invalid activity falls back to the generic baseline', async () => {
    const s = activitySetup();
    s.profile.medium = { model: 'missing/generic' };
    await consume(s.stream());
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      routeCell: 'code',
      targetModelId: 'code',
    });
    s.answer.invalidActivity = true;
    await consume(
      s.stream({
        messages: [{ role: 'user', content: 'next task', timestamp: 2 }],
      }),
    );
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      targetModelId: 'primary',
      advisor: 'classifier-fallback',
    });
    expect(s.state.lastDecision?.activity).toBeUndefined();
  });

  it('above budget prefers a lower activity-only plan over a high generic and bypasses advice', async () => {
    const s = activitySetup();
    s.profile.medium = { model: 'missing/generic' };
    s.profile.low = undefined;
    s.state.currentConfig.maxSessionBudget = 1;
    s.state.accumulatedCost = 1;
    await consume(s.stream());
    expect(s.classify).not.toHaveBeenCalled();
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      routeCell: 'code',
      targetModelId: 'code',
      reasonCode: 'budget',
      isBudgetForced: true,
    });
    expect(s.state.lastDecision?.activity).toBeUndefined();
  });

  it('pins generic only and rejects an ineligible generic pin despite eligible activity plans', async () => {
    const s = activitySetup();
    s.state.pinnedTierByProfile.balanced = 'medium';
    await consume(s.stream());
    expect(s.state.lastDecision).toMatchObject({
      targetModelId: 'primary',
      reasonCode: 'pinned',
    });
    s.profile.medium = { model: 'missing/generic' };
    expect((await consume(s.stream())).result.stopReason).toBe('error');
    expect(s.classify).not.toHaveBeenCalled();
  });

  it('asks activity only for one tier with distinct cells, but one effective plan bypasses advice', async () => {
    const s = activitySetup();
    s.profile.high = undefined;
    s.profile.low = undefined;
    await consume(s.stream());
    expect(
      Object.keys(required(s.classify.mock.calls[0]?.[1]).questions),
    ).toEqual(['activity']);
    expect(s.state.lastDecision).toMatchObject({
      activity: 'code',
      targetModelId: 'code',
    });
    s.profile.activities = undefined;
    await consume(
      s.stream({ messages: [{ role: 'user', content: 'next', timestamp: 2 }] }),
    );
    expect(s.classify).toHaveBeenCalledOnce();
    expect(s.state.lastDecision?.bypassReason).toBe('single-candidate');
  });

  it('whole classifier failure goes directly to baseline and off never uses activity-only cells', async () => {
    const s = activitySetup();
    s.answer.fail = true;
    await consume(s.stream());
    expect(s.state.lastDecision).toMatchObject({
      advisor: 'classifier-fallback',
      targetModelId: 'primary',
    });
    expect(s.classify).toHaveBeenCalledOnce();
    s.state.currentConfig.activityRouting = 'off';
    s.profile.high = undefined;
    s.profile.low = undefined;
    s.profile.medium = { model: 'missing/generic' };
    expect(
      (
        await consume(
          s.stream({
            messages: [{ role: 'user', content: 'next', timestamp: 2 }],
          }),
        )
      ).result.stopReason,
    ).toBe('error');
    expect(s.classify).toHaveBeenCalledOnce();
  });

  it('a selected plan is immutable and live revalidation cannot add a newly configured fallback', async () => {
    const s = activitySetup();
    s.delegate.mockImplementation((target) => {
      if (target.id === 'code') {
        required(s.profile.activities?.code?.medium).fallbacks = ['test/docs'];
        s.models.splice(
          s.models.findIndex((m) => m.id === 'code-backup'),
          1,
        );
        return failure();
      }
      return done();
    });
    expect((await consume(s.stream())).result.stopReason).toBe('error');
    expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
      'code',
    ]);
  });

  it('caller cancellation during activity advice never starts generation', async () => {
    const s = activitySetup();
    const controller = new AbortController();
    s.classify.mockImplementation(
      async (_model, _context, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                api: 'test',
                provider: 'typesafe',
                model: 'jev-latest',
                stopReason: 'aborted',
                answers: {},
                timestamp: 1,
              }),
            { once: true },
          );
        }),
    );
    const completion = consume(s.stream(undefined, controller.signal));
    await vi.waitFor(() => expect(s.classify).toHaveBeenCalledOnce());
    controller.abort();
    expect((await completion).result.stopReason).toBe('aborted');
    expect(s.delegate).not.toHaveBeenCalled();
  });
  it('one physical attempt plan bypasses even when only specialization cells are available', async () => {
    const s = activitySetup();
    s.profile.high = undefined;
    s.profile.medium = undefined;
    s.profile.low = undefined;
    s.profile.activities = {
      docs: { medium: { model: 'test/code', thinking: 'off' } },
      code: { medium: { model: 'test/code', thinking: 'off' } },
    };
    await consume(s.stream());
    expect(s.classify).not.toHaveBeenCalled();
    expect(s.state.lastDecision).toMatchObject({
      routeCell: 'code',
      targetModelId: 'code',
      bypassReason: 'single-candidate',
    });
    expect(s.state.lastDecision?.activity).toBeUndefined();
  });
  it('does not retry a specialization after visible content or caller cancellation', async () => {
    const visible = activitySetup();
    visible.delegate.mockImplementation(() => {
      const partial = message({ model: 'code' });
      return events(
        { type: 'text_delta', contentIndex: 0, delta: 'visible', partial },
        {
          type: 'error',
          reason: 'error',
          error: { ...partial, stopReason: 'error' },
        },
      );
    });
    expect((await consume(visible.stream())).result.stopReason).toBe('error');
    expect(visible.delegate).toHaveBeenCalledOnce();
    const cancelled = activitySetup();
    const controller = new AbortController();
    cancelled.delegate.mockImplementation(() => {
      controller.abort();
      return done();
    });
    expect(
      (await consume(cancelled.stream(undefined, controller.signal))).result
        .stopReason,
    ).toBe('aborted');
    expect(cancelled.delegate).toHaveBeenCalledOnce();
    expect(cancelled.state.accumulatedCost).toBe(0.01);
  });
});

describe('repeated failure escalation', () => {
  const turn = (
    text: string,
    ...results: Array<[toolName: string, isError: boolean]>
  ): Context['messages'] => [
    { role: 'user', content: text, timestamp: 1 },
    ...results.flatMap(([toolName, isError], index) => [
      message({
        model: 'small',
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            id: `${text}-${index}`,
            name: toolName,
            arguments: {},
          },
        ],
      }),
      {
        role: 'toolResult' as const,
        toolCallId: `${text}-${index}`,
        toolName,
        content: [
          {
            type: 'text' as const,
            text: isError ? 'FAIL parser.test.ts:12' : 'ok',
          },
        ],
        isError,
        timestamp: 2,
      },
    ]),
  ];
  const failingLoop = turn(
    'fix the parser',
    ['bash', true],
    ['edit', false],
    ['bash', true],
  );
  const routeWith = (raw: Record<string, unknown> = {}, pin?: 'low') => {
    const s = setup();
    s.state.pinnedTierByProfile = pin ? { balanced: pin } : {};
    s.state.currentConfig = normalizeConfig({
      ...raw,
      profiles: {
        balanced: {
          baselineTier: 'low',
          high: { model: 'test/primary' },
          medium: { model: 'test/fallback' },
          low: { model: 'test/small' },
          ...((raw.profiles as Record<string, object> | undefined)?.balanced ??
            {}),
        },
      },
    }).config;
    const run = async (messages: Context['messages']) => {
      s.delegate.mockClear();
      await consume(s.stream({ messages }));
      return s.delegate.mock.calls[0]?.[0].id;
    };
    return { s, run };
  };

  it('moves one tier up after the same failure repeats across an edit', async () => {
    const { s, run } = routeWith();
    expect(await run(failingLoop)).toBe('fallback');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      reasonCode: 'escalation',
      escalatedFrom: 'low',
    });
  });

  it('keeps the baseline when no edit separates the failures', async () => {
    const { s, run } = routeWith();
    expect(
      await run(turn('fix the parser', ['bash', true], ['bash', true])),
    ).toBe('small');
    expect(s.state.lastDecision?.reasonCode).toBe('baseline');
  });

  it('does not override a pin', async () => {
    const { s, run } = routeWith({}, 'low');
    expect(await run(failingLoop)).toBe('small');
    expect(s.state.lastDecision?.reasonCode).toBe('pinned');
  });

  it('never escalates to high over the soft budget', async () => {
    const { s, run } = routeWith({
      maxSessionBudget: 0.01,
      profiles: { balanced: { baselineTier: 'medium' } },
    });
    s.state.accumulatedCost = 1;
    expect(await run(failingLoop)).toBe('fallback');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      reasonCode: 'budget',
    });
  });

  it.each([
    [0, 'small'],
    [1, 'fallback'],
  ])(
    'with escalationHoldTurns %i the next user turn routes to %s',
    async (escalationHoldTurns, next) => {
      const { run } = routeWith({ switchPolicy: { escalationHoldTurns } });
      expect(await run(failingLoop)).toBe('fallback');
      expect(await run([...failingLoop, ...turn('add a test')])).toBe(next);
    },
  );

  it('keeps the hold on a new user turn after a Google answer with thinking', async () => {
    const { run } = routeWith({ switchPolicy: { escalationHoldTurns: 1 } });
    const googleAnswer = message({
      api: 'google-generative-ai',
      model: 'fallback',
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'fixed' },
      ],
    });
    expect(await run(failingLoop)).toBe('fallback');
    expect(
      await run([...failingLoop, googleAnswer, ...turn('add a test')]),
    ).toBe('fallback');
  });
});

describe('routing mode changes while advice is in flight', () => {
  const price = (input: number) => ({
    cost: {
      input,
      output: input * 5,
      cacheRead: input / 10,
      cacheWrite: input,
    },
  });
  const priced = (mode?: 'cost', low: object = { model: 'test/small' }) => {
    const s = setup();
    s.models.splice(
      0,
      s.models.length,
      model('primary', price(4)),
      model('fallback', price(2)),
      model('small', { contextWindow: 1024, ...price(1) }),
    );
    s.state.pinnedTierByProfile = {};
    if (mode) s.state.modeOverride = mode;
    s.state.currentConfig = normalizeConfig({
      advisor: {
        enabled: true,
        model: 'typesafe/jev-latest',
        reviewEveryRequests: 2,
      },
      profiles: {
        balanced: {
          advisor: { models: ['typesafe/jev-latest'] },
          high: { model: 'test/primary' },
          medium: { model: 'test/fallback' },
          low,
        },
      },
    }).config;
    s.registry.findOfType = (() =>
      classifierModel) as unknown as ExtensionContext['modelRegistry']['findOfType'];
    return s;
  };
  const routed = (s: ReturnType<typeof setup>) =>
    s.delegate.mock.calls.at(-1)?.[0].id;

  it('accepts advice for the mode it was asked under', async () => {
    const s = priced('cost');
    s.registry.classify = vi.fn<Classify>(async (target, context) =>
      classifierResponse(target, context, 'high'),
    );
    await consume(s.stream(userContext()));
    expect(routed(s)).toBe('fallback');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      advisor: 'classifier',
      mode: 'cost',
      modeSource: 'session',
      modeLever: 'model',
      modeSourceTier: 'medium',
    });
  });

  it('rejects initial advice after a mode change and generates from the current matrix', async () => {
    const s = priced();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const classify = vi.fn<Classify>(async (target, context) => {
      await gate;
      return classifierResponse(target, context, 'high');
    });
    s.registry.classify = classify;
    const pending = consume(s.stream(userContext()));
    await vi.waitFor(() => expect(classify).toHaveBeenCalled());
    s.state.modeOverride = 'cost';
    release();
    await pending;
    // balanced advice would run primary; the same advice on the cost matrix, fallback
    expect(routed(s)).toBe('small');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      advisor: 'classifier-fallback',
      mode: 'cost',
      modeSource: 'session',
      modeLever: 'model',
      modeSourceTier: 'low',
    });
  });

  it('rejects initial advice after a mode change that leaves the advised cell unchanged', async () => {
    const s = priced(undefined, { model: 'test/small', thinking: 'low' });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const classify = vi.fn<Classify>(async (target, context) => {
      await gate;
      return classifierResponse(target, context, 'low');
    });
    s.registry.classify = classify;
    const pending = consume(s.stream(userContext()));
    await vi.waitFor(() => expect(classify).toHaveBeenCalled());
    s.state.modeOverride = 'cost';
    release();
    await pending;
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      advisor: 'classifier-fallback',
      mode: 'cost',
    });
  });

  it('discards a background review started before a mode change', async () => {
    const s = priced();
    const answer = { tier: 'medium' };
    const classify = vi.fn<Classify>(async (target, context) =>
      classifierResponse(target, context, answer.tier),
    );
    s.registry.classify = classify;
    s.delegate.mockImplementation((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            {
              type: 'toolCall',
              name: 'read',
              id: `call-${target.id}-${Math.random()}`,
              arguments: {},
            },
          ],
        }),
      }),
    );
    const messages: Context['messages'] = [
      { role: 'user', content: 'Implement the retry behavior.', timestamp: 20 },
    ];
    const advance = async () => {
      const { result } = await consume(s.stream({ messages }));
      messages.push(result);
      const call = result.content.find((part) => part.type === 'toolCall');
      if (call?.type !== 'toolCall') throw new Error('Expected a tool call');
      messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: 'step result' }],
        isError: false,
        timestamp: 21 + messages.length,
      });
      return result.model;
    };
    expect(await advance()).toBe('fallback');
    answer.tier = 'high';
    expect(await advance()).toBe('fallback');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(classify).toHaveBeenCalledTimes(2);
    s.state.modeOverride = 'cost';
    // a consumed stale review would run primary (balanced) or fallback (cost high)
    expect(await advance()).toBe('small');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      reasonCode: 'baseline',
      mode: 'cost',
    });
  });
});

describe('routing mode on an unchanged tool route', () => {
  it('records the new mode when a mode change leaves the route unchanged', async () => {
    const s = setup();
    s.state.pinnedTierByProfile = {};
    s.state.currentConfig = normalizeConfig({
      profiles: {
        balanced: {
          baselineTier: 'low',
          low: { model: 'test/small', thinking: 'low' },
        },
      },
    }).config;
    s.delegate.mockImplementation((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            { type: 'toolCall', name: 'read', id: 'call-1', arguments: {} },
          ],
        }),
      }),
    );
    const messages: Context['messages'] = [
      { role: 'user', content: 'Read the file.', timestamp: 20 },
    ];
    const { result } = await consume(s.stream({ messages }));
    expect(s.state.lastDecision?.mode).toBe('balanced');
    messages.push(result, {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'contents' }],
      isError: false,
      timestamp: 22,
    });
    s.state.modeOverride = 'cost';
    await consume(s.stream({ messages }));
    expect(s.delegate.mock.calls.at(-1)?.[0].id).toBe('small');
    expect(s.state.lastDecision).toMatchObject({
      mode: 'cost',
      modeSource: 'session',
      modeLever: 'none',
      thinking: 'low',
    });
  });
});
