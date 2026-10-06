import { runChoiceDetailed } from './choice';
import { normalizeCloudflareConfig } from './config';
import type {
  ChoiceRegistry,
  CloudflareConfig,
  JevDependencies,
  JevRequest,
  JevResult,
} from './types';

/** The selector is fixed; Pi resolves Cloudflare credentials and the account endpoint. */
export const runCloudflareDetailed = async (
  selection: 'clef' | 'clef-flash',
  config: CloudflareConfig | undefined,
  request: JevRequest,
  registry: ChoiceRegistry,
  dependencies: JevDependencies = {},
): Promise<JevResult> =>
  runChoiceDetailed(
    {
      provider: 'cloudflare-workers-ai',
      modelId: `@cf/cloudflare/${selection}`,
      api: 'cloudflare-workers-ai-system-one',
    },
    normalizeCloudflareConfig(config, []),
    request,
    registry,
    dependencies,
  );
