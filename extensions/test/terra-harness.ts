import {
  type ClassifierContext,
  type Context,
  normalizeContext,
} from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { vi } from 'vitest';
import { normalizeConfig } from '../config';
import { registerRouterProvider } from '../provider';
import type {
  RawRouterConfig,
  RouterActivity,
  RouterMode,
  RouterTier,
} from '../types';
import { createRouterUIRuntime } from '../ui/runtime';
import { events, message, model, required } from './fixtures';

type State = Parameters<typeof registerRouterProvider>[1];
type MutableState = { -readonly [K in keyof State]: State[K] };
export const terraHarness = (
  raw: RawRouterConfig,
  find: ExtensionContext['modelRegistry']['find'],
) => {
  let tier: RouterTier = 'medium';
  let activity: RouterActivity | 'generic' = 'generic';
  let classifyFailure = false;
  const classify = vi.fn(
    async (
      target: { api: string; provider: string; id: string },
      context: ClassifierContext,
    ) => {
      if (classifyFailure) throw new Error('fixture unavailable');
      const question = context.questions.route;
      const choice =
        question?.type === 'choice'
          ? Object.keys(question.criteria).find((id) =>
              id.startsWith(`${tier}|`),
            )
          : undefined;
      const answer = activity === 'generic' ? 'uncertain' : activity;
      return {
        api: target.api,
        provider: target.provider,
        model: target.id,
        timestamp: 1,
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
                  choice: answer,
                  confidence: 1,
                  probabilities: { [answer]: 1 },
                },
              }
            : {}),
        },
      };
    },
  );
  const delegate = vi.fn<ExtensionContext['modelRegistry']['streamSimple']>(
    (target) =>
      events({
        type: 'done',
        reason: 'stop',
        message: message({
          provider: target.provider,
          model: target.id,
          api: target.api,
        }),
      }),
  );
  const registry = {
    find,
    classify,
    streamSimple: delegate,
    findOfType: () => ({
      type: 'classifier',
      provider: 'fixture',
      id: 'choice',
      name: 'Fixture',
      api: 'fixture-choice',
      baseUrl: 'fixture://local',
      input: ['text'],
      contextWindow: 64000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  } as unknown as ExtensionContext['modelRegistry'];
  const state: MutableState = {
    lastRegisteredModels: '',
    currentModelRegistry: registry,
    lastExtensionContext: {
      sessionManager: { getBranch: () => [{ id: 'root', type: 'message' }] },
      ui: { setHiddenThinkingLabel: vi.fn() },
    } as unknown as ExtensionContext,
    currentConfig: normalizeConfig(raw).config,
    selectedProfile: 'p',
    routerEnabled: true,
    lastDecision: undefined,
    thinkingByProfile: {},
    pinnedTierByProfile: {},
    accumulatedCost: 0,
  };
  const ui = createRouterUIRuntime(
    Object.assign(state, { debugHistory: [] }),
    () => undefined,
  );
  const register = vi.fn<ExtensionAPI['registerProvider']>();
  registerRouterProvider(
    { registerProvider: register } as unknown as ExtensionAPI,
    state,
    {
      beginRequest: ui.beginRequest,
      persistState: vi.fn(),
      recordDebugDecision: vi.fn(),
      updateStatus: vi.fn(),
      syncPiThinkingLevel: vi.fn(),
    },
  );
  const generate = required(register.mock.calls.at(-1)?.[1].streamSimple);
  let timestamp = 0;
  const run = async (
    mode: RouterMode,
    selectedTier: RouterTier = 'medium',
    selectedActivity: RouterActivity | 'generic' = 'generic',
    context?: Context,
  ) => {
    state.modeOverride = mode;
    tier = selectedTier;
    activity = selectedActivity;
    const stream = generate(
      model('p', { provider: 'router' }),
      normalizeContext(
        context ?? {
          messages: [
            {
              role: 'user',
              content: 'Controlled routing fixture.',
              timestamp: ++timestamp,
            },
          ],
        },
      ),
      { sessionId: 'terra-test' },
    );
    for await (const _event of stream) {
      /* drain */
    }
    return stream.result();
  };
  return {
    run,
    state,
    ui,
    delegate,
    classify,
    failClassifier: () => {
      classifyFailure = true;
    },
  };
};
