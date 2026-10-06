import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { onTestFinished, test } from 'vitest';

test('Pi RPC loads the router provider without dispatching a model', {
  timeout: 20_000,
}, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-router-host-'));
  onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, 'agent');
  mkdirSync(agentDir);
  writeFileSync(
    join(agentDir, 'model-router.json'),
    JSON.stringify({
      profiles: { offline: { medium: { model: 'openai/gpt-6.1-sol' } } },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
      '--mode',
      'rpc',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-session',
      '--extension',
      resolve('extensions/index.ts'),
      '--model',
      'router/offline',
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: cwd,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: '1',
      },
      input: '{"id":"state","type":"get_state"}\n',
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Failed to load extension|Error:/);
  const events: Array<Record<string, unknown>> = result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const response = events.find((event) => event.id === 'state');
  assert.equal(response?.success, true);
  const data = response?.data;
  assert.ok(data && typeof data === 'object' && 'model' in data);
  const model = data.model;
  assert.ok(model && typeof model === 'object' && 'provider' in model);
  assert.equal(model.provider, 'router');
  assert.ok('id' in model);
  assert.equal(model.id, 'offline');
  assert.equal(
    events.some((event) => event.type === 'agent_start'),
    false,
  );
});

for (const view of ['usage', 'settings', 'status', ''] as const) {
  for (const mode of ['print', 'json', 'rpc'] as const) {
    test(`Pi ${mode} exposes ${view || 'overview'} text without inference`, {
      timeout: 20_000,
    }, () => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-router-inspector-'));
      onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
      const agentDir = join(cwd, 'agent');
      mkdirSync(agentDir);
      writeFileSync(
        join(agentDir, 'model-router.json'),
        JSON.stringify({
          profiles: { offline: { medium: { model: 'openai/gpt-6.1-sol' } } },
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
          '--no-session',
          '--extension',
          resolve('extensions/index.ts'),
          '--model',
          'router/offline',
          ...(mode === 'print' ? ['--print'] : ['--mode', mode]),
          ...(mode === 'rpc' ? [] : [`/router ${view}`]),
        ],
        {
          cwd,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: cwd,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: '1',
          },
          encoding: 'utf8',
          input:
            mode === 'rpc'
              ? JSON.stringify({ type: 'prompt', message: `/router ${view}` }) +
                '\n'
              : undefined,
          timeout: 15_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const expected =
        view === 'usage'
          ? /Retained active-branch history: 0/
          : view === 'status'
            ? /Router: on/
            : /Router \/ offline/;
      if (mode === 'print') {
        assert.match(result.stderr, expected);
        assert.equal(result.stdout, '');
      } else if (mode === 'rpc') {
        const entries = result.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(
          entries.some((event) => event.type === 'agent_start'),
          false,
        );
        assert.match(result.stdout, expected);
      } else {
        const entries = result.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.ok(
          entries.some(
            (event) =>
              event.type === 'message_end' &&
              JSON.stringify(event).includes(
                view === 'status' ? 'router-status' : 'router-inspector',
              ),
          ),
        );
        assert.equal(
          entries.some((event) => event.type === 'agent_start'),
          false,
        );
        assert.match(result.stdout, expected);
      }
    });
  }
}
