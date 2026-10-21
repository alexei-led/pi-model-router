import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('installed Pi loads the classifier catalog through its extension loader', {
  timeout: 20000,
}, () => {
  const binary = process.env.PI_TEST_BINARY;
  assert.ok(binary, 'Set PI_TEST_BINARY to the installed Pi 1.3+ executable');
  const directory = mkdtempSync(join(tmpdir(), 'pi-classifier-startup-'));
  const agentDir = join(directory, 'agent');
  mkdirSync(agentDir);
  try {
    const result = spawnSync(
      binary,
      [
        '--offline',
        '--no-mcp',
        '--no-session',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--model',
        'openai/gpt-6.1-sol',
        '--extension',
        fileURLToPath(
          new URL('../examples/classifier-catalog.ts', import.meta.url),
        ),
        '--mode',
        'rpc',
      ],
      {
        cwd: directory,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: directory,
          PI_CODING_AGENT_DIR: agentDir,
          PI_TELEMETRY: '0',
        },
        input: '{"id":"startup","type":"get_state"}\n',
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Failed to load extension|Error:/);
    const events = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(events.find((event) => event.id === 'startup')?.success, true);
    assert.equal(
      events.some((event) => event.type === 'agent_start'),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
