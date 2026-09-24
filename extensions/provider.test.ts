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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from './config';
import { registerRouterProvider, waitForRegistry } from './provider';
import {
  done,
  events,
  failure,
  message,
  model,
  required,
} from './test/fixtures';
import type { JevConfig, JevContextState } from './types';

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
    getThinkingOverride: vi.fn(),
    updateStatus: vi.fn(),
    syncPiThinkingLevel: vi.fn(),
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
          stayAllReadUsd: 0.14,
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
    const balanced = required(s.state.currentConfig.profiles.balanced);
    balanced.high = {
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
      reasonCode: 'baseline',
    });
  });

  it('does not trust an orphan Google tool result or call a classifier for it', async () => {
    const s = setup();
    s.state.currentConfig.classifierModel = { model: 'test/small' };
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

  it('does not persist classifier explanation text in a decision sink', async () => {
    const s = setup();
    delete s.state.pinnedTierByProfile.balanced;
    s.state.currentConfig.classifierModel = { model: 'test/small' };
    s.delegate.mockReturnValueOnce(
      done('Tier: high\nReasoning: do not persist this explanation'),
    );

    await consume(s.stream());

    expect(s.state.lastDecision?.reasonCode).toBe('classifier');
    expect(s.actions.recordDebugDecision).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: 'classifier' }),
    );
    expect(
      s.actions.recordDebugDecision.mock.calls[0]?.[0].reasonCode,
    ).not.toContain('do not persist');
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
    s.state.currentConfig.classifierModel = { model: 'test/primary' };
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

  it('accepts a semantic classifier tier without applying a prompt-derived floor', async () => {
    const s = setup();
    delete s.state.pinnedTierByProfile.balanced;
    s.state.currentConfig.classifierModel = { model: 'test/primary' };
    s.delegate.mockReturnValueOnce(done('Tier: low\nReasoning: cheap'));
    await consume(
      s.stream({
        messages: [
          { role: 'user', content: 'design a migration', timestamp: 1 },
        ],
      }),
    );
    expect(s.delegate).toHaveBeenCalledTimes(2);
    expect(s.state.lastDecision).toMatchObject({
      tier: 'low',
      reasonCode: 'classifier',
      isClassifier: true,
    });
    expect(advisorOf(s.state.lastDecision)).toBe('classifier');
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

const jevConfig: JevConfig = {
  enabled: true,
  apiKey: 'private-test-key',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-1.13.0',
  timeoutMs: 750,
  confidenceThreshold: 0.65,
  probabilityThreshold: 0.8,
  maxStateTokens: 3000,
  mode: 'advisory',
};
const enableAdvisors = (s: ReturnType<typeof setup>) => {
  s.state.currentConfig.jev = { ...jevConfig };
  required(s.state.currentConfig.profiles.balanced).jev = { enabled: true };
  s.state.currentConfig.classifierModel = { model: 'test/small' };
  delete s.state.pinnedTierByProfile.balanced;
};
type ChoiceRequest = {
  state: JevContextState;
  questions: { route: { criteria: Record<string, string> } };
};
const choiceResponse = (init: RequestInit | undefined, tier = 'medium') => {
  const body = JSON.parse(String(init?.body)) as ChoiceRequest;
  const ids = Object.keys(body.questions.route.criteria);
  const selected = ids.find((id) => id.startsWith(`${tier}|`)) ?? 'uncertain';
  return new Response(
    JSON.stringify({
      answers: {
        route: {
          type: 'choice',
          choice: selected,
          confidence: 0.99,
          probabilities: Object.fromEntries(
            ids.map((id) => [id, id === selected ? 1 : 0]),
          ),
          reasoning: 'remote explanation must not escape',
        },
      },
    }),
  );
};
const mockChoice = (tier = 'medium') => {
  const transport = vi.fn<typeof fetch>(async (_url, init) =>
    choiceResponse(init, tier),
  );
  vi.stubGlobal('fetch', transport);
  return transport;
};
const userContext = (text = 'implement a parser', timestamp = 1): Context => ({
  messages: [{ role: 'user', content: text, timestamp }],
});
const astraSetup = () => {
  const s = setup();
  s.models.splice(
    0,
    s.models.length,
    ...['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol'].map((id) =>
      model(id, {
        provider: 'openai-codex-personal',
        thinkingLevelMap: {
          ...(id === 'gpt-6-astra' ? { off: null } : {}),
          minimal: 'low',
          xhigh: 'xhigh',
          max: 'max',
        },
      }),
    ),
  );
  s.state.currentConfig = normalizeConfig({
    jev: jevConfig,
    models: {
      frontier: { model: 'openai-codex-personal/gpt-6-astra' },
      worker: { model: 'openai-codex-personal/gpt-5.6-luna' },
      fast: { model: 'openai-codex-personal/gpt-5.6-luna' },
    },
    profiles: {
      balanced: {
        jev: { enabled: true },
        high: {
          model: 'frontier',
          thinking: 'high',
          fallbacks: ['openai-codex-personal/gpt-5.6-sol'],
        },
        medium: { model: 'worker', thinking: 'max' },
        low: { model: 'fast', thinking: 'max' },
        micro: { model: 'fast', thinking: 'off' },
      },
    },
  }).config;
  delete s.state.pinnedTierByProfile.balanced;
  return s;
};
const toolMessage = (provider = 'test', id = 'primary') =>
  message({
    api: provider === 'google' ? 'google-generative-ai' : 'openai-completions',
    provider,
    model: id,
    timestamp: 2,
    stopReason: 'toolUse',
    content: [
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'read',
        arguments: {},
        ...(provider === 'google'
          ? { thoughtSignature: 'opaque-signature' }
          : {}),
      },
    ],
  });
const toolContext = (
  first = userContext(),
  assistant = toolMessage(),
): Context => ({
  messages: [
    ...first.messages,
    assistant,
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'untrusted tool text' }],
      isError: false,
      timestamp: 3,
    },
  ],
});
const finishTool = (assistant = toolMessage()) =>
  events({ type: 'done', reason: 'toolUse', message: assistant });
const gatedFinishTool = (gate: Promise<void>, assistant = toolMessage()) =>
  (async function* () {
    await gate;
    yield { type: 'done', reason: 'toolUse', message: assistant };
  })() as unknown as AssistantMessageEventStream;

describe('Jev provider integration', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'offers and accepts high/Astra after alias normalization (image=%s)',
    async (image) => {
      const s = astraSetup();
      const fetch = mockChoice('high');
      const context = userContext('Synthetic routing task');
      if (image)
        context.messages.push({
          role: 'user',
          content: [
            { type: 'image', data: 'synthetic', mimeType: 'image/png' },
          ],
          timestamp: 2,
        });

      const { result } = await consume(s.stream(context));

      expect(result.stopReason).toBe('stop');
      expect(fetch).toHaveBeenCalledOnce();
      const body = JSON.parse(
        String(fetch.mock.calls[0]?.[1]?.body),
      ) as ChoiceRequest;
      expect(Object.keys(body.questions.route.criteria)).toEqual([
        'uncertain',
        'medium|openai-codex-personal%2Fgpt-5.6-luna|max',
        'high|openai-codex-personal%2Fgpt-6-astra|high',
        'low|openai-codex-personal%2Fgpt-5.6-luna|max',
        'micro|openai-codex-personal%2Fgpt-5.6-luna|off',
      ]);
      expect(s.state.lastDecision).toMatchObject({
        tier: 'high',
        targetLabel: 'openai-codex-personal/gpt-6-astra',
        thinking: 'high',
        reasonCode: 'jev',
        advisor: 'jev',
      });
      expect(s.delegate).toHaveBeenCalledOnce();
      expect(s.delegate.mock.calls[0]?.[0]).toMatchObject({
        provider: 'openai-codex-personal',
        id: 'gpt-6-astra',
      });
      expect(s.delegate.mock.calls[0]?.[2]?.reasoning).toBe('high');
    },
  );

  it('uses medium/Luna baseline when Jev exceeds its cap despite eligible Astra', async () => {
    vi.useFakeTimers();
    const s = astraSetup();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const pending = consume(s.stream(userContext('Synthetic routing task')));

    await vi.advanceTimersByTimeAsync(749);
    expect(fetch).toHaveBeenCalledOnce();
    expect(s.delegate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const { result } = await pending;

    expect(result.stopReason).toBe('stop');
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls[0]?.[0].id).toBe('gpt-5.6-luna');
    expect(s.delegate.mock.calls[0]?.[2]?.reasoning).toBe('max');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      thinking: 'max',
      reasonCode: 'baseline',
      advisor: 'jev-fallback',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps interleaved stream continuations keyed to their originating turn', async () => {
    const s = setup();
    let releaseFirst: () => void = () => undefined;
    let releaseSecond: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    enableAdvisors(s);
    const fetch = mockChoice('low');
    fetch.mockImplementationOnce(async (_url, init) =>
      choiceResponse(init, 'high'),
    );
    const firstAssistant = toolMessage('test', 'primary');
    const secondAssistant = toolMessage('test', 'small');
    s.delegate
      .mockImplementationOnce(() => gatedFinishTool(firstGate, firstAssistant))
      .mockImplementationOnce(() =>
        gatedFinishTool(secondGate, secondAssistant),
      );

    const first = consume(s.stream(userContext('implement first', 1)));
    const second = consume(s.stream(userContext('implement second', 2)));
    await vi.waitFor(() => expect(s.delegate).toHaveBeenCalledTimes(2));
    releaseSecond();
    await second;
    releaseFirst();
    await first;

    await consume(
      s.stream(toolContext(userContext('implement first', 1), firstAssistant)),
    );
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      targetLabel: 'test/primary',
      reasonCode: 'continuation',
    });
    await consume(
      s.stream(
        toolContext(userContext('implement second', 2), secondAssistant),
      ),
    );
    expect(s.state.lastDecision).toMatchObject({
      tier: 'low',
      targetLabel: 'test/small',
      reasonCode: 'continuation',
    });
    expect(s.delegate).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['micro', 'low', 'medium', 'high'])(
    'accepts semantic Jev selection of %s',
    async (tier) => {
      const s = setup();
      enableAdvisors(s);
      required(s.state.currentConfig.profiles.balanced).micro = {
        model: 'test/small',
      };
      const fetch = mockChoice(tier);
      await consume(s.stream(userContext('да, сделай')));
      expect(fetch).toHaveBeenCalledOnce();
      expect(s.delegate).toHaveBeenCalledOnce();
      expect(s.state.lastDecision).toMatchObject({ tier, reasonCode: 'jev' });
      expect(advisorOf(s.state.lastDecision)).toBe('jev');
    },
  );

  it.each(['да, сделай', 'yes', 'plese fix 日本語'])(
    'sends bounded role-labelled history for %s',
    async (text) => {
      const s = setup();
      enableAdvisors(s);
      required(s.state.currentConfig.jev).maxStateTokens = 75;
      required(s.state.currentConfig.jev).context = {
        previousTurns: 2,
        maxHistoryTokens: 50,
        toolResults: 'last',
        maxToolTokens: 25,
      };
      const fetch = mockChoice();
      const context = toolContext(userContext('前の依頼: improve the parser'));
      context.systemPrompt = 'PRIVATE_SYSTEM';
      context.messages.push({ role: 'user', content: text, timestamp: 4 });
      await consume(s.stream(context));
      const body = JSON.parse(
        String(fetch.mock.calls[0]?.[1]?.body),
      ) as ChoiceRequest;
      expect(body.state.currentRequest.text).toBe(text);
      expect(body.state.recentDialogue[0]?.text).toContain('前の依頼');
      expect(body.state.recentToolEvidence[0]?.text).toBe(
        'untrusted tool text',
      );
      const metrics = required(s.state.lastDecision?.jev?.context);
      expect(
        metrics.currentRequestTokens +
          metrics.historyTokens +
          metrics.toolTokens,
      ).toBeLessThanOrEqual(75);
      expect(JSON.stringify(body)).not.toContain('PRIVATE_SYSTEM');
      expect(JSON.stringify(body)).not.toContain(jevConfig.apiKey);
    },
  );

  it.each([
    'uncertain',
    'invalid-id',
    'http-error',
    'malformed',
    'transport-error',
  ])(
    'falls straight to baseline after active Jev %s, never to classifier',
    async (kind) => {
      const s = setup();
      enableAdvisors(s);
      const transport = vi.fn<typeof fetch>(async (_url, init) => {
        if (kind === 'transport-error') throw new Error('private-test-key');
        if (kind === 'http-error') return new Response('', { status: 500 });
        if (kind === 'malformed') return new Response('{}');
        const response = await choiceResponse(
          init,
          kind === 'uncertain' ? kind : 'high',
        ).json();
        if (kind === 'invalid-id')
          response.answers.route.choice = 'foreign-model';
        return new Response(JSON.stringify(response));
      });
      vi.stubGlobal('fetch', transport);
      await consume(s.stream(userContext()));
      // Only a documented transient status is retried, once, inside the budget.
      expect(transport).toHaveBeenCalledTimes(kind === 'http-error' ? 2 : 1);
      expect(s.delegate).toHaveBeenCalledOnce();
      expect(s.state.lastDecision).toMatchObject({
        tier: 'medium',
        reasonCode: 'baseline',
      });
      expect(advisorOf(s.state.lastDecision)).toBe('jev-fallback');
    },
  );

  it('routes a split low-confidence distribution up instead of discarding the answer', async () => {
    const s = setup();
    enableAdvisors(s);
    required(s.state.currentConfig.profiles.balanced).micro = {
      model: 'test/small',
    };
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ChoiceRequest;
      const ids = Object.keys(body.questions.route.criteria);
      const find = (tier: string) =>
        ids.find((id) => id.startsWith(`${tier}|`)) ?? 'uncertain';
      return new Response(
        JSON.stringify({
          answers: {
            route: {
              type: 'choice',
              choice: find('micro'),
              confidence: 0.3,
              probabilities: Object.fromEntries(
                ids.map((id) => [
                  id,
                  id === find('micro') ? 0.5 : id === find('high') ? 0.5 : 0,
                ]),
              ),
            },
          },
        }),
      );
    });
    vi.stubGlobal('fetch', transport);
    await consume(s.stream(userContext()));
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      reasonCode: 'jev',
      jev: {
        choice: 'micro',
        selectedTier: 'high',
        selectionBasis: 'probability',
      },
    });
    expect(advisorOf(s.state.lastDecision)).toBe('jev');
  });

  it.each([true, false])(
    'missing Jev key uses only the configured compatibility path (classifier=%s)',
    async (classifier) => {
      const s = setup();
      enableAdvisors(s);
      required(s.state.currentConfig.jev).apiKey = '';
      const fetch = mockChoice();
      if (classifier) {
        required(s.state.currentConfig.profiles.balanced).micro = {
          model: 'test/small',
        };
        s.delegate.mockReturnValueOnce(
          done('Tier: micro\nReasoning: semantic selection'),
        );
      } else s.state.currentConfig.classifierModel = undefined;
      await consume(s.stream(userContext()));
      expect(fetch).not.toHaveBeenCalled();
      expect(s.delegate).toHaveBeenCalledTimes(classifier ? 2 : 1);
      expect(s.state.lastDecision).toMatchObject({
        tier: classifier ? 'micro' : 'medium',
        reasonCode: classifier ? 'classifier' : 'baseline',
      });
    },
  );

  it.each(['uncertain', 'unknown', 'micro'])(
    'uses baseline for unavailable classifier choice %s',
    async (tier) => {
      const s = setup();
      delete s.state.pinnedTierByProfile.balanced;
      s.state.currentConfig.classifierModel = { model: 'test/small' };
      s.delegate.mockReturnValueOnce(done(`Tier: ${tier}\nReasoning: ignored`));
      const fetch = mockChoice();
      await consume(s.stream(userContext()));
      expect(fetch).not.toHaveBeenCalled();
      expect(s.delegate).toHaveBeenCalledTimes(2);
      expect(s.state.lastDecision).toMatchObject({
        tier: 'medium',
        reasonCode: 'baseline',
      });
      expect(advisorOf(s.state.lastDecision)).toBe('classifier-fallback');
    },
  );

  it('propagates caller abort during classifier-only advice without baseline generation', async () => {
    const s = setup();
    delete s.state.pinnedTierByProfile.balanced;
    s.state.currentConfig.classifierModel = { model: 'test/small' };
    const controller = new AbortController();
    s.delegate.mockImplementationOnce(() => {
      controller.abort();
      return done('Tier: high\nReasoning: ignored');
    });
    const { result } = await consume(
      s.stream(userContext(), controller.signal),
    );
    expect(result.stopReason).toBe('aborted');
    expect(s.delegate).toHaveBeenCalledOnce();
  });

  it('applies only a local allowlisted pair and delegates once through Pi', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice('high');
    expect((await consume(s.stream(userContext()))).result.stopReason).toBe(
      'stop',
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      reasonCode: 'jev',
    });
    expect(advisorOf(s.state.lastDecision)).toBe('jev');
    const recorded = JSON.stringify(s.actions.recordDebugDecision.mock.calls);
    for (const value of [
      'private-test-key',
      'typesafe.ai',
      'implement a parser',
      'remote explanation',
    ])
      expect(recorded).not.toContain(value);
    expect(s.state.lastDecision?.routingLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('keeps Jev provenance when generation falls back to an explicit target', async () => {
    const s = setup();
    enableAdvisors(s);
    required(s.state.currentConfig.profiles.balanced).high = {
      model: 'test/primary',
      fallbacks: ['test/fallback'],
    };
    mockChoice('high');
    s.delegate.mockReturnValueOnce(failure()).mockReturnValueOnce(done());

    await consume(s.stream(userContext()));

    expect(s.state.lastDecision).toMatchObject({
      targetLabel: 'test/fallback',
      reasonCode: 'fallback',
      isFallback: true,
    });
    expect(advisorOf(s.state.lastDecision)).toBe('jev');
  });

  it.each(['pin', 'single', 'budget', 'disabled-profile'] as const)(
    'skips external advice for %s',
    async (kind) => {
      const s = setup();
      enableAdvisors(s);
      const fetch = mockChoice();
      if (kind === 'pin') s.state.pinnedTierByProfile.balanced = 'low';
      if (kind === 'single')
        s.state.currentConfig.profiles.balanced = {
          medium: { model: 'test/primary' },
          jev: { enabled: true },
        };
      if (kind === 'budget') {
        s.state.currentConfig.maxSessionBudget = 1;
        s.state.accumulatedCost = 2;
      }
      if (kind === 'disabled-profile') {
        required(s.state.currentConfig.profiles.balanced).jev = {
          enabled: false,
        };
        s.state.currentConfig.classifierModel = undefined;
      }
      const context = userContext('implement a parser');
      await consume(s.stream(context));
      expect(fetch).not.toHaveBeenCalled();
      expect(s.delegate).toHaveBeenCalledOnce();
      expect(advisorOf(s.state.lastDecision)).toBe(
        kind === 'disabled-profile' ? 'none' : 'bypassed',
      );
      expect(s.state.lastDecision?.bypassReason).toBe(
        {
          pin: 'pinned',
          single: 'single-candidate',
          budget: 'budget',
          'disabled-profile': undefined,
        }[kind],
      );
      expect(s.actions.recordDebugDecision).toHaveBeenLastCalledWith(
        expect.objectContaining({
          advisor: kind === 'disabled-profile' ? 'none' : 'bypassed',
        }),
      );
    },
  );

  it('names a tool turn that cannot reuse its route as the bypass reason', async () => {
    const s = setup();
    enableAdvisors(s);
    mockChoice();
    await consume(
      s.stream(
        toolContext(userContext('same task', 1), toolMessage('test', 'small')),
      ),
    );
    expect(s.state.lastDecision).toMatchObject({
      reasonCode: 'baseline',
      advisor: 'bypassed',
      bypassReason: 'tool-continuation',
    });
  });

  it.each([undefined, 20_000, 2_000])(
    'gives the classifier its configured budget (%s) as the routing deadline',
    async (timeoutMs) => {
      const s = setup();
      delete s.state.pinnedTierByProfile.balanced;
      s.state.currentConfig.classifierModel = {
        model: 'test/small',
        timeoutMs,
      };
      s.delegate.mockReturnValueOnce(done('Tier: low\nReasoning: cheap'));
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      try {
        await consume(s.stream(userContext()));
        const budget = timeoutSpy.mock.calls[0]?.[0] ?? 0;
        const expected = timeoutMs ?? 10_000;
        expect(budget).toBeGreaterThan(expected - 500);
        expect(budget).toBeLessThanOrEqual(expected);
      } finally {
        timeoutSpy.mockRestore();
      }
      expect(s.state.lastDecision).toMatchObject({
        tier: 'low',
        reasonCode: 'classifier',
      });
    },
  );

  it.each(['none', 'jev', 'classifier'] as const)(
    'preserves a fallback-only baseline with one eligible primary (%s)',
    async (advisor) => {
      for (const unavailable of ['missing', 'image'] as const) {
        const s = setup();
        s.state.currentConfig = normalizeConfig({
          profiles: {
            balanced: {
              baselineTier: 'medium',
              high: { model: 'test/small' },
              medium: {
                model: 'test/primary',
                fallbacks: ['test/fallback'],
              },
            },
          },
        }).config;
        delete s.state.pinnedTierByProfile.balanced;
        if (advisor === 'jev') enableAdvisors(s);
        if (advisor === 'classifier')
          s.state.currentConfig.classifierModel = { model: 'test/small' };
        const fetch = mockChoice('high');
        const context = userContext();
        if (unavailable === 'missing') s.models.shift();
        else {
          required(s.models[0]).input = ['text'];
          context.messages.push({
            role: 'user',
            content: [
              { type: 'image', data: 'synthetic', mimeType: 'image/png' },
            ],
            timestamp: 2,
          });
        }
        expect((await consume(s.stream(context))).result.stopReason).toBe(
          'stop',
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(s.delegate).toHaveBeenCalledOnce();
        expect(s.delegate.mock.calls[0]?.[0].id).toBe('fallback');
        expect(s.state.lastDecision).toMatchObject({
          tier: 'medium',
          targetLabel: 'test/fallback',
          reasonCode: 'fallback',
        });
        expect(advisorOf(s.state.lastDecision)).toBe(
          advisor === 'none' ? 'none' : 'bypassed',
        );
      }
    },
  );

  it.each(['jev', 'classifier'] as const)(
    'keeps non-reasoning primaries eligible for %s with implicit thinking',
    async (advisor) => {
      const s = setup();
      enableAdvisors(s);
      if (advisor === 'classifier') s.state.currentConfig.jev = undefined;
      required(s.models[0]).reasoning = false;
      const fetch = mockChoice('medium');
      if (advisor === 'classifier')
        s.delegate.mockReturnValueOnce(
          done('Tier: medium\nReasoning: semantic'),
        );
      expect((await consume(s.stream(userContext()))).result.stopReason).toBe(
        'stop',
      );
      expect(s.state.lastDecision).toMatchObject({
        tier: 'medium',
        thinking: 'off',
        reasonCode: advisor,
      });
      expect(advisorOf(s.state.lastDecision)).toBe(advisor);
      expect(s.delegate.mock.calls.at(-1)?.[0].id).toBe('primary');
      expect(s.delegate.mock.calls.at(-1)?.[2]?.reasoning).toBeUndefined();
      if (advisor === 'jev') {
        expect(fetch).toHaveBeenCalledOnce();
        const body = JSON.parse(
          String(fetch.mock.calls[0]?.[1]?.body),
        ) as ChoiceRequest;
        expect(Object.keys(body.questions.route.criteria)).toContain(
          'medium|test%2Fprimary|off',
        );
      } else expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['jev', 'classifier'] as const)(
    'releases the %s guard after terminal abort/error without retrying generation',
    async (advisor) => {
      for (const kind of [
        'aborted',
        'visible-error',
        'visible-abort',
      ] as const) {
        const s = setup();
        enableAdvisors(s);
        if (advisor === 'classifier') s.state.currentConfig.jev = undefined;
        const fetch = mockChoice('high');
        const reason = kind === 'visible-error' ? 'error' : 'aborted';
        const terminal: AssistantMessageEvent = {
          type: 'error',
          reason,
          error: message({ stopReason: reason }),
        };
        const failed =
          kind === 'aborted'
            ? events(terminal)
            : events(
                {
                  type: 'text_delta',
                  contentIndex: 0,
                  delta: 'partial',
                  partial: message(),
                },
                terminal,
              );
        if (advisor === 'classifier')
          s.delegate.mockReturnValueOnce(
            done('Tier: high\nReasoning: semantic'),
          );
        s.delegate.mockReturnValueOnce(failed);
        const first = await consume(s.stream(userContext()));
        expect(first.result.stopReason).toBe(reason);
        expect(
          first.received.filter((event) => event.type === 'error'),
        ).toHaveLength(1);
        expect(s.delegate).toHaveBeenCalledTimes(
          advisor === 'classifier' ? 2 : 1,
        );
        if (advisor === 'classifier')
          s.delegate.mockReturnValueOnce(
            done('Tier: high\nReasoning: semantic'),
          );
        expect((await consume(s.stream(userContext()))).result.stopReason).toBe(
          'stop',
        );
        expect(s.state.lastDecision).toMatchObject({
          tier: 'high',
          reasonCode: advisor,
        });
        expect(advisorOf(s.state.lastDecision)).toBe(advisor);
        expect(s.delegate).toHaveBeenCalledTimes(
          advisor === 'classifier' ? 4 : 2,
        );
        expect(fetch).toHaveBeenCalledTimes(advisor === 'jev' ? 2 : 0);
      }
    },
  );

  it.each([
    ['uncertain', 'high', 'gpt-6-astra', 'jev-fallback'],
    ['micro', 'micro', 'gpt-5.6-luna', 'jev'],
    ['low', 'low', 'gpt-5.6-luna', 'jev'],
  ] as const)(
    'uses high as baseline without overriding confident %s advice',
    async (choice, tier, target, advisor) => {
      const s = astraSetup();
      required(s.state.currentConfig.profiles.balanced).baselineTier = 'high';
      const fetch = mockChoice(choice);
      await consume(s.stream(userContext()));
      expect(fetch).toHaveBeenCalledOnce();
      expect(s.delegate.mock.calls[0]?.[0].id).toBe(target);
      expect(s.state.lastDecision).toMatchObject({ tier, advisor });
    },
  );

  it('still honors the budget before a high baseline and skips Jev', async () => {
    const s = astraSetup();
    required(s.state.currentConfig.profiles.balanced).baselineTier = 'high';
    s.state.currentConfig.maxSessionBudget = 0.01;
    s.state.accumulatedCost = 1;
    const fetch = mockChoice('high');
    await consume(s.stream(userContext()));
    expect(fetch).not.toHaveBeenCalled();
    expect(s.state.lastDecision?.tier).not.toBe('high');
    expect(s.state.lastDecision?.isBudgetForced).toBe(true);
  });

  it('reuses the Jev route on a repeated call for the same user turn', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice('high');
    for (const timestamp of [1, 2, 3, 3])
      await consume(s.stream(userContext('implement a parser', timestamp)));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(s.delegate).toHaveBeenCalledTimes(4);
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      reasonCode: 'jev',
      advisor: 'jev',
    });
  });

  it('reuses the actual fallback route without reusing its old generation metrics', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice('medium');
    s.delegate.mockReturnValueOnce(failure());
    await consume(s.stream(userContext()));
    expect(s.state.lastDecision?.generation?.attempts).toBe(2);
    s.delegate.mockImplementationOnce(() => {
      expect(s.state.lastDecision?.generation).toBeUndefined();
      return done();
    });
    await consume(s.stream(userContext()));
    expect(fetch).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
      'primary',
      'fallback',
      'fallback',
    ]);
    expect(s.state.lastDecision?.generation).toMatchObject({
      attempts: 1,
      reportedCostUsd: 0.01,
    });
  });

  it('keeps a fallback-only baseline when low-confidence advice needs its abstention mass', async () => {
    const s = setup();
    s.state.currentConfig = normalizeConfig({
      profiles: {
        balanced: {
          baselineTier: 'high',
          high: { model: 'test/unavailable', fallbacks: ['test/fallback'] },
          medium: { model: 'test/primary' },
          low: { model: 'test/small' },
        },
      },
    }).config;
    enableAdvisors(s);
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ChoiceRequest;
      const ids = Object.keys(body.questions.route.criteria);
      expect(ids.some((id) => id.startsWith('high|'))).toBe(false);
      return Response.json({
        answers: {
          route: {
            type: 'choice',
            choice: ids.find((id) => id.startsWith('medium|')),
            confidence: 0.1,
            probabilities: Object.fromEntries(
              ids.map((id) => [
                id,
                id === 'uncertain'
                  ? 0.35
                  : id.startsWith('medium|')
                    ? 0.45
                    : 0.2,
              ]),
            ),
          },
        },
      });
    });
    vi.stubGlobal('fetch', transport);
    expect((await consume(s.stream(userContext()))).result.stopReason).toBe(
      'stop',
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      targetLabel: 'test/fallback',
      advisor: 'jev-fallback',
    });
    expect(s.delegate.mock.calls[0]?.[0].id).toBe('fallback');
  });

  it('updates the cached target when a reused decision falls back', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice('medium');
    await consume(s.stream(userContext()));
    s.delegate.mockReturnValueOnce(failure());
    await consume(s.stream(userContext()));
    expect(s.state.lastDecision?.targetLabel).toBe('test/fallback');
    await consume(s.stream(userContext()));
    expect(fetch).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
      'primary',
      'primary',
      'fallback',
      'fallback',
    ]);
    expect(s.state.lastDecision?.generation?.attempts).toBe(1);
  });

  it('isolates identical transcripts by caller session and preserves cache affinity', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice('high');
    for (const session of ['parent', 'child', 'parent'])
      await consume(s.stream(userContext(), undefined, session));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.delegate.mock.calls.map((call) => call[2]?.sessionId)).toEqual([
      'parent',
      'child',
      'parent',
    ]);
  });

  it('scopes reuse to the native session when the caller omits a session ID', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice('high');
    let sessionId = 'parent';
    Object.assign(required(s.state.lastExtensionContext).sessionManager, {
      getSessionId: () => sessionId,
    });
    for (const next of ['parent', 'child', 'parent']) {
      sessionId = next;
      await consume(s.stream(userContext()));
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      s.delegate.mock.calls.every((call) => call[2]?.sessionId === undefined),
    ).toBe(true);
  });

  it('shares one in-flight Jev request across concurrent calls for one turn', async () => {
    const s = astraSetup();
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);

    const first = consume(s.stream(userContext('implement a parser')));
    const second = consume(s.stream(userContext('implement a parser')));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    resolveFetch(choiceResponse(fetch.mock.calls[0]?.[1], 'high'));

    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(s.delegate).toHaveBeenCalledTimes(2);
    expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
      'gpt-6-astra',
      'gpt-6-astra',
    ]);
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      reasonCode: 'jev',
      advisor: 'jev',
    });
  });

  it('cancels one waiter without cancelling a shared Jev request or generating for it', async () => {
    const s = astraSetup();
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const first = consume(s.stream(userContext(), controller.signal));
    const second = consume(s.stream(userContext()));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    expect((await first).result.stopReason).toBe('aborted');
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(s.delegate).not.toHaveBeenCalled();
    resolveFetch(choiceResponse(fetch.mock.calls[0]?.[1], 'high'));
    await second;
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      reuse: 'shared',
      jev: { outcome: 'selected' },
    });
  });

  it('aborts the transport when the final Jev waiter cancels', async () => {
    const s = astraSetup();
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise(() => undefined),
    );
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = consume(s.stream(userContext(), controller.signal));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    expect((await pending).result.stopReason).toBe('aborted');
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(s.delegate).not.toHaveBeenCalled();
  });

  it('reports the same original deadline for a late-joining waiter', async () => {
    vi.useFakeTimers();
    try {
      const s = astraSetup();
      const fetch = vi.fn<typeof globalThis.fetch>(
        () => new Promise(() => undefined),
      );
      vi.stubGlobal('fetch', fetch);
      required(s.state.currentConfig.jev).timeoutMs = 5000;
      const first = consume(s.stream(userContext()));
      await vi.advanceTimersByTimeAsync(3000);
      const second = consume(s.stream(userContext()));
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.all([first, second]);
      expect(fetch).toHaveBeenCalledOnce();
      expect(s.delegate).toHaveBeenCalledTimes(2);
      expect(s.state.lastDecision).toMatchObject({
        advisor: 'jev-fallback',
        errorClass: 'deadline',
        jev: { outcome: 'deadline', timeoutMs: 5000 },
      });
      await consume(s.stream(userContext()));
      expect(fetch).toHaveBeenCalledOnce();
      expect(s.state.lastDecision).toMatchObject({
        reuse: 'same-turn',
        jev: { outcome: 'deadline' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['test', 'google'])(
    'reuses a validated %s tool route on ordinary Pi hosts without an auth identity API',
    async (provider) => {
      const s = setup();
      enableAdvisors(s);
      const fetch = mockChoice();
      required(s.models[0]).provider = provider;
      required(s.state.currentConfig.profiles.balanced).medium = {
        model: `${provider}/primary`,
      };
      const assistant = toolMessage(provider);
      s.delegate.mockReturnValueOnce(finishTool(assistant));
      await consume(s.stream(userContext()));
      await consume(s.stream(toolContext(userContext(), assistant)));
      expect(fetch).toHaveBeenCalledOnce();
      expect(s.delegate).toHaveBeenCalledTimes(2);
      expect(s.state.lastDecision?.reasonCode).toBe('continuation');
      expect(advisorOf(s.state.lastDecision)).toBe('jev');
      expect(s.delegate.mock.calls[1]?.[0].provider).toBe(provider);
    },
  );

  it.each(['jev', 'classifier'] as const)(
    'clears stale %s diagnostics on a reused continuation',
    async (source) => {
      const s = setup();
      enableAdvisors(s);
      if (source === 'jev') {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValue(new Response(null, { status: 503 }));
        vi.stubGlobal('fetch', fetch);
      } else {
        s.state.currentConfig.jev = undefined;
        s.delegate.mockReturnValueOnce(
          done('Tier: medium\nReasoning: semantic selection'),
        );
      }
      s.delegate.mockReturnValueOnce(finishTool());
      await consume(s.stream(userContext()));
      expect(s.state.lastDecision?.routingLatencyMs).toBeGreaterThanOrEqual(0);
      if (source === 'jev')
        expect(s.state.lastDecision?.errorClass).toBe('advisor-unavailable');
      else expect(s.state.lastDecision?.isClassifier).toBe(true);
      await consume(s.stream(toolContext()));
      expect(s.state.lastDecision?.reasonCode).toBe('continuation');
      expect(s.state.lastDecision?.isClassifier).toBeUndefined();
      expect(s.state.lastDecision?.routingLatencyMs).toBeUndefined();
      expect(s.state.lastDecision?.errorClass).toBeUndefined();
      expect(advisorOf(s.state.lastDecision)).toBe(
        source === 'jev' ? 'jev-fallback' : 'classifier',
      );
    },
  );

  it('bounds continuation history to the last 16 completed turns', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice('low');
    for (let timestamp = 1; timestamp <= 17; timestamp++) {
      s.delegate.mockReturnValueOnce(finishTool(toolMessage('test', 'small')));
      await consume(s.stream(userContext('same task', timestamp)));
    }
    await consume(
      s.stream(
        toolContext(userContext('same task', 2), toolMessage('test', 'small')),
      ),
    );
    expect(s.state.lastDecision).toMatchObject({
      tier: 'low',
      reasonCode: 'continuation',
    });
    expect(advisorOf(s.state.lastDecision)).toBe('jev');
    await consume(
      s.stream(
        toolContext(userContext('same task', 1), toolMessage('test', 'small')),
      ),
    );
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      reasonCode: 'baseline',
    });
    expect(advisorOf(s.state.lastDecision)).toBe('bypassed');
    expect(fetch).toHaveBeenCalledTimes(17);
  });

  it.each([
    'tool-id',
    'user-identity',
    'profile',
    'provider',
    'branch',
    'branch-rewind',
    'pin',
    'thinking',
    'config-reload',
    'stale-target',
    'unsupported-target',
  ] as const)(
    'invalidates continuation on %s without calling advisors',
    async (kind) => {
      const s = setup();
      enableAdvisors(s);
      const fetch = mockChoice();
      s.delegate.mockReturnValueOnce(finishTool());
      await consume(s.stream(userContext()));
      let context = toolContext();
      if (kind === 'tool-id') {
        const last = context.messages.at(-1);
        if (last?.role === 'toolResult') last.toolCallId = 'foreign';
      }
      if (kind === 'user-identity')
        context = toolContext(userContext('implement a parser', 99));
      if (kind === 'profile') required(s.state.lastDecision).profile = 'other';
      if (kind === 'provider') {
        required(s.state.currentConfig.profiles.balanced).medium = {
          model: 'work/primary',
        };
        s.models.push(model('primary', { provider: 'work' }));
      }
      if (kind === 'branch')
        required(s.state.lastExtensionContext).sessionManager.getBranch = () =>
          [{ id: 'other-branch' }] as ReturnType<
            ExtensionContext['sessionManager']['getBranch']
          >;
      if (kind === 'branch-rewind')
        required(s.state.lastExtensionContext).sessionManager.getBranch =
          () => [];
      if (kind === 'pin') s.state.pinnedTierByProfile.balanced = 'high';
      if (kind === 'thinking')
        s.state.thinkingByProfile.balanced = { medium: 'high' };
      if (kind === 'config-reload')
        s.state.currentConfig = { ...s.state.currentConfig };
      if (kind === 'stale-target') s.models.shift();
      if (kind === 'unsupported-target')
        required(s.models[0]).thinkingLevelMap = { medium: null };
      await consume(s.stream(context));
      expect(fetch).toHaveBeenCalledOnce();
      expect(s.state.lastDecision?.reasonCode).not.toBe('continuation');
      expect(
        s.delegate.mock.calls.every(([target]) => target.id !== 'small'),
      ).toBe(true);
    },
  );

  it('explicit new user instructions win over a tool continuation', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice('high');
    s.delegate.mockReturnValueOnce(finishTool());
    await consume(s.stream(userContext()));
    const context = toolContext();
    context.messages.push({
      role: 'user',
      content: 'design authentication',
      timestamp: 4,
    });
    await consume(s.stream(context));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      reasonCode: 'jev',
    });
  });

  it('keeps the actual Google fallback stable across tool results', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice();
    required(s.models[0]).provider = 'google';
    required(s.models[1]).provider = 'google';
    required(s.state.currentConfig.profiles.balanced).medium = {
      model: 'google/primary',
      fallbacks: ['google/fallback'],
    };
    const assistant = toolMessage('google', 'fallback');
    s.delegate
      .mockReturnValueOnce(failure())
      .mockReturnValueOnce(finishTool(assistant));
    await consume(s.stream(userContext()));
    await consume(s.stream(toolContext(userContext(), assistant)));
    expect(fetch).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
      'primary',
      'fallback',
      'fallback',
    ]);
    expect(s.state.lastDecision).toMatchObject({
      reasonCode: 'continuation',
      targetLabel: 'google/fallback',
    });
  });

  it('offers only image-capable primary pairs to Jev', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice('high');
    required(s.models[2]).input = ['text'];
    const context: Context = {
      messages: [
        {
          role: 'user',
          timestamp: 1,
          content: [
            { type: 'text', text: 'what is shown?' },
            { type: 'image', data: 'abc', mimeType: 'image/png' },
          ],
        },
      ],
    };
    await consume(s.stream(context));
    const body = JSON.parse(
      String(fetch.mock.calls[0]?.[1]?.body),
    ) as ChoiceRequest;
    expect(Object.keys(body.questions.route.criteria).join(' ')).not.toContain(
      'low|',
    );
    expect(s.state.lastDecision?.tier).toBe('high');
    expect(s.delegate).toHaveBeenCalledOnce();
  });

  it('prefers a valid lower route after the budget removes an unavailable medium', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice();
    s.state.currentConfig.maxSessionBudget = 1;
    s.state.accumulatedCost = 2;
    required(s.state.currentConfig.profiles.balanced).medium = {
      model: 'test/missing',
    };
    await consume(s.stream(userContext('think hard about this question')));
    expect(s.state.lastDecision).toMatchObject({
      tier: 'low',
      reasonCode: 'budget',
      isBudgetForced: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves a signed Google target after crossing the soft budget (unavailable=%s)',
    async (unavailable) => {
      const s = setup();
      s.state.pinnedTierByProfile = {};
      s.state.currentConfig = normalizeConfig({
        maxSessionBudget: 0.005,
        profiles: {
          balanced: {
            high: { model: 'google/primary' },
            medium: { model: 'test/fallback' },
          },
        },
      }).config;
      required(s.models[0]).provider = 'google';
      const first = userContext('implement a parser');
      const assistant = toolMessage('google');
      // The explicit pin remains authoritative after crossing the soft budget.
      s.state.pinnedTierByProfile.balanced = 'high';
      s.delegate.mockReturnValueOnce(finishTool(assistant));
      await consume(s.stream(first));
      expect(s.state.accumulatedCost).toBeGreaterThan(0.005);
      if (unavailable) s.models.shift();
      const { result } = await consume(s.stream(toolContext(first, assistant)));
      if (unavailable) {
        expect(result.stopReason).toBe('error');
        expect(s.delegate).toHaveBeenCalledOnce();
      } else {
        expect(result.stopReason).toBe('stop');
        expect(s.delegate).toHaveBeenCalledTimes(2);
        expect(s.delegate.mock.calls[1]?.[0]).toMatchObject({
          provider: 'google',
          id: 'primary',
        });
        expect(s.state.lastDecision?.reasonCode).toBe('pinned');
      }
    },
  );

  it.each([
    ['google', 'google-generative-ai'],
    ['google-vertex', 'google-vertex'],
    ['google-work', 'google-generative-ai'],
    ['google-gemini-cli', 'google-gemini-cli'],
  ] as const)(
    'preserves signed continuations for %s using %s and forbids cross-model fallbacks',
    async (provider, api) => {
      for (const signature of ['toolCall', 'text', 'thinking'] as const) {
        const s = setup();
        s.state.pinnedTierByProfile = {};
        s.state.currentConfig = normalizeConfig({
          profiles: {
            balanced: {
              high: { model: `${provider}/primary`, fallbacks: ['test/small'] },
              medium: { model: 'test/fallback' },
            },
          },
        }).config;
        Object.assign(required(s.models[0]), { provider, api });
        const assistant = toolMessage(provider);
        assistant.api = api;
        assistant.content = [
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} },
        ];
        if (signature === 'toolCall') {
          assistant.content = [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'read',
              arguments: {},
              thoughtSignature: 'opaque-signature',
            },
          ];
        } else {
          assistant.content.unshift(
            signature === 'text'
              ? {
                  type: 'text',
                  text: 'Reading',
                  textSignature: 'opaque-signature',
                }
              : {
                  type: 'thinking',
                  thinking: 'Reading',
                  thinkingSignature: 'opaque-signature',
                },
          );
        }
        const context = toolContext(userContext(), assistant);
        await consume(s.stream(context));
        expect(s.delegate.mock.calls[0]?.[0]).toMatchObject({
          provider,
          api,
          id: 'primary',
        });
        s.delegate.mockReturnValueOnce(failure());
        const { result } = await consume(s.stream(context));
        expect(result.stopReason).toBe('error');
        expect(s.delegate).toHaveBeenCalledTimes(2);
      }
    },
  );

  it('fails plainly rather than replaying Google signatures on a different target', async () => {
    const s = setup();
    enableAdvisors(s);
    const fetch = mockChoice();
    const { result } = await consume(
      s.stream(toolContext(userContext(), toolMessage('google', 'foreign'))),
    );
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('compatible route');
    expect(fetch).not.toHaveBeenCalled();
    expect(s.delegate).not.toHaveBeenCalled();
  });

  it('filters unsupported efforts and vision before Jev and never offers fallback-chain entries', async () => {
    const s = setup();
    enableAdvisors(s);
    required(required(s.state.currentConfig.profiles.balanced).high).thinking =
      'high';
    required(s.models[0]).thinkingLevelMap = { medium: null };
    const fetch = mockChoice('high');
    await consume(s.stream(userContext()));
    const body = JSON.parse(
      String(fetch.mock.calls[0]?.[1]?.body),
    ) as ChoiceRequest;
    const ids = Object.keys(body.questions.route.criteria);
    expect(ids).toHaveLength(3); // high, low plus uncertain; fallbacks remain local
    expect(ids.join(' ')).not.toContain('fallback');
    expect(ids.join(' ')).not.toContain('medium|');
    expect(s.state.lastDecision?.tier).toBe('high');
  });

  it('revalidates Jev choice after registry capabilities change', async () => {
    const s = setup();
    enableAdvisors(s);
    required(required(s.state.currentConfig.profiles.balanced).high).thinking =
      'high';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (_url, init) => {
        required(s.models[0]).thinkingLevelMap = { high: null };
        return choiceResponse(init, 'high');
      }),
    );
    await consume(s.stream(userContext()));
    expect(s.state.lastDecision?.reasonCode).not.toBe('jev');
    expect(s.state.lastDecision?.tier).toBe('medium');
    expect(s.state.lastDecision?.jev).toMatchObject({
      choice: 'high',
      outcome: 'unavailable',
    });
    expect(s.delegate).toHaveBeenCalledOnce();
  });

  it.each([
    [1500, 900],
    [3000, 2000],
    [5000, 4000],
  ])(
    'accepts Jev within a %i ms budget after %i ms',
    async (timeoutMs, delayMs) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      try {
        const s = setup();
        enableAdvisors(s);
        required(s.state.currentConfig.jev).timeoutMs = timeoutMs;
        const transport = vi.fn<typeof fetch>(
          (_url, init) =>
            new Promise((resolve) => {
              setTimeout(() => resolve(choiceResponse(init, 'high')), delayMs);
            }),
        );
        vi.stubGlobal('fetch', transport);
        const pending = consume(s.stream(userContext()));
        await vi.advanceTimersByTimeAsync(delayMs - 1);
        expect(s.delegate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).result.stopReason).toBe('stop');
        expect(transport).toHaveBeenCalledOnce();
        expect(s.delegate).toHaveBeenCalledOnce();
        expect(s.state.lastDecision).toMatchObject({
          tier: 'high',
          reasonCode: 'jev',
          advisor: 'jev',
          routingLatencyMs: delayMs,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([500, 750, 1500, 3000, 5000])(
    'bounds Jev to its configured %i ms budget and falls directly to baseline',
    async (timeoutMs) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      try {
        const s = setup();
        enableAdvisors(s);
        required(s.state.currentConfig.jev).timeoutMs = timeoutMs;
        const transport = vi.fn<typeof fetch>(() => new Promise(() => {}));
        vi.stubGlobal('fetch', transport);
        const pending = consume(s.stream(userContext()));
        await vi.advanceTimersByTimeAsync(0);
        const cap = timeoutMs;
        await vi.advanceTimersByTimeAsync(cap - 1);
        expect(s.delegate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).result.stopReason).toBe('stop');
        expect(transport).toHaveBeenCalledOnce();
        expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        expect(s.delegate).toHaveBeenCalledOnce();
        expect(s.state.lastDecision).toMatchObject({
          tier: 'medium',
          reasonCode: 'baseline',
          errorClass: 'deadline',
          routingLatencyMs: cap,
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('retains the independent 10-second classifier-only bound', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      });
      const s = setup();
      delete s.state.pinnedTierByProfile.balanced;
      s.state.currentConfig.classifierModel = { model: 'test/small' };
      let classifierSignal: AbortSignal | undefined;
      s.delegate.mockImplementationOnce((_model, _context, options) => {
        classifierSignal = options?.signal;
        return {
          [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
        } as AssistantMessageEventStream;
      });
      const pending = consume(s.stream(userContext()));
      await vi.advanceTimersByTimeAsync(9999);
      expect(s.delegate).toHaveBeenCalledOnce();
      expect(classifierSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).result.stopReason).toBe('stop');
      expect(classifierSignal?.aborted).toBe(true);
      expect(s.delegate).toHaveBeenCalledTimes(2);
      expect(s.state.lastDecision).toMatchObject({
        tier: 'medium',
        reasonCode: 'baseline',
        errorClass: 'deadline',
        routingLatencyMs: 10000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the request rather than starting local generation after advisor abort', async () => {
    const s = setup();
    enableAdvisors(s);
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        controller.abort();
        throw new Error('private-test-key');
      }),
    );
    const { result } = await consume(
      s.stream(userContext(), controller.signal),
    );
    expect(result.stopReason).toBe('aborted');
    expect(s.delegate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private-test-key');
  });

  it('preserves explicitly configured cross-provider fallbacks but never discovers another account', async () => {
    const s = setup();
    required(s.models[0]).provider = 'openai';
    required(s.models[1]).provider = 'anthropic';
    s.models.push(model('available', { provider: 'personal' }));
    required(s.state.currentConfig.profiles.balanced).medium = {
      model: 'openai/primary',
      fallbacks: ['anthropic/fallback'],
    };
    s.delegate.mockReturnValueOnce(failure());
    await consume(s.stream());
    expect(s.delegate.mock.calls.map(([target]) => target.provider)).toEqual([
      'openai',
      'anthropic',
    ]);
    expect(s.state.lastDecision).toMatchObject({
      targetProvider: 'anthropic',
      reasonCode: 'fallback',
    });
    s.delegate.mockClear();
    s.delegate.mockImplementation(() => failure());
    await consume(s.stream());
    expect(s.delegate.mock.calls.map(([target]) => target.provider)).toEqual([
      'openai',
      'anthropic',
    ]);
  });

  it('validates fallback effort against its own live model, never clamps the request', async () => {
    const s = setup();
    required(s.models[1]).thinkingLevelMap = { medium: null };
    s.delegate.mockReturnValueOnce(failure());
    const { result } = await consume(s.stream());
    expect(result.stopReason).toBe('error');
    expect(s.delegate).toHaveBeenCalledOnce();
    expect(s.delegate.mock.calls[0]?.[2]?.reasoning).toBe('medium');
  });
});
