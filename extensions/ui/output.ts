import type { EntryRenderer } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

/** Custom session entry type for multi-line command output. It never enters model context. */
export const ROUTER_OUTPUT_ENTRY = 'router-output';

export interface RouterOutput {
  title: string;
  lines: readonly string[];
}

const isRouterOutput = (value: unknown): value is RouterOutput =>
  typeof value === 'object' &&
  value !== null &&
  'title' in value &&
  typeof value.title === 'string' &&
  'lines' in value &&
  Array.isArray(value.lines) &&
  value.lines.every((line: unknown) => typeof line === 'string');

/** Draws `/router status` and `/router log` in the transcript; ignores foreign data. */
export const renderRouterOutput: EntryRenderer = (entry, _options, theme) => {
  if (!isRouterOutput(entry.data)) return undefined;
  const { title, lines } = entry.data;
  return new Text(
    [
      theme.fg('accent', title),
      ...lines.map((line) => theme.fg('muted', line)),
    ].join('\n'),
    1,
    0,
  );
};
