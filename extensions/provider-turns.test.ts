import { describe, expect, it } from 'vitest';
import { createProviderTurnCache, type ReviewStamp } from './provider-turns';
import type { ClassifierResult } from './types';

const result: ClassifierResult = {
  diagnostics: { outcome: 'selected', latencyMs: 1 },
};
const stamp = (requestCount: number, branch = ['user']): ReviewStamp => ({
  contextLength: 1,
  contextDigest: 'fixture',
  prefixDigest: () => 'fixture',
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

describe('durable goal anchors', () => {
  it('keeps a bounded anchor only across confirmed continuation and matching ancestry', () => {
    const cache = createProviderTurnCache();
    const config = {} as import('./types').RouterConfig;
    const first = cache.beginGoal(
      'one',
      undefined,
      'owner',
      ['root', 'one'],
      'p',
      config,
    );
    cache.finishGoal(first, {
      text: 'Implement the feature',
      truncated: false,
    });
    const next = cache.beginGoal(
      'two',
      'one',
      'owner',
      ['root', 'one', 'two'],
      'p',
      config,
    );
    expect(next.previous?.text).toBe('Implement the feature');
    cache.finishGoal(next, next.previous);
    const third = cache.beginGoal(
      'three',
      'two',
      'owner',
      ['root', 'one', 'two', 'three'],
      'p',
      config,
    );
    expect(third.previous?.text).toBe('Implement the feature');
    cache.finishGoal(third, undefined);
    expect(
      cache.beginGoal(
        'four',
        'three',
        'owner',
        ['root', 'one', 'two', 'three', 'four'],
        'p',
        config,
      ).previous,
    ).toBeUndefined();
  });
  it('rejects sibling branches, changed config, stale completions and disposal', () => {
    const cache = createProviderTurnCache();
    const config = {} as import('./types').RouterConfig;
    const first = cache.beginGoal(
      'one',
      undefined,
      'owner',
      ['root', 'one'],
      'p',
      config,
    );
    cache.finishGoal(first, { text: 'goal', truncated: false });
    expect(
      cache.beginGoal('two', 'one', 'owner', ['root', 'fork'], 'p', config)
        .previous,
    ).toBeUndefined();
    const old = cache.beginGoal(
      'three',
      'two',
      'owner',
      ['root', 'fork', 'three'],
      'p',
      config,
    );
    const newer = cache.beginGoal(
      'four',
      'three',
      'owner',
      ['root', 'fork', 'three', 'four'],
      'p',
      config,
    );
    cache.finishGoal(old, { text: 'stale', truncated: false });
    cache.finishGoal(newer, { text: 'current', truncated: false });
    expect(
      cache.beginGoal(
        'five',
        'four',
        'owner',
        ['root', 'fork', 'three', 'four', 'five'],
        'p',
        {} as import('./types').RouterConfig,
      ).previous,
    ).toBeUndefined();
    cache.dispose();
    cache.finishGoal(newer, { text: 'stale', truncated: false });
    expect(
      cache.beginGoal('six', undefined, 'owner', ['root', 'six'], 'p', config)
        .previous,
    ).toBeUndefined();
  });
});

it.each([
  ['foreign owner', 'one', 'foreign', ['root', 'one', 'two']],
  [
    'unmatched prior message prefix',
    'different',
    'owner',
    ['root', 'one', 'two'],
  ],
  ['missing native owner', 'one', undefined, ['root', 'one', 'two']],
  ['missing branch', 'one', 'owner', []],
])('does not expose a goal to %s', (_name, prior, owner, branch) => {
  const cache = createProviderTurnCache();
  const config = {} as import('./types').RouterConfig;
  const scope = cache.beginGoal(
    'one',
    undefined,
    'owner',
    ['root', 'one'],
    'p',
    config,
  );
  cache.finishGoal(scope, { text: 'private synthetic goal', truncated: false });
  expect(
    cache.beginGoal('two', prior, owner, branch, 'p', config).previous,
  ).toBeUndefined();
});

it('rejects a background review when the request context prefix changed on the same native branch', async () => {
  const cache = createProviderTurnCache();
  const original = {
    ...stamp(2),
    contextLength: 2,
    contextDigest: 'original',
    prefixDigest: () => 'original',
  };
  cache.startReview('turn', original, async () => result);
  await Promise.resolve();
  const rewritten = {
    ...stamp(3, ['user', 'assistant', 'tool']),
    contextLength: 3,
    contextDigest: 'new',
    prefixDigest: () => 'rewritten',
  };
  expect(cache.takeReview('turn', rewritten)).toBeUndefined();
});

it('accepts a background review when the request context extends the original prefix', async () => {
  const cache = createProviderTurnCache();
  const original = {
    ...stamp(2),
    contextLength: 2,
    contextDigest: 'original',
    prefixDigest: () => 'original',
  };
  cache.startReview('turn', original, async () => result);
  await Promise.resolve();
  const extended = {
    ...stamp(3, ['user', 'assistant', 'tool']),
    contextLength: 3,
    contextDigest: 'extended',
    prefixDigest: (length: number) => (length === 2 ? 'original' : 'extended'),
  };
  expect(cache.takeReview('turn', extended)).toEqual(result);
});

it('expires only phase-derived ops after new same-turn evidence is appended', async () => {
  const cache = createProviderTurnCache();
  const advice: ClassifierResult = {
    advice: {
      candidateId: 'local',
      activity: 'ops',
      confidence: 1,
      latencyMs: 1,
    },
    diagnostics: {
      outcome: 'selected',
      latencyMs: 1,
      activity: 'code',
      activityOutcome: 'selected',
      phase: 'verify',
      phaseOutcome: 'selected',
      phaseConfidence: 1,
    },
  };
  cache.startReview(
    'turn',
    { ...stamp(2), contextDigest: 'before' },
    async () => advice,
  );
  await Promise.resolve();
  const next = cache.takeReview('turn', {
    ...stamp(3),
    contextLength: 2,
    contextDigest: 'after',
    prefixDigest: () => 'before',
  });
  expect(next?.advice).toMatchObject({
    candidateId: 'local',
    activity: 'code',
  });
  expect(next?.diagnostics.phaseOutcome).toBe('uncertain');
  expect(next?.diagnostics.phase).toBeUndefined();
});
