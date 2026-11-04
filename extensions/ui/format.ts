import type { RouterTier } from '../types';

/** Display order for tiers, cheapest first. `ROUTER_TIERS` stays high-first for routing. */
export const TIER_DISPLAY_ORDER = ['micro', 'low', 'medium', 'high'] as const;

const TIER_METERS: Readonly<Record<RouterTier, string>> = {
  micro: '▂',
  low: '▂▄',
  medium: '▂▄▆',
  high: '▂▄▆█',
};

/** Signal-strength bars: one more bar per tier. The same bars name a tier on every surface. */
export const tierMeter = (tier: RouterTier): string => TIER_METERS[tier];

const BRANDS: Readonly<Record<string, string>> = {
  deepseek: 'DeepSeek',
  glm: 'GLM',
  gpt: 'GPT',
  kimi: 'Kimi',
  mimo: 'MiMo',
  minimax: 'MiniMax',
};

const capitalize = (word: string): string =>
  word.replace(/^./u, (first) => first.toUpperCase());

/**
 * Readable model name from a model id: `claude-opus-5-5` → `Opus 5.5`.
 * Presentation only; the id stays the identity everywhere else.
 */
export const modelName = (id: string): string => {
  const bare = id
    .replace(/\[[^\]]*\]$/u, '')
    .replace(/-\d{8}$/u, '')
    .replace(/-latest$/u, '');
  if (bare.startsWith('claude-'))
    return capitalize(
      bare.replace(/^claude-/u, '').replace(/-(\d)-(\d)$/u, ' $1.$2'),
    );
  return bare
    .split('-')
    .map((word) => BRANDS[word.toLowerCase()] ?? capitalize(word))
    .join(' ');
};

const isMoney = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0;

/**
 * User-facing catalog dollars: `$1.24`, `<$0.01` for a positive amount below
 * half a cent, `unknown` for a missing or invalid amount. Unknown is never free.
 */
export const usd = (value: number | undefined): string => {
  if (!isMoney(value)) return 'unknown';
  if (value > 0 && value < 0.005) return '<$0.01';
  return `$${value.toFixed(2)}`;
};

/** Diagnostic dollars for log lines, where sub-cent amounts matter. */
export const usdFine = (value: number | undefined): string =>
  isMoney(value) ? `$${value.toFixed(4)}` : 'unknown';

/** `−$1.86 (−60%)`; a rise past double reads as a ratio, `+$2.48 (×5.0)`. */
export const signedUsd = (diff: number, base: number): string => {
  const sign = diff < 0 ? '−' : '+';
  const amount = usd(Math.abs(diff));
  if (diff === 0) return '$0.00';
  if (!(base > 0)) return `${sign}${amount}`;
  const share = Math.round((diff / base) * 100);
  if (share > 100)
    return `${sign}${amount} (×${((base + diff) / base).toFixed(1)})`;
  return share === 0
    ? `${sign}${amount}`
    : `${sign}${amount} (${share < 0 ? '−' : '+'}${Math.abs(share)}%)`;
};

/** `412 ms` below a second, `1.2 s` from a second, `10 s` without a trailing `.0`. */
export const latency = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${Number((ms / 1000).toFixed(1))} s`;

/** Whole percent of a 0–1 share: `13%`. */
export const percent = (share: number): string => `${Math.round(share * 100)}%`;

/** 24-hour `HH:MM:SS`, the same on every machine. */
export const clock = (timestampMs: number): string =>
  new Date(timestampMs).toLocaleTimeString('en-GB', { hour12: false });

/** `1 switch`, `2 switches`. */
export const count = (
  value: number,
  singular: string,
  plural = `${singular}s`,
): string => `${value} ${value === 1 ? singular : plural}`;

/** `1 reply`, `12 replies`. */
export const replies = (value: number): string =>
  count(value, 'reply', 'replies');
