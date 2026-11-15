import { describe, expect, it } from 'vitest';
import { selectedAdviceConfidence } from './choice';
import type { ClassifierDiagnostics } from './types';

const selected: ClassifierDiagnostics = {
  outcome: 'selected',
  latencyMs: 1,
  choice: 'high',
  selectedTier: 'high',
  selectionBasis: 'choice',
  confidence: 0.95,
  activity: 'code',
  activityOutcome: 'selected',
  activityConfidence: 0.9,
};

describe('selected strong-advice confidence', () => {
  it('uses the weakest selected changed dimension without multiplying distributions', () => {
    expect(
      selectedAdviceConfidence(selected, { tier: true, activity: true }),
    ).toBe(0.9);
    expect(
      selectedAdviceConfidence(selected, { tier: true, activity: false }),
    ).toBe(0.95);
    expect(
      selectedAdviceConfidence(selected, { tier: false, activity: true }),
    ).toBe(0.9);
  });
  it.each(['uncertain', 'invalid-response'] as const)(
    'never uses %s activity confidence for an override',
    (activityOutcome) => {
      expect(
        selectedAdviceConfidence(
          {
            ...selected,
            activity: 'uncertain',
            activityOutcome,
            activityConfidence: 0.99,
          },
          { tier: false, activity: true },
        ),
      ).toBeUndefined();
    },
  );
  it('does not attribute the top-choice confidence to a cumulative selected tier', () => {
    expect(
      selectedAdviceConfidence(
        {
          ...selected,
          choice: 'low',
          selectedTier: 'high',
          selectionBasis: 'probability',
          confidence: 0.99,
          routeProbability: 0.95,
        },
        { tier: true, activity: false },
      ),
    ).toBeUndefined();
  });
  it.each(['reason', 'produce'] as const)(
    'bounds the ops %s floor by phase confidence',
    (phase) => {
      expect(
        selectedAdviceConfidence(
          {
            ...selected,
            activity: 'ops',
            phase,
            phaseOutcome: 'selected',
            phaseConfidence: 0.7,
          },
          { tier: false, activity: true },
        ),
      ).toBe(0.7);
    },
  );
  it('supports a selected activity-only answer but rejects its abstention', () => {
    const activityOnly: ClassifierDiagnostics = {
      outcome: 'selected',
      latencyMs: 1,
      selectedTier: 'medium',
      activity: 'docs',
      activityOutcome: 'selected',
      activityConfidence: 0.95,
    };
    expect(
      selectedAdviceConfidence(activityOnly, { tier: false, activity: true }),
    ).toBe(0.95);
    expect(
      selectedAdviceConfidence(
        {
          ...activityOnly,
          activity: 'uncertain',
          activityOutcome: 'uncertain',
          activityConfidence: 1,
        },
        { tier: false, activity: true },
      ),
    ).toBeUndefined();
  });
});
