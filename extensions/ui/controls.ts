import { isRouterMode } from '../domain';
import type { RouterUIControls } from '../types';

export const validateRouterUIControls = (
  controls: Readonly<RouterUIControls>,
): string | undefined => {
  if (controls.mode !== undefined && !isRouterMode(controls.mode))
    return 'Mode must be cost, balanced, quality or inherited.';
  if (
    controls.budget !== undefined &&
    (!Number.isFinite(controls.budget) || controls.budget <= 0)
  )
    return 'Budget must be positive and finite.';
  if (
    !Number.isFinite(controls.timeout) ||
    controls.timeout <= 0 ||
    controls.timeout > 2147483647
  )
    return 'Timeout must be positive, finite and at most 2147483647 ms.';
  if (
    !Number.isSafeInteger(controls.reviewEveryRequests) ||
    controls.reviewEveryRequests < 0 ||
    controls.reviewEveryRequests > 1000
  )
    return 'Review interval must be 0–1000 requests.';
  if (
    !Number.isSafeInteger(controls.costHorizon) ||
    controls.costHorizon < 1 ||
    controls.costHorizon > 20
  )
    return 'Cost horizon must be 1–20 requests.';
  if (
    !Number.isFinite(controls.costSensitivity) ||
    controls.costSensitivity < 0 ||
    controls.costSensitivity > 1
  )
    return 'Switch-cost sensitivity must be between 0 and 1.';
  if (
    !Number.isFinite(controls.strongAdviceConfidence) ||
    controls.strongAdviceConfidence < 0 ||
    controls.strongAdviceConfidence > 1
  )
    return 'Strong-advice threshold must be between 0 and 1.';
  return undefined;
};
