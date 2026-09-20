import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from '@earendil-works/pi-ai';
import {
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  type ProviderConfig,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { registerRouterProvider } from './provider';
import { runClassifier } from './routing';
import { done, model } from './test/fixtures';

describe('Pi registry integration', () => {
  it.each([
    { name: 'keyless', headers: undefined },
    {
      name: 'headers-only',
      headers: { Authorization: 'Bearer test-only', 'X-Custom': 'custom' },
    },
  ])(
    'dispatches $name custom providers through real Pi auth and transcript normalization',
    async ({ headers }) => {
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      const registry = new ModelRegistry(runtime);
      const custom = vi.fn<NonNullable<ProviderConfig['streamSimple']>>(() =>
        done('Tier: medium\nReasoning: implementation'),
      );
      registry.registerProvider({
        id: 'test',
        name: 'Test',
        getModels: () => [model('primary', { api: 'custom-test-api' })],
        auth: {
          apiKey: {
            name: 'Test auth',
            login: async () => {
              throw new Error('Unexpected login');
            },
            resolve: async () => ({
              auth: { headers, baseUrl: 'https://tenant.example.invalid' },
              source: 'test',
            }),
          },
        },
        stream: () => {
          throw new Error('Unexpected raw stream');
        },
        streamSimple: custom,
      });
      expect(
        await runClassifier('test/primary', registry, {
          messages: [{ role: 'user', content: 'implement', timestamp: 1 }],
        }),
      ).toMatchObject({ tier: 'medium' });
      expect(custom).toHaveBeenCalledOnce();
      const api = {
        registerProvider: (name: string, config: ProviderConfig) =>
          registry.registerProvider(name, config),
      } as unknown as ExtensionAPI;
      registerRouterProvider(
        api,
        {
          currentConfig: {
            profiles: { auto: { medium: { model: 'test/primary' } } },
          },
          currentModelRegistry: registry,
          lastExtensionContext: undefined,
          lastRegisteredModels: '',
          selectedProfile: undefined,
          routerEnabled: false,
          lastDecision: undefined,
          thinkingByProfile: {},
          pinnedTierByProfile: {},
          accumulatedCost: 0,
        },
        {
          persistState: () => {},
          recordDebugDecision: () => {},
          getThinkingOverride: () => undefined,
          updateStatus: () => {},
          syncPiThinkingLevel: () => {},
        },
      );
      const router = registry.find('router', 'auto');
      if (!router) throw new Error('Router registration failed');
      const result = await registry
        .streamSimple(router, {
          messages: [{ role: 'user', content: 'implement', timestamp: 1 }],
        })
        .result();
      expect(result.stopReason).toBe('stop');
      expect(custom).toHaveBeenCalledTimes(2);
      expect(custom.mock.calls[1]?.[2]?.apiKey).toBeUndefined();
      if (headers) {
        expect(custom.mock.calls[0]?.[2]?.headers).toMatchObject(headers);
        expect(custom.mock.calls[1]?.[2]?.headers).toMatchObject(headers);
      }
      expect(custom.mock.calls[0]?.[0].baseUrl).toBe(
        'https://tenant.example.invalid',
      );
      expect(custom.mock.calls[1]?.[0].baseUrl).toBe(
        'https://tenant.example.invalid',
      );
    },
  );
});
