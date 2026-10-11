import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { onTestFinished, test } from 'vitest';
import { adaptiveFixtureConfig } from './test/adaptive-router-fixture';

test('actual Pi loop changes tier, activity and physical effort in both directions', {
  timeout: 30000,
}, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-adaptive-host-'));
  onTestFinished(() => rmSync(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, 'agent');
  mkdirSync(agentDir);
  writeFileSync(
    join(agentDir, 'model-router.json'),
    JSON.stringify(adaptiveFixtureConfig),
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
      '--extension',
      resolve('extensions/test/adaptive-router-fixture.ts'),
      '--model',
      'router/adaptive',
      '--print',
      'Run the local adaptive fixture loop.',
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
      timeout: 25000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Failed to load extension|Error:/);
  const raw = result.stdout.match(/ADAPTIVE_FIXTURE_TRACE (\{[^\n]+\})/u)?.[1];
  assert.ok(raw, result.stdout);
  const trace: unknown = JSON.parse(raw);
  assert.ok(
    trace &&
      typeof trace === 'object' &&
      'physical' in trace &&
      Array.isArray(trace.physical),
  );
  const physical = trace.physical as {
    request: number;
    model: string;
    effort: string;
  }[];
  assert.equal(physical.length, 21);
  assert.ok(
    physical.some(
      (entry) => entry.model === 'deep' && entry.effort === 'xhigh',
    ),
    JSON.stringify(physical),
  );
  assert.ok(
    physical.some((entry) => entry.model === 'docs'),
    JSON.stringify(physical),
  );
  assert.equal(physical.at(-1)?.model, 'balanced');
  assert.equal(physical.at(-1)?.effort, 'low');
  assert.ok('observed' in trace && Array.isArray(trace.observed));
  const observed = trace.observed as { tier: string; activity?: string }[];
  assert.ok(
    observed.some(
      (entry) => entry.tier === 'high' && entry.activity === 'debug',
    ),
    JSON.stringify(observed),
  );
  assert.ok(
    observed.some(
      (entry) => entry.tier === 'medium' && entry.activity === 'docs',
    ),
    JSON.stringify(observed),
  );
});
