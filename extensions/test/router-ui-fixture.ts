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

/** Deterministic local provider for actual-host acceptance; excluded from npm package. */
export default (pi: ExtensionAPI) => {
  let scenario = 'baseline';
  pi.registerCommand('router-demo', {
    description:
      'Local fixture: baseline, fallback, unknown, tool, slow, advisor-timeout, advisor-invalid',
    handler: async (args, ctx) => {
      if (
        ![
          'baseline',
          'fallback',
          'unknown',
          'tool',
          'slow',
          'advisor-timeout',
          'advisor-invalid',
          'failure',
        ].includes(args.trim())
      ) {
        ctx.ui.notify(
          'Fixture scenarios: baseline | fallback | unknown | tool | slow | advisor-timeout | advisor-invalid',
          'info',
        );
        return;
      }
      scenario = args.trim();
      ctx.ui.notify(`Local fixture scenario: ${scenario}`, 'info');
    },
  });
  pi.registerTool({
    name: 'fixture_echo',
    label: 'Fixture echo',
    description: 'Return a deterministic read-only fixture result.',
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: 'text', text: 'fixture-ok' }],
      details: undefined,
    }),
  });
  pi.registerProvider('router-fixture', {
    api: 'router-fixture-api',
    apiKey: 'local-fixture-no-network',
    baseUrl: 'fixture://local',
    models: ['micro', 'low', 'medium', 'high', 'fallback', 'classifier'].map(
      (id) => ({
        id,
        name: `Fixture ${id}`,
        reasoning: true,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 1024,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
      }),
    ),
    streamSimple: (model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const usage = {
        input: 1200,
        output: 80,
        cacheRead: 18000,
        cacheWrite: 300,
        totalTokens: 19580,
        cost: {
          input: 0.0012,
          output: 0.00016,
          cacheRead: 0.0018,
          cacheWrite: 0.000375,
          total: 0.003535,
        },
      };
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        stopReason: 'stop',
        timestamp: Date.now(),
        usage,
      };
      const finish = () => {
        if (options?.signal?.aborted) {
          message.stopReason = 'aborted';
          message.errorMessage = 'Fixture cancelled';
          stream.push({ type: 'error', reason: 'aborted', error: message });
          stream.end();
          return;
        }
        if (
          (scenario === 'failure' ||
            scenario === 'fallback' ||
            scenario === 'unknown') &&
          (scenario === 'failure' || model.id !== 'fallback')
        ) {
          if (scenario === 'unknown') message.usage.cost.total = Number.NaN;
          message.stopReason = 'error';
          message.errorMessage = 'Fixture pre-content failure';
          stream.push({ type: 'error', reason: 'error', error: message });
          stream.end();
          return;
        }
        if (
          scenario === 'tool' &&
          context.messages.at(-1)?.role !== 'toolResult'
        ) {
          message.content = [
            {
              type: 'toolCall',
              id: `fixture-call-${Date.now()}`,
              name: 'fixture_echo',
              arguments: {},
            },
          ];
          message.stopReason = 'toolUse';
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'done', reason: 'toolUse', message });
          stream.end();
          return;
        }
        const text =
          model.id === 'classifier'
            ? 'Tier: medium\nReasoning: Local semantic classifier fixture.'
            : `Local fixture complete. Route: ${model.provider}/${model.id}. No external inference was used.`;
        message.content = [{ type: 'text', text }];
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_start', contentIndex: 0, partial: message });
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: text,
          partial: message,
        });
        stream.push({
          type: 'text_end',
          contentIndex: 0,
          content: text,
          partial: message,
        });
        stream.push({ type: 'done', reason: 'stop', message });
        stream.end();
      };
      if (scenario === 'slow') {
        const timer = setTimeout(() => {
          options?.signal?.removeEventListener('abort', abort);
          finish();
        }, 10000);
        const abort = () => {
          clearTimeout(timer);
          finish();
        };
        options?.signal?.addEventListener('abort', abort, { once: true });
        if (options?.signal?.aborted) abort();
      } else queueMicrotask(finish);
      return stream;
    },
  });
  const classifyFixture = async (
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
    options?: ClassifierOptions,
  ): Promise<ClassifierResult> => {
    if (scenario === 'advisor-timeout')
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
    const question = context.questions.route;
    const keys =
      question?.type === 'choice' ? Object.keys(question.criteria) : [];
    const choice =
      keys.find((key) => key.startsWith('medium|')) ?? keys[0] ?? 'uncertain';
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: options?.signal?.aborted ? 'aborted' : 'stop',
      answers: {
        route: {
          type: 'choice',
          choice: scenario === 'advisor-invalid' ? 'foreign' : choice,
          confidence: 1,
          probabilities: Object.fromEntries(
            keys.map((key) => [key, key === choice ? 1 : 0]),
          ),
        },
      },
    };
  };
  pi.registerProvider('router-fixture-classifiers', {
    apiKey: 'local-fixture-no-network',
    models: [
      {
        type: 'classifier',
        id: 'demo/route',
        name: 'Fixture route chooser',
        api: 'fixture-classifier',
        baseUrl: 'https://fixture.invalid',
        input: ['text'],
        contextWindow: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    classifiers: { 'fixture-classifier': { classify: classifyFixture } },
  });
  pi.registerCommand('router-demo-check', {
    description: 'Check the local classifier registration, without network',
    handler: async (_args, ctx) => {
      const model = ctx.modelRegistry.findOfType(
        'classifier',
        'router-fixture-classifiers',
        'demo/route',
      );
      if (!model) {
        ctx.ui.notify('Fixture classifier absent', 'error');
        return;
      }
      const result = await ctx.modelRegistry.classify(model, {
        state: { fixture: true },
        questions: {
          route: {
            type: 'choice',
            instructions: 'Choose fixture',
            criteria: { 'medium|fixture': 'yes', uncertain: 'no' },
          },
        },
      });
      ctx.ui.notify(JSON.stringify(result), 'info');
    },
  });
  pi.registerCommand('router-demo-theme', {
    description: 'Switch the fixture between Pi dark and light themes',
    handler: async (args, ctx) => {
      if (args !== 'dark' && args !== 'light') return;
      const result = ctx.ui.setTheme(args);
      ctx.ui.notify(
        result.success ? `Fixture theme: ${args}` : 'Theme switch failed',
        result.success ? 'info' : 'error',
      );
    },
  });
  pi.registerCommand('router-demo-size', {
    description: 'Report the fixture terminal dimensions',
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Fixture terminal: ${process.stdout.columns} columns, ${process.stdout.rows} rows`,
        'info',
      );
    },
  });
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setStatus('fixture', 'LOCAL FIXTURE · no network');
    ctx.ui.setWidget(
      'fixture',
      ['Acceptance sandbox · deterministic generation'],
      { placement: 'belowEditor' },
    );
  });
};
