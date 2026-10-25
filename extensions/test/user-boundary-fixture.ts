import {
  type AssistantMessage,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export const userBoundaryConfig = {
  profiles: {
    auto: {
      medium: { model: 'boundary-local/base', thinking: 'medium' },
      low: { model: 'boundary-local/cheap', thinking: 'high' },
    },
  },
};

export const createUserBoundaryFixture = () => {
  const physical: { model: string; effort: string }[] = [];
  let release: () => void = () => {};
  let started: () => void = () => {};
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const extension = (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'boundary_wait',
      label: 'User-boundary wait',
      description:
        'A local deterministic wait released by the acceptance controller.',
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        started();
        signal?.addEventListener('abort', release, { once: true });
        try {
          await waiting;
          signal?.throwIfAborted();
        } finally {
          signal?.removeEventListener('abort', release);
        }
        return {
          content: [{ type: 'text', text: 'Local wait released.' }],
          details: undefined,
        };
      },
    });
    pi.registerCommand('boundary-queue', {
      description:
        'Queue a local steering/follow-up user without releasing the tool.',
      handler: async (args, ctx) => {
        if (args !== 'steer' && args !== 'followUp') {
          ctx.ui.notify('Use /boundary-queue steer|followUp', 'error');
          return;
        }
        pi.sendUserMessage('Consumed local user goal.', { deliverAs: args });
      },
    });
    pi.registerCommand('boundary-release', {
      description: 'Release the local wait.',
      handler: async () => {
        release();
      },
    });
    pi.registerProvider('boundary-local', {
      apiKey: 'local-no-network',
      api: 'boundary-local-chat',
      baseUrl: 'fixture://local',
      models: ['base', 'cheap'].map((id) => ({
        id,
        name: id,
        reasoning: true,
        input: ['text'] as ['text'],
        contextWindow: 128000,
        maxTokens: 4096,
        cost: {
          input: id === 'base' ? 2 : 0.1,
          output: 1,
          cacheRead: 0.1,
          cacheWrite: 1,
        },
      })),
      streamSimple: (model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        physical.push({ model: model.id, effort: options?.reasoning ?? 'off' });
        const finished = physical.length > 1;
        const message: AssistantMessage = {
          role: 'assistant',
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: finished ? 'stop' : 'toolUse',
          content: finished
            ? [
                {
                  type: 'text',
                  text: `USER_BOUNDARY_PHYSICAL ${JSON.stringify(physical)}`,
                },
              ]
            : [
                {
                  type: 'toolCall',
                  id: 'boundary-wait',
                  name: 'boundary_wait',
                  arguments: {},
                },
              ],
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
    pi.on('session_shutdown', release);
    pi.on('session_start', (_event, ctx) =>
      ctx.ui.setStatus(
        'user-boundary-fixture',
        'LOCAL USER-BOUNDARY FIXTURE · no network',
      ),
    );
  };
  return { extension, physical, toolStarted, release };
};

export default (pi: ExtensionAPI) => createUserBoundaryFixture().extension(pi);
