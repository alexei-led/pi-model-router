// Optional Pi 1.3+ extension. Not loaded automatically by pi-model-router.
import {
  type ClassifierApi,
  type ClassifierModel,
  createProvider,
  type Provider,
} from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
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
  // Pi's bundled loader exposes providers/all, not individual provider/API imports.
  const providers = builtinProviders();
  const typesafe = providers.find((provider) => provider.id === 'typesafe');
  const cloudflare = providers.find(
    (provider) => provider.id === 'cloudflare-workers-ai',
  );
  if (!typesafe?.classify || !cloudflare?.classify) {
    throw new Error('Classifier catalog requires Pi 1.3+ built-in classifiers');
  }
  const classify = typesafe.classify.bind(typesafe);

  pi.registerProvider(
    withClassifier(
      typesafe,
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
      cloudflare,
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
      classifiers: { 'typesafe-system-one': { classify } },
    }),
  );
};
