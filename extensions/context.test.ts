import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { getBoundedRecentContext } from './context';
import { message } from './test/fixtures';

const conversation = (request: string): Context => ({
  systemPrompt: 'PRIVATE_SYSTEM_CONFIG_KEY',
  tools: [
    {
      name: 'private_tool',
      description: 'PRIVATE_TOOL_SCHEMA',
      parameters: {},
    },
  ],
  messages: [
    { role: 'user', content: 'Обсудим parser для 日本語', timestamp: 1 },
    message({
      content: [
        { type: 'text', text: 'Should I implement the proposed changes?' },
        { type: 'thinking', thinking: 'PRIVATE_THINKING' },
        {
          type: 'toolCall',
          id: 'call',
          name: 'read',
          arguments: { key: 'PRIVATE_ARGUMENTS' },
        },
      ],
    }),
    {
      role: 'toolResult',
      toolCallId: 'call',
      toolName: 'read',
      isError: false,
      timestamp: 2,
      content: [
        { type: 'text', text: `tool output ${'x'.repeat(20000)}` },
        { type: 'image', data: 'PRIVATE_BINARY', mimeType: 'image/png' },
      ],
    },
    { role: 'user', content: request, timestamp: 3 },
  ],
});

describe('getBoundedRecentContext', () => {
  it.each([
    'да, сделай',
    'yes',
    'はい、実装して',
    'plese implemnt',
    'sí, поправь parser',
  ])(
    'preserves %s and role-labelled history despite oversized tool output',
    (request) => {
      const context = conversation(request);
      const text = getBoundedRecentContext(context, 400);
      expect(text.length).toBeLessThanOrEqual(400);
      expect(text).toContain(`user:\n${request}`);
      expect(text).toContain('user:\nОбсудим parser для 日本語');
      expect(text).toContain('assistant:\nShould I implement');
      expect(text).toContain('tool:\ntool output');
      expect(text).not.toContain('PRIVATE_');
      expect(getBoundedRecentContext(context, 400)).toBe(text);
    },
  );

  it('gives the current request the entire budget before older messages', () => {
    const text = getBoundedRecentContext(
      conversation('current '.repeat(100)),
      100,
    );
    expect(text).toBe(`user:\n${'current '.repeat(100).slice(0, 94)}`);
  });

  it('uses only recent messages without changing case or scoring words', () => {
    const context = conversation('YES');
    context.messages.unshift(
      ...Array.from({ length: 10 }, (_, index) => ({
        role: 'user' as const,
        content: `OLD_${index}`,
        timestamp: index,
      })),
    );
    const text = getBoundedRecentContext(context, 12000);
    expect(text).not.toContain('OLD_7');
    expect(text).toContain('user:\nYES');
  });

  it('handles tiny and invalid budgets without losing current text to labels', () => {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(getBoundedRecentContext(conversation('yes'), budget)).toBe('');
    expect(getBoundedRecentContext(conversation('yes'), 1)).toBe('y');
    expect(getBoundedRecentContext({ messages: [] }, 100)).toBe('');
  });
});
