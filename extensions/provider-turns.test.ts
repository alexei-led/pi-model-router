import { describe, expect, it } from 'vitest';
import { createProviderTurnCache, type ReviewStamp } from './provider-turns';
import type { ClassifierResult } from './types';

const result: ClassifierResult = {
  diagnostics: { outcome: 'selected', latencyMs: 1 },
};
const stamp = (requestCount: number, branch = ['user']): ReviewStamp => ({
  identity: 'policy-and-plan',
  requestCount,
  branch,
});

describe('background review lifetime', () => {
  it('accepts growing native branch ancestry at the next request', async () => {
    const cache = createProviderTurnCache();
    cache.startReview('turn', stamp(2), async () => result);
    await Promise.resolve();
    expect(
      cache.takeReview('turn', stamp(3, ['user', 'assistant', 'tool'])),
    ).toEqual(result);
    expect(cache.takeReview('turn', stamp(3))).toBeUndefined();
  });
  it('rejects sibling branches, changed policy and missed request windows', async () => {
    for (const next of [
      stamp(3, ['fork']),
      { ...stamp(3), identity: 'changed-policy' },
      stamp(4, ['user', 'assistant', 'tool']),
    ]) {
      const cache = createProviderTurnCache();
      let signal: AbortSignal | undefined;
      cache.startReview('turn', stamp(2), async (value) => {
        signal = value;
        return result;
      });
      await Promise.resolve();
      expect(cache.takeReview('turn', next)).toBeUndefined();
      expect(signal?.aborted).toBe(true);
    }
  });
  it('propagates caller cancellation and cannot apply its late response', async () => {
    const cache = createProviderTurnCache();
    const caller = new AbortController();
    let signal: AbortSignal | undefined;
    let settle: ((value: ClassifierResult) => void) | undefined;
    cache.startReview(
      'turn',
      { ...stamp(2), signal: caller.signal },
      async (value) => {
        signal = value;
        return new Promise<ClassifierResult>((resolve) => {
          settle = resolve;
        });
      },
    );
    caller.abort();
    expect(signal?.aborted).toBe(true);
    settle?.(result);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.takeReview('turn', stamp(3))).toBeUndefined();
  });
  it('rejects a completed result after its originating caller was cancelled', async () => {
    const cache = createProviderTurnCache();
    const caller = new AbortController();
    cache.startReview(
      'turn',
      { ...stamp(2), signal: caller.signal },
      async () => result,
    );
    await Promise.resolve();
    caller.abort();
    expect(cache.takeReview('turn', stamp(3))).toBeUndefined();
  });
  it('aborts an unready review when its only consumption window arrives', () => {
    const cache = createProviderTurnCache();
    let signal: AbortSignal | undefined;
    cache.startReview('turn', stamp(2), async (value) => {
      signal = value;
      return new Promise<ClassifierResult>(() => {});
    });
    expect(cache.takeReview('turn', stamp(3))).toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it('replaces an unready prior snapshot when a new review is due', async () => {
    const cache = createProviderTurnCache();
    let oldSignal: AbortSignal | undefined;
    cache.startReview('turn', stamp(1), async (signal) => {
      oldSignal = signal;
      return new Promise<ClassifierResult>(() => {});
    });
    cache.startReview(
      'turn',
      stamp(2, ['user', 'assistant']),
      async () => result,
    );
    expect(oldSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(
      cache.takeReview('turn', stamp(3, ['user', 'assistant', 'tool'])),
    ).toEqual(result);
  });
  it('aborts reviews on steering and disposal', () => {
    for (const dispose of [false, true]) {
      const cache = createProviderTurnCache();
      let signal: AbortSignal | undefined;
      cache.startReview('turn', stamp(2), async (value) => {
        signal = value;
        return new Promise<ClassifierResult>(() => {});
      });
      if (dispose) cache.dispose();
      else cache.clearReviewsExcept('new-turn');
      expect(signal?.aborted).toBe(true);
      expect(cache.takeReview('turn', stamp(3))).toBeUndefined();
    }
  });
});
