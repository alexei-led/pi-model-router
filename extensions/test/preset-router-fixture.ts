import {
  type AssistantMessage,
  type ClassifierApi,
  type ClassifierContext,
  type ClassifierModel,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default (pi: ExtensionAPI) => {
  const classify = async (
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
  ) => {
    const question = context.questions.route;
    const choice =
      question?.type === 'choice'
        ? Object.keys(question.criteria).find((id) => id.startsWith('medium|'))
        : undefined;
    return {
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: 'stop' as const,
      answers: {
        ...(choice
          ? {
              route: {
                type: 'choice' as const,
                choice,
                confidence: 1,
                probabilities: { [choice]: 1 },
              },
            }
          : {}),
        ...(context.questions.activity
          ? {
              activity: {
                type: 'choice' as const,
                choice: 'debug',
                confidence: 1,
                probabilities: { debug: 1 },
              },
            }
          : {}),
      },
    };
  };
  for (const provider of ['preset-openai', 'preset-anthropic']) {
    pi.registerProvider(provider, {
      apiKey: 'local-no-network',
      api: 'preset-fixture',
      baseUrl: 'fixture://local',
      models: (provider === 'preset-openai'
        ? ['gpt-6-luna', 'gpt-6.1-sol']
        : ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']
      ).map((id) => ({
        id,
        name: id,
        input: ['text'],
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          xhigh: 'xhigh',
          max: 'max',
        },
        contextWindow: 128000,
        maxTokens: 4096,
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
      })),
      streamSimple: (model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [
            {
              type: 'text',
              text:
                'PRESET_PHYSICAL ' +
                JSON.stringify({
                  provider: model.provider,
                  model: model.id,
                  effort: options?.reasoning ?? 'off',
                }),
            },
          ],
          timestamp: Date.now(),
          stopReason: options?.signal?.aborted ? 'aborted' : 'stop',
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        queueMicrotask(() => {
          if (options?.signal?.aborted)
            stream.push({
              type: 'error',
              reason: 'aborted',
              error: { ...message, errorMessage: 'Cancelled' },
            });
          else {
            stream.push({ type: 'start', partial: message });
            stream.push({ type: 'done', reason: 'stop', message });
          }
          stream.end();
        });
        return stream;
      },
    });
  }
  pi.registerProvider('preset-classifier', {
    apiKey: 'local-no-network',
    models: [
      {
        type: 'classifier',
        id: 'choice',
        name: 'Local preset classifier',
        api: 'preset-choice',
        baseUrl: 'fixture://local',
        input: ['text'],
        contextWindow: 64000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    classifiers: { 'preset-choice': { classify } },
  });
};
