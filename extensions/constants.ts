export const MAX_DEBUG_HISTORY = 50;
// Bound JSON metadata as well as text; expand only with measured long-dialogue needs.
export const MAX_JEV_CONTEXT_TURNS = 20;
export const MAX_JEV_STATE_TOKENS = 24_000;
export const MAX_JEV_ESTIMATED_REQUEST_TOKENS = 28_000;
export const DEFAULT_JEV_CONTEXT = {
  previousTurns: 2,
  maxHistoryTokens: 500,
  toolResults: 'last-error',
  maxToolTokens: 250,
} as const;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
