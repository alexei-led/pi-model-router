/**
 * One table for the help text and the completions. Profile names are explicit
 * arguments, so command names remain valid profiles.
 */
export const ROUTER_COMMANDS = [
  { name: 'status', args: '', desc: 'Short text status' },
  { name: 'routes', args: '', desc: 'Configured routes and per-cell editor' },
  {
    name: 'classifier',
    args: '',
    desc: 'Classifier status and session selection',
  },
  { name: 'usage', args: '', desc: 'Retained usage and catalog costs' },
  { name: 'settings', args: '', desc: 'Session controls' },
  {
    name: 'profile',
    args: '<name>',
    desc: 'Switch profile (enables the router)',
  },
  {
    name: 'off',
    args: '',
    desc: 'Leave the router; restore the previous model',
  },
  {
    name: 'pin',
    args: '<tier|auto>',
    desc: 'Pin the active profile to a tier, or clear',
  },
  {
    name: 'thinking',
    args: '<level|auto>',
    desc: 'Override effort for every tier, or clear',
  },
  {
    name: 'mode',
    args: '[cost|balanced|quality|default]',
    desc: 'Session mode; default clears it',
  },
  {
    name: 'log',
    args: '[on|off|clear]',
    desc: 'Recent decisions and classifier stats; control collection',
  },
  { name: 'widget', args: '', desc: 'Toggle the status widget' },
  { name: 'reload', args: '', desc: 'Reload model-router.json' },
  { name: 'help', args: '', desc: 'This text' },
] as const;

export const MAX_DEBUG_HISTORY = 50;
// Bound JSON metadata as well as text; expand only with measured long-dialogue needs.
export const MAX_CLASSIFIER_CONTEXT_TURNS = 20;
export const MAX_CLASSIFIER_STATE_TOKENS = 24_000;
export const MAX_CLASSIFIER_ESTIMATED_REQUEST_TOKENS = 28_000;
export const DEFAULT_CLASSIFIER_CONTEXT = {
  previousTurns: 2,
  maxHistoryTokens: 500,
  toolResults: 'last-error',
  maxToolTokens: 250,
  currentLoopMessages: 8,
} as const;
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 10_000;
export const MAX_CLASSIFIER_RETRIES = 4;
/** Runtime-only per-turn caches: continuations and advised decisions. */
export const MAX_TURN_CACHE_ENTRIES = 16;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
/** Share of a route's context window the estimated request may fill; the rest is output headroom. */
export const CONTEXT_FILL = 0.9;
