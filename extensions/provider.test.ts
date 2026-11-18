import {
  type AssistantMessageEventStream,
  type Context,
  normalizeContext,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from './config';
import { registerRouterProvider } from './provider';
import { waitForRegistry } from './provider-runtime';
import {
  consume,
  events,
  failure,
  message,
  model,
  required,
} from './test/fixtures';
import {
  advisorOf,
  type ClassifierResponse,
  type Classify,
  classifierModel,
  classifierResponse,
  enableAdvisors,
  setup,
  userContext,
} from './test/provider-harness';
import type { RouterRequestObservation } from './types';

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
    expect(s.actions.recordDebugDecision).toHaveBeenCalledOnce();
    expect(
      s.actions.recordDebugDecision.mock.calls[0]?.[0].isGenerationFailed,
    ).toBeUndefined();
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

  it('does not report complete cost coverage after an unpriced zero-cost failed attempt', async () => {
    const s = setup();
    s.delegate.mockReturnValueOnce(
      events({
        type: 'error',
        reason: 'error',
        error: message({
          stopReason: 'error',
          usage: {
            input: 1,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        }),
      }),
    );
    await consume(s.stream());
    expect(s.delegate).toHaveBeenCalledTimes(2);
    expect(s.state.accumulatedCost).toBe(0.01);
    expect(s.state.lastDecision?.generation).toMatchObject({
      attempts: 2,
      reportedCostUsd: undefined,
    });
    expect(s.state.lastDecision?.generation?.costSource).toBeUndefined();
  });

  it('records every failed terminal charge and a sanitized failed decision', async () => {
    const s = setup();
    s.delegate.mockImplementation(() => failure());
    expect((await consume(s.stream())).result.stopReason).toBe('error');
    expect(s.state.accumulatedCost).toBe(0.02);
    expect(s.actions.persistState).toHaveBeenCalledOnce();
    expect(s.actions.recordDebugDecision).toHaveBeenCalledOnce();
    expect(s.actions.recordDebugDecision).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'medium', isGenerationFailed: true }),
    );
    expect(
      JSON.stringify(s.actions.recordDebugDecision.mock.calls),
    ).not.toContain('request failed');
  });

  it.each([
    {
      missingUsage: 'first attempt',
      firstThrows: true,
      outcome: 'stop',
      finalModel: 'fallback',
    },
    {
      missingUsage: 'last attempt',
      firstThrows: false,
      outcome: 'error',
      finalModel: undefined,
    },
  ])(
    'keeps the total unknown when $missingUsage has no usage',
    async ({ firstThrows, outcome, finalModel }) => {
      const s = setup();
      const withoutUsage = () => {
        throw new Error('no terminal usage');
      };
      if (firstThrows) s.delegate.mockImplementationOnce(withoutUsage);
      else
        s.delegate
          .mockReturnValueOnce(failure())
          .mockImplementationOnce(withoutUsage);
      const { result } = await consume(s.stream());
      expect(result.stopReason).toBe(outcome);
      if (finalModel) expect(result.model).toBe(finalModel);
      expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual([
        'primary',
        'fallback',
      ]);
      expect(s.state.accumulatedCost).toBe(0.01);
      expect(s.state.lastDecision?.generation).toMatchObject({
        attempts: 2,
        reportedCostUsd: undefined,
      });
      expect(s.state.lastDecision?.generation?.costSource).toBeUndefined();
    },
  );

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

  it('switches from Luna max to Opus high without delegating the old effort', async () => {
    const s = setup();
    s.models.push(
      model('luna', { thinkingLevelMap: { max: 'max' } }),
      model('opus', { thinkingLevelMap: { max: 'max' } }),
    );
    s.state.currentConfig = normalizeConfig({
      profiles: {
        balanced: {
          effortPolicy: 'table',
          medium: {
            model: 'test/opus',
            thinking: 'high',
            modeRoutes: { cost: { model: 'test/luna', thinking: 'max' } },
          },
        },
      },
    }).config;
    delete s.state.pinnedTierByProfile.balanced;
    registerRouterProvider(s.api, s.state, s.actions);
    const generate = required(s.register.mock.calls.at(-1)?.[1].streamSimple);
    const run = (timestamp: number) =>
      consume(
        generate(
          model('balanced', { provider: 'router' }),
          normalizeContext(userContext('task', timestamp)),
          { reasoning: 'max' },
        ),
      );
    s.state.modeOverride = 'cost';
    expect((await run(1)).result.stopReason).toBe('stop');
    s.state.modeOverride = 'quality';
    expect((await run(2)).result.stopReason).toBe('stop');
    expect(
      s.delegate.mock.calls.map(([target, , options]) => [
        target.id,
        options?.reasoning,
      ]),
    ).toEqual([
      ['luna', 'max'],
      ['opus', 'high'],
    ]);
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

  it.each([false, true])(
    'stops after visible content and a terminal error (fallback: %s)',
    async (fallback) => {
      const s = setup();
      required(s.state.currentConfig.profiles.balanced?.medium).fallbacks = [
        'test/fallback',
        'test/small',
      ];
      if (fallback) s.delegate.mockReturnValueOnce(failure());
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

      expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual(
        fallback ? ['primary', 'fallback'] : ['primary'],
      );
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
    },
  );

  it('returns a terminal error when every stream ends without a terminal event', async () => {
    const s = setup();
    s.delegate.mockImplementation(() => events());
    const { result } = await consume(s.stream());
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('terminal');
  });

  it.each([false, true])(
    'preserves cancellation without another retry (fallback: %s)',
    async (fallback) => {
      const s = setup();
      required(s.state.currentConfig.profiles.balanced?.medium).fallbacks = [
        'test/fallback',
        'test/small',
      ];
      if (fallback) s.delegate.mockReturnValueOnce(failure());
      s.delegate.mockReturnValueOnce(failure('aborted'));
      const observe = vi.fn<(event: RouterRequestObservation) => void>();
      s.actions.beginRequest.mockReturnValue(observe);
      expect((await consume(s.stream())).result.stopReason).toBe('aborted');
      expect(observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ stage: 'cancelled' }),
      );
      expect(s.delegate.mock.calls.map(([target]) => target.id)).toEqual(
        fallback ? ['primary', 'fallback'] : ['primary'],
      );
    },
  );

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
              id: `call-${target.id}-${s.delegate.mock.calls.length}`,
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
    await s.waitForReviews(1);
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
  it('keeps the prior activity and tier when the new baseline shares its model', async () => {
    const s = setup();
    s.state.pinnedTierByProfile = {};
    s.state.currentConfig = normalizeConfig({
      profiles: {
        balanced: {
          activityPreset: 'off',
          baselineTier: 'low',
          low: {
            model: 'test/primary',
            thinking: 'low',
            modeRoutes: {
              quality: { model: 'test/primary', thinking: 'low' },
            },
          },
          high: { model: 'test/fallback', thinking: 'high' },
          activities: {
            code: {
              high: {
                model: 'test/primary',
                thinking: 'high',
                modeRoutes: {
                  quality: { model: 'test/primary', thinking: 'xhigh' },
                },
              },
            },
          },
        },
      },
    }).config;
    required(s.models[0]).thinkingLevelMap = { xhigh: 'xhigh' };
    enableAdvisors(s, 'high');
    s.registry.classify = vi.fn<Classify>(async (target, context) => {
      const response = classifierResponse(target, context, 'high');
      return {
        ...response,
        answers: {
          ...response.answers,
          activity: {
            type: 'choice',
            choice: 'code',
            confidence: 1,
            probabilities: { code: 1 },
          },
        },
      };
    });
    s.delegate.mockImplementationOnce((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            { type: 'toolCall', name: 'read', id: 'continue', arguments: {} },
          ],
        }),
      }),
    );
    const messages: Context['messages'] = [
      { role: 'user', content: 'Work on the change.', timestamp: 20 },
    ];
    const { result } = await consume(s.stream({ messages }));
    expect(s.state.lastDecision).toMatchObject({
      reasonCode: 'classifier',
      routeCell: 'code',
      tier: 'high',
      thinking: 'high',
    });
    messages.push(result, {
      role: 'toolResult',
      toolCallId: 'continue',
      toolName: 'read',
      content: [{ type: 'text', text: 'contents' }],
      isError: false,
      timestamp: 22,
    });
    s.state.modeOverride = 'quality';
    await consume(s.stream({ messages }));
    expect(s.state.lastDecision).toMatchObject({
      reasonCode: 'continuation',
      mode: 'quality',
      routeCell: 'code',
      tier: 'high',
      thinking: 'xhigh',
    });
  });

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

it('includes mode-only capabilities in the logical provider model', () => {
  const s = setup();
  s.models.push(
    model('mode-only', {
      contextWindow: 100_000,
      maxTokens: 50_000,
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    }),
  );
  required(s.models[0]).reasoning = false;
  s.state.currentConfig = normalizeConfig({
    profiles: {
      balanced: {
        activityPreset: 'off',
        medium: {
          model: 'test/primary',
          reasoning: false,
          modeRoutes: {
            quality: { model: 'test/mode-only', thinking: 'high' },
          },
        },
      },
    },
  }).config;
  registerRouterProvider(s.api, s.state, s.actions);
  const definition = s.register.mock.calls.at(-1)?.[1].models?.[0];
  expect(definition).toMatchObject({
    contextWindow: 100_000,
    maxTokens: 50_000,
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
  });
});
