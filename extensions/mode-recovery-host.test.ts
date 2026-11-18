import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostFixture } from './test/host-fixture';
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
    const fixture = hostFixture(
      terra ? terraRecoveryFixtureConfig : recoveryFixtureConfig,
      'router/auto',
      ['extensions/test/mode-recovery-fixture.ts'],
    );
    const result = fixture.run(
      [
        '--tools',
        'write,recovery_fixture_check',
        '--print',
        'Run the local deterministic recovery loop.',
      ],
      undefined,
      17_000,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/Failed to load extension/u);
    expect(readFileSync(join(fixture.cwd, 'recovery-proof.txt'), 'utf8')).toBe(
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
      { model: terra ? 'gpt-6.2-sol' : 'claude-opus-5-5', effort: 'high' },
    ]);
  },
);
