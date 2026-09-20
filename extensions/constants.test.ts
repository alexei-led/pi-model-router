import { describe, expect, it, vi } from 'vitest';
import { hasUsableRequestAuth, resolveDelegatedModel } from './constants';

describe('constants.ts helpers', () => {
  describe('hasUsableRequestAuth', () => {
    it('accepts a non-empty API key', () => {
      expect(hasUsableRequestAuth({ apiKey: 'token' })).toBe(true);
      expect(hasUsableRequestAuth({ apiKey: '   ' })).toBe(false);
    });

    it.each(['Authorization', 'x-api-key', 'CF-AIG-Authorization'])(
      'accepts %s headers-only authentication',
      (header) => {
        expect(hasUsableRequestAuth({ headers: { [header]: 'token' } })).toBe(
          true,
        );
      },
    );

    it('rejects missing or unrelated authentication headers', () => {
      expect(hasUsableRequestAuth({})).toBe(false);
      expect(hasUsableRequestAuth({ headers: { 'x-request-id': 'id' } })).toBe(
        false,
      );
    });
  });

  describe('resolveDelegatedModel', () => {
    const model = {
      provider: 'github-copilot',
      baseUrl: 'https://api.github.com',
      id: 'model',
    };

    it('uses a credential-specific provider URL when available', async () => {
      const registry = {
        getProviderAuth: vi.fn().mockResolvedValue({
          auth: { baseUrl: 'https://enterprise.example.com' },
        }),
      };

      await expect(resolveDelegatedModel(registry, model)).resolves.toEqual({
        ...model,
        baseUrl: 'https://enterprise.example.com',
      });
    });

    it('keeps the static URL when provider auth is unavailable or fails', async () => {
      const noAuthRegistry = {
        getProviderAuth: vi.fn().mockResolvedValue(undefined),
      };
      const failingRegistry = {
        getProviderAuth: vi.fn().mockRejectedValue(new Error('expired auth')),
      };

      await expect(resolveDelegatedModel(noAuthRegistry, model)).resolves.toBe(
        model,
      );
      await expect(resolveDelegatedModel(failingRegistry, model)).resolves.toBe(
        model,
      );
    });
  });
});
