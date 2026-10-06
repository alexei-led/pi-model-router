import { runChoiceDetailed } from './choice';
import { normalizeJevConfig } from './config';
import type {
  ChoiceRegistry,
  JevAdvice,
  JevConfig,
  JevDependencies,
  JevRequest,
  JevResult,
} from './types';

export { createJevCandidate } from './choice';

/** TypeSafe credentials, configured provider URLs and HTTP dispatch belong to Pi. */
export const runJevDetailed = async (
  config: JevConfig | undefined,
  request: JevRequest,
  registry: ChoiceRegistry,
  dependencies: JevDependencies = {},
): Promise<JevResult> => {
  const tuning = normalizeJevConfig(config, []);
  return runChoiceDetailed(
    {
      provider: 'typesafe',
      modelId: tuning?.model ?? '',
      api: 'typesafe-system-one',
    },
    tuning,
    request,
    registry,
    dependencies,
  );
};

export const runJev = async (
  config: JevConfig | undefined,
  request: JevRequest,
  registry: ChoiceRegistry,
  dependencies: JevDependencies = {},
): Promise<JevAdvice | undefined> =>
  (await runJevDetailed(config, request, registry, dependencies)).advice;
