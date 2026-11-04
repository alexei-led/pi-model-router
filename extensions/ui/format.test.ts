import { describe, expect, it } from 'vitest';
import {
  clock,
  latency,
  modelName,
  percent,
  replies,
  signedUsd,
  TIER_DISPLAY_ORDER,
  tierMeter,
  usd,
  usdFine,
} from './format';

describe('tierMeter', () => {
  it.each([
    ['micro', '▂'],
    ['low', '▂▄'],
    ['medium', '▂▄▆'],
    ['high', '▂▄▆█'],
  ] as const)('draws %s as %s', (tier, meter) => {
    expect(tierMeter(tier)).toBe(meter);
  });

  it('lists tiers cheapest first', () => {
    expect(TIER_DISPLAY_ORDER).toEqual(['micro', 'low', 'medium', 'high']);
  });
});

describe('modelName', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-haiku-5-5', 'Haiku 5.5'],
    ['claude-sonnet-4-5-20250929', 'Sonnet 4.5'],
    ['gpt-6.1-terra', 'GPT 6.1 Terra'],
    ['deepseek-flash[1m]', 'DeepSeek Flash'],
    ['claude-opus-5-5-latest', 'Opus 5.5'],
    ['foo', 'Foo'],
  ])('names %s as %s', (id, name) => {
    expect(modelName(id)).toBe(name);
  });
});

describe('usd', () => {
  it.each([
    [0, '$0.00'],
    [0.0049, '<$0.01'],
    [0.005, '$0.01'],
    [1.236, '$1.24'],
    [undefined, 'unknown'],
    [Number.NaN, 'unknown'],
    [-1, 'unknown'],
    [Number.POSITIVE_INFINITY, 'unknown'],
  ])('formats %s as %s', (value, text) => {
    expect(usd(value)).toBe(text);
  });
});

describe('usdFine', () => {
  it.each([
    [0.0042, '$0.0042'],
    [0, '$0.0000'],
    [1.23456, '$1.2346'],
    [undefined, 'unknown'],
    [Number.NaN, 'unknown'],
    [-0.1, 'unknown'],
  ])('formats %s as %s', (value, text) => {
    expect(usdFine(value)).toBe(text);
  });
});

describe('signedUsd', () => {
  it.each([
    ['a drop', -1.86, 3.1, '−$1.86 (−60%)'],
    ['a rise', 0.5, 1, '+$0.50 (+50%)'],
    ['no change', 0, 5, '$0.00'],
    ['a rise past double', 2.48, 0.62, '+$2.48 (×5.0)'],
    ['exactly double', 1, 1, '+$1.00 (+100%)'],
    ['a zero base', 1.5, 0, '+$1.50'],
    ['a change under one percent', 0.001, 5, '+<$0.01'],
  ])('writes %s', (_name, diff, base, text) => {
    expect(signedUsd(diff, base)).toBe(text);
  });
});

describe('latency', () => {
  it.each([
    [0, '0 ms'],
    [999, '999 ms'],
    [1000, '1 s'],
    [1234.4, '1.2 s'],
    [10_000, '10 s'],
    [412.6, '413 ms'],
  ])('formats %s ms as %s', (ms, text) => {
    expect(latency(ms)).toBe(text);
  });
});

describe('percent', () => {
  it.each([
    [0, '0%'],
    [0.126, '13%'],
    [0.5, '50%'],
    [1, '100%'],
  ])('formats %s as %s', (share, text) => {
    expect(percent(share)).toBe(text);
  });
});

describe('replies', () => {
  it.each([
    [0, '0 replies'],
    [1, '1 reply'],
    [2, '2 replies'],
    [12, '12 replies'],
  ])('counts %s as %s', (count, text) => {
    expect(replies(count)).toBe(text);
  });
});

describe('clock', () => {
  it('writes HH:MM:SS in 24-hour form', () => {
    expect(clock(Date.UTC(2026, 10, 4, 15, 7, 9))).toMatch(
      /^\d{2}:\d{2}:\d{2}$/u,
    );
    expect(clock(0)).toMatch(/^\d{2}:\d{2}:\d{2}$/u);
  });
});
