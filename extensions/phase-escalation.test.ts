import type { Context } from '@earendil-works/pi-ai';
import { expect, it, vi } from 'vitest';
import { events, message, model, required } from './test/fixtures';
import { terraHarness } from './test/terra-harness';

const scenario = (
  phase: 'reason' | 'produce',
  high: 'explicit' | 'inherited' | 'reset' = 'explicit',
) => {
  const engineering = phase === 'reason' ? 'debug' : 'code';
  const f = terraHarness(
    {
      advisor: {
        enabled: true,
        model: 'fixture/choice',
        reviewEveryRequests: 0,
      },
      profiles: {
        p: {
          activityPreset: 'off',
          advisor: { models: ['fixture/choice'] },
          medium: { model: 'work/glm-flash', thinking: 'high' },
          high: { model: 'work/gpt-6.1-sol', thinking: 'high' },
          activities: {
            docs: {
              medium: { model: 'work/expensive', thinking: 'high' },
              high: { model: 'work/expensive', thinking: 'high' },
            },
            ops: {
              medium: { model: 'work/deepseek', thinking: 'high' },
              high: { model: 'work/gpt-6.1-terra', thinking: 'medium' },
            },
            ...(high === 'inherited'
              ? {}
              : {
                  [engineering]: {
                    high:
                      high === 'reset'
                        ? null
                        : { model: 'work/gpt-6.1-sol', thinking: 'high' },
                  },
                }),
          },
        },
      },
    },
    (provider, id) =>
      model(id, {
        provider,
        contextWindow: 128000,
        thinkingLevelMap: { xhigh: 'xhigh' },
        cost: {
          input: id === 'expensive' ? 100 : 0.1,
          output: id === 'expensive' ? 100 : 0.1,
          cacheRead: id === 'expensive' ? 10 : 0.01,
          cacheWrite: id === 'expensive' ? 125 : 0.125,
        },
      }),
  );
  Object.assign(required(f.state.lastExtensionContext).sessionManager, {
    getSessionId: () => 'native-phase-escalation',
  });
  let call = 0;
  const context: Context = {
    messages: [
      { role: 'user', content: 'Controlled adaptive ops task.', timestamp: 1 },
    ],
  };
  const advance = async (tool: string, isError: boolean) => {
    const id = `call-${++call}`;
    f.delegate.mockImplementationOnce((target) =>
      events({
        type: 'done',
        reason: 'toolUse',
        message: message({
          provider: target.provider,
          model: target.id,
          api: target.api,
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id, name: tool, arguments: {} }],
        }),
      }),
    );
    const result = await f.run('balanced', 'medium', 'ops', context, phase);
    expect(result.stopReason).toBe('toolUse');
    context.messages.push(result, {
      role: 'toolResult',
      toolCallId: id,
      toolName: tool,
      isError,
      content: [
        {
          type: 'text',
          text: isError ? 'FAIL assertion expected A got B' : 'Applied',
        },
      ],
      timestamp: call + 1,
    });
    return required(f.state.lastDecision);
  };
  return { ...f, engineering, advance, context };
};

it.each(['reason', 'produce'] as const)(
  'preserves accepted ops %s engineering intent through native continuation escalation',
  async (phase) => {
    const f = scenario(phase);
    const first = await f.advance('bash', true);
    expect(first).toMatchObject({
      tier: 'medium',
      routeCell: 'ops',
      targetModelId: 'deepseek',
    });
    const edited = await f.advance('edit', false);
    expect(edited).toMatchObject({
      reuse: 'continuation',
      tier: 'medium',
      targetModelId: 'deepseek',
    });
    const repeated = await f.advance('bash', true);
    expect(repeated).toMatchObject({
      reuse: 'continuation',
      tier: 'medium',
      targetModelId: 'deepseek',
    });
    const escalated = await f.advance('read', false);
    expect(escalated).toMatchObject({
      tier: 'high',
      routeCell: f.engineering,
      activity: f.engineering,
      targetModelId: 'gpt-6.1-sol',
      thinking: 'high',
      reasonCode: 'escalation',
    });
    expect(f.classify).toHaveBeenCalledOnce();
    expect(await f.advance('read', false)).toMatchObject({
      tier: 'high',
      routeCell: f.engineering,
      targetModelId: 'gpt-6.1-sol',
      reuse: 'continuation',
    });
  },
);

it.each(['reason', 'produce'] as const)(
  'refused review diagnostics cannot replace accepted ops %s escalation intent',
  async (phase) => {
    const f = scenario(phase);
    const advisor = required(f.state.currentConfig.advisor);
    advisor.reviewEveryRequests = 1;
    f.state.currentConfig.switchPolicy = {
      horizonRequests: 1,
      costSensitivity: 1,
      strongAdviceConfidence: 0.99,
      escalationHoldTurns: 2,
    };
    await f.advance('bash', true);
    const classify = required(f.classify.getMockImplementation());
    f.classify.mockImplementationOnce(async (...args) => {
      const result = await classify(...args);
      return {
        ...result,
        answers: {
          ...result.answers,
          activity: {
            type: 'choice',
            choice: 'docs',
            confidence: 0.8,
            probabilities: { docs: 1 },
          },
          phase: {
            type: 'choice',
            choice: 'reason',
            confidence: 1,
            probabilities: { reason: 1 },
          },
        },
      };
    });
    await f.advance('edit', false);
    await vi.waitFor(() =>
      expect(f.recordDebugDecision.mock.calls.some(([d]) => d.reviewOnly)).toBe(
        true,
      ),
    );
    const refused = await f.advance('bash', true);
    expect(refused).toMatchObject({
      targetModelId: 'deepseek',
      activityPreference: f.engineering,
      classification: { activity: 'docs' },
      switchCost: { reason: 'cost-held' },
      proposedRoute: { activity: 'docs' },
    });
    expect(await f.advance('read', false)).toMatchObject({
      targetModelId: 'gpt-6.1-sol',
      routeCell: f.engineering,
      activityPreference: f.engineering,
      reasonCode: 'escalation',
    });
  },
);

it.each(['budget', 'pin', 'config', 'context', 'owner', 'branch'] as const)(
  'protected engineering preference respects %s continuation fences',
  async (fence) => {
    const f = scenario('reason');
    f.state.currentConfig.maxSessionBudget = 1;
    await f.advance('bash', true);
    await f.advance('edit', false);
    await f.advance('bash', true);
    if (fence === 'budget') f.state.accumulatedCost = 2;
    if (fence === 'pin') f.state.pinnedTierByProfile.p = 'medium';
    if (fence === 'config')
      f.state.currentConfig = { ...f.state.currentConfig };
    if (fence === 'owner')
      Object.assign(required(f.state.lastExtensionContext).sessionManager, {
        getSessionId: () => 'new-owner',
      });
    if (fence === 'branch')
      Object.assign(required(f.state.lastExtensionContext).sessionManager, {
        getBranch: () => [{ id: 'new-branch', type: 'message' }],
      });
    if (fence === 'context') {
      const registry = required(f.state.currentModelRegistry);
      const find = registry.find;
      registry.find = (provider, id) => {
        const target = find(provider, id);
        return target && id === 'gpt-6.1-sol'
          ? { ...target, contextWindow: 1 }
          : target;
      };
    }
    const selected = await f.advance('read', false);
    if (fence === 'budget' || fence === 'pin' || fence === 'context')
      expect(selected.tier).toBe('medium');
    if (fence !== 'context')
      expect(selected.activityPreference).toBeUndefined();
    expect(selected.targetModelId).not.toBe('gpt-6.1-sol');
  },
);

it.each(['reason', 'produce'] as const)(
  'ops %s escalation retains unknown inherited high specialization but honors explicit high reset',
  async (phase) => {
    for (const high of ['inherited', 'reset'] as const) {
      const f = scenario(phase, high);
      await f.advance('bash', true);
      await f.advance('write', false);
      await f.advance('bash', true);
      const escalated = await f.advance('read', false);
      expect(escalated).toMatchObject({
        tier: 'high',
        reasonCode: 'escalation',
        targetModelId: high === 'inherited' ? 'gpt-6.1-terra' : 'gpt-6.1-sol',
        routeCell: high === 'inherited' ? 'ops' : undefined,
      });
    }
  },
);
