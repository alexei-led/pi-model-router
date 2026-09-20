import type { Context } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { runClassifier } from './classifier';
import { done, events, failure, model } from './test/fixtures';

const setup = () => {
  const streamSimple = vi.fn<ExtensionContext['modelRegistry']['streamSimple']>(
    () => done('Tier: high\nReasoning: Analyze: complex design'),
  );
  const registry = {
    find: () => model(),
    streamSimple,
  } as unknown as ExtensionContext['modelRegistry'];
  const context: Context = {
    systemPrompt: 'private instructions',
    tools: [],
    messages: [{ role: 'user', content: 'design system', timestamp: 1 }],
  };
  return { registry, context, streamSimple };
};

describe('classifier', () => {
  it('uses isolated registry requests, keeps colons, and forwards cancellation', async () => {
    const s = setup();
    const abort = new AbortController();
    expect(
      await runClassifier(
        'test/primary',
        s.registry,
        s.context,
        'planning',
        'low',
        abort.signal,
      ),
    ).toEqual({ tier: 'high', reasoning: 'Analyze: complex design' });
    const call = s.streamSimple.mock.calls[0];
    expect(call?.[1]).not.toHaveProperty('systemPrompt');
    expect(call?.[1]).not.toHaveProperty('tools');
    expect(call?.[2]).toMatchObject({ maxTokens: 256, reasoning: 'low' });
    abort.abort();
    expect(call?.[2]?.signal?.aborted).toBe(true);
  });
  it.each(['malformed', 'error', 'aborted', 'unterminated'] as const)(
    'ignores %s responses',
    async (kind) => {
      const s = setup();
      s.streamSimple.mockReturnValue(
        kind === 'malformed'
          ? done('Tier: giant')
          : kind === 'unterminated'
            ? events()
            : failure(kind),
      );
      expect(
        await runClassifier('test/primary', s.registry, s.context),
      ).toBeUndefined();
    },
  );
  it('does not recursively invoke router classifiers or start aborted calls', async () => {
    const s = setup();
    expect(
      await runClassifier('router/auto', s.registry, s.context),
    ).toBeUndefined();
    expect(
      await runClassifier(
        'test/primary',
        s.registry,
        s.context,
        undefined,
        undefined,
        AbortSignal.abort(),
      ),
    ).toBeUndefined();
    expect(s.streamSimple).not.toHaveBeenCalled();
  });
});
