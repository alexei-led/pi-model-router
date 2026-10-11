import {
  type AssistantMessage,
  type ClassifierApi,
  type ClassifierContext,
  type ClassifierModel,
  type ClassifierOptions,
  type ClassifierResult,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { isRouterPersistedState } from '../state';

const phases = [
  { tier: 'low', activity: 'explore' },
  { tier: 'medium', activity: 'code' },
  { tier: 'high', activity: 'debug' },
  { tier: 'medium', activity: 'docs' },
  { tier: 'low', activity: 'explore' },
] as const;

export const adaptiveFixtureConfig = {
  debug: true,
  activityRouting: 'on',
  advisor: {
    enabled: true,
    model: 'adaptive-fixture/choice',
    reviewEveryRequests: 2,
    timeoutMs: 1000,
    confidenceThreshold: 0.65,
    probabilityThreshold: 0.8,
    context: {
      previousTurns: 2,
      currentLoopMessages: 8,
      maxHistoryTokens: 500,
      toolResults: 'last',
      maxToolTokens: 250,
    },
  },
  models: {
    balanced: {
      model: 'adaptive-fixture/balanced',
      effortCacheSharing: 'shared',
    },
  },
  profiles: {
    adaptive: {
      advisor: { models: ['adaptive-fixture/choice'] },
      micro: { model: 'adaptive-fixture/quick', thinking: 'off' },
      low: { model: 'balanced', thinking: 'low' },
      medium: { model: 'balanced', thinking: 'medium' },
      high: { model: 'adaptive-fixture/deep', thinking: 'high' },
      activities: {
        code: { medium: { model: 'balanced', thinking: 'high' } },
        debug: { high: { model: 'adaptive-fixture/deep', thinking: 'xhigh' } },
        docs: { medium: { model: 'adaptive-fixture/docs', thinking: 'low' } },
      },
    },
  },
};

export default (pi: ExtensionAPI) => {
  let requests = 0;
  const physical: { request: number; model: string; effort: string }[] = [];
  const observed: {
    tier: string;
    activity?: string;
    model: string;
    effort: string;
  }[] = [];
  const currentPhase = () =>
    phases[Math.min(phases.length - 1, Math.floor(requests / 4))] ?? phases[0];

  pi.registerTool({
    name: 'adaptive_fixture_step',
    label: 'Adaptive fixture step',
    description:
      'Deterministic read-only local fixture. No network or filesystem writes.',
    parameters: Type.Object({}),
    execute: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      return {
        content: [
          {
            type: 'text',
            text: `Local fixture evidence: ${currentPhase().activity}`,
          },
        ],
        details: undefined,
      };
    },
  });
  const classify = async (
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
    options?: ClassifierOptions,
  ): Promise<ClassifierResult> => {
    const phase = currentPhase();
    const question = context.questions.route;
    const candidate =
      question?.type === 'choice'
        ? Object.keys(question.criteria).find((id) =>
            id.startsWith(`${phase.tier}|`),
          )
        : undefined;
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: options?.signal?.aborted ? 'aborted' : 'stop',
      answers: {
        ...(candidate
          ? {
              route: {
                type: 'choice' as const,
                choice: candidate,
                confidence: 0.95,
                probabilities: { [candidate]: 1 },
              },
            }
          : {}),
        ...(context.questions.activity
          ? {
              activity: {
                type: 'choice' as const,
                choice: phase.activity,
                confidence: 0.95,
                probabilities: { [phase.activity]: 1 },
              },
            }
          : {}),
      },
    };
  };
  pi.registerProvider('adaptive-fixture', {
    apiKey: 'local-fixture-no-network',
    api: 'adaptive-fixture-api',
    baseUrl: 'fixture://local',
    models: [
      ...['quick', 'balanced', 'deep', 'docs'].map((id) => ({
        id,
        name: `Fixture ${id}`,
        reasoning: true,
        thinkingLevelMap: { xhigh: 'xhigh' },
        input: ['text'] as ('text' | 'image')[],
        contextWindow: 128000,
        maxTokens: 2048,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
      })),
      {
        type: 'classifier',
        id: 'choice',
        name: 'Local adaptive classifier fixture',
        api: 'adaptive-fixture-classifier',
        baseUrl: 'https://fixture.invalid',
        input: ['text'],
        contextWindow: 64000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    classifiers: { 'adaptive-fixture-classifier': { classify } },
    streamSimple: (model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      requests += 1;
      physical.push({
        request: requests,
        model: model.id,
        effort: options?.reasoning ?? 'off',
      });
      const finished = requests >= 21;
      const content: AssistantMessage['content'] = [
        {
          type: 'text',
          text: finished
            ? 'ADAPTIVE_FIXTURE_TRACE ' +
              JSON.stringify({ physical, observed, noNetwork: true })
            : 'Local fixture is now working on ' +
              currentPhase().activity +
              '.',
        },
        ...(!finished
          ? [
              {
                type: 'toolCall' as const,
                id: `adaptive-step-${requests}`,
                name: 'adaptive_fixture_step',
                arguments: {},
              },
            ]
          : []),
      ];
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        stopReason: finished ? 'stop' : 'toolUse',
        timestamp: Date.now(),
        usage: {
          input: 100,
          output: 30,
          cacheRead: 900,
          cacheWrite: 0,
          totalTokens: 1030,
          cost: {
            input: 0.0001,
            output: 0.00006,
            cacheRead: 0.00009,
            cacheWrite: 0,
            total: 0.00025,
          },
        },
      };
      queueMicrotask(() => {
        if (options?.signal?.aborted) {
          message.stopReason = 'aborted';
          message.errorMessage = 'Local fixture cancelled';
          stream.push({ type: 'error', reason: 'aborted', error: message });
        } else {
          stream.push({ type: 'start', partial: message });
          stream.push({
            type: 'done',
            reason: finished ? 'stop' : 'toolUse',
            message,
          });
        }
        stream.end();
      });
      return stream;
    },
  });
  pi.on('message_end', (_event, ctx) => {
    const last = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === 'custom' && entry.customType === 'router-state',
      );
    if (last?.type !== 'custom' || !isRouterPersistedState(last.data)) return;
    const decision = last.data.lastDecision;
    if (!decision) return;
    observed.push({
      tier: decision.tier,
      ...(decision.activity ? { activity: decision.activity } : {}),
      model: decision.targetModelId,
      effort: decision.thinking,
    });
  });
  pi.registerCommand('adaptive-fixture-reset', {
    description: 'Reset deterministic local loop fixture (no model calls)',
    handler: async (_args, ctx) => {
      requests = 0;
      physical.length = 0;
      observed.length = 0;
      ctx.ui.notify('LOCAL ADAPTIVE FIXTURE reset · no network', 'info');
    },
  });
  pi.registerCommand('adaptive-fixture-report', {
    description: 'Show local physical route trace',
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        'ADAPTIVE_FIXTURE_TRACE ' +
          JSON.stringify({ physical, observed, noNetwork: true }),
        'info',
      );
    },
  });
  pi.registerCommand('adaptive-fixture-theme', {
    description: 'Change the isolated fixture theme',
    handler: async (args, ctx) => {
      if (args === 'dark' || args === 'light') ctx.ui.setTheme(args);
    },
  });
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setStatus('adaptive-fixture', 'LOCAL FIXTURE · no network');
  });
};
