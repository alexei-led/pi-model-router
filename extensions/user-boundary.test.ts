import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type Theme,
} from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import { expect, it, onTestFinished, vi } from 'vitest';
import routerExtension from './index';
import { model } from './test/fixtures';
import {
  createUserBoundaryFixture,
  userBoundaryConfig,
} from './test/user-boundary-fixture';

it.each(['steer', 'followUp'] as const)(
  'native SDK consumes %s before activating a queued Settings mode',
  { timeout: 20000 },
  async (delivery) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-user-boundary-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', cwd);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(cwd, { recursive: true, force: true });
    });
    writeFileSync(
      join(cwd, 'model-router.json'),
      JSON.stringify(userBoundaryConfig),
    );
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(cwd, 'catalog.json'),
      refreshOnCreate: false,
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });
    const fixture = createUserBoundaryFixture();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [routerExtension, fixture.extension],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      resourceLoader: loader,
      modelRuntime: runtime,
      settingsManager,
      sessionManager: manager,
      noTools: 'builtin',
      tools: ['boundary_wait'],
      model: model('auto', { provider: 'router', api: 'router-local-api' }),
    });
    onTestFinished(async () => {
      fixture.release();
      await session.abort();
      session.dispose();
    });
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    } as Theme;
    const tui = {
      terminal: { columns: 80, rows: 45 },
      requestRender: () => {},
    } as unknown as TUI;
    const keys = { matches: () => false } as unknown as Parameters<
      Parameters<ExtensionUIContext['custom']>[0]
    >[2];
    const custom: ExtensionUIContext['custom'] = (factory) =>
      new Promise((resolve, reject) => {
        void Promise.resolve(factory(tui, theme, keys, resolve))
          .then(async (component) => {
            component.render(80);
            for (const key of ['\t', '\t', '\x1b[C', '\t', '\t', '\r'])
              component.handleInput?.(key);
            await vi.waitFor(() =>
              expect(component.render(80).join('\n')).toContain(
                'Queued for next user turn',
              ),
            );
            component.handleInput?.('\x1b');
            component.dispose?.();
          })
          .catch(reject);
      });
    const uiContext = {
      theme,
      custom,
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
      setHiddenThinkingLabel: () => {},
    } as unknown as ExtensionUIContext;
    await session.bindExtensions({
      mode: 'tui',
      uiContext,
      onError: (error) => {
        throw new Error(error.error);
      },
    });
    const lastState = () =>
      manager
        .getBranch()
        .findLast(
          (entry) =>
            entry.type === 'custom' && entry.customType === 'router-state',
        );
    const run = session.prompt('Run the local user-boundary fixture.');
    await fixture.toolStarted;
    await session.prompt('/router settings');
    expect(fixture.physical).toEqual([{ model: 'base', effort: 'medium' }]);
    await session[delivery]('Consume the queued user goal.');
    const before = lastState();
    expect(
      before?.type === 'custom' &&
        before.data &&
        typeof before.data === 'object' &&
        'modeOverride' in before.data
        ? before.data.modeOverride
        : undefined,
    ).toBeUndefined();
    fixture.release();
    await run;
    expect(fixture.physical).toEqual(
      delivery === 'steer'
        ? [
            { model: 'base', effort: 'medium' },
            { model: 'cheap', effort: 'high' },
          ]
        : [
            { model: 'base', effort: 'medium' },
            { model: 'base', effort: 'medium' },
            { model: 'cheap', effort: 'high' },
          ],
    );
    const saved = lastState();
    expect(saved?.type === 'custom' ? saved.data : undefined).toMatchObject({
      modeOverride: 'cost',
    });
  },
);
