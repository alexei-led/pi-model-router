import { describe, expect, it } from 'vitest';
import type { RoutingDecision } from '../types';
import {
  decisionReason,
  modelChangeNotice,
  thinkingSet,
  thinkingUnchanged,
} from './notices';

const decision = (patch: Partial<RoutingDecision> = {}): RoutingDecision => ({
  profile: 'auto',
  tier: 'medium',
  targetProvider: 'anthropic',
  targetModelId: 'claude-sonnet-5-5',
  targetLabel: 'anthropic/claude-sonnet-5-5',
  thinking: 'medium',
  reasonCode: 'classifier',
  timestamp: 1,
  ...patch,
});

const opus = (patch: Partial<RoutingDecision> = {}) =>
  decision({
    tier: 'high',
    targetModelId: 'claude-opus-5-5',
    targetLabel: 'anthropic/claude-opus-5-5',
    thinking: 'high',
    ...patch,
  });

describe('modelChangeNotice', () => {
  it('names both models, efforts and the direction of an upward change', () => {
    expect(modelChangeNotice(decision(), opus())).toBe(
      'Model changed: Sonnet 5.5 · medium → Opus 5.5 · high · ↑ stronger',
    );
  });

  it('names a downward change', () => {
    expect(modelChangeNotice(opus(), decision())).toBe(
      'Model changed: Opus 5.5 · high → Sonnet 5.5 · medium · ↓ cheaper',
    );
  });

  it('reads a same-tier model change as a fit', () => {
    expect(
      modelChangeNotice(
        decision(),
        decision({ targetModelId: 'gpt-6.1-terra', targetProvider: 'openai' }),
      ),
    ).toBe(
      'Model changed: Sonnet 5.5 · medium → GPT 6.1 Terra · medium · = fits',
    );
  });

  it('treats the same model id on another provider as a model change', () => {
    expect(
      modelChangeNotice(decision(), decision({ targetProvider: 'proxy' })),
    ).toContain('Model changed: Sonnet 5.5');
  });

  it.each([
    ['pinned', '⏵ pinned'],
    ['escalation', '↑ tool errors'],
    ['budget', '↓ over budget'],
  ] as const)('gives %s as the reason', (reasonCode, reason) => {
    expect(modelChangeNotice(decision(), opus({ reasonCode }))).toBe(
      `Model changed: Sonnet 5.5 · medium → Opus 5.5 · high · ${reason}`,
    );
  });

  it.each([
    ['there is no previous decision', undefined, opus()],
    ['only the effort changed', decision(), decision({ thinking: 'high' })],
    ['the profile differs', decision({ profile: 'other' }), opus()],
    [
      'the previous decision was a review',
      decision({ reviewOnly: true }),
      opus(),
    ],
    ['the next decision is a review', decision(), opus({ reviewOnly: true })],
  ])('stays silent when %s', (_name, previous, next) => {
    expect(modelChangeNotice(previous, next)).toBeUndefined();
  });
});

describe('decisionReason', () => {
  it.each([
    ['pinned', '⏵ pinned'],
    ['escalation', '↑ tool errors'],
    ['budget', '↓ over budget'],
    ['fallback', '! fallback'],
    ['cost-recovery', '↑ cost recovery'],
    ['continuation', '= reused'],
  ] as const)(
    'maps %s to %s regardless of tier movement',
    (reasonCode, text) => {
      expect(decisionReason(decision({ reasonCode }), opus())).toBe(text);
    },
  );

  it.each([
    ['classifier', '= fits'],
    ['baseline', '= baseline'],
    ['legacy', '= baseline'],
  ] as const)('reads a first %s decision as %s', (reasonCode, text) => {
    expect(decisionReason(decision({ reasonCode }))).toBe(text);
  });

  it.each([
    ['micro', 'low', '↑ stronger'],
    ['high', 'medium', '↓ cheaper'],
    ['low', 'low', '= fits'],
  ] as const)('reads %s then %s as %s', (from, to, text) => {
    expect(
      decisionReason(decision({ tier: to }), decision({ tier: from })),
    ).toBe(text);
  });
});

describe('thinking notices', () => {
  it('explains an unchanged level', () => {
    expect(thinkingUnchanged('high')).toBe(
      "Router thinking unchanged: 'high' leaves no eligible route.",
    );
  });

  it.each([
    [[], 'Router thinking set to high'],
    [['low capped'], 'Router thinking set to high; low capped'],
    [
      ['low capped', 'micro capped'],
      'Router thinking set to high; low capped, micro capped',
    ],
  ])('reports adjustments %j', (adjusted, text) => {
    expect(thinkingSet('high', adjusted)).toBe(text);
  });
});
