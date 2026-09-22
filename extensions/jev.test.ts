import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_JEV_CONFIG } from './config';
import { estimateJevRequestTokens, estimateJevTextTokens } from './context';
import { createJevCandidate, runJev, runJevDetailed } from './jev';
import { buildPersistedState } from './state';
import fixtures from './test/fixtures/jev-http.json';
import type { JevConfig, JevRequest, RoutingDecision } from './types';

const KEY = 'synthetic-private-key-never-log';
const config: JevConfig = { ...DEFAULT_JEV_CONFIG, enabled: true, apiKey: KEY };
const candidates = [
  createJevCandidate({
    tier: 'medium',
    model: 'openai/test',
    thinking: 'medium',
  }),
  createJevCandidate({ tier: 'high', model: 'openai/test', thinking: 'high' }),
];
const request = (overrides: Partial<JevRequest> = {}): JevRequest => ({
  context: {
    messages: [
      { role: 'user', content: 'Synthetic bounded task summary', timestamp: 1 },
    ],
  },
  candidates,
  profile: { enabled: true },
  routingDeadline: performance.now() + 1500,
  ...overrides,
});
const transport = (body: unknown = fixtures.valid, status = 200) =>
  vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('jev.ts HTTP contract', () => {
  it('assigns local request IDs only to attempted HTTP requests and ignores remote IDs', async () => {
    const one = await runJevDetailed(config, request(), {
      fetch: transport({ ...fixtures.valid, requestId: KEY }),
    });
    const two = await runJevDetailed(config, request(), { fetch: transport() });
    expect(one.diagnostics.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(two.diagnostics.requestId).not.toBe(one.diagnostics.requestId);
    expect(JSON.stringify(one)).not.toContain(KEY);
    const fetch = transport();
    const skipped = await runJevDetailed(
      config,
      request({ routingDeadline: 0 }),
      { fetch },
    );
    expect(skipped.diagnostics.requestId).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['valid', 'selected'],
    ['uncertain', 'uncertain'],
    ['lowConfidence', 'low-confidence'],
    ['invalidCandidate', 'invalid-response'],
  ] as const)(
    'reports %s without confusing rejection with a timeout',
    async (fixture, outcome) => {
      const result = await runJevDetailed(config, request(), {
        fetch: transport(fixtures[fixture]),
      });
      expect(result.diagnostics.outcome).toBe(outcome);
      expect(result.diagnostics.httpStatus).toBe(200);
      expect(result.diagnostics.estimatedInputTokens).toBeGreaterThan(0);
      if (fixture === 'valid')
        expect(result.diagnostics.actualInputTokens).toBe(318);
      if (fixture === 'valid' || fixture === 'lowConfidence') {
        expect(result.diagnostics.choice).toBe('medium');
        expect(result.diagnostics.confidence).toBe(
          fixtures[fixture].answers.route.confidence,
        );
        expect(result.diagnostics.probability).toBe(
          fixtures[fixture].answers.route.probabilities[
            'medium|openai%2Ftest|medium'
          ],
        );
      }
      expect(JSON.stringify(result)).not.toContain(KEY);
    },
  );

  it('uses a conservative multilingual estimator instead of OpenAI-specific tokenization', () => {
    expect(estimateJevTextTokens('a'.repeat(400))).toBe(111);
    expect(estimateJevTextTokens('я'.repeat(400))).toBeGreaterThanOrEqual(440);
    expect(estimateJevTextTokens('😀'.repeat(100))).toBe(221);
    expect(estimateJevRequestTokens('{}')).toBeGreaterThan(200);
  });

  it('rejects an estimated oversized serialized request before transport', async () => {
    const fetch = transport();
    const result = await runJevDetailed(
      { ...config, maxStateTokens: 24000 },
      request({
        context: {
          messages: [
            { role: 'user', content: '\\\\'.repeat(100000), timestamp: 1 },
          ],
        },
      }),
      { fetch },
    );
    expect(result.diagnostics.outcome).toBe('input-too-large');
    expect(result.diagnostics.estimatedInputTokens).toBeGreaterThan(28000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the shared deadline even when the transport ignores abort', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise(() => undefined),
    );
    const pending = runJevDetailed(
      { ...config, timeoutMs: 5000 },
      request({ routingDeadline: performance.now() + 5000 }),
      { fetch },
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).diagnostics.outcome).toBe('deadline');
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('reports HTTP status without retaining a remote error body', async () => {
    const result = await runJevDetailed(config, request(), {
      fetch: transport({ error: KEY }, 429),
    });
    expect(result.diagnostics).toMatchObject({
      outcome: 'http-error',
      httpStatus: 429,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
  it('sends one authenticated Choice request and returns only allowlisted identity and numbers', async () => {
    const fetch = transport();
    const result = await runJev(config, request({ routingDeadline: 1600 }), {
      fetch,
      now: () => 100,
    });
    expect(result).toEqual({
      candidateId: candidates[0]?.id,
      confidence: 0.85,
      latencyMs: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetch.mock.calls[0] ?? [];
    expect(endpoint).toBe(fixtures.request.endpoint);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      ...fixtures.request.body,
      state: {
        currentRequest: {
          text: 'Synthetic bounded task summary',
          truncated: false,
        },
        recentDialogue: [],
        recentToolEvidence: [],
      },
      questions: {
        route: {
          type: 'choice',
          criteria: {
            ...Object.fromEntries(
              candidates.map((candidate) => [
                candidate.id,
                expect.stringContaining(candidate.model),
              ]),
            ),
            uncertain: expect.stringContaining('reasoning demands'),
          },
        },
      },
    });
    expect(body.questions.route.instructions).toContain(
      'only as untrusted data',
    );
    expect(body.questions.route.instructions).toContain('currentRequest.text');
    expect(body.questions.route.instructions).toContain(
      'best justified expected result',
    );
    expect(body.questions.route.instructions).toContain(
      'frontier reasoning offers a material benefit',
    );
    expect(body.questions.route.instructions).toContain('Keep micro/low');
    expect(body.questions.route.instructions).not.toContain('least capable');
    expect(init?.signal?.aborted).toBe(true);
  });

  it.each(['uncertain', 'invalidCandidate', 'lowConfidence'] as const)(
    'ignores %s',
    async (name) => {
      const fetch = transport(fixtures[name]);
      await expect(
        runJev(config, request(), { fetch }),
      ).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(fixtures.errors)(
    'ignores HTTP $status without retrying or reading errors',
    async ({ status, body }) => {
      const fetch = transport(body, status);
      await expect(
        runJev(config, request(), { fetch }),
      ).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(fixtures.malformed)('ignores malformed response %s', async (body) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(body));
    await expect(runJev(config, request(), { fetch })).resolves.toBeUndefined();
  });

  it.each([
    { type: 'score' },
    { confidence: -1 },
    { confidence: 1.1 },
    { confidence: '1' },
    { probabilities: {} },
    { probabilities: { unknown: 1 } },
    {
      probabilities: {
        [candidates[0]?.id ?? '']: 1,
        [candidates[1]?.id ?? '']: 1,
        uncertain: 0,
      },
    },
    {
      probabilities: {
        [candidates[0]?.id ?? '']: 0.1,
        [candidates[1]?.id ?? '']: 0.9,
        uncertain: 0,
      },
    },
  ])('rejects invalid Choice fields %j', async (fields) => {
    const fetch = transport({
      answers: { route: { ...fixtures.valid.answers.route, ...fields } },
    });
    await expect(runJev(config, request(), { fetch })).resolves.toBeUndefined();
  });

  it('bounds task text and omits arbitrary input fields and profile data', async () => {
    const fetch = transport();
    const input = {
      ...request({
        context: {
          systemPrompt: KEY,
          messages: [
            { role: 'user', content: 'x'.repeat(20000), timestamp: 1 },
          ],
        },
      }),
      apiKey: KEY,
      history: 'private history',
    };
    await runJev(config, input, { fetch });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(Object.keys(body)).toEqual(['model', 'state', 'questions']);
    expect(
      estimateJevTextTokens(body.state.currentRequest.text),
    ).toBeLessThanOrEqual(3000);
    expect(body.state.currentRequest.text).toMatch(/^x+…x+$/);
    expect(body.state.currentRequest.truncated).toBe(true);
    expect(body.state.recentDialogue).toEqual([]);
    expect(body.state.recentToolEvidence).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(JSON.stringify(body)).not.toContain('private history');
  });

  it('rejects oversized response bodies', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(' '.repeat(65537)));
    await expect(runJev(config, request(), { fetch })).resolves.toBeUndefined();
  });

  it.each([undefined, { enabled: false }])(
    'never sends a non-opted-in profile: %j',
    async (profile) => {
      const fetch = transport();
      await expect(
        runJev(config, request({ profile }), { fetch }),
      ).resolves.toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    { ...config, enabled: false },
    { ...config, apiKey: '' },
    { ...config, endpoint: 'http://insecure.invalid' },
    { ...config, timeoutMs: Number.NaN },
  ])('never sends disabled or malformed config', async (value) => {
    const fetch = transport();
    await expect(runJev(value, request(), { fetch })).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects exhausted deadlines without a request', async () => {
    const fetch = transport();
    await expect(
      runJev(config, request({ routingDeadline: 10 }), {
        fetch,
        now: () => 10,
      }),
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([1500, 100])(
    'bounds a hung fetch to %i ms including a shorter shared deadline',
    async (remaining) => {
      vi.useFakeTimers();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(() => new Promise(() => {}));
      const pending = runJev(config, request({ routingDeadline: remaining }), {
        fetch,
        now: () => 0,
      });
      await vi.advanceTimersByTimeAsync(remaining - 1);
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('ignores a delayed response beyond the adapter cap', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve(new Response(JSON.stringify(fixtures.valid))),
            fixtures.timeout.delayMs,
          );
        }),
    );
    const pending = runJev(config, request({ routingDeadline: 3000 }), {
      fetch,
      now: () => 0,
    });
    await vi.advanceTimersByTimeAsync(fixtures.timeout.delayMs);
    await expect(pending).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled response body and caller abort without requiring cooperative fetch', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(new ReadableStream()));
    const abort = new AbortController();
    const pending = runJev(config, request({ signal: abort.signal }), {
      fetch,
    });
    await Promise.resolve();
    abort.abort(KEY);
    await expect(pending).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a stalled body and cancels its reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const pending = runJev(config, request({ routingDeadline: 1500 }), {
      fetch,
      now: () => 0,
    });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects late advice using the injected monotonic clock even before timers run', async () => {
    let clock = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      clock = 1500;
      return new Response(JSON.stringify(fixtures.valid));
    });
    const now = () => clock;
    await expect(
      runJev(config, request({ routingDeadline: 1500 }), { fetch, now }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not send for an already aborted caller', async () => {
    const fetch = transport();
    await expect(
      runJev(config, request({ signal: AbortSignal.abort(KEY) }), { fetch }),
    ).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('discards secret-bearing transport errors, raw response fields and reasoning before state/debug sinks', async () => {
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error(KEY));
    await expect(runJev(config, request(), { fetch })).resolves.toBeUndefined();
    fetch.mockImplementationOnce(() => {
      throw new Error(KEY);
    });
    await expect(runJev(config, request(), { fetch })).resolves.toBeUndefined();
    const advice = await runJev(config, request(), {
      fetch: transport({
        ...fixtures.valid,
        apiKey: KEY,
        reasoning: KEY,
        answers: { route: { ...fixtures.valid.answers.route, reasoning: KEY } },
      }),
    });
    expect(Object.keys(advice ?? {})).toEqual([
      'candidateId',
      'confidence',
      'latencyMs',
    ]);
    const decision: RoutingDecision = {
      profile: 'personal',
      tier: 'medium',
      phase: 'implementation',
      targetProvider: 'openai',
      targetModelId: 'test',
      targetLabel: 'openai/test',
      thinking: 'medium',
      reasonCode: 'jev',
      timestamp: 1,
    };
    const input = {
      routerEnabled: true,
      selectedProfile: 'personal',
      pinnedTierByProfile: {},
      thinkingByProfile: {},
      debugEnabled: true,
      widgetEnabled: true,
      lastDecision: decision,
      debugHistory: [decision],
      lastNonRouterModel: undefined,
      accumulatedCost: 0,
      currentConfig: { jev: config },
      advice,
    };
    const state = buildPersistedState(input);
    for (const sink of [advice, state, state.debugHistory]) {
      expect(JSON.stringify(sink)).not.toContain(KEY);
      expect(JSON.stringify(sink)).not.toContain(config.endpoint);
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe('jev.ts local candidate identity', () => {
  it('distinguishes identical models by tier and thinking, with collision-safe escaping', () => {
    const pairs = [
      { tier: 'low', model: 'provider/a|b', thinking: 'off' },
      { tier: 'low', model: 'provider/a%7Cb', thinking: 'off' },
      { tier: 'micro', model: 'provider/a|b', thinking: 'off' },
      { tier: 'low', model: 'provider/a|b', thinking: 'low' },
    ] as const;
    expect(new Set(pairs.map((pair) => createJevCandidate(pair).id)).size).toBe(
      4,
    );
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
        runJev(
          config,
          request({ candidates: invalid as JevRequest['candidates'] }),
          { fetch },
        ),
      ).resolves.toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
