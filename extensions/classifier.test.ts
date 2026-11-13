import type {
  ClassifierContext,
  ClassifierModel,
  ClassifierResult,
} from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { createCandidate } from './choice';
import { runClassifierDetailed } from './classifier';
import type {
  AdvisorConfig,
  ClassifierRegistry,
  ClassifierRequest,
} from './types';

const model: ClassifierModel<'custom-decisions'> = {
  type: 'classifier',
  provider: 'custom',
  id: 'decision:model/v2',
  name: 'Configured decision model',
  api: 'custom-decisions',
  baseUrl: 'https://fixture.invalid',
  input: ['text'],
  contextWindow: 64000,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
};
const config: AdvisorConfig = {
  enabled: true,
  model: 'custom/decision:model/v2',
  timeoutMs: 1500,
  reviewEveryRequests: 4,
  confidenceThreshold: 0.65,
  probabilityThreshold: 0.8,
  maxStateTokens: 3000,
  maxRetries: 1,
};
const candidates = [
  createCandidate({
    tier: 'medium',
    model: 'generation/base',
    thinking: 'off',
  }),
  createCandidate({
    tier: 'high',
    model: 'generation/strong',
    thinking: 'high',
  }),
];
const request = (
  overrides: Partial<ClassifierRequest> = {},
): ClassifierRequest => ({
  context: {
    messages: [{ role: 'user', content: 'Synthetic task', timestamp: 1 }],
  },
  candidates,
  profile: { models: ['custom/decision:model/v2'] },
  baselineTier: 'medium',
  routingDeadline: performance.now() + 1500,
  ...overrides,
});
const classifierResult = (): ClassifierResult => ({
  api: model.api,
  provider: model.provider,
  model: model.id,
  timestamp: 1,
  stopReason: 'stop',
  answers: {
    route: {
      type: 'choice',
      choice: candidates[1]?.id ?? '',
      confidence: 0.9,
      probabilities: {
        [candidates[0]?.id ?? '']: 0.1,
        [candidates[1]?.id ?? '']: 0.9,
        uncertain: 0,
      },
    },
  },
  usage: {
    input: 50,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 52,
    cost: {
      input: 0.00005,
      output: 0.000004,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.000054,
    },
  },
});
const registry = (): ClassifierRegistry => ({
  findOfType: vi.fn(() => model),
  classify: vi.fn(async () => classifierResult()),
});

describe('Pi classifier registry routing', () => {
  it('uses profile confidence thresholds without changing other profiles', async () => {
    const current = registry();
    current.classify = vi.fn(async () => {
      const response = classifierResult();
      response.answers.route = {
        type: 'choice',
        choice: candidates[0]?.id ?? '',
        confidence: 0.6,
        probabilities: {
          [candidates[0]?.id ?? '']: 0.6,
          [candidates[1]?.id ?? '']: 0.4,
          uncertain: 0,
        },
      };
      return response;
    });
    const personal = await runClassifierDetailed(
      config,
      request({
        profile: {
          models: ['custom/decision:model/v2'],
          confidenceThreshold: 0.55,
          probabilityThreshold: 0.75,
        },
      }),
      current,
    );
    expect(personal.diagnostics).toMatchObject({
      selectedTier: 'medium',
      selectionBasis: 'choice',
      threshold: 0.55,
      probabilityThreshold: 0.75,
    });
    const work = await runClassifierDetailed(config, request(), current);
    expect(work.diagnostics).toMatchObject({
      selectedTier: 'high',
      selectionBasis: 'probability',
      threshold: 0.65,
      probabilityThreshold: 0.8,
    });
  });

  it.each([
    'typesafe-system-one',
    'cloudflare-workers-ai-system-one',
    'openai-decisions',
    'llama-cpp-classify',
    'custom-decisions',
  ])(
    'uses Pi typed classify for %s without a router-specific wire path',
    async (api) => {
      const current = registry();
      current.findOfType = vi.fn(() => ({ ...model, api }));
      const result = await runClassifierDetailed(config, request(), current);
      expect(result.diagnostics).toMatchObject({
        outcome: 'selected',
        model: 'custom/decision:model/v2',
        actualInputTokens: 50,
        actualOutputTokens: 2,
        costUsd: 0.000054,
      });
      expect(result.advice?.candidateId).toBe(candidates[1]?.id);
      expect(current.findOfType).toHaveBeenCalledWith(
        'classifier',
        'custom',
        'decision:model/v2',
      );
      expect(current.classify).toHaveBeenCalledOnce();
      const [, context, options] =
        vi.mocked(current.classify).mock.calls[0] ?? [];
      expect(context?.questions.route?.type).toBe('choice');
      expect(context?.questions.route).toHaveProperty('criteria');
      expect(context?.images).toBeUndefined();
      expect(options).toMatchObject({ maxRetries: 1 });
      expect(options).not.toHaveProperty('apiKey');
      expect(options).not.toHaveProperty('onPayload');
    },
  );

  it('requires exact per-profile approval for the configured classifier', async () => {
    const current = registry();
    const result = await runClassifierDetailed(
      config,
      request({ profile: { models: ['other/private'] } }),
      current,
    );
    expect(result.diagnostics.outcome).toBe('unavailable');
    expect(current.classify).not.toHaveBeenCalled();
  });

  it('uses only the model Pi registered and never fabricates metadata', async () => {
    const current = registry();
    current.findOfType = vi.fn(() => undefined);
    expect(
      (await runClassifierDetailed(config, request(), current)).diagnostics
        .outcome,
    ).toBe('unavailable');
    expect(current.classify).not.toHaveBeenCalled();
  });

  it('bounds custom classifier implementations that ignore abort', async () => {
    const current = registry();
    current.classify = vi.fn(
      () => new Promise<ClassifierResult>(() => undefined),
    );
    const result = await runClassifierDetailed(
      { ...config, timeoutMs: 20 },
      request(),
      current,
    );
    expect(result.diagnostics.outcome).toBe('deadline');
    expect(
      vi.mocked(current.classify).mock.calls[0]?.[2]?.signal?.aborted,
    ).toBe(true);
  });

  it('drops provider error text but keeps safe numeric usage', async () => {
    const current = registry();
    current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
      ...classifierResult(),
      stopReason: 'error' as const,
      errorMessage: 'private-provider-detail',
      answers: {},
    }));
    const result = await runClassifierDetailed(config, request(), current);
    expect(result.advice).toBeUndefined();
    expect(result.diagnostics.costUsd).toBe(0.000054);
    expect(JSON.stringify(result)).not.toContain('private-provider-detail');
  });

  it('excludes system prompts, thinking, tool arguments and images from the bounded state', async () => {
    const current = registry();
    let observed: ClassifierContext | undefined;
    current.classify = vi.fn<ClassifierRegistry['classify']>(
      async (_model, context) => {
        observed = context;
        return classifierResult();
      },
    );
    await runClassifierDetailed(
      config,
      request({
        context: {
          systemPrompt: 'system-secret',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Synthetic task' },
                { type: 'image', data: 'image-secret', mimeType: 'image/png' },
              ],
              timestamp: 1,
            },
            {
              role: 'assistant',
              api: 'test',
              provider: 'generation',
              model: 'base',
              content: [
                { type: 'thinking', thinking: 'thinking-secret' },
                {
                  type: 'toolCall',
                  id: '1',
                  name: 'read',
                  arguments: { path: 'argument-secret' },
                },
              ],
              timestamp: 2,
              stopReason: 'toolUse',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            },
          ],
        },
      }),
      current,
    );
    expect(observed?.state).toHaveProperty('currentRequest');
    expect(JSON.stringify(observed)).not.toMatch(
      /system-secret|image-secret|thinking-secret|argument-secret/,
    );
  });
});

describe('independent tier/activity classifier answers', () => {
  const activityCandidates: NonNullable<
    ClassifierRequest['activityCandidates']
  > = [
    {
      activity: 'code',
      candidate: createCandidate({
        tier: 'medium',
        model: 'generation/code',
        thinking: 'off',
      }),
    },
  ];

  it('validates activity independently, never multiplies distributions or changes tier thresholds', async () => {
    const current = registry();
    current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
      ...classifierResult(),
      answers: {
        ...classifierResult().answers,
        activity: {
          type: 'choice',
          choice: 'code',
          confidence: 0.7,
          probabilities: { code: 0.4, docs: 0.3, uncertain: 0.3 },
        },
      },
    }));
    const result = await runClassifierDetailed(
      config,
      request({ activityCandidates }),
      current,
    );
    expect(result.advice).toMatchObject({
      candidateId: candidates[1]?.id,
      activity: 'code',
      confidence: 0.9,
    });
    expect(result.diagnostics).toMatchObject({
      activity: 'code',
      activityConfidence: 0.7,
      activityOutcome: 'selected',
      selectedTier: 'high',
    });
    expect(current.classify).toHaveBeenCalledOnce();
  });

  it.each([
    'unknown',
    'bad-confidence',
    'bad-type',
    'missing-distribution',
    'bad-argmax',
    'bad-sum',
    'uncertain',
    'low-confidence',
  ])('does not discard valid tier advice for %s activity', async (mode) => {
    const current = registry();
    const activity = {
      type: mode === 'bad-type' ? 'bool' : 'choice',
      choice:
        mode === 'unknown'
          ? 'private-model-reference'
          : mode === 'uncertain'
            ? 'uncertain'
            : 'code',
      confidence:
        mode === 'bad-confidence' ? 2 : mode === 'low-confidence' ? 0.1 : 0.9,
      probabilities:
        mode === 'missing-distribution'
          ? undefined
          : mode === 'bad-argmax'
            ? { code: 0.1, docs: 0.9 }
            : mode === 'bad-sum'
              ? { code: 0.2 }
              : { [mode === 'uncertain' ? 'uncertain' : 'code']: 1 },
      explanation: 'private-provider-explanation',
    };
    current.classify = vi.fn<ClassifierRegistry['classify']>(async () =>
      JSON.parse(
        JSON.stringify({
          ...classifierResult(),
          answers: { ...classifierResult().answers, activity },
        }),
      ),
    );
    const result = await runClassifierDetailed(
      config,
      request({ activityCandidates }),
      current,
    );
    expect(result.advice?.candidateId).toBe(candidates[1]?.id);
    expect(result.advice?.activity).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(
      /private-model-reference|private-provider-explanation/,
    );
  });

  it('an invalid tier cannot be rescued by valid activity, and malformed local activity requests do not classify', async () => {
    const current = registry();
    current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
      ...classifierResult(),
      answers: {
        activity: {
          type: 'choice',
          choice: 'code',
          confidence: 1,
          probabilities: { code: 1 },
        },
      },
    }));
    const result = await runClassifierDetailed(
      config,
      request({ activityCandidates }),
      current,
    );
    expect(result.advice).toBeUndefined();
    expect(result.diagnostics.outcome).toBe('invalid-response');
    for (const overrides of [
      { activityCandidates: [] },
      { askRoute: false },
      { askRoute: false, activityCandidates },
    ])
      expect(
        (await runClassifierDetailed(config, request(overrides), current))
          .diagnostics.outcome,
      ).toBe('unavailable');
    expect(current.classify).toHaveBeenCalledOnce();
  });
});

describe('goal and phase advice', () => {
  const activityCandidates = [
    {
      activity: 'ops' as const,
      candidate: createCandidate({
        tier: 'high',
        model: 'generation/ops',
        thinking: 'off',
      }),
    },
  ];
  it.each([
    ['verify', 'ops'],
    ['execute', 'ops'],
    ['produce', 'code'],
    ['reason', 'code'],
    ['report', 'code'],
  ])(
    'uses %s phase independently of the code goal',
    async (phase, effective) => {
      const current = registry();
      current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
        ...classifierResult(),
        answers: {
          ...classifierResult().answers,
          activity: {
            type: 'choice',
            choice: 'code',
            confidence: 0.9,
            probabilities: { code: 1 },
          },
          phase: {
            type: 'choice',
            choice: phase,
            confidence: 0.9,
            probabilities: { [phase]: 1 },
          },
        },
      }));
      const result = await runClassifierDetailed(
        config,
        request({ activityCandidates }),
        current,
      );
      expect(result.advice?.activity).toBe(effective);
      expect(result.diagnostics).toMatchObject({ activity: 'code', phase });
      const [, context] = vi.mocked(current.classify).mock.calls[0] ?? [];
      expect(context?.questions.phase?.type).toBe('choice');
      expect(context?.questions.activity?.type).toBe('choice');
    },
  );
});

describe('conservative phase gating', () => {
  const activityCandidates = [
    {
      activity: 'ops' as const,
      candidate: createCandidate({
        tier: 'high',
        model: 'generation/ops',
        thinking: 'off',
      }),
    },
  ];
  it.each(['missing', 'low', 'unknown', 'bad-sum', 'uncertain'])(
    'keeps the goal on %s phase',
    async (mode) => {
      const current = registry();
      current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
        ...classifierResult(),
        answers: {
          ...classifierResult().answers,
          activity: {
            type: 'choice',
            choice: 'code',
            confidence: 0.9,
            probabilities: { code: 1 },
          },
          ...(mode === 'missing'
            ? {}
            : {
                phase: {
                  type: 'choice' as const,
                  choice:
                    mode === 'unknown'
                      ? 'other'
                      : mode === 'uncertain'
                        ? 'uncertain'
                        : 'verify',
                  confidence: mode === 'low' ? 0.1 : 0.9,
                  probabilities:
                    mode === 'bad-sum'
                      ? { verify: 0.1 }
                      : {
                          [mode === 'unknown'
                            ? 'other'
                            : mode === 'uncertain'
                              ? 'uncertain'
                              : 'verify']: 1,
                        },
                },
              }),
        },
      }));
      const result = await runClassifierDetailed(
        config,
        request({ activityCandidates }),
        current,
      );
      expect(result.advice?.activity).toBe('code');
    },
  );
  it('does not derive ops when goal is missing', async () => {
    const current = registry();
    current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
      ...classifierResult(),
      answers: {
        ...classifierResult().answers,
        phase: {
          type: 'choice',
          choice: 'verify',
          confidence: 1,
          probabilities: { verify: 1 },
        },
      },
    }));
    const result = await runClassifierDetailed(
      config,
      request({ activityCandidates }),
      current,
    );
    expect(result.advice?.activity).toBeUndefined();
  });
});

it('does not downgrade based on unassociated notification progress', async () => {
  const current = registry();
  current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
    ...classifierResult(),
    answers: {
      ...classifierResult().answers,
      activity: {
        type: 'choice',
        choice: 'code',
        confidence: 1,
        probabilities: { code: 1 },
      },
      phase: {
        type: 'choice',
        choice: 'verify',
        confidence: 1,
        probabilities: { verify: 1 },
      },
    },
  }));
  const result = await runClassifierDetailed(
    config,
    request({
      context: {
        messages: [
          { role: 'user', content: 'Implement the feature', timestamp: 1 },
          {
            role: 'user',
            content: 'A different job reports tests passed',
            timestamp: 2,
          },
        ],
      },
      notificationIndices: [1],
      activityCandidates: [
        {
          activity: 'ops',
          candidate: createCandidate({
            tier: 'high',
            model: 'generation/ops',
            thinking: 'off',
          }),
        },
      ],
    }),
    current,
  );
  expect(result.advice?.activity).toBe('code');
});

it('marks prior task evidence separately from current-loop phase evidence', async () => {
  const current = registry();
  await runClassifierDetailed(
    config,
    request({
      context: {
        messages: [
          { role: 'user', content: 'previous task', timestamp: 1 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Ready to run the old checks' }],
            api: 'custom',
            provider: 'x',
            model: 'x',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'stop',
            timestamp: 2,
          },
          { role: 'user', content: 'Implement a new feature', timestamp: 3 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Editing the new feature' }],
            api: 'custom',
            provider: 'x',
            model: 'x',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'stop',
            timestamp: 4,
          },
        ],
      },
      activityCandidates: [
        {
          activity: 'ops',
          candidate: createCandidate({
            tier: 'high',
            model: 'generation/ops',
            thinking: 'off',
          }),
        },
      ],
    }),
    current,
  );
  const [, payload] = vi.mocked(current.classify).mock.calls[0] ?? [];
  expect(payload?.state.recentDialogue).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: 'Ready to run the old checks',
        scope: 'previous',
      }),
      expect.objectContaining({
        text: 'Editing the new feature',
        scope: 'current',
      }),
    ]),
  );
});

describe('durable goal continuity', () => {
  it.each(['continuation', 'new-task'] as const)(
    'asks continuity in the same operation and accepts %s',
    async (relation) => {
      const current = registry();
      current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
        ...classifierResult(),
        answers: {
          ...classifierResult().answers,
          activity: {
            type: 'choice',
            choice: 'code',
            confidence: 1,
            probabilities: { code: 1 },
          },
          continuity: {
            type: 'choice',
            choice: relation,
            confidence: 1,
            probabilities: { [relation]: 1 },
          },
        },
      }));
      const result = await runClassifierDetailed(
        config,
        request({
          activeGoal: {
            text: 'Implement the synthetic feature',
            truncated: false,
          },
          askContinuity: true,
          activityCandidates: [
            {
              activity: 'ops',
              candidate: createCandidate({
                tier: 'high',
                model: 'generation/ops',
                thinking: 'off',
              }),
            },
          ],
        }),
        current,
      );
      expect(result.goalRelation).toBe(relation);
      expect(result.advice?.activity).toBe('code');
      expect(current.classify).toHaveBeenCalledOnce();
      const [, payload] = vi.mocked(current.classify).mock.calls[0] ?? [];
      expect(payload?.state.activeGoal).toEqual({
        text: 'Implement the synthetic feature',
        truncated: false,
      });
      expect(payload?.questions.continuity?.type).toBe('choice');
    },
  );
  it('does not use goal or tier advice when continuity is missing or uncertain', async () => {
    for (const relation of [
      'missing',
      'uncertain',
      'low',
      'bad-sum',
      'bad-argmax',
      'bad-confidence',
    ]) {
      const current = registry();
      current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
        ...classifierResult(),
        answers: {
          ...classifierResult().answers,
          activity: {
            type: 'choice',
            choice: 'code',
            confidence: 1,
            probabilities: { code: 1 },
          },
          ...(relation === 'missing'
            ? {}
            : {
                continuity: {
                  type: 'choice' as const,
                  choice:
                    relation === 'uncertain' ? 'uncertain' : 'continuation',
                  confidence:
                    relation === 'low'
                      ? 0.1
                      : relation === 'bad-confidence'
                        ? 2
                        : 1,
                  probabilities:
                    relation === 'bad-sum'
                      ? { continuation: 0.2 }
                      : relation === 'bad-argmax'
                        ? { continuation: 0.1, 'new-task': 0.9 }
                        : {
                            [relation === 'uncertain'
                              ? 'uncertain'
                              : 'continuation']: 1,
                          },
                },
              }),
        },
      }));
      const result = await runClassifierDetailed(
        config,
        request({
          activeGoal: { text: 'Earlier goal', truncated: false },
          askContinuity: true,
          activityCandidates: [
            {
              activity: 'ops',
              candidate: createCandidate({
                tier: 'high',
                model: 'generation/ops',
                thinking: 'off',
              }),
            },
          ],
        }),
        current,
      );
      expect(result.advice).toBeUndefined();
      expect(result.goalRelation).toBeUndefined();
    }
  });
});

it('provides a short approval as the current request and prior proposals as reference only', async () => {
  const current = registry();
  await runClassifierDetailed(
    config,
    request({
      context: {
        messages: [
          { role: 'user', content: 'Implement the feature', timestamp: 1 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Run the specified tests?' }],
            api: 'custom',
            provider: 'x',
            model: 'x',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
            stopReason: 'stop',
            timestamp: 2,
          },
          { role: 'user', content: 'yes', timestamp: 3 },
        ],
      },
      activeGoal: { text: 'Implement the feature', truncated: false },
      askContinuity: true,
      activityCandidates: [
        {
          activity: 'ops',
          candidate: createCandidate({
            tier: 'high',
            model: 'generation/ops',
            thinking: 'off',
          }),
        },
      ],
    }),
    current,
  );
  const [, payload] = vi.mocked(current.classify).mock.calls[0] ?? [];
  expect(payload?.state.currentRequest).toMatchObject({ text: 'yes' });
  expect(payload?.state.recentDialogue).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        text: 'Run the specified tests?',
        scope: 'previous',
      }),
    ]),
  );
  expect(JSON.stringify(payload?.questions.phase)).toContain(
    'not itself the current step',
  );
});

it('rejects an oversized runtime goal anchor before calling Pi', async () => {
  const current = registry();
  const result = await runClassifierDetailed(
    config,
    request({
      activeGoal: { text: 'synthetic '.repeat(1000), truncated: false },
      askContinuity: true,
      activityCandidates: [
        {
          activity: 'ops',
          candidate: createCandidate({
            tier: 'high',
            model: 'generation/ops',
            thinking: 'off',
          }),
        },
      ],
    }),
    current,
  );
  expect(result.diagnostics.outcome).toBe('unavailable');
  expect(current.classify).not.toHaveBeenCalled();
});

it('asks about final deliverables rather than diagnostic steps or configuration tools', async () => {
  const current = registry();
  await runClassifierDetailed(
    config,
    request({
      activityCandidates: [
        {
          activity: 'code',
          candidate: createCandidate({
            tier: 'high',
            model: 'generation/code',
            thinking: 'off',
          }),
        },
      ],
    }),
    current,
  );
  const goal = vi.mocked(current.classify).mock.calls[0]?.[1].questions
    .activity;
  expect(goal?.type).toBe('choice');
  if (goal?.type !== 'choice') throw new Error('Missing goal question');
  expect(goal.criteria.code).toContain('required implemented fix');
  expect(goal.criteria.code).toContain('configuration');
  expect(goal.criteria.code).toContain('tests');
  expect(goal.criteria.debug).toContain('without a required implemented fix');
  expect(goal.criteria.ops).toContain(
    'specified operations as the final deliverable',
  );
  expect(goal.criteria.ops).toContain('not authoring configuration');
  expect(goal.criteria.code).not.toContain('unknown cause is debug');
});

it('can judge unanchored new-task evidence without inventing an active goal', async () => {
  for (const relation of ['new-task', 'continuation', undefined]) {
    const current = registry();
    current.classify = vi.fn<ClassifierRegistry['classify']>(async () => ({
      ...classifierResult(),
      answers: {
        ...classifierResult().answers,
        activity: {
          type: 'choice',
          choice: 'code',
          confidence: 1,
          probabilities: { code: 1 },
        },
        ...(relation
          ? {
              continuity: {
                type: 'choice' as const,
                choice: relation,
                confidence: 1,
                probabilities: { [relation]: 1 },
              },
            }
          : {}),
      },
    }));
    const result = await runClassifierDetailed(
      config,
      request({
        askContinuity: true,
        activityCandidates: [
          {
            activity: 'code',
            candidate: createCandidate({
              tier: 'high',
              model: 'generation/code',
              thinking: 'off',
            }),
          },
        ],
      }),
      current,
    );
    expect(result.goalRelation).toBe(relation);
    expect(result.advice?.activity).toBe('code');
    const payload = vi.mocked(current.classify).mock.calls[0]?.[1];
    expect(payload?.state.activeGoal).toBeUndefined();
    expect(payload?.questions.continuity?.type).toBe('choice');
  }
});
