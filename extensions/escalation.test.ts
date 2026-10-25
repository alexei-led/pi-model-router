import type { Message } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { repeatedFailure, updateEscalation } from './escalation';
import type { RouterTier } from './types';

const user = (text = 'goal'): Message => ({
  role: 'user',
  content: text,
  timestamp: 1,
});
const result = (toolName: string, text: string, isError: boolean): Message => ({
  role: 'toolResult',
  toolCallId: `${toolName}-call`,
  toolName,
  content: [{ type: 'text', text }],
  isError,
  timestamp: 2,
});
const fail = (text = 'FAIL src/a.test.ts:12 expected 3 got 4 (41 ms)') =>
  result('bash', text, true);
const edit = (isError = false) => result('edit', 'Applied edit', isError);
const pass = () => result('bash', 'ok', false);

describe('repeated tool failure', () => {
  it.each<[string, Message[], boolean]>([
    [
      'same failure with an edit between',
      [user(), fail(), edit(), fail()],
      true,
    ],
    [
      'write counts as an edit',
      [user(), fail(), result('write', 'Wrote', false), fail()],
      true,
    ],
    ['no edit between', [user(), fail(), fail()], false],
    ['failed edit between', [user(), fail(), edit(true), fail()], false],
    ['edit only after both failures', [user(), fail(), fail(), edit()], false],
    ['one failure only', [user(), fail(), edit()], false],
    [
      'different failure text',
      [user(), fail('error A'), edit(), fail('error B')],
      false,
    ],
    [
      'same text from another tool',
      [
        user(),
        fail(),
        edit(),
        result('read', 'FAIL src/a.test.ts:12 expected 3 got 4 (41 ms)', true),
      ],
      false,
    ],
    [
      'digits in the output differ',
      [
        user(),
        fail('FAIL a.ts:12 (41 ms)'),
        edit(),
        fail('FAIL a.ts:13 (57 ms)'),
      ],
      true,
    ],
    [
      'a later success of the same tool clears it',
      [user(), fail(), edit(), fail(), pass()],
      false,
    ],
    [
      'pair from an earlier user turn',
      [user(), fail(), edit(), fail(), user('next')],
      false,
    ],
    [
      'first failure before the user turn',
      [fail(), user(), edit(), fail()],
      false,
    ],
    ['no messages', [], false],
  ])('%s', (_name, messages, expected) => {
    expect(repeatedFailure(messages) !== undefined).toBe(expected);
  });

  it('gives a stable signature that hides the output text', () => {
    const messages = [user(), fail(), edit(), fail()];
    const signature = repeatedFailure(messages);
    expect(signature).toBe(repeatedFailure(messages));
    expect(signature).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('escalation hold', () => {
  const failing = [user(), fail(), edit(), fail()];
  const update = (
    state: Parameters<typeof updateEscalation>[0],
    messages: Message[],
    incumbent: RouterTier | undefined,
    holdTurns = 2,
  ) => updateEscalation(state, { messages, incumbent, holdTurns });

  it.each<[RouterTier, RouterTier | undefined]>([
    ['micro', 'low'],
    ['low', 'medium'],
    ['medium', 'high'],
    ['high', undefined],
  ])('moves %s one tier up', (incumbent, floor) => {
    expect(update({}, failing, incumbent).floor).toBe(floor);
  });

  it('keeps the signature unconsumed when no tier is higher', () => {
    expect(update({}, failing, 'high').state).toEqual({});
  });

  it('does nothing without a known incumbent tier', () => {
    expect(update({}, failing, undefined)).toEqual({
      state: {},
      floor: undefined,
    });
  });

  it('holds the floor for N further user turns, then releases it', () => {
    const first = update({}, failing, 'low');
    expect(first.floor).toBe('medium');
    const turn2 = [...failing, user('2')];
    const turn3 = [...turn2, user('3')];
    const turn4 = [...turn3, user('4')];
    expect(update(first.state, turn2, 'medium').floor).toBe('medium');
    expect(update(first.state, turn3, 'medium').floor).toBe('medium');
    expect(update(first.state, turn4, 'medium').floor).toBeUndefined();
  });

  it('holds only the current user turn when holdTurns is 0', () => {
    const first = update({}, failing, 'low', 0);
    expect(first.floor).toBe('medium');
    expect(
      update(first.state, [...failing, user('2')], 'medium', 0).floor,
    ).toBeUndefined();
  });

  it('does not escalate the same signature twice', () => {
    const first = update({}, failing, 'low');
    const again = update(first.state, failing, 'medium');
    expect(again.floor).toBe('medium');
    expect(again.state).toBe(first.state);
  });

  it('counts turns after the failing turn when compaction rewrites history', () => {
    const history = [user('old 1'), user('old 2'), ...failing];
    const first = update({}, history, 'low');
    const compacted = [user('summary'), ...failing];
    expect(update(first.state, [...compacted, user('2')], 'medium').floor).toBe(
      'medium',
    );
    expect(
      update(
        first.state,
        [...compacted, user('2'), user('3'), user('4')],
        'medium',
      ).floor,
    ).toBeUndefined();
  });

  it('releases the floor when compaction removes the failing turn', () => {
    const first = update({}, failing, 'low');
    expect(
      update(first.state, [user('summary'), user('2')], 'medium').floor,
    ).toBeUndefined();
  });

  it('does not apply the floor on another branch', () => {
    const first = update({}, [user('shared'), ...failing], 'low');
    expect(
      update(first.state, [user('shared'), user('other task')], 'medium').floor,
    ).toBeUndefined();
  });

  it('does not restore the hold in a fresh runtime', () => {
    expect(update({}, [...failing, user('2')], 'medium').floor).toBeUndefined();
  });

  it('escalates again for a new signature during a hold', () => {
    const first = update({}, failing, 'low');
    const other = [user(), fail('B'), edit(), fail('B')];
    expect(update(first.state, other, 'medium').floor).toBe('high');
  });
});

describe('cost-mode recovery at the tier ceiling', () => {
  const messages = [user(), fail(), edit(), fail()];
  it('arms a bounded high-tier recovery only when explicitly enabled', () => {
    const recovered = updateEscalation(
      {},
      { messages, incumbent: 'high', holdTurns: 1, recoverCostHigh: true },
    );
    expect(recovered).toMatchObject({
      floor: 'high',
      costRecovery: true,
      state: { floor: 'high', costRecovery: true },
    });
    expect(
      updateEscalation({}, { messages, incumbent: 'high', holdTurns: 1 }).floor,
    ).toBeUndefined();
    expect(
      updateEscalation(recovered.state, {
        messages: [...messages, user('next')],
        incumbent: undefined,
        holdTurns: 1,
      }).costRecovery,
    ).toBe(true);
    expect(
      updateEscalation(recovered.state, {
        messages: [...messages, user('next'), user('expired')],
        incumbent: undefined,
        holdTurns: 1,
      }).costRecovery,
    ).toBe(false);
  });
  it('re-arms for the same failure in a new user turn, without renewing the current turn indefinitely', () => {
    const first = updateEscalation(
      {},
      { messages, incumbent: 'high', holdTurns: 0, recoverCostHigh: true },
    );
    const same = updateEscalation(first.state, {
      messages,
      incumbent: 'high',
      holdTurns: 0,
      recoverCostHigh: true,
    });
    expect(same.state).toBe(first.state);
    const next = [user('a different goal'), fail(), edit(), fail()];
    const again = updateEscalation(first.state, {
      messages: next,
      incumbent: 'high',
      holdTurns: 0,
      recoverCostHigh: true,
    });
    expect(again.costRecovery).toBe(true);
    expect(again.state.anchor).not.toBe(first.state.anchor);
  });
});
