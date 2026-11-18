import { normalizeContext } from '@earendil-works/pi-ai';
import {
  type ExtensionContext,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from './config';
import { consume, events, message, model, required } from './test/fixtures';
import {
  type ClassifierResponse,
  type Classify,
  classifierResponse,
  enableAdvisors,
  setup,
  userContext,
} from './test/provider-harness';

describe('Pi classifier provider integration', () => {
  it.each([
    [
      'explicit notification',
      'fixture-status',
      { router: { intent: 'notification' } },
      1,
    ],
    ['completion notification', 'subagent-notify', undefined, 1],
    [
      'incremental child notification',
      'subagent-incremental-child-notify',
      undefined,
      1,
    ],
    [
      'incremental child steering',
      'subagent-incremental-child-notify',
      { router: { intent: 'steering' } },
      2,
    ],
    [
      'explicit steering',
      'subagent-notify',
      { router: { intent: 'steering' } },
      2,
    ],
    ['untyped intercom', 'intercom_message', undefined, 2],
    ['configured intercom', 'intercom_message', undefined, 1],
    ['invalid intent', 'fixture-status', { router: { intent: 'other' } }, 2],
    [
      'background progress',
      'fixture-status',
      { router: { intent: 'notification' }, private: 'PRIVATE_METADATA' },
      2,
      1,
    ],
  ])(
    'preserves notification routing but reconsiders %s',
    async (_name, customType, details, calls, reviewEveryRequests = 4) => {
      const s = setup();
      enableAdvisors(s, 'high');
      if (_name === 'configured intercom')
        required(s.state.currentConfig.profiles.balanced).notificationTypes = [
          'intercom_message',
        ];
      required(s.state.currentConfig.advisor).reviewEveryRequests =
        reviewEveryRequests;
      const manager = SessionManager.inMemory();
      s.state.lastExtensionContext = {
        ...required(s.state.lastExtensionContext),
        sessionManager: manager,
      };
      const goal = {
        role: 'user' as const,
        content: 'diagnose the original failure',
        timestamp: 1,
      };
      manager.appendMessage(goal);
      const assistant = message({
        content: [
          {
            type: 'toolCall',
            id: 'notification-tool',
            name: 'read',
            arguments: {},
          },
        ],
        stopReason: 'toolUse',
      });
      s.delegate.mockReturnValueOnce(
        events({ type: 'done', reason: 'toolUse', message: assistant }),
      );
      await consume(s.stream({ messages: [goal] }));
      manager.appendMessage(assistant);
      const result = {
        role: 'toolResult' as const,
        toolCallId: 'notification-tool',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'successful check' }],
        isError: false,
        timestamp: 2,
      };
      manager.appendMessage(result);
      manager.appendCustomMessageEntry(
        customType,
        'worker finished a check',
        true,
        details,
      );
      const native = required(manager.getBranch().at(-1));
      const notification = {
        role: 'user' as const,
        content: 'worker finished a check',
        timestamp: Date.parse(native.timestamp),
      };
      const continued = { messages: [goal, assistant, result, notification] };
      expect((await consume(s.stream(continued))).result.stopReason).toBe(
        'stop',
      );
      expect(s.registry.classify).toHaveBeenCalledTimes(calls);
      expect(s.state.lastDecision?.reasonCode).toBe(
        calls === 1 || reviewEveryRequests === 1
          ? 'continuation'
          : 'classifier',
      );
      expect(s.delegate.mock.calls.at(-1)?.[1].messages).toEqual(
        normalizeContext(continued).messages,
      );
      if (reviewEveryRequests === 1) {
        const payload = JSON.stringify(
          vi.mocked(s.registry.classify).mock.calls[1]?.[1].state,
        );
        expect(payload).toContain('diagnose the original failure');
        expect(payload).toContain('worker finished a check');
        expect(payload).not.toContain('PRIVATE_METADATA');
      }
    },
  );

  it.each(['subagent-notify', 'subagent-incremental-child-notify'])(
    'reuses the accepted route when %s wakes an idle parent',
    async (customType) => {
      const s = setup();
      enableAdvisors(s, 'low');
      const manager = SessionManager.inMemory();
      s.state.lastExtensionContext = {
        ...required(s.state.lastExtensionContext),
        sessionManager: manager,
      };
      const goal = {
        role: 'user' as const,
        content: 'repeat the approved report checks',
        timestamp: 1,
      };
      manager.appendMessage(goal);
      const first = await consume(s.stream({ messages: [goal] }));
      const target = s.state.lastDecision?.targetLabel;
      manager.appendMessage(first.result);
      manager.appendCustomMessageEntry(customType, 'report completed', false);
      const native = required(manager.getBranch().at(-1));
      const context = {
        messages: [
          goal,
          first.result,
          {
            role: 'user' as const,
            content: 'report completed',
            timestamp: Date.parse(native.timestamp),
          },
        ],
      };
      expect((await consume(s.stream(context))).result.stopReason).toBe('stop');
      expect(s.registry.classify).toHaveBeenCalledTimes(1);
      expect(s.state.lastDecision?.targetLabel).toBe(target);
      expect(s.state.lastDecision?.tier).toBe('low');
      expect(s.delegate.mock.calls.at(-1)?.[1].messages).toEqual(
        normalizeContext(context).messages,
      );
    },
  );

  it('does not truncate the active goal or tool chain at a notification boundary', async () => {
    const s = setup();
    required(s.models[0]).contextWindow = 64;
    const manager = SessionManager.inMemory();
    s.state.lastExtensionContext = {
      ...required(s.state.lastExtensionContext),
      sessionManager: manager,
    };
    const goal = {
      role: 'user' as const,
      content: 'fix the original failure',
      timestamp: 1,
    };
    manager.appendMessage(goal);
    const assistant = message({
      content: [
        { type: 'toolCall', id: 'active-tool', name: 'read', arguments: {} },
      ],
      stopReason: 'toolUse',
    });
    s.delegate.mockReturnValueOnce(
      events({ type: 'done', reason: 'toolUse', message: assistant }),
    );
    await consume(s.stream({ messages: [goal] }));
    manager.appendMessage(assistant);
    const result = {
      role: 'toolResult' as const,
      toolCallId: 'active-tool',
      toolName: 'read',
      content: [{ type: 'text' as const, text: 'checked' }],
      isError: false,
      timestamp: 2,
    };
    manager.appendMessage(result);
    const text = 'worker progress '.repeat(100);
    manager.appendCustomMessageEntry('subagent-notify', text, true);
    const native = required(manager.getBranch().at(-1));
    const context = {
      messages: [
        goal,
        assistant,
        result,
        {
          role: 'user' as const,
          content: text,
          timestamp: Date.parse(native.timestamp),
        },
      ],
    };
    expect((await consume(s.stream(context))).result.stopReason).toBe('stop');
    expect(s.delegate.mock.calls.at(-1)?.[1].messages).toEqual(
      normalizeContext(context).messages,
    );
  });

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
    enableAdvisors(s, 'high');
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
    enableAdvisors(s, 'high');
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
    enableAdvisors(s, 'high');
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
    required(
      required(s.state.currentConfig.profiles.balanced).advisor,
    ).confidenceThreshold = 0.55;
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
    required(
      required(s.state.currentConfig.profiles.balanced).advisor,
    ).confidenceThreshold = 0.55;
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
