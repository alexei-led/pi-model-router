import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { ROUTER_OUTPUT_ENTRY, renderRouterOutput } from './output';

const theme = { fg: (_color: string, text: string) => text } as Theme;

const render = (data: unknown) =>
  renderRouterOutput(
    { type: 'custom', customType: ROUTER_OUTPUT_ENTRY, data } as never,
    { expanded: false } as never,
    theme,
  );

describe('renderRouterOutput', () => {
  it('draws the title and every line at the given width', () => {
    const component = render({
      title: 'Router status',
      lines: ['profile auto', 'mode balanced (default)'],
    });
    const lines = component?.render(40) ?? [];
    const text = lines.join('\n');
    expect(text).toContain('Router status');
    expect(text).toContain('profile auto');
    expect(text).toContain('mode balanced (default)');
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it('wraps a long line instead of overflowing', () => {
    const lines =
      render({ title: 'Log', lines: ['word '.repeat(30)] })?.render(40) ?? [];
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it('draws a title with no lines', () => {
    expect(
      render({ title: 'Router log', lines: [] })?.render(40).join('\n'),
    ).toContain('Router log');
  });

  it.each([
    ['missing data', undefined],
    ['null data', null],
    ['a string', 'text'],
    ['a missing title', { lines: ['a'] }],
    ['a non-string title', { title: 1, lines: [] }],
    ['missing lines', { title: 'x' }],
    ['non-array lines', { title: 'x', lines: 'a' }],
    ['a non-string line', { title: 'x', lines: ['a', 2] }],
  ])('ignores foreign data: %s', (_name, data) => {
    expect(render(data)).toBeUndefined();
  });
});
