import {
  isRetryableAssistantError,
  normalizeContext,
} from '@earendil-works/pi-ai';
import { streamSimple as streamAnthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { afterEach, expect, it, vi } from 'vitest';
import { normalizeConfig } from './config';
import {
  createProviderHolds,
  observeDelegateFailure,
} from './provider-failover';
import { consume, events, message, model } from './test/fixtures';
import { setup, userContext } from './test/provider-harness';

const fixture = () => {
  const s = setup();
  s.models.push(
    model('opus', { api: 'anthropic-messages', provider: 'claude-work' }),
    model('sonnet', { api: 'anthropic-messages', provider: 'claude-work' }),
    model('sol', { provider: 'openai-work' }),
    model('deepseek', { provider: 'valar' }),
  );
  s.state.currentConfig = normalizeConfig({
    models: {
      opus: { model: 'claude-work/opus', quotaGroup: 'claude-plan' },
      sonnet: { model: 'claude-work/sonnet', quotaGroup: 'claude-plan' },
    },
    profiles: {
      balanced: {
        medium: {
          model: 'opus',
          fallbacks: ['sonnet', 'openai-work/sol', 'valar/deepseek'],
        },
      },
    },
  }).config;
  const result = (turn: number) =>
    consume(s.stream(userContext('prompt', turn)));
  const calls = () => s.delegate.mock.calls.map(([target]) => target.id);
  return { ...s, result, calls };
};

const rejected = (errorMessage: string) => ({
  type: 'error' as const,
  reason: 'error' as const,
  error: message({ stopReason: 'error', errorMessage }),
});

const clock = () => {
  const now = Date.UTC(2026, 10, 19, 12);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  return now;
};

afterEach(() => vi.useRealTimers());

it('uses an independent fallback until the shared Claude window resets', async () => {
  const now = clock();
  const s = fixture();
  const reset = now + 120_000;
  s.delegate.mockImplementationOnce((target, _context, options) => {
    void options?.onResponse?.(
      {
        status: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-reset': String(reset / 1000),
        },
      },
      target,
    );
    return events(rejected('Claude plan limit'));
  });
  expect((await s.result(1)).result.model).toBe('sol');
  expect((await s.result(2)).result.model).toBe('sol');
  expect(s.calls()).toEqual(['opus', 'sol', 'sol']);
  vi.setSystemTime(reset);
  expect((await s.result(3)).result.model).toBe('opus');
});

it('treats an ambiguous 429 as a target hold even when models share a quota group', async () => {
  const now = clock();
  const s = fixture();
  s.delegate.mockImplementationOnce((target, _context, options) => {
    void options?.onResponse?.(
      {
        status: 429,
        headers: { 'retry-after': new Date(now + 30_000).toUTCString() },
      },
      target,
    );
    return events(rejected('throttled'));
  });
  expect((await s.result(1)).result.model).toBe('sonnet');
  expect((await s.result(2)).result.model).toBe('sonnet');
  vi.setSystemTime(now + 30_000);
  expect((await s.result(3)).result.model).toBe('opus');
  expect(s.calls()).toEqual(['opus', 'sonnet', 'sonnet', 'opus']);
});

it('records a hold after output without replaying the response', async () => {
  const s = fixture();
  const partial = message({ content: [{ type: 'text', text: 'partial' }] });
  s.delegate.mockReturnValueOnce(
    events(
      { type: 'text_delta', contentIndex: 0, delta: 'partial', partial },
      rejected('529 overloaded_error'),
    ),
  );
  const { result } = await s.result(1);
  expect(result.stopReason).toBe('error');
  expect(isRetryableAssistantError(result)).toBe(false);
  expect(s.calls()).toEqual(['opus']);
  expect((await s.result(2)).result.model).toBe('sonnet');
  expect(s.calls()).toEqual(['opus', 'sonnet']);
});

it('captures a rejected window on the real Anthropic SDK error path', async () => {
  const now = clock();
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      Response.json(
        { error: { type: 'rate_limit_error', message: 'Quota fixture' } },
        {
          status: 429,
          headers: {
            'retry-after': '90',
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-5h-status': 'rejected',
            'anthropic-ratelimit-unified-5h-reset': String(
              (now + 120_000) / 1000,
            ),
            'anthropic-ratelimit-unified-7d-status': 'rejected',
            'anthropic-ratelimit-unified-7d-reset': String(
              (now + 300_000) / 1000,
            ),
          },
        },
      ),
    ),
  );
  const onResponse = vi.fn();
  const observed = observeDelegateFailure('anthropic-messages', {
    apiKey: 'fixture-key',
    fetch,
    maxRetries: 0,
    onResponse,
  });
  const { compat: _compat, ...target } = model('opus');
  const result = await streamAnthropic(
    { ...target, api: 'anthropic-messages', provider: 'claude-work' },
    normalizeContext(userContext()),
    observed.options,
  ).result();
  expect(fetch).toHaveBeenCalledOnce();
  expect(onResponse).not.toHaveBeenCalled();
  expect(result.stopReason).toBe('error');
  expect(observed.classify(result.errorMessage)).toEqual({
    kind: 'quota',
    shared: true,
    retryAt: now + 300_000,
  });
});

it('does not hold Sonnet for an Opus-only window', async () => {
  const now = clock();
  const s = fixture();
  s.delegate.mockImplementationOnce((target, _context, options) => {
    void options?.onResponse?.(
      {
        status: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
          'anthropic-ratelimit-unified-reset': String((now + 120_000) / 1000),
        },
      },
      target,
    );
    return events(rejected('failed'));
  });
  expect((await s.result(1)).result.model).toBe('sonnet');
  expect((await s.result(2)).result.model).toBe('sonnet');
  expect(s.calls()).toEqual(['opus', 'sonnet', 'sonnet']);
});

it('does not send a request to another provider after a known auth or context error', async () => {
  const s = fixture();
  for (const error of ['401 Unauthorized', '400 prompt is too long']) {
    s.delegate.mockReturnValueOnce(events(rejected(error)));
    expect((await s.result(1)).result).toMatchObject({
      stopReason: 'error',
      errorMessage: error,
    });
  }
  expect(s.calls()).toEqual(['opus', 'opus']);
});

it('fails quickly without triggering Pi auto-retry when all targets are held', async () => {
  const s = fixture();
  s.delegate.mockImplementation(() =>
    events(rejected('503 upstream overloaded')),
  );
  const { result } = await s.result(1);
  expect(result.errorMessage).toContain('cooling down');
  expect(isRetryableAssistantError(result)).toBe(false);
  expect((await s.result(2)).result.errorMessage).toContain('On hold');
  expect(s.calls()).toEqual(['opus', 'sonnet', 'sol', 'deepseek']);
});

it('clears the cooldown streak only when that model succeeds after expiry', () => {
  const now = clock();
  const config = fixture().state.currentConfig;
  const holds = createProviderHolds();
  const ref = 'claude-work/opus';
  expect(holds.record(config, ref, { kind: 'capacity' })?.until).toBe(
    now + 15_000,
  );
  vi.setSystemTime(now + 15_000);
  expect(holds.record(config, ref, { kind: 'capacity' })?.until).toBe(
    now + 45_000,
  );
  holds.success(ref, now);
  expect(holds.lookup(config, ref)).toBeDefined();
  vi.setSystemTime(now + 45_000);
  holds.success(ref, Date.now());
  expect(holds.record(config, ref, { kind: 'capacity' })?.until).toBe(
    now + 60_000,
  );
});

it('keeps quota unknown and billing blocked without retaining provider messages', async () => {
  const now = clock();
  const s = fixture();
  const opus = 'claude-work/opus';
  const config = s.state.currentConfig;
  const holds = createProviderHolds();
  const malformed = observeDelegateFailure('anthropic-messages', {});
  await malformed.options.onResponse?.(
    {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
        'anthropic-ratelimit-unified-reset': 'nonsense',
        'retry-after': 'bogus',
      },
    },
    model('opus'),
  );
  const quota = holds.record(
    config,
    opus,
    malformed.classify('private provider details'),
  );
  expect(quota).toMatchObject({ resetKnown: false, until: now + 15 * 60_000 });
  expect(JSON.stringify(quota)).not.toContain('private provider details');
  const billing = observeDelegateFailure('openai-responses', {});
  const failure = billing.classify(
    '429 {"error":{"code":"billing_hard_limit_reached"}}',
  );
  expect(holds.record(config, opus, failure)).toMatchObject({
    kind: 'billing',
    until: Infinity,
  });
  vi.setSystemTime(now + 24 * 60 * 60_000);
  expect(holds.lookup(config, 'claude-work/sonnet')?.kind).toBe('billing');
});

it('uses the final provider if the independent first backup is also unavailable', async () => {
  const now = clock();
  const s = fixture();
  s.delegate
    .mockImplementationOnce((target, _context, options) => {
      void options?.onResponse?.(
        {
          status: 429,
          headers: {
            'retry-after': '300',
            'anthropic-ratelimit-unified-status': 'rejected',
            'anthropic-ratelimit-unified-representative-claim':
              'seven_day_opus',
            'anthropic-ratelimit-unified-5h-status': 'rejected',
            'anthropic-ratelimit-unified-5h-reset': String(
              (now + 90_000) / 1000,
            ),
          },
        },
        target,
      );
      return events(rejected('Claude plan limit'));
    })
    .mockReturnValueOnce(events(rejected('503 unavailable')));
  expect((await s.result(1)).result.model).toBe('deepseek');
  expect((await s.result(2)).result.model).toBe('deepseek');
  expect(s.calls()).toEqual(['opus', 'sol', 'deepseek', 'deepseek']);
  vi.setSystemTime(now + 90_000);
  expect((await s.result(3)).result.model).toBe('sonnet');
  vi.setSystemTime(now + 300_000);
  expect((await s.result(4)).result.model).toBe('opus');
});
