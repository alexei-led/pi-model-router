import assert from 'node:assert/strict';
import { test } from 'vitest';
import { adaptiveFixtureConfig } from './test/adaptive-router-fixture';
import { hostFixture } from './test/host-fixture';

test('actual Pi loop changes tier, activity and physical effort in both directions', {
  timeout: 30000,
}, () => {
  const fixture = hostFixture(adaptiveFixtureConfig, 'router/adaptive', [
    'extensions/test/adaptive-router-fixture.ts',
  ]);
  const result = fixture.run(
    ['--print', 'Run the local adaptive fixture loop.'],
    undefined,
    25_000,
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
