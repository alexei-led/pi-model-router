import {
  type AssistantMessage,
  type ClassifierContext,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export const recoveryFixtureConfig = {
  advisor: {
    enabled: true,
    model: 'recovery-local/choice',
    reviewEveryRequests: 0,
  },
  profiles: {
    auto: {
      mode: 'cost',
      advisor: { models: ['recovery-local/choice'] },
      high: { model: 'recovery-local/claude-opus-5-5', thinking: 'high' },
      medium: { model: 'recovery-local/claude-sonnet-5-5', thinking: 'medium' },
      low: { model: 'recovery-local/claude-sonnet-5-5', thinking: 'low' },
    },
  },
};

export default (pi: ExtensionAPI) => {
  let requests = 0;
  const physical: { model: string; effort: string }[] = [];
  pi.registerTool({
    name: 'recovery_fixture_check',
    label: 'Local recovery check',
    description: 'A deterministic local failing check for router acceptance.',
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error('LOCAL_RECOVERY_FIXTURE repeated failure');
    },
  });
  pi.registerProvider('recovery-local', {
    apiKey: 'local-no-network',
    api: 'recovery-local-chat',
    baseUrl: 'fixture://local',
    models: [
      ...['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(
        (id) => ({
          id,
          name: id,
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            xhigh: 'xhigh',
            max: 'max',
          },
          input: ['text'] as ['text'],
          contextWindow: 128000,
          maxTokens: 4096,
          cost: {
            input: id.includes('haiku') ? 0.1 : id.includes('sonnet') ? 2 : 4,
            output: 10,
            cacheRead: 0.1,
            cacheWrite: 1,
          },
        }),
      ),
      {
        type: 'classifier',
        id: 'choice',
        name: 'Local recovery classifier',
        api: 'recovery-local-choice',
        baseUrl: 'fixture://local',
        input: ['text'],
        contextWindow: 64000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    classifiers: {
      'recovery-local-choice': {
        classify: async (model, context: ClassifierContext) => {
          const q = context.questions.route;
          const choice =
            q?.type === 'choice'
              ? Object.keys(q.criteria).find((id) => id.startsWith('high|'))
              : undefined;
          return {
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            stopReason: 'stop',
            answers: {
              ...(choice
                ? {
                    route: {
                      type: 'choice',
                      choice,
                      confidence: 1,
                      probabilities: { [choice]: 1 },
                    },
                  }
                : {}),
              ...(context.questions.activity
                ? {
                    activity: {
                      type: 'choice',
                      choice: 'ops',
                      confidence: 1,
                      probabilities: { ops: 1 },
                    },
                  }
                : {}),
            },
          };
        },
      },
    },
    streamSimple: (model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      requests++;
      physical.push({ model: model.id, effort: options?.reasoning ?? 'off' });
      const finished = requests >= 4;
      const content: AssistantMessage['content'] = finished
        ? [
            {
              type: 'text',
              text: `RECOVERY_PHYSICAL ${JSON.stringify(physical)}`,
            },
          ]
        : [
            {
              type: 'toolCall',
              id: `local-recovery-${requests}`,
              name: requests === 2 ? 'write' : 'recovery_fixture_check',
              arguments:
                requests === 2
                  ? {
                      path: 'recovery-proof.txt',
                      content: 'Local recovery fixture wrote this file.\n',
                    }
                  : {},
            },
          ];
      const message: AssistantMessage = {
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content,
        timestamp: Date.now(),
        stopReason: finished ? 'stop' : 'toolUse',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        if (options?.signal?.aborted)
          stream.push({
            type: 'error',
            reason: 'aborted',
            error: {
              ...message,
              stopReason: 'aborted',
              errorMessage: 'Cancelled',
            },
          });
        else {
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
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setStatus('recovery-fixture', 'LOCAL FIXTURE · no network');
  });
};
