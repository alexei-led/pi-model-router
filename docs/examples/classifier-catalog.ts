// Optional Pi 1.3+ extension. Not loaded automatically by pi-model-router.
import {
  type ClassifierApi,
  type ClassifierModel,
  createProvider,
  type Provider,
} from '@earendil-works/pi-ai';
import { typesafeSystemOneApi } from '@earendil-works/pi-ai/api/typesafe-system-one.lazy';
import { cloudflareWorkersAIProvider } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai';
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const withClassifier = (
  provider: Provider,
  model: ClassifierModel<ClassifierApi>,
): Provider => ({
  ...provider,
  getAllModels: () => {
    const models = provider.getAllModels?.() ?? provider.getModels();
    return models.some(
      (entry) => entry.type === 'classifier' && entry.id === model.id,
    )
      ? models
      : [...models, model];
  },
});

const classifier = (
  provider: string,
  id: string,
  name: string,
  api: ClassifierApi,
  baseUrl: string,
  inputCost: number,
): ClassifierModel<ClassifierApi> => ({
  type: 'classifier',
  provider,
  id,
  name,
  api,
  baseUrl,
  input: ['text'],
  contextWindow: 64000,
  cost: { input: inputCost, output: 0, cacheRead: 0, cacheWrite: 0 },
});

export default (pi: ExtensionAPI): void => {
  pi.registerProvider(
    withClassifier(
      typesafeProvider(),
      classifier(
        'typesafe',
        'jev-1.14.0',
        'Jev 1.14',
        'typesafe-system-one',
        'https://api.typesafe.ai/v1/',
        0.042,
      ),
    ),
  );
  pi.registerProvider(
    withClassifier(
      cloudflareWorkersAIProvider(),
      classifier(
        'cloudflare-workers-ai',
        '@cf/cloudflare/clef-omni',
        'Clef Omni',
        'cloudflare-workers-ai-system-one',
        'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/',
        0.15,
      ),
    ),
  );
  pi.registerProvider(
    createProvider({
      id: 'ollama',
      name: 'Ollama',
      auth: {
        apiKey: {
          name: 'Local Ollama',
          // Pi's System One implementation requires a key; local Ollama ignores it.
          resolve: async ({ credential }) => ({
            auth: { apiKey: credential?.key ?? 'ollama' },
            source: credential ? 'configured key' : 'local Ollama',
          }),
        },
      },
      models: [
        classifier(
          'ollama',
          'nimble',
          'Nimble (local Ollama)',
          'typesafe-system-one',
          'http://localhost:11434/v1/',
          0,
        ),
      ],
      classifiers: { 'typesafe-system-one': typesafeSystemOneApi() },
    }),
  );
};
