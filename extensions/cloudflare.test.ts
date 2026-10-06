import type { ClassifierModel, ClassifierResult } from '@earendil-works/pi-ai';
import { classify } from '@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCloudflareDetailed } from './cloudflare';
import { normalizeCloudflareConfig } from './config';
import { createJevCandidate } from './jev';
import { required } from './test/fixtures';
import wireContract from './test/fixtures/cloudflare-wire.json';
import type { JevRequest } from './types';

const candidates = [
  createJevCandidate({ tier: 'medium', model: 'test/base', thinking: 'off' }),
  createJevCandidate({
    tier: 'high',
    model: 'test/frontier',
    thinking: 'high',
  }),
];
const tuning = required(normalizeCloudflareConfig({ enabled: true }, []));
const request = (overrides: Partial<JevRequest> = {}): JevRequest => ({
  context: {
    messages: [{ role: 'user', content: 'Synthetic task', timestamp: 1 }],
  },
  candidates,
  profile: { enabled: true },
  baselineTier: 'medium',
  routingDeadline: performance.now() + 1500,
  ...overrides,
});
const answer = () => ({
  type: 'choice',
  choice: candidates[1]?.id,
  confidence: 0.9,
  probabilities: {
    [candidates[0]?.id ?? '']: 0.1,
    [candidates[1]?.id ?? '']: 0.9,
    uncertain: 0,
  },
});
const body = (route: unknown = answer()) => ({
  success: true,
  result: { answers: { route }, usage: { input_tokens: 42, output_tokens: 5 } },
});
const modelFor = (
  id: string,
): ClassifierModel<'cloudflare-workers-ai-system-one'> => ({
  type: 'classifier',
  id,
  provider: 'cloudflare-workers-ai',
  name: 'fixture',
  api: 'cloudflare-workers-ai-system-one',
  baseUrl: 'https://fixture.invalid/accounts/synthetic/ai',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
});
const registry = () => ({
  findOfType: vi.fn(
    (
      _type: string,
      _provider: string,
      id: string,
    ): ReturnType<typeof modelFor> | undefined => modelFor(id),
  ),

  // Synthetic auth boundary: native transport receives a key ONLY from registry.
  classify: vi.fn<Parameters<typeof runCloudflareDetailed>[3]['classify']>(
    (model, context, options) =>
      classify(model, context, { ...options, apiKey: 'registry-synthetic' }),
  ),
});
const fetchBody = (raw: unknown = body()) =>
  vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(raw)));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Cloudflare native classifier adapter', () => {
  it.each(['clef', 'clef-flash'] as const)(
    'pins %s selector and delegates auth through public registry',
    async (selection) => {
      const r = registry();
      const fetch = fetchBody();
      const result = await runCloudflareDetailed(
        selection,
        tuning,
        request(),
        r,
        { fetch },
      );
      expect(result.diagnostics).toMatchObject({
        outcome: 'selected',
        model: `@cf/cloudflare/${selection}`,
        actualInputTokens: 42,
        attempts: 1,
      });
      expect(result.advice?.candidateId).toBe(candidates[1]?.id);
      expect(r.findOfType).toHaveBeenCalledWith(
        'classifier',
        'cloudflare-workers-ai',
        `@cf/cloudflare/${selection}`,
      );
      const init = fetch.mock.calls[0]?.[1];
      const wire = JSON.parse(String(init?.body));
      expect(wire).toMatchObject(wireContract.requests[selection]);
      expect(Object.keys(wire.input).sort()).toEqual(
        [...wireContract.requiredInnerFields].sort(),
      );
      expect(wire).toMatchObject({
        model: `@cf/cloudflare/${selection}`,
        input: {
          model: selection,
          state: { currentRequest: { text: 'Synthetic task' } },
          questions: { route: { type: 'choice' } },
        },
      });
      expect(
        JSON.parse(wire.input.questions.route.instructions).objective,
      ).toContain('Prioritize correctness');
      expect(Object.keys(wire.input.questions.route.criteria)).toEqual([
        'uncertain',
        ...candidates.map(({ id }) => id),
      ]);
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer registry-synthetic',
      );
      expect(r.classify.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0 });
      expect(r.classify.mock.calls[0]?.[2]).not.toHaveProperty('apiKey');
      expect(JSON.stringify(result)).not.toContain('registry-synthetic');
    },
  );

  it('accepts the documented nested Completed envelope', async () => {
    const result = await runCloudflareDetailed(
      'clef',
      tuning,
      request(),
      registry(),
      {
        fetch: fetchBody({
          success: true,
          result: {
            state: 'Completed',
            result: { answers: { route: answer() } },
          },
        }),
      },
    );
    expect(result.diagnostics.outcome).toBe('selected');
  });

  it.each([
    { ...answer(), choice: 'foreign' },
    { ...answer(), confidence: 7 },
    {
      ...answer(),
      probabilities: { [candidates[1]?.id ?? '']: 2, uncertain: -1 },
    },
    { ...answer(), probabilities: { [candidates[1]?.id ?? '']: 0.2 } },
    {
      ...answer(),
      probabilities: {
        [candidates[0]?.id ?? '']: 0.9,
        [candidates[1]?.id ?? '']: 0.1,
      },
    },
    {
      ...answer(),
      probabilities: { [candidates[1]?.id ?? '']: 1, foreign: 0 },
    },
  ])('rejects malformed native advice without clamping: %j', async (route) => {
    const result = await runCloudflareDetailed(
      'clef',
      tuning,
      request(),
      registry(),
      { fetch: fetchBody(body(route)) },
    );
    expect(result.diagnostics.outcome).toBe('invalid-response');
    expect(result.advice).toBeUndefined();
  });

  it('abstains and preserves baseline mass for cumulative selection', async () => {
    const fetch = fetchBody(
      body({
        ...answer(),
        choice: 'uncertain',
        probabilities: { uncertain: 1 },
      }),
    );
    expect(
      (
        await runCloudflareDetailed('clef', tuning, request(), registry(), {
          fetch,
        })
      ).diagnostics.outcome,
    ).toBe('uncertain');
    const route = {
      ...answer(),
      confidence: 0.2,
      probabilities: {
        [candidates[0]?.id ?? '']: 0.4,
        [candidates[1]?.id ?? '']: 0.5,
        uncertain: 0.1,
      },
    };
    const result = await runCloudflareDetailed(
      'clef',
      { ...tuning, probabilityThreshold: 0.5 },
      request(),
      registry(),
      { fetch: fetchBody(body(route)) },
    );
    expect(result.advice?.candidateId).toBe(candidates[0]?.id);
  });

  it.each(['disabled', 'no-profile', 'no-model', 'pre-abort'] as const)(
    'makes no native request when %s',
    async (mode) => {
      const r = registry();
      if (mode === 'no-model') r.findOfType.mockReturnValue(undefined);
      const controller = new AbortController();
      if (mode === 'pre-abort') controller.abort();
      const result = await runCloudflareDetailed(
        'clef',
        mode === 'disabled' ? { ...tuning, enabled: false } : tuning,
        request({
          profile: { enabled: mode !== 'no-profile' },
          signal: controller.signal,
        }),
        r,
      );
      expect(result.diagnostics.outcome).toBe(
        mode === 'pre-abort' ? 'cancelled' : 'unavailable',
      );
      expect(r.classify).not.toHaveBeenCalled();
    },
  );

  it.each(['auth', 'fetch', 'body'] as const)(
    'bounds stalled %s and caller cancellation',
    async (phase) => {
      vi.useFakeTimers();
      const r = registry();
      const controller = new AbortController();
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        phase === 'body'
          ? Promise.resolve(new Response(new ReadableStream({ start() {} })))
          : new Promise(() => {}),
      );
      if (phase === 'auth')
        r.classify.mockImplementation(() => new Promise(() => {}));
      const promise = runCloudflareDetailed(
        'clef',
        tuning,
        request({ signal: controller.signal }),
        r,
        { fetch },
      );
      await vi.advanceTimersByTimeAsync(20);
      controller.abort();
      expect((await promise).diagnostics.outcome).toBe('cancelled');
      const timeout = runCloudflareDetailed(
        'clef',
        { ...tuning, timeoutMs: 30 },
        request(),
        r,
        { fetch },
      );
      await vi.advanceTimersByTimeAsync(31);
      expect((await timeout).diagnostics.outcome).toBe('deadline');
    },
  );

  it('rejects oversized bodies and discards unbounded error bodies', async () => {
    const huge = fetchBody({ ...body(), padding: 'x'.repeat(65536) });
    expect(
      (
        await runCloudflareDetailed('clef', tuning, request(), registry(), {
          fetch: huge,
        })
      ).diagnostics.outcome,
    ).toBe('invalid-response');
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(new ReadableStream({ start() {}, cancel }), {
        status: 400,
      }),
    );
    expect(
      (
        await runCloudflareDetailed('clef', tuning, request(), registry(), {
          fetch,
        })
      ).diagnostics.outcome,
    ).toBe('http-error');
    expect(cancel).toHaveBeenCalled();
  });

  it.each([408, 429, 500, 503])(
    'retries status %s once under the total deadline',
    async (status) => {
      const fetch = fetchBody();
      fetch.mockResolvedValueOnce(new Response(null, { status }));
      const result = await runCloudflareDetailed(
        'clef',
        { ...tuning, retry: { maxAttempts: 2, backoffMs: 0 } },
        request(),
        registry(),
        { fetch },
      );
      expect(result.diagnostics).toMatchObject({
        outcome: 'selected',
        attempts: 2,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('does not retry auth/network/nontransient failures or retry-after outside deadline', async () => {
    for (const first of [
      new Response(null, { status: 400 }),
      new Response(null, { status: 429, headers: { 'retry-after': '30' } }),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(first);
      expect(
        (
          await runCloudflareDetailed('clef', tuning, request(), registry(), {
            fetch,
          })
        ).diagnostics.outcome,
      ).toBe('http-error');
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const r = registry();
    r.classify.mockRejectedValue(new Error('secret raw auth error'));
    expect(
      JSON.stringify(await runCloudflareDetailed('clef', tuning, request(), r)),
    ).not.toContain('secret');
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('network'));
    expect(
      (
        await runCloudflareDetailed('clef', tuning, request(), registry(), {
          fetch,
        })
      ).diagnostics.outcome,
    ).toBe('network-error');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['error', 'aborted'] as const)(
    'honors native %s stopReason',
    async (stopReason) => {
      const r = registry();
      r.classify.mockResolvedValue({
        stopReason,
        answers: {},
      } as ClassifierResult);
      expect(
        (await runCloudflareDetailed('clef', tuning, request(), r)).diagnostics
          .outcome,
      ).toBe(stopReason === 'aborted' ? 'cancelled' : 'network-error');
    },
  );
});

describe('Cloudflare absolute deadline edges', () => {
  it('includes context preparation in the absolute deadline', async () => {
    const r = registry();
    const now = vi
      .fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(1600);
    const result = await runCloudflareDetailed(
      'clef',
      tuning,
      request({ routingDeadline: 1500 }),
      r,
      { now },
    );
    expect(result.diagnostics.outcome).toBe('deadline');
    expect(r.classify).not.toHaveBeenCalled();
  });

  it('cannot begin fetch after late auth resolution past the deadline', async () => {
    vi.useFakeTimers();
    const r = registry();
    const original = r.classify.getMockImplementation();
    let resolveAuth = () => {};
    r.classify.mockImplementation(
      (...args) =>
        new Promise((resolve) => {
          resolveAuth = () => {
            void required(original)(...args).then(resolve);
          };
        }),
    );
    const fetch = fetchBody();
    const pending = runCloudflareDetailed(
      'clef',
      { ...tuning, timeoutMs: 20 },
      request(),
      r,
      { fetch },
    );
    await vi.advanceTimersByTimeAsync(21);
    expect((await pending).diagnostics.outcome).toBe('deadline');
    resolveAuth();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lets a stalled second attempt consume only the remaining budget', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'retry-after-ms': '20' },
        }),
      )
      .mockImplementation(() => new Promise(() => {}));
    const pending = runCloudflareDetailed(
      'clef',
      { ...tuning, timeoutMs: 200, retry: { maxAttempts: 2, backoffMs: 0 } },
      request(),
      registry(),
      { fetch },
    );
    await vi.advanceTimersByTimeAsync(201);
    const result = await pending;
    expect(result.diagnostics).toMatchObject({
      outcome: 'deadline',
      attempts: 2,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('Cloudflare model identity', () => {
  it.each(['provider', 'id', 'api', 'type'] as const)(
    'rejects a registry result with foreign %s',
    async (field) => {
      const r = registry();
      r.findOfType.mockReturnValue({
        ...modelFor('@cf/cloudflare/clef'),
        [field]: 'foreign',
      } as unknown as ReturnType<typeof modelFor>);
      const result = await runCloudflareDetailed('clef', tuning, request(), r);
      expect(result.diagnostics.outcome).toBe('unavailable');
      expect(r.classify).not.toHaveBeenCalled();
    },
  );
});
