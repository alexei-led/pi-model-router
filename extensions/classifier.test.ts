import type {
  AssistantMessageEventStream,
  Context,
} from '@earendil-works/pi-ai';
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
    ).toEqual({ tier: 'high', reasoning: 'classifier' });
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
  it('ignores a classifier stream creation rejection', async () => {
    const s = setup();
    s.streamSimple.mockImplementationOnce(() => {
      throw new Error('classifier unavailable');
    });
    await expect(
      runClassifier('test/primary', s.registry, s.context),
    ).resolves.toBeUndefined();
  });
  it('returns a fixed reason code instead of classifier explanation text', async () => {
    const s = setup();
    const result = await runClassifier('test/primary', s.registry, s.context);
    expect(result).toEqual({ tier: 'high', reasoning: 'classifier' });
    expect(result?.reasoning).not.toContain('Analyze');
  });
  it('returns no advice when the classifier times out', async () => {
    const s = setup();
    const hangingStream = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<never>(() => {}),
      }),
    } as unknown as AssistantMessageEventStream;
    s.streamSimple.mockReturnValue(hangingStream);
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeout.signal);
    try {
      const pending = runClassifier('test/primary', s.registry, s.context);
      timeout.abort();
      await expect(pending).resolves.toBeUndefined();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
  it('returns no advice when the caller aborts an active classifier', async () => {
    const s = setup();
    const hangingStream = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<never>(() => {}),
      }),
    } as unknown as AssistantMessageEventStream;
    s.streamSimple.mockReturnValue(hangingStream);
    const abort = new AbortController();
    const pending = runClassifier(
      'test/primary',
      s.registry,
      s.context,
      undefined,
      undefined,
      abort.signal,
    );
    abort.abort();
    await expect(pending).resolves.toBeUndefined();
  });
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
