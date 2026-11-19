import type { Context } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { normalizeConfig } from './config';
import {
  consume,
  done,
  events,
  failure,
  message,
  model,
  required,
} from './test/fixtures';
import { setup } from './test/provider-harness';

describe('activity matrix provider routing', () => {
  const activitySetup = () => {
    const s = setup();
    s.models.push(
      model('code'),
      model('code-backup'),
      model('docs'),
      model('ops'),
    );
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
            ops: {
              medium: { model: 'test/ops', thinking: 'low', fallbacks: [] },
            },
          },
        },
      },
    }).config;
    const answer = {
      tier: 'medium',
      tierConfidence: 0.95,
      tierProbabilities: undefined as Record<string, number> | undefined,
      activity: 'code',
      phase: undefined as string | undefined,
      relation: 'new-task' as string | undefined,
      relationConfidence: 0.95,
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
          ...(context.questions.continuity && answer.relation
            ? {
                continuity: {
                  type: 'choice' as const,
                  choice: answer.relation,
                  confidence: answer.relationConfidence,
                  probabilities: { [answer.relation]: 1 },
                },
              }
            : {}),
          ...(answer.phase
            ? {
                phase: {
                  type: 'choice' as const,
                  choice: answer.phase,
                  confidence: 0.9,
                  probabilities: { [answer.phase]: 1 },
                },
              }
            : {}),
          ...(routeId
            ? {
                route: {
                  type: 'choice' as const,
                  choice: routeId,
                  confidence: answer.tierConfidence,
                  probabilities: answer.tierProbabilities
                    ? Object.fromEntries(
                        Object.keys(routeQuestion?.criteria ?? {}).map((id) => [
                          id,
                          answer.tierProbabilities?.[id.split('|')[0] ?? id] ??
                            0,
                        ]),
                      )
                    : { [routeId]: 1 },
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
    ).toEqual(['continuity', 'route', 'activity', 'phase']);
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

  it.each([
    ['verify', 'ops'],
    ['execute', 'ops'],
    ['produce', 'code'],
    ['report', 'code'],
  ])(
    'routes %s with a durable code goal to the %s cell',
    async (phase, expected) => {
      const s = activitySetup();
      s.answer.phase = phase;
      await consume(s.stream());
      expect(s.delegate.mock.calls.at(-1)?.[0].id).toBe(expected);
      expect(s.state.lastDecision).toMatchObject({
        activity: expected,
        routeCell: expected,
        classification: { activity: 'code', phase },
      });
    },
  );

  it.each(['', 'morethink: '])(
    'retains a confirmed goal after %j across verify, commit and report and replaces it for a new task',
    async (prefix) => {
      const s = activitySetup();
      let ids = ['root', 'one'];
      s.state.lastExtensionContext = {
        sessionManager: {
          getBranch: () => ids.map((id) => ({ id, type: 'message' })),
          getSessionId: () => 'native-session',
        },
        ui: { setHiddenThinkingLabel: vi.fn() },
      } as unknown as ExtensionContext;
      const first = {
        role: 'user' as const,
        content: `${prefix}Implement the feature`,
        timestamp: 1,
      };
      const messages: Context['messages'] = [first];
      await consume(s.stream({ messages: [...messages] }));
      const steps = [
        { text: 'Run the specified tests', phase: 'verify', route: 'ops' },
        { text: 'Commit the verified changes', phase: 'execute', route: 'ops' },
        { text: 'Report the result', phase: 'report', route: 'code' },
      ];
      s.answer.relation = 'continuation';
      for (const [index, step] of steps.entries()) {
        ids = [...ids, String(index + 2)];
        messages.push({
          role: 'user',
          content: step.text,
          timestamp: index + 2,
        });
        s.answer.phase = step.phase;
        await consume(s.stream({ messages: [...messages] }));
        expect(s.state.lastDecision?.routeCell).toBe(step.route);
        expect(s.state.lastDecision?.promptControl).toBeUndefined();
        const payload = s.classify.mock.calls.at(-1)?.[1];
        expect(payload?.state.activeGoal).toMatchObject({
          text: `${prefix}Implement the feature`,
        });
        expect(payload?.questions.continuity?.type).toBe('choice');
      }
      ids = [...ids, 'new'];
      messages.push({
        role: 'user',
        content: 'Start a new task: write a manual',
        timestamp: 8,
      });
      s.answer.relation = 'new-task';
      s.answer.activity = 'docs';
      s.answer.phase = 'produce';
      await consume(s.stream({ messages: [...messages] }));
      expect(s.state.lastDecision?.routeCell).toBe('docs');
      ids = [...ids, 'follow'];
      messages.push({ role: 'user', content: 'Continue', timestamp: 9 });
      s.answer.relation = 'continuation';
      await consume(s.stream({ messages: [...messages] }));
      expect(s.classify.mock.calls.at(-1)?.[1].state.activeGoal).toMatchObject({
        text: 'Start a new task: write a manual',
      });
    },
  );

  it('drops an ambiguous cross-turn goal and never reuses it on a later request', async () => {
    const s = activitySetup();
    let ids = ['root', 'one'];
    s.state.lastExtensionContext = {
      sessionManager: {
        getBranch: () => ids.map((id) => ({ id, type: 'message' })),
        getSessionId: () => 'native-session',
      },
      ui: { setHiddenThinkingLabel: vi.fn() },
    } as unknown as ExtensionContext;
    const messages: Context['messages'] = [
      { role: 'user', content: 'Implement a feature', timestamp: 1 },
    ];
    await consume(s.stream({ messages: [...messages] }));
    ids = [...ids, 'two'];
    messages.push({ role: 'user', content: 'Do it', timestamp: 2 });
    s.answer.relation = undefined;
    s.answer.phase = 'verify';
    await consume(s.stream({ messages: [...messages] }));
    expect(s.state.lastDecision?.advisor).toBe('classifier-fallback');
    ids = [...ids, 'three'];
    messages.push({
      role: 'user',
      content: 'Start writing a manual',
      timestamp: 3,
    });
    s.answer.activity = 'docs';
    s.answer.phase = 'produce';
    await consume(s.stream({ messages: [...messages] }));
    expect(s.classify.mock.calls.at(-1)?.[1].state.activeGoal).toBeUndefined();
    expect(s.state.lastDecision?.routeCell).toBe('docs');
  });

  it.each([
    ['continuation', 0.95],
    ['uncertain', 0.95],
    [undefined, 0.95],
    ['new-task', 0.1],
  ] as const)(
    'does not seed an unanchored approval for relation %s at %s',
    async (relation, confidence) => {
      const s = activitySetup();
      let ids = ['root', 'one'];
      s.state.lastExtensionContext = {
        sessionManager: {
          getBranch: () => ids.map((id) => ({ id, type: 'message' })),
          getSessionId: () => 'native-session',
        },
        ui: { setHiddenThinkingLabel: vi.fn() },
      } as unknown as ExtensionContext;
      s.answer.relation = relation;
      s.answer.relationConfidence = confidence;
      const messages: Context['messages'] = [
        { role: 'user', content: 'Yes, proceed', timestamp: 1 },
      ];
      await consume(s.stream({ messages: [...messages] }));
      expect(s.state.lastDecision?.activity).toBe('code');
      expect(s.classify.mock.calls[0]?.[1].state.activeGoal).toBeUndefined();
      expect(s.classify.mock.calls[0]?.[1].questions.continuity?.type).toBe(
        'choice',
      );
      ids = [...ids, 'two'];
      messages.push({ role: 'user', content: 'Continue', timestamp: 2 });
      await consume(s.stream({ messages: [...messages] }));
      expect(
        s.classify.mock.calls.at(-1)?.[1].state.activeGoal,
      ).toBeUndefined();
    },
  );

  it('does not turn a missing referenced brief into an ops goal', async () => {
    const s = activitySetup();
    s.answer.activity = 'uncertain';
    s.answer.phase = 'verify';
    await consume(
      s.stream({
        messages: [
          {
            role: 'user',
            content: 'Implement the task in the unavailable brief',
            timestamp: 1,
          },
        ],
      }),
    );
    expect(s.state.lastDecision).toMatchObject({
      routeCell: undefined,
      targetModelId: 'primary',
      classification: { activity: 'uncertain', phase: 'verify' },
    });
    expect(s.state.lastDecision?.activity).toBeUndefined();
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

  it('does not use a review verification phase after new implementation text arrives', async () => {
    const s = activitySetup();
    required(s.state.currentConfig.advisor).reviewEveryRequests = 1;
    s.delegate.mockImplementation((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          model: target.id,
          stopReason: 'toolUse',
          content: [
            { type: 'text', text: 'More implementation edits are needed.' },
            { type: 'toolCall', name: 'read', id: 'step', arguments: {} },
          ],
        }),
      }),
    );
    const messages: Context['messages'] = [
      { role: 'user', content: 'Implement the feature', timestamp: 1 },
    ];
    const append = (
      assistant: Awaited<ReturnType<typeof consume>>['result'],
    ) => {
      messages.push(assistant, {
        role: 'toolResult',
        toolCallId: 'step',
        toolName: 'read',
        content: [{ type: 'text', text: 'New implementation evidence' }],
        isError: false,
        timestamp: messages.length + 1,
      });
    };
    append((await consume(s.stream({ messages: [...messages] }))).result);
    s.answer.phase = 'verify';
    append((await consume(s.stream({ messages: [...messages] }))).result);
    await vi.waitFor(() =>
      expect(
        s.actions.recordDebugDecision.mock.calls.some(
          ([decision]) =>
            decision.reviewOnly && decision.classification?.phase === 'verify',
        ),
      ).toBe(true),
    );
    await consume(s.stream({ messages: [...messages] }));
    expect(s.state.lastDecision).toMatchObject({
      routeCell: 'code',
      activity: 'code',
      classification: { activity: 'code', phaseOutcome: 'uncertain' },
    });
    expect(s.state.lastDecision?.classification?.phase).toBeUndefined();
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
    const reviewGate = Promise.withResolvers<void>();
    s.classify.mockImplementationOnce(async (...args) => {
      const result = immediate(...args);
      await reviewGate.promise;
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
    reviewGate.resolve();
    await s.waitForReviews(1);
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
    await s.waitForReviews(1);
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
    const reviewGate = Promise.withResolvers<void>();
    s.classify.mockImplementationOnce(async (...args) => {
      const result = immediate(...args);
      await reviewGate.promise;
      return result;
    });
    await advance();
    await advance();
    await advance();
    expect(s.classify).toHaveBeenCalledTimes(2);
    expect((await advance()).model).toBe('code');
    expect((await advance()).model).toBe('code');
    reviewGate.resolve();
    await s.waitForReviews(1);
    expect((await advance()).model).toBe('code');
    await advance();
    await s.waitForReviews(2);
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

  it('does not upgrade above the classifier top choice on uncertain initial advice', async () => {
    const s = activitySetup();
    s.answer.tierConfidence = 0.4;
    s.answer.tierProbabilities = {
      low: 0.1,
      medium: 0.46,
      high: 0.41,
      uncertain: 0.03,
    };

    await consume(s.stream());

    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      targetModelId: 'code',
      classification: { choice: 'medium' },
    });
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
    s.answer.tierConfidence = 0.4;
    s.answer.tierProbabilities = {
      low: 0.1,
      medium: 0.46,
      high: 0.41,
      uncertain: 0.03,
    };
    await advance();
    await s.waitForReviews(1);
    await advance();
    expect(s.state.lastDecision).toMatchObject({
      tier: 'medium',
      adviceSource: 'review',
      classification: { choice: 'medium', selectedTier: 'high' },
    });

    s.answer.tier = 'high';
    s.answer.tierConfidence = 0.95;
    s.answer.tierProbabilities = undefined;
    await advance();
    await s.waitForReviews(2);
    const up = await advance();
    expect(up.model).toBe('primary');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'high',
      targetModelId: 'primary',
    });
    s.answer.tier = 'medium';
    s.answer.tierConfidence = 0.4;
    s.answer.tierProbabilities = {
      low: 0.08,
      medium: 0.47,
      high: 0.2,
      uncertain: 0.25,
    };
    await advance();
    await s.waitForReviews(3);
    await advance();
    expect(s.state.lastDecision?.tier).toBe('high');

    s.answer.tier = 'low';
    s.answer.tierProbabilities = {
      low: 0.62,
      medium: 0.08,
      high: 0.25,
      uncertain: 0.05,
    };
    await advance();
    await s.waitForReviews(4);
    const down = await advance();
    expect(down.model).toBe('small');
    expect(s.state.lastDecision).toMatchObject({
      tier: 'low',
      targetModelId: 'small',
    });
    expect(s.classify).toHaveBeenCalledTimes(5);
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
    ).toEqual(['continuity', 'activity', 'phase']);
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
