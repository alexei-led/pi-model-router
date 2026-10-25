import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

it.each([
  ['openai', {}, 'gpt-6.1-sol', 'high'],
  ['anthropic', {}, 'claude-opus-5-5', 'medium'],
  [
    'openai',
    { activities: { debug: { medium: { thinking: 'xhigh' } } } },
    'gpt-6.1-sol',
    'xhigh',
  ],
  [
    'openai',
    { activities: { debug: { medium: null } } },
    'gpt-6.1-sol',
    'medium',
  ],
  ['openai', { activityPreset: 'off' }, 'gpt-6.1-sol', 'medium'],
] as const)(
  'native Pi delegates %s defaults/tuning %j to %s/%s',
  { timeout: 15000 },
  (family, tuning, target, effort) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-preset-host-'));
    onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
    const agentDir = join(cwd, 'agent');
    mkdirSync(agentDir);
    writeFileSync(
      join(agentDir, 'model-router.json'),
      JSON.stringify({
        advisor: { enabled: true, model: 'preset-classifier/choice' },
        profiles: {
          auto: {
            advisor: { models: ['preset-classifier/choice'] },
            medium: {
              model: `preset-${family}/${family === 'openai' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5'}`,
              thinking: 'medium',
            },
            ...tuning,
          },
        },
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
        '--no-tools',
        '--no-session',
        '--extension',
        resolve('extensions/index.ts'),
        '--extension',
        resolve('extensions/test/preset-router-fixture.ts'),
        '--model',
        'router/auto',
        '--print',
        'Diagnose the fixture failure.',
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
        timeout: 12000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/Failed to load extension|Error:/u);
    const output: unknown = JSON.parse(
      result.stdout.match(/PRESET_PHYSICAL (\{[^\n]+\})/u)?.[1] ?? 'null',
    );
    expect(output).toEqual({
      provider: `preset-${family}`,
      model: target,
      effort,
    });
  },
);
