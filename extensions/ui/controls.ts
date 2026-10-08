import type { RouterUIControls } from '../types';

export const validateRouterUIControls = (
  controls: Readonly<RouterUIControls>,
): string | undefined => {
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
  return undefined;
};
