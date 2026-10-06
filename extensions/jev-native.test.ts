import type {
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierResult,
} from '@earendil-works/pi-ai';
import { classify } from '@earendil-works/pi-ai/api/typesafe-system-one';
import { describe, expect, it, vi } from 'vitest';
import { normalizeJevConfig } from './config';
import { createJevCandidate, runJevDetailed } from './jev';

const key = 'registry-only-test-secret';
const candidate = createJevCandidate({
  tier: 'medium',
  model: 'test/generation',
  thinking: 'off',
});
const model: ClassifierModel<'typesafe-system-one'> = {
  type: 'classifier',
  provider: 'typesafe',
  id: 'jev-latest',
  name: 'Jev',
  api: 'typesafe-system-one',
  baseUrl: 'https://typesafe.fixture.invalid/v1/',
  input: ['text'],
  contextWindow: 64000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const request = () => ({
  context: {
    messages: [
      { role: 'user' as const, content: 'Synthetic task', timestamp: 1 },
    ],
  },
  candidates: [candidate],
  profile: { enabled: true },
  baselineTier: 'medium' as const,
  routingDeadline: performance.now() + 1500,
});
const response = () =>
  new Response(
    JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        route: {
          type: 'choice',
          choice: candidate.id,
          confidence: 1,
          probabilities: { [candidate.id]: 1, uncertain: 0 },
        },
      },
      usage: { input_tokens: 100, output_tokens: 2 },
    }),
  );
describe('Jev uses Pi-owned TypeSafe authentication', () => {
  it('needs no key in router config and keeps an explicit pin on the wire', async () => {
    const config = normalizeJevConfig(
      { enabled: true, model: 'jev-1.13.0' },
      [],
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const registry = {
      findOfType: vi.fn((_type: string, _provider: string, id: string) =>
        id === 'jev-latest' ? model : undefined,
      ),
      classify: vi.fn(
        (
          target: ClassifierModel<ClassifierApi>,
          context: ClassifierContext,
          options?: ClassifierOptions,
        ): Promise<ClassifierResult> =>
          classify(target, context, { ...options, apiKey: key }),
      ),
    };
    const result = await runJevDetailed(config, request(), registry, { fetch });
    expect(result.diagnostics).toMatchObject({
      outcome: 'selected',
      model: 'jev-1.13.0',
      resolvedModel: 'jev-1.13.0',
    });
    expect(registry.classify).toHaveBeenCalledOnce();
    expect(registry.classify.mock.calls[0]?.[2]).not.toHaveProperty('apiKey');
    expect(registry.classify.mock.calls[0]?.[2]).toMatchObject({
      maxRetries: 0,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://typesafe.fixture.invalid/v1/systemone');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${key}`,
    );
    expect(JSON.parse(String(init?.body)).model).toBe('jev-1.13.0');
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each(['returned-error', 'thrown-error'] as const)(
    'does not count a request when Pi authentication fails before fetch: %s',
    async (failure) => {
      const config = normalizeJevConfig({ enabled: true }, []);
      const fetch = vi.fn<typeof globalThis.fetch>();
      const registry = {
        findOfType: () => ({ ...model, id: 'jev-1.13.0' }),
        classify: async (): Promise<ClassifierResult> => {
          if (failure === 'thrown-error') throw new Error(key);
          return {
            api: model.api,
            provider: model.provider,
            model: 'jev-1.13.0',
            answers: {},
            stopReason: 'error',
            errorMessage: key,
            timestamp: 1,
          };
        },
      };
      const result = await runJevDetailed(config, request(), registry, {
        fetch,
      });
      expect(result.advice).toBeUndefined();
      expect(result.diagnostics.requestId).toBeUndefined();
      expect(result.diagnostics.attempts).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(key);
    },
  );
  it('uses one logical request ID for a bounded HTTP retry', async () => {
    const config = normalizeJevConfig(
      { enabled: true, retry: { maxAttempts: 2, backoffMs: 0 } },
      [],
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(response());
    const registry = {
      findOfType: () => ({ ...model, id: 'jev-1.13.0' }),
      classify: (
        target: ClassifierModel<ClassifierApi>,
        context: ClassifierContext,
        options?: ClassifierOptions,
      ) => classify(target, context, { ...options, apiKey: key }),
    };
    const result = await runJevDetailed(config, request(), registry, { fetch });
    expect(result.diagnostics).toMatchObject({
      outcome: 'selected',
      attempts: 2,
    });
    expect(result.diagnostics.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('bounds a stalled Pi auth operation before any HTTP call', async () => {
    const config = normalizeJevConfig({ enabled: true, timeoutMs: 30 }, []);
    let signal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>();
    const registry = {
      findOfType: () => ({ ...model, id: 'jev-1.13.0' }),
      classify: (
        _target: ClassifierModel<ClassifierApi>,
        _context: ClassifierContext,
        options?: ClassifierOptions,
      ) => {
        signal = options?.signal;
        return new Promise<ClassifierResult>(() => undefined);
      },
    };
    const result = await runJevDetailed(config, request(), registry, { fetch });
    expect(result.diagnostics.outcome).toBe('deadline');
    expect(signal?.aborted).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not derive a pin from a foreign registry provider', async () => {
    const config = normalizeJevConfig({ enabled: true }, []);
    const classify = vi.fn();
    const registry = {
      findOfType: (_type: string, _provider: string, id: string) =>
        id === 'jev-latest' ? { ...model, provider: 'foreign' } : undefined,
      classify,
    };
    const result = await runJevDetailed(config, request(), registry);
    expect(result.diagnostics.outcome).toBe('unavailable');
    expect(classify).not.toHaveBeenCalled();
  });
  it('keeps an already-registered pinned model and its provider-owned URL', async () => {
    const config = normalizeJevConfig(
      { enabled: true, model: 'jev-1.13.0' },
      [],
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const registry = {
      findOfType: vi.fn(() => ({
        ...model,
        id: 'jev-1.13.0',
        baseUrl: 'https://owned.fixture.invalid/v1/',
      })),
      classify: (
        target: ClassifierModel<ClassifierApi>,
        context: ClassifierContext,
        options?: ClassifierOptions,
      ) => classify(target, context, { ...options, apiKey: key }),
    };
    const result = await runJevDetailed(config, request(), registry, { fetch });
    expect(result.diagnostics.outcome).toBe('selected');
    expect(registry.findOfType).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://owned.fixture.invalid/v1/systemone',
    );
  });
  it('drops obsolete credentials and endpoint without copying or echoing them', () => {
    const warnings: string[] = [];
    const config = normalizeJevConfig(
      {
        enabled: true,
        apiKey: key,
        endpoint: 'https://api.typesafe.ai/v1/systemone',
      },
      warnings,
    );
    expect(config?.enabled).toBe(true);
    expect(config).not.toHaveProperty('apiKey');
    expect(config).not.toHaveProperty('endpoint');
    expect(warnings.join(' ')).toContain('/login typesafe');
    expect(JSON.stringify({ config, warnings })).not.toContain(key);
  });
  it('does not silently redirect an old custom endpoint to the native service', () => {
    const warnings: string[] = [];
    const config = normalizeJevConfig(
      {
        enabled: true,
        apiKey: key,
        endpoint: 'https://private.fixture.invalid/custom',
      },
      warnings,
    );
    expect(config?.enabled).toBe(false);
    expect(JSON.stringify({ config, warnings })).not.toContain(
      'private.fixture.invalid',
    );
  });
});
