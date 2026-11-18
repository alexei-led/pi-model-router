import { type Context, normalizeContext } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { expect, vi } from 'vitest';
import { normalizeConfig } from '../config';
import { registerRouterProvider } from '../provider';
import type { AdvisorConfig } from '../types';
import {
  events,
  message,
  model,
  required,
  typeSafeClassifierRegistry,
} from './fixtures';

type State = Parameters<typeof registerRouterProvider>[1];
type MutableState = { -readonly [K in keyof State]: State[K] };
export const advisorOf = (decision: State['lastDecision']) => decision?.advisor;

export const setup = () => {
  const models = [
    model(),
    model('fallback', { contextWindow: 2048 }),
    model('small', { contextWindow: 1024 }),
  ];
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
    ...typeSafeClassifierRegistry(),
    find: (provider: string, id: string) =>
      models.find((m) => m.provider === provider && m.id === id),
    streamSimple: delegate,
  } as unknown as ExtensionContext['modelRegistry'];
  const state: MutableState = {
    lastRegisteredModels: '',
    currentModelRegistry: registry,
    lastExtensionContext: {
      sessionManager: {
        getBranch: () => [{ id: 'user-turn', type: 'message' }],
      },
      ui: { setHiddenThinkingLabel: vi.fn() },
    } as unknown as ExtensionContext,
    currentConfig: normalizeConfig({
      profiles: {
        balanced: {
          high: { model: 'test/primary' },
          medium: { model: 'test/primary', fallbacks: ['test/fallback'] },
          low: { model: 'test/small' },
        },
      },
    }).config,
    selectedProfile: undefined,
    routerEnabled: false,
    lastDecision: undefined,
    thinkingByProfile: {},
    pinnedTierByProfile: { balanced: 'medium' },
    accumulatedCost: 0,
  };
  const register = vi.fn<ExtensionAPI['registerProvider']>();
  const api = { registerProvider: register } as unknown as ExtensionAPI;
  const actions = {
    persistState: vi.fn(),
    recordDebugDecision: vi.fn(),
    updateStatus: vi.fn(),
    syncPiThinkingLevel: vi.fn(),
    beginRequest: vi.fn<
      NonNullable<Parameters<typeof registerRouterProvider>[2]['beginRequest']>
    >(() => () => undefined),
  };
  const stream = (
    context: Context = {
      messages: [{ role: 'user', content: 'implement', timestamp: 1 }],
    },
    signal?: AbortSignal,
    sessionId?: string,
  ) => {
    registerRouterProvider(api, state, actions);
    const config = register.mock.calls.at(-1)?.[1];
    if (!config?.streamSimple)
      throw new Error('Router provider not registered');
    const streamOptions = {
      ...(signal ? { signal } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    return config.streamSimple(
      model('balanced', { provider: 'router', contextWindow: 8192 }),
      normalizeContext(context),
      streamOptions,
    );
  };
  const waitForReviews = (count: number) =>
    vi.waitFor(
      () => {
        expect(
          actions.recordDebugDecision.mock.calls.filter(
            ([decision]) => decision.reviewOnly,
          ),
        ).toHaveLength(count);
      },
      { interval: 1 },
    );
  return {
    models,
    registry,
    state,
    delegate,
    register,
    api,
    actions,
    stream,
    waitForReviews,
  };
};

export const userContext = (
  text = 'implement a parser',
  timestamp = 1,
): Context => ({
  messages: [{ role: 'user', content: text, timestamp }],
});

export const classifierModel = {
  type: 'classifier' as const,
  provider: 'typesafe',
  id: 'jev-latest',
  name: 'Jev',
  api: 'typesafe-system-one' as const,
  baseUrl: 'https://api.typesafe.ai/v1/',
  input: ['text'] as 'text'[],
  contextWindow: 64000,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};
const classifierConfig: AdvisorConfig = {
  enabled: true,
  model: 'typesafe/jev-latest',
  timeoutMs: 1500,
  reviewEveryRequests: 4,
  confidenceThreshold: 0.65,
  probabilityThreshold: 0.8,
  maxStateTokens: 3000,
  maxRetries: 1,
};
export type Classify = ExtensionContext['modelRegistry']['classify'];
export type ClassifierResponse = Awaited<ReturnType<Classify>>;
export const classifierResponse = (
  target: Parameters<Classify>[0],
  context: Parameters<Classify>[1],
  tier: string,
): ClassifierResponse => {
  const criteria = required(context.questions.route).criteria;
  const ids = Object.keys(criteria);
  const choice = ids.find((id) => id.startsWith(`${tier}|`)) ?? '';
  return {
    api: target.api,
    provider: target.provider,
    model: target.id,
    timestamp: Date.now(),
    stopReason: 'stop',
    answers: {
      route: {
        type: 'choice',
        choice,
        confidence: 0.99,
        probabilities: Object.fromEntries(
          ids.map((id) => [id, id === choice ? 1 : 0]),
        ),
      },
    },
  };
};
export const enableAdvisors = (
  s: ReturnType<typeof setup>,
  tier = 'medium',
) => {
  s.state.currentConfig.advisor = { ...classifierConfig };
  required(s.state.currentConfig.profiles.balanced).advisor = {
    models: ['typesafe/jev-latest'],
  };
  s.registry.findOfType = (() =>
    classifierModel) as unknown as ExtensionContext['modelRegistry']['findOfType'];
  s.registry.classify = vi.fn<Classify>(async (target, context) =>
    classifierResponse(target, context, tier),
  );
  delete s.state.pinnedTierByProfile.balanced;
};
