import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryCredentialStore,
  type ProviderClassifier,
  Type,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { expect, onTestFinished, test, vi } from 'vitest';
import routerExtension from './index';
import { events, message, model, required } from './test/fixtures';

// These are fresh SDK runtimes, not proof of pi-subagents' inherited policy propagation.
test('fresh Pi SDK sessions share a profile, not controls, cost, advice caches or callbacks', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-router-sdk-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', cwd);
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });
  writeFileSync(
    join(cwd, 'model-router.json'),
    JSON.stringify({
      debug: true,
      advisor: { enabled: true, model: 'fixture/advisor' },
      profiles: {
        auto: {
          advisor: { models: ['fixture/advisor'] },
          medium: { model: 'fixture/base' },
          high: { model: 'fixture/base', thinking: 'high' },
          activities: {
            code: { medium: { model: 'fixture/code' } },
            docs: { medium: { model: 'fixture/docs' } },
          },
        },
      },
    }),
  );
  let steer: (() => Promise<void>) | undefined;
  const createFresh = async (savedState?: unknown) => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(cwd, 'catalog.json'),
      refreshOnCreate: false,
    });
    const classify = vi.fn<ProviderClassifier['classify']>(
      async (classifier, context) => {
        const question = context.questions.route;
        const route =
          question?.type === 'choice'
            ? required(
                Object.keys(question.criteria).find((id) =>
                  id.startsWith('medium|'),
                ),
              )
            : undefined;
        const current = JSON.stringify(context.state.currentRequest);
        const activity = current.includes('guide') ? 'docs' : 'code';
        return {
          api: classifier.api,
          provider: classifier.provider,
          model: classifier.id,
          timestamp: 1,
          stopReason: 'stop',
          answers: {
            ...(route
              ? {
                  route: {
                    type: 'choice',
                    choice: route,
                    confidence: 1,
                    probabilities: { [route]: 1 },
                  },
                }
              : {}),
            activity: {
              type: 'choice',
              choice: activity,
              confidence: 1,
              probabilities: { [activity]: 1 },
            },
          },
        };
      },
    );
    const generate = vi.fn<
      NonNullable<
        Parameters<ModelRuntime['registerProvider']>[1]['streamSimple']
      >
    >((target) =>
      events({
        type: 'done',
        reason: 'stop',
        message: message({
          provider: 'fixture',
          model: target.id,
          api: target.api,
        }),
      }),
    );
    runtime.registerProvider('fixture', {
      api: 'fixture-chat',
      baseUrl: 'https://fixture.invalid',
      apiKey: 'synthetic-only',
      models: [
        ...['base', 'code', 'docs'].map((id) => ({
          ...model(id, { provider: 'fixture', api: 'fixture-chat' }),
        })),
        {
          type: 'classifier',
          id: 'advisor',
          name: 'advisor',
          api: 'fixture-classifier',
          input: ['text'],
          contextWindow: 64000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      streamSimple: generate,
      classifiers: { 'fixture-classifier': { classify } },
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [routerExtension],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(cwd);
    if (savedState !== undefined)
      manager.appendCustomEntry('router-state', savedState);
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      resourceLoader: loader,
      modelRuntime: runtime,
      settingsManager,
      sessionManager: manager,
      noTools: 'builtin',
      tools: ['inspect'],
      ...(savedState !== undefined
        ? {
            sessionStartEvent: {
              type: 'session_start' as const,
              reason: 'fork' as const,
            },
          }
        : {}),
      customTools: [
        {
          name: 'inspect',
          label: 'Inspect fixture',
          description: 'Return synthetic evidence.',
          parameters: Type.Object({}),
          execute: async () => {
            await steer?.();
            return {
              content: [{ type: 'text', text: 'synthetic evidence' }],
              details: {},
            };
          },
        },
      ],
      model: model('auto', { provider: 'router', api: 'router-local-api' }),
    });
    await session.bindExtensions({
      mode: 'print',
      onError: (error) => {
        throw new Error(error.error);
      },
    });
    onTestFinished(() => session.dispose());
    const lastState = () =>
      manager
        .getBranch()
        .findLast(
          (entry) =>
            entry.type === 'custom' && entry.customType === 'router-state',
        );
    return { session, manager, classify, generate, lastState };
  };
  const parent = await createFresh();
  await parent.session.prompt('/router pin high');
  await parent.session.prompt('Implement the helper');
  expect(parent.generate.mock.calls.at(-1)?.[0].id).toBe('base');
  expect(parent.classify).not.toHaveBeenCalled();
  const parentState = structuredClone(parent.lastState());
  const child = await createFresh(
    parentState?.type === 'custom' ? parentState.data : undefined,
  );
  expect(parent.manager.getSessionId()).not.toBe(child.manager.getSessionId());
  await child.session.prompt('Implement the helper');
  expect(child.classify).toHaveBeenCalledOnce();
  expect(child.generate.mock.calls.at(-1)?.[0].id).toBe('code');
  expect(parent.lastState()).toEqual(parentState);
  await child.session.prompt('Write the guide instead');
  expect(child.classify).toHaveBeenCalledTimes(2);
  expect(child.generate.mock.calls.at(-1)?.[0].id).toBe('docs');
  expect(parent.generate).toHaveBeenCalledOnce();
  expect(parent.lastState()).toEqual(parentState);
  child.generate.mockImplementationOnce((target) =>
    events({
      type: 'done',
      reason: 'toolUse',
      message: message({
        provider: 'fixture',
        model: target.id,
        api: target.api,
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            name: 'inspect',
            id: 'inspect-before-steer',
            arguments: {},
          },
        ],
      }),
    }),
  );
  await child.session.prompt('Implement with evidence');
  expect(child.classify).toHaveBeenCalledTimes(3);
  expect(
    child.generate.mock.calls.slice(-2).map(([target]) => target.id),
  ).toEqual(['code', 'code']);
  child.session.setActiveToolsByName(['inspect']);
  steer = async () => {
    await child.session.steer('Write the guide instead');
  };
  child.generate.mockImplementationOnce((target) =>
    events({
      type: 'done',
      reason: 'toolUse',
      message: message({
        provider: 'fixture',
        model: target.id,
        api: target.api,
        stopReason: 'toolUse',
        content: [
          {
            type: 'toolCall',
            name: 'inspect',
            id: 'inspect-one',
            arguments: {},
          },
        ],
      }),
    }),
  );
  await child.session.prompt('Implement another helper');
  expect(child.classify).toHaveBeenCalledTimes(5);
  expect(
    child.generate.mock.calls.slice(-2).map(([target]) => target.id),
  ).toEqual(['code', 'docs']);
  expect(parent.lastState()).toEqual(parentState);
  const childState = child.lastState();
  expect(childState?.type === 'custom' && childState.data).toMatchObject({
    ownerSessionId: child.manager.getSessionId(),
    pinByProfile: {},
    accumulatedCost: expect.closeTo(0.06, 8),
    lastDecision: {
      activity: 'docs',
      routeCell: 'docs',
      targetModelId: 'docs',
    },
  });
}, 20_000);
