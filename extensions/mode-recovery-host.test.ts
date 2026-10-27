import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  recoveryFixtureConfig,
  terraRecoveryFixtureConfig,
} from './test/mode-recovery-fixture';

it.each([false, true])(
  'native Pi recovers cost high (Terra: %s) after a real write between two failing tool results',
  {
    timeout: 20000,
  },
  (terra) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-recovery-host-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
    const agentDir = join(cwd, 'agent');
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, 'model-router.json'),
      JSON.stringify(
        terra ? terraRecoveryFixtureConfig : recoveryFixtureConfig,
      ),
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
        '--tools',
        'write,recovery_fixture_check',
        '--extension',
        resolve('extensions/index.ts'),
        '--extension',
        resolve('extensions/test/mode-recovery-fixture.ts'),
        '--model',
        'router/auto',
        '--print',
        'Run the local deterministic recovery loop.',
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
        timeout: 17000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/Failed to load extension/u);
    expect(readFileSync(join(cwd, 'recovery-proof.txt'), 'utf8')).toBe(
      'Local recovery fixture wrote this file.\n',
    );
    const physical: unknown = JSON.parse(
      result.stdout.match(/RECOVERY_PHYSICAL (\[[^\n]+\])/u)?.[1] ?? 'null',
    );
    expect(physical).toEqual([
      {
        model: terra ? 'gpt-6.1-terra' : 'claude-haiku-5-5',
        effort: terra ? 'medium' : 'high',
      },
      {
        model: terra ? 'gpt-6.1-terra' : 'claude-haiku-5-5',
        effort: terra ? 'medium' : 'high',
      },
      {
        model: terra ? 'gpt-6.1-terra' : 'claude-haiku-5-5',
        effort: terra ? 'medium' : 'high',
      },
      { model: terra ? 'gpt-6.1-sol' : 'claude-opus-5-5', effort: 'high' },
    ]);
  },
);
