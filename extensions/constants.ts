export const MAX_DEBUG_HISTORY = 12;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

const AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cf-aig-authorization',
]);

export interface RegistryWithProviderAuth {
  getProviderAuth?: (
    provider: string,
  ) => Promise<{ auth: { baseUrl?: string } } | undefined>;
}

export const hasUsableRequestAuth = (auth: {
  apiKey?: string;
  headers?: Record<string, string | null | undefined>;
}): boolean => {
  if (typeof auth.apiKey === 'string' && auth.apiKey.trim().length > 0) {
    return true;
  }

  return Object.entries(auth.headers ?? {}).some(
    ([name, value]) =>
      AUTH_HEADERS.has(name.toLowerCase()) &&
      typeof value === 'string' &&
      value.trim().length > 0,
  );
};

export const resolveDelegatedModel = async <
  TModel extends { provider: string; baseUrl: string },
>(
  registry: RegistryWithProviderAuth,
  model: TModel,
): Promise<TModel> => {
  try {
    const providerAuth = await registry.getProviderAuth?.(model.provider);
    const authBaseUrl = providerAuth?.auth.baseUrl;
    if (authBaseUrl && authBaseUrl !== model.baseUrl) {
      return { ...model, baseUrl: authBaseUrl };
    }
  } catch {
    // Older Pi versions and unavailable credentials use the model's static URL.
  }
  return model;
};
