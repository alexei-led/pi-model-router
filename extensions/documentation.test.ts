import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { mergeConfig, normalizeConfig, normalizeTierConfig } from './config';
import { isObjectRecord } from './domain';
import { required } from './test/fixtures';

const jsonExamples = (path: string) =>
  [
    ...readFileSync(new URL(path, import.meta.url), 'utf8').matchAll(
      /```json\n([\s\S]*?)\n```/gu,
    ),
  ].map((match) => {
    const value: unknown = JSON.parse(required(match[1]));
    if (!isObjectRecord(value)) throw new Error('Expected an object example');
    return value;
  });

it('the first-profile guide produces a recognized preset without enabling external advice', () => {
  const { config, warnings } = normalizeConfig(
    required(jsonExamples('../docs/user-guide.md')[0]),
  );
  expect(warnings).toEqual([]);
  expect(config.profiles.auto).toMatchObject({
    activityPresetFamily: 'openai',
    baselineTier: 'medium',
    medium: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
  });
  expect(config.advisor?.enabled).not.toBe(true);
});

it('activity-tuning examples change effort, reset a cell and independently disable presets or routing', () => {
  const base = required(jsonExamples('../docs/user-guide.md')[0]);
  const examples = jsonExamples('../docs/activity-routing.md');
  const tuned = normalizeConfig(mergeConfig(base, required(examples[0])));
  expect(tuned.warnings).toEqual([]);
  expect(tuned.config.profiles.auto?.activities?.debug?.medium).toMatchObject({
    model: 'openai-codex/gpt-6.1-sol',
    thinking: 'high',
  });
  expect(
    normalizeTierConfig(required(examples[1]), 'auto/debug', 'medium', []),
  ).toMatchObject({ model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' });
  const reset = normalizeConfig(mergeConfig(base, required(examples[2])));
  expect(reset.warnings).toEqual([]);
  expect(reset.config.profiles.auto?.activities?.ops?.medium).toBeUndefined();
  expect(reset.config.profiles.auto?.activities?.debug?.medium).toBeDefined();
  const optedOut = normalizeConfig(mergeConfig(base, required(examples[3])));
  expect(optedOut.warnings).toEqual([]);
  expect(optedOut.config.profiles.auto?.activities).toBeUndefined();
  const off = normalizeConfig(mergeConfig(base, required(examples[4])));
  expect(off.warnings).toEqual([]);
  expect(off.config.activityRouting).toBe('off');
  expect(off.config.profiles.auto?.activities?.debug?.medium).toBeDefined();
});
