import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCandidate } from './choice';
import { runClassifierDetailed as runNativeClassifierDetailed } from './classifier';
import { DEFAULT_ADVISOR_CONFIG } from './config';
import { typeSafeClassifierRegistry } from './test/fixtures';
import fixtures from './test/fixtures/classifier-systemone.json';
import type {
  AdvisorConfig,
  ClassifierDependencies,
  ClassifierRequest,
} from './types';

const KEY = 'synthetic-private-key-never-log';
const config: AdvisorConfig = {
  ...DEFAULT_ADVISOR_CONFIG,
  enabled: true,
  model: 'typesafe/jev-1.13.0',
};
const runClassifier = (
  config: AdvisorConfig | undefined,
  request: ClassifierRequest,
  dependencies: ClassifierDependencies = {},
) =>
  runNativeClassifierDetailed(
    config,
    request,
    typeSafeClassifierRegistry(KEY),
    dependencies,
  ).then((result) => result.advice);
const runClassifierDetailed = (
  config: AdvisorConfig | undefined,
  request: ClassifierRequest,
  dependencies: ClassifierDependencies = {},
) =>
  runNativeClassifierDetailed(
    config,
    request,
    typeSafeClassifierRegistry(KEY),
    dependencies,
  );
const candidates = [
  createCandidate({
    tier: 'medium',
    model: 'openai/test',
    thinking: 'medium',
  }),
  createCandidate({ tier: 'high', model: 'openai/test', thinking: 'high' }),
];
const request = (
  overrides: Partial<ClassifierRequest> = {},
): ClassifierRequest => ({
  context: {
    messages: [
      { role: 'user', content: 'Synthetic bounded task summary', timestamp: 1 },
    ],
  },
  candidates,
  profile: { models: ['typesafe/jev-1.13.0'] },
  baselineTier: 'medium',
  routingDeadline: performance.now() + 1500,
  ...overrides,
});
const transport = (body: unknown = fixtures.valid, status = 200) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));

const stalledResponse = () => {
  let beginRead: () => void = () => undefined;
  let cancelRead: () => void = () => undefined;
  let didStart = false;
  const started = new Promise<void>((resolve) => {
    beginRead = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    cancelRead = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    pull: () => {
      didStart = true;
      beginRead();
      return new Promise<void>(() => undefined);
    },
    cancel: () => cancelRead(),
  });
  return {
    response: new Response(body, { status: 200 }),
    started,
    cancelled,
    hasStarted: () => didStart,
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('classifier route selection and text bounds', () => {
  it('uses the full distribution to select a conservative route below confidence threshold', async () => {
    const result = await runClassifierDetailed(config, request(), {
      fetch: transport(fixtures.lowConfidence),
    });
    expect(result.advice?.candidateId).toBe(candidates[1]?.id);
    expect(result.diagnostics).toMatchObject({
      outcome: 'selected',
      choice: 'medium',
      selectedTier: 'high',
      selectionBasis: 'probability',
      probability: 0.4,
      routeProbability: 1,
    });
  });
  it('accepts the lowest eligible tier only when cumulative probability meets threshold', async () => {
    const raw = {
      answers: {
        route: {
          type: 'choice',
          choice: candidates[0]?.id,
          confidence: 0.1,
          probabilities: {
            [candidates[0]?.id ?? '']: 0.85,
            [candidates[1]?.id ?? '']: 0.1,
            uncertain: 0.05,
          },
        },
      },
    };
    expect(
      (
        await runClassifierDetailed(config, request(), {
          fetch: transport(raw),
        })
      ).advice?.candidateId,
    ).toBe(candidates[0]?.id);
  });
  it('bounds recent text and excludes private inputs', async () => {
    const result = await runClassifierDetailed(
      config,
      request({
        context: {
          systemPrompt: 'system-secret',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'task-secret' },
                { type: 'image', data: 'image-secret', mimeType: 'image/png' },
              ],
              timestamp: 1,
            },
          ],
        },
      }),
      { fetch: transport() },
    );
    expect(JSON.stringify(result)).not.toMatch(/system-secret|image-secret/);
  });
  it('does not send when disabled, unauthorized or the caller is already aborted', async () => {
    const fetch = transport();
    expect(
      (
        await runClassifierDetailed({ ...config, enabled: false }, request(), {
          fetch,
        })
      ).advice,
    ).toBeUndefined();
    expect(
      (
        await runClassifierDetailed(
          config,
          request({ profile: { models: [] } }),
          { fetch },
        )
      ).advice,
    ).toBeUndefined();
    expect(
      (
        await runClassifierDetailed(
          config,
          request({ signal: AbortSignal.abort() }),
          { fetch },
        )
      ).diagnostics.outcome,
    ).toBe('cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps non-2xx error bodies out of the exact HTTP diagnostics', async () => {
    const secret = 'private-http-error-body';
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(secret, { status: 429, headers: { 'Retry-After': '1' } }),
    );
    const output = await runClassifierDetailed(
      { ...config, maxRetries: 0 },
      request(),
      { fetch },
    );
    expect(output.diagnostics).toMatchObject({
      outcome: 'http-error',
      httpStatus: 429,
      attempts: 1,
    });
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it('records rejected fetches as safe network diagnostics', async () => {
    const secret = 'private-fetch-rejection';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error(secret));
    const output = await runClassifierDetailed(
      { ...config, maxRetries: 0 },
      request(),
      { fetch },
    );
    expect(output.diagnostics).toMatchObject({
      outcome: 'network-error',
      attempts: 1,
    });
    expect(output.diagnostics.httpStatus).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it('maps malformed response bodies to a safe invalid-response diagnostic', async () => {
    const secret = 'private-malformed-response';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(`{"error":"${secret}"`, { status: 200 }));
    const output = await runClassifierDetailed(
      { ...config, maxRetries: 0 },
      request(),
      { fetch },
    );
    expect(output.diagnostics).toMatchObject({
      outcome: 'invalid-response',
      attempts: 1,
    });
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it('rejects oversized response bodies without retaining remote content', async () => {
    const secret = 'private-oversized-response';
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(secret + 'x'.repeat(65536), { status: 200 }),
      );
    const output = await runClassifierDetailed(
      { ...config, maxRetries: 0 },
      request(),
      { fetch },
    );
    expect(output.diagnostics).toMatchObject({
      outcome: 'invalid-response',
      attempts: 1,
    });
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it('cancels a stalled response body at the shared classification deadline', async () => {
    vi.useFakeTimers();
    let now = 0;
    const body = stalledResponse();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(body.response);
    const pending = runClassifierDetailed(
      { ...config, timeoutMs: 1000, maxRetries: 0 },
      request({ routingDeadline: 1000 }),
      { fetch, now: () => now },
    );
    await body.started;
    now = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    const output = await pending;
    await body.cancelled;
    expect(output.diagnostics).toMatchObject({
      outcome: 'deadline',
      timeoutMs: 1000,
      httpStatus: 200,
      attempts: 1,
    });
    expect(JSON.stringify(output)).not.toContain('private');
  });

  it('cancels a stalled response body when the caller aborts', async () => {
    const body = stalledResponse();
    let fetchSignal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      fetchSignal = init?.signal;
      return body.response;
    });
    const caller = new AbortController();
    const pending = runClassifierDetailed(
      { ...config, maxRetries: 0 },
      request({ signal: caller.signal }),
      { fetch },
    );
    await vi.waitFor(() => expect(body.hasStarted()).toBe(true), {
      timeout: 1000,
    });
    expect(fetch).toHaveBeenCalledOnce();
    caller.abort();
    expect(fetchSignal?.aborted).toBe(true);
    const output = await pending;
    await body.cancelled;
    expect(output.diagnostics).toMatchObject({
      outcome: 'cancelled',
      httpStatus: 200,
      attempts: 1,
    });
    expect(JSON.stringify(output)).not.toContain('private');
  });

  it('checks classifier results without leaking provider errors or remote explanations', async () => {
    const output = await runClassifierDetailed(config, request(), {
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              answers: {
                route: {
                  type: 'choice',
                  choice: 'foreign',
                  confidence: 1,
                  probabilities: { foreign: 1 },
                },
              },
              error: 'private-error',
            }),
          ),
      ),
    });
    expect(output.advice).toBeUndefined();
    expect(output.diagnostics).toMatchObject({
      outcome: 'invalid-response',
      responseIssue: 'unknown-choice',
    });
    expect(JSON.stringify(output)).not.toContain('private-error');
  });
});

describe('classifier local candidate identity', () => {
  it('distinguishes identical models by tier and thinking, with collision-safe escaping', () => {
    const pairs = [
      { tier: 'low', model: 'provider/a|b', thinking: 'off' },
      { tier: 'low', model: 'provider/a%7Cb', thinking: 'off' },
      { tier: 'micro', model: 'provider/a|b', thinking: 'off' },
      { tier: 'low', model: 'provider/a|b', thinking: 'low' },
    ] as const;
    expect(new Set(pairs.map((pair) => createCandidate(pair).id)).size).toBe(4);
  });

  it.each([
    { invalid: [] },
    { invalid: [...candidates, ...candidates] },
    { invalid: [{ ...candidates[0], id: 'arbitrary' }] },
    { invalid: [{ ...candidates[0], model: 'not-canonical' }] },
    { invalid: [{ ...candidates[0], thinking: 'invalid' }] },
    { invalid: [{ ...candidates[0], tier: 'unknown' }] },
  ])(
    'rejects malformed, colliding or empty candidates without transport: %j',
    async ({ invalid }) => {
      const fetch = transport();
      await expect(
        runClassifier(
          config,
          request({ candidates: invalid as ClassifierRequest['candidates'] }),
          { fetch },
        ),
      ).resolves.toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
