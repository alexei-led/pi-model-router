/** Active command names are reserved profile names. */
export const ROUTER_COMMANDS = [
  { name: 'pin', desc: 'Pin the active profile to a tier, or auto' },
  { name: 'thinking', desc: 'Override thinking for every tier, or auto' },
  { name: 'log', desc: 'Recent decisions and Jev stats; on, off or clear' },
  { name: 'widget', desc: 'Toggle the status widget' },
  { name: 'off', desc: 'Leave the router and restore the previous model' },
  { name: 'reload', desc: 'Reload model-router.json' },
  { name: 'help', desc: 'Show usage' },
] as const;

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
/** One retry of a documented transient status; the total budget stays `jev.timeoutMs`. */
export const DEFAULT_JEV_RETRY = { maxAttempts: 2, backoffMs: 400 } as const;
export const MAX_JEV_ATTEMPTS = 5;
export const MAX_JEV_BACKOFF_MS = 60_000;
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 10_000;
/** Runtime-only per-turn caches: continuations and advised decisions. */
export const MAX_TURN_CACHE_ENTRIES = 16;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
