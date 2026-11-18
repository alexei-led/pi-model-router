import { expect, it } from 'vitest';
import { hostFixture } from './test/host-fixture';

it.each([
  ['openai', {}, 'gpt-6.2-sol', 'medium'],
  ['anthropic', {}, 'claude-opus-5-5', 'medium'],
  [
    'openai',
    { activities: { debug: { medium: { thinking: 'xhigh' } } } },
    'gpt-6.2-sol',
    'xhigh',
  ],
  [
    'openai',
    { activities: { debug: { medium: null } } },
    'gpt-6.2-sol',
    'medium',
  ],
  ['openai', { activityPreset: 'off' }, 'gpt-6.2-sol', 'medium'],
] as const)(
  'native Pi delegates %s defaults/tuning %j to %s/%s',
  { timeout: 15000 },
  (family, tuning, target, effort) => {
    const fixture = hostFixture(
      {
        advisor: { enabled: true, model: 'preset-classifier/choice' },
        profiles: {
          auto: {
            advisor: { models: ['preset-classifier/choice'] },
            medium: {
              model: `preset-${family}/${family === 'openai' ? 'gpt-6.2-sol' : 'claude-sonnet-5-5'}`,
              thinking: 'medium',
            },
            ...tuning,
          },
        },
      },
      'router/auto',
      ['extensions/test/preset-router-fixture.ts'],
    );
    const result = fixture.run(
      ['--no-tools', '--print', 'Diagnose the fixture failure.'],
      undefined,
      12_000,
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
