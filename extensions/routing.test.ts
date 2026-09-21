import type { Context, Message, UserMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { normalizeConfig } from './config';
import {
  containsAny,
  countToolResults,
  countWords,
  extractTextFromContent,
  getLastUserText,
  getRecentConversationText,
  hasImageAttachment,
} from './context';
import {
  allowed,
  availableRoutePairs,
  buildRoutingDecision,
  decideRouting,
  isMechanicalTask,
  localSafetyFloor,
  phaseForTier,
  resolveAvailableTier,
  resolveRoutePair,
  tierRank,
  validateRoutePair,
} from './routing';
import { model, required } from './test/fixtures';
import type { RouterProfile, RouterTier, RoutingRule } from './types';
import { ROUTER_TIERS } from './types';

describe('routing.ts', () => {
  describe('extractTextFromContent', () => {
    it('return string directly if content is string', () => {
      expect(extractTextFromContent('hello world')).toBe('hello world');
    });

    it('extract text and toolCall parts from message structure', () => {
      const parts: Message['content'] = [
        { type: 'text' as const, text: 'some text' },
        { type: 'thinking' as const, thinking: 'some thought' },
        {
          type: 'toolCall' as const,
          id: 'call_1',
          name: 'write_file',
          arguments: { path: 'file.txt' },
        },
      ];
      const result = extractTextFromContent(parts);
      expect(result).toContain('some text');
      expect(result).toContain('some thought');
      expect(result).toContain('write_file {"path":"file.txt"}');
    });
  });

  describe('getLastUserText', () => {
    it('return empty string if no messages', () => {
      const context: Context = { messages: [] };
      expect(getLastUserText(context)).toBe('');
    });

    it('extract the last user message text', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'first user', timestamp: Date.now() },
          {
            role: 'assistant',
            content: 'assistant response',
            timestamp: Date.now(),
          } as unknown as Message,
          { role: 'user', content: 'second user', timestamp: Date.now() },
          {
            role: 'assistant',
            content: 'another assistant',
            timestamp: Date.now(),
          } as unknown as Message,
        ],
      };
      expect(getLastUserText(context)).toBe('second user');
    });
  });

  describe('getRecentConversationText', () => {
    it('combine last N messages in lowercase', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'First', timestamp: Date.now() },
          { role: 'user', content: 'Second', timestamp: Date.now() },
          { role: 'user', content: 'Third', timestamp: Date.now() },
        ],
      };
      const result = getRecentConversationText(context, 2);
      expect(result).toBe('second\nthird');
    });
  });

  describe('countToolResults', () => {
    it('count messages with role toolResult', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'hey', timestamp: Date.now() },
          {
            role: 'toolResult',
            toolCallId: '1',
            toolName: 't',
            content: 'result 1',
            isError: false,
            timestamp: Date.now(),
          } as unknown as Message,
          { role: 'user', content: 'ok', timestamp: Date.now() },
          {
            role: 'toolResult',
            toolCallId: '2',
            toolName: 't',
            content: 'result 2',
            isError: false,
            timestamp: Date.now(),
          } as unknown as Message,
        ],
      };
      expect(countToolResults(context)).toBe(2);
    });
  });

  describe('countWords', () => {
    it('count words correctly', () => {
      expect(countWords('   one two   three\nfour ')).toBe(4);
      expect(countWords('')).toBe(0);
    });
  });

  describe('hasImageAttachment', () => {
    it('return true if any message contains image part', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image' as const },
            ] as unknown as UserMessage['content'],
            timestamp: Date.now(),
          },
        ],
      };
      expect(hasImageAttachment(context)).toBe(true);
    });

    it('return false if no image part exists', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'text message', timestamp: Date.now() },
        ],
      };
      expect(hasImageAttachment(context)).toBe(false);
    });
  });

  describe('containsAny', () => {
    it('check if string contains any keyword', () => {
      expect(containsAny('hello world', ['earth', 'world'])).toBe(true);
      expect(containsAny('hello world', ['mars'])).toBe(false);
    });
  });

  describe('phaseForTier', () => {
    it('return correct phase for tier', () => {
      expect(phaseForTier('high')).toBe('planning');
      expect(phaseForTier('medium')).toBe('implementation');
      expect(phaseForTier('low')).toBe('lightweight');
    });
  });

  describe('resolveAvailableTier', () => {
    it('return preferred if available', () => {
      expect(
        resolveAvailableTier(
          { high: { model: 'a' }, medium: { model: 'b' } },
          'high',
        ),
      ).toBe('high');
    });

    it('fall up if preferred is unavailable', () => {
      expect(resolveAvailableTier({ high: { model: 'a' } }, 'low')).toBe(
        'high',
      );
    });

    it('fall down if falling up finds nothing', () => {
      expect(resolveAvailableTier({ low: { model: 'a' } }, 'medium')).toBe(
        'low',
      );
    });
  });

  describe('buildRoutingDecision', () => {
    const profile: RouterProfile = {
      high: { model: 'openai/gpt-4o-pro', thinking: 'high' },
    };

    it('construct correct decision object', () => {
      const decision = buildRoutingDecision(
        'balanced',
        profile,
        'high',
        'planning',
        'heuristic',
      );
      expect(decision.profile).toBe('balanced');
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
      expect(decision.targetProvider).toBe('openai');
      expect(decision.targetModelId).toBe('gpt-4o-pro');
      expect(decision.targetLabel).toBe('openai/gpt-4o-pro');
      expect(decision.thinking).toBe('high');
      expect(decision.reasonCode).toBe('heuristic');
    });

    it('throw if tier is not in profile', () => {
      expect(() =>
        buildRoutingDecision(
          'balanced',
          profile,
          'medium',
          'implementation',
          'heuristic',
        ),
      ).toThrow();
    });
  });

  describe('decideRouting', () => {
    it('uses an available low tier instead of re-escalating after the budget downgrade', () => {
      const profile: RouterProfile = {
        high: { model: 'test/high' },
        low: { model: 'test/low' },
      };
      const context: Context = {
        messages: [{ role: 'user', content: 'think hard', timestamp: 1 }],
      };
      expect(
        decideRouting(
          context,
          'balanced',
          profile,
          undefined,
          undefined,
          undefined,
          0.5,
          undefined,
          true,
        ),
      ).toMatchObject({ tier: 'low', isBudgetForced: true });
    });
    const profile: RouterProfile = {
      high: { model: 'openai/gpt-4o', resolvedContextWindow: 100 },
      medium: { model: 'openai/gpt-4o-mini', resolvedContextWindow: 100 },
      low: { model: 'openai/gpt-4o-micro', resolvedContextWindow: 100 },
    };

    const rules: RoutingRule[] = [
      { matches: 'force-high', tier: 'high', reason: 'High rule' },
    ];

    it('respect manual pinned tier', () => {
      const context: Context = {
        messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }],
      };
      const decision = decideRouting(context, 'p', profile, undefined, 'high');
      expect(decision.tier).toBe('high');
      expect(decision.reasonCode).toBe('pinned');
    });

    it('match custom rule first', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Please force-high model',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        rules,
      );
      expect(decision.tier).toBe('high');
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasonCode).toBe('custom-rule');
    });

    it('match custom rule case-insensitively', () => {
      const rulesWithCapitalCase = [
        { matches: 'Force-High', tier: 'high' as const, reason: 'High rule' },
      ];
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Please force-high model',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        rulesWithCapitalCase,
      );
      expect(decision.tier).toBe('high');
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasonCode).toBe('custom-rule');
    });

    it('collect all matching rules and pick the highest tier', () => {
      const rulesWithMultipleMatches = [
        { matches: 'summary', tier: 'low' as const, reason: 'Low rule' },
        { matches: 'refactor', tier: 'high' as const, reason: 'High rule' },
      ];
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'Please summarize the refactor',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        rulesWithMultipleMatches,
      );
      expect(decision.tier).toBe('high');
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasonCode).toBe('custom-rule');
    });

    it('route explicit high/low hints', () => {
      const contextHigh: Context = {
        messages: [
          {
            role: 'user',
            content: 'think hard step by step',
            timestamp: Date.now(),
          },
        ],
      };
      const decisionHigh = decideRouting(contextHigh, 'p', profile, undefined);
      expect(decisionHigh.tier).toBe('high');

      const contextLow: Context = {
        messages: [
          { role: 'user', content: 'fast summary', timestamp: Date.now() },
        ],
      };
      const decisionLow = decideRouting(contextLow, 'p', profile, undefined);
      expect(decisionLow.tier).toBe('low');
    });

    it('downgrade high to medium if budget is exceeded', () => {
      const context: Context = {
        messages: [
          { role: 'user', content: 'think hard', timestamp: Date.now() },
        ],
      };
      const decision = decideRouting(
        context,
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        true,
      );
      expect(decision.tier).toBe('medium');
      expect(decision.isBudgetForced).toBe(true);
    });

    it('maintain planning phase bias (stickiness)', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'how to design this',
            timestamp: Date.now(),
          },
          {
            role: 'user',
            content: 'we should design X',
            timestamp: Date.now(),
          },
          { role: 'user', content: 'why X?', timestamp: Date.now() },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'high',
        'planning',
        'heuristic',
      );
      const decision = decideRouting(context, 'p', profile, previous);
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
    });

    it('keep planning phase bias when previous phase was planning, no tools, and word count > lowThreshold', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content:
              'what about this particular scenario that we discussed earlier today',
            timestamp: Date.now(),
          },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'high',
        'planning',
        'heuristic',
      );
      const decision = decideRouting(
        context,
        'p',
        profile,
        previous,
        undefined,
        undefined,
        0.5,
      );
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
      expect(decision.reasonCode).toBe('heuristic');
    });

    it('detect implementation from previous implementation phase', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'ok next step',
            timestamp: Date.now(),
          },
        ],
      };
      const previous = buildRoutingDecision(
        'p',
        profile,
        'medium',
        'implementation',
        'heuristic',
      );
      const decision = decideRouting(context, 'p', profile, previous);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasonCode).toBe('heuristic');
    });

    it('detect implementation from toolResultCount > 0', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content: 'ok next step',
            timestamp: Date.now(),
          },
          {
            role: 'toolResult',
            toolCallId: '1',
            toolName: 'read_file',
            content: 'file contents',
            isError: false,
            timestamp: Date.now(),
          } as unknown as Message,
          {
            role: 'user',
            content: 'looks good proceed',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(context, 'p', profile, undefined);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasonCode).toBe('heuristic');
    });

    it('detect implementation from recent conversation containing plan:', () => {
      const context: Context = {
        messages: [
          {
            role: 'assistant',
            content: 'Plan:\n1. Do X\n2. Do Y',
            timestamp: Date.now(),
          } as unknown as Message,
          {
            role: 'user',
            content: 'sounds good lets go',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(context, 'p', profile, undefined);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasonCode).toBe('heuristic');
    });

    it('default to medium tier when no heuristic rules match for moderate-length prompts', () => {
      const context: Context = {
        messages: [
          {
            role: 'user',
            content:
              'i wonder about some random topic that doesnt match any particular keyword category here today now',
            timestamp: Date.now(),
          },
        ],
      };
      const decision = decideRouting(context, 'p', profile, undefined);
      expect(decision.tier).toBe('medium');
      expect(decision.reasonCode).toBe('heuristic');
    });
  });
});

describe('four-level local routing', () => {
  const profile: RouterProfile = Object.fromEntries(
    ROUTER_TIERS.map((tier) => [tier, { model: `test/${tier}` }]),
  );
  const context = (content: string): Context => ({
    messages: [{ role: 'user', content, timestamp: 1 }],
  });
  const prompts: Record<RouterTier, string> = {
    micro: 'git status --short',
    low: 'hello',
    medium: 'fix the test',
    high: 'design the architecture',
  };

  it.each(ROUTER_TIERS)(
    '%s has a distinct rank, phase, default effort and route pair',
    (tier) => {
      expect(tierRank(tier)).toBe(
        ['micro', 'low', 'medium', 'high'].indexOf(tier),
      );
      expect(phaseForTier(tier)).toBe(
        tier === 'high'
          ? 'planning'
          : tier === 'medium'
            ? 'implementation'
            : 'lightweight',
      );
      expect(resolveRoutePair(profile, tier)).toEqual({
        tier,
        model: `test/${tier}`,
        thinking: tier === 'micro' ? 'off' : tier,
      });
      expect(resolveAvailableTier(profile, tier, tier)).toBe(tier);
      expect(
        decideRouting(context(prompts[tier]), 'p', profile, undefined).tier,
      ).toBe(tier);
      expect(
        decideRouting(context('pwd'), 'p', profile, undefined, tier).tier,
      ).toBe(tier);
    },
  );

  it.each(
    ROUTER_TIERS.flatMap((tier) =>
      ROUTER_TIERS.map((floor) => ({ tier, floor })),
    ),
  )(
    'enforces $floor floor against $tier pins, rules, budgets and partial profiles',
    ({ tier, floor }) => {
      const expected = allowed(tier, floor) ? tier : floor;
      expect(allowed(tier, floor)).toBe(tierRank(tier) >= tierRank(floor));
      expect(
        decideRouting(context(prompts[floor]), 'p', profile, undefined, tier)
          .tier,
      ).toBe(expected);
      expect(
        decideRouting(
          context(prompts[floor]),
          'p',
          profile,
          undefined,
          undefined,
          undefined,
          0.5,
          [{ matches: prompts[floor], tier }],
        ).tier,
      ).toBe(expected);
      const budget = decideRouting(
        context(prompts[floor]),
        'p',
        profile,
        undefined,
        tier,
        undefined,
        0.5,
        undefined,
        true,
      );
      expect(allowed(budget.tier, floor)).toBe(true);
      const partial: RouterProfile = { [tier]: profile[tier] };
      if (allowed(tier, floor)) {
        expect(resolveAvailableTier(partial, floor, floor)).toBe(tier);
      } else {
        expect(() => resolveAvailableTier(partial, floor, floor)).toThrow(
          'No eligible route',
        );
      }
    },
  );

  it.each([
    'pwd',
    'Please run git status --short.',
    'git diff --stat',
    'git log -1 --oneline',
    'head -n 20 README.md',
    'Replace the exact comment "// teh value" with "// the value" in src/index.ts',
  ])('recognizes only bounded mechanical requests: %s', (prompt) => {
    expect(isMechanicalTask(prompt)).toBe(true);
    expect(
      decideRouting(context(prompt), 'p', profile, undefined),
    ).toMatchObject({
      tier: 'micro',
      thinking: 'off',
      reasonCode: 'micro-mechanical',
    });
  });

  it.each([
    ['git status; delete the repository', 'high'],
    ['git status && rm -rf ./src', 'high'],
    ['git status --short and design a migration', 'high'],
    ['quick security fix', 'high'],
    ['broad debugging', 'high'],
    ['database migrations', 'high'],
    ['deleting old files', 'high'],
    ['editing a file', 'medium'],
    ['remove the directory', 'high'],
    ['add logging', 'medium'],
    ['add a dropdown', 'medium'],
    ['WIP commit', 'low'],
    ['drop the database', 'high'],
    ['dropped tables', 'high'],
    ['wipe the disk', 'high'],
    ['wiping the disk', 'high'],
    ['briefly debug the entire system', 'high'],
    ['fix the concurrency bug', 'high'],
    ['deploy to production', 'high'],
    ['write comments', 'medium'],
    ['quickly edit this file', 'medium'],
    ['debug this test', 'medium'],
    ['make a tiny change', 'medium'],
    ['git status && pwd', 'low'],
    ['git status $(whoami)', 'low'],
    ['git status > status.txt', 'low'],
    ['git status | cat', 'low'],
    ['git unknown', 'low'],
    ['run an arbitrary CLI command', 'low'],
    ['what should I do?', 'low'],
    ['head -n 1000 README.md', 'low'],
    ['head -n 10 --help', 'low'],
  ] as const)(
    'never routes dangerous or ambiguous input to micro: %s',
    (prompt, floor) => {
      expect(isMechanicalTask(prompt)).toBe(false);
      expect(localSafetyFloor(context(prompt))).toBe(floor);
      expect(
        allowed(
          decideRouting(context(prompt), 'p', profile, undefined, 'micro').tier,
          floor,
        ),
      ).toBe(true);
    },
  );

  it.each([
    'go ahead',
    'continue',
    'resume',
    'implement it',
    'apply the plan',
    'yes',
    'apply the patch',
  ])(
    'inherits the active task floor for %s, including repeated follow-ups',
    (followUp) => {
      const conversation: Context = {
        messages: [
          ...context('design a secure authentication flow').messages,
          ...context('go ahead').messages,
          ...context(followUp).messages,
        ],
      };
      expect(localSafetyFloor(conversation)).toBe('high');
      expect(localSafetyFloor(context(followUp))).toBe('medium');
      expect(
        localSafetyFloor({
          messages: [
            ...conversation.messages,
            ...context('add a dropdown').messages,
          ],
        }),
      ).toBe('medium');
      expect(
        localSafetyFloor({
          messages: [...conversation.messages, ...context('pwd').messages],
        }),
      ).toBe('micro');
    },
  );

  it('risk signals override an otherwise exact mechanical match', () => {
    const prompt =
      'Replace the exact comment "// security" with "// disabled" in auth.ts';
    expect(isMechanicalTask(prompt)).toBe(true);
    expect(localSafetyFloor(context(prompt))).toBe('high');
  });

  it('keeps safety above a below-floor pin or soft budget', () => {
    expect(
      decideRouting(
        context('design a migration'),
        'p',
        profile,
        undefined,
        'micro',
      ),
    ).toMatchObject({
      tier: 'high',
      reasonCode: 'pinned',
    });
    expect(
      decideRouting(
        context('design a migration'),
        'p',
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        true,
      ),
    ).toMatchObject({
      tier: 'high',
      reasonCode: 'budget-floor-conflict',
      isBudgetForced: false,
    });
    const partial = { high: profile.high, low: profile.low };
    expect(
      decideRouting(
        context('think hard and fix the bug'),
        'p',
        partial,
        undefined,
        undefined,
        undefined,
        0.5,
        undefined,
        true,
      ),
    ).toMatchObject({
      tier: 'high',
      reasonCode: 'budget-floor-conflict',
    });
  });

  it('preserves old three-tier profiles and accepts informational keyword mentions', () => {
    expect(
      decideRouting(context('pwd'), 'p', { low: profile.low }, undefined).tier,
    ).toBe('low');
    for (const prompt of [
      'What does the auth module do?',
      'What is the production configuration?',
      'Can you explain the design document?',
    ]) {
      expect(
        decideRouting(context(prompt), 'p', { low: profile.low }, undefined)
          .tier,
      ).toBe('low');
    }
    expect(() =>
      decideRouting(
        context('design a migration'),
        'p',
        { low: profile.low },
        undefined,
      ),
    ).toThrow('No eligible route');
  });

  it('normalizes route identity and honors explicit thinking overrides', () => {
    expect(
      resolveRoutePair(
        { micro: { model: ' test / tiny ', thinking: 'low' } },
        'micro',
      ),
    ).toEqual({ tier: 'micro', model: 'test/tiny', thinking: 'low' });
    expect(
      resolveRoutePair(profile, 'micro', { micro: 'minimal' }).thinking,
    ).toBe('minimal');
  });
});

describe('local authority across every routing source', () => {
  const profile = required(
    normalizeConfig({
      profiles: {
        balanced: {
          micro: { model: 'test/tiny' },
          low: { model: 'test/small' },
          medium: { model: 'test/worker' },
          high: { model: 'test/frontier' },
        },
      },
    }).config.profiles.balanced,
  );
  it.each(
    ROUTER_TIERS.flatMap((tier) =>
      ROUTER_TIERS.map((floor) => ({ tier, floor })),
    ),
  )(
    'enforces allowed($tier, $floor) in candidate validation and source policy',
    ({ tier, floor }) => {
      const expected = tierRank(tier) >= tierRank(floor);
      const prompt = {
        micro: 'pwd',
        low: 'what is this?',
        medium: 'implement parser',
        high: 'design security',
      }[floor];
      const context: Context = {
        messages: [{ role: 'user', content: prompt, timestamp: 1 }],
      };
      const pair = resolveRoutePair(profile, tier);
      expect(
        validateRoutePair(pair, floor, (_provider, id) => model(id), false),
      ).toBe(expected);
      // Jev and all fallback routes are constructed only from these validated pairs.
      expect(
        availableRoutePairs(
          profile,
          floor,
          (_provider, id) => model(id),
          false,
        ).some((candidate) => candidate.tier === tier),
      ).toBe(expected);
      for (const budget of [true, false]) {
        const pinned = decideRouting(
          context,
          'p',
          profile,
          undefined,
          tier,
          undefined,
          0.5,
          undefined,
          budget,
        );
        const ruled = decideRouting(
          context,
          'p',
          profile,
          undefined,
          undefined,
          undefined,
          0.5,
          [{ matches: prompt, tier, reason: 'private rule text' }],
          budget,
        );
        for (const decision of [pinned, ruled]) {
          expect(allowed(decision.tier, floor)).toBe(true);
          expect(JSON.stringify(decision)).not.toContain('private rule text');
        }
      }
    },
  );
  it('checks actual model input and effort, including non-reasoning and off support', () => {
    const pair = {
      tier: 'medium' as const,
      model: 'test/worker',
      thinking: 'medium' as const,
    };
    expect(validateRoutePair(pair, 'low', () => undefined, false)).toBe(false);
    expect(
      validateRoutePair(
        pair,
        'low',
        () => model('worker', { input: ['text'] }),
        true,
      ),
    ).toBe(false);
    expect(
      validateRoutePair(
        pair,
        'low',
        () => model('worker', { reasoning: false }),
        false,
      ),
    ).toBe(false);
    expect(
      validateRoutePair(
        pair,
        'low',
        () => model('worker', { thinkingLevelMap: { medium: null } }),
        false,
      ),
    ).toBe(false);
    expect(
      validateRoutePair(
        { ...pair, thinking: 'off' },
        'low',
        () => model('worker', { thinkingLevelMap: { off: null } }),
        false,
      ),
    ).toBe(false);
    expect(validateRoutePair(pair, 'low', () => model(), false, ['high'])).toBe(
      false,
    );
  });
});

describe('normalized route thinking', () => {
  it.each([undefined, 'medium', 'off'] as const)(
    'resolves omitted versus explicit %s thinking for each actual target',
    (thinking) => {
      const profile = required(
        normalizeConfig({
          profiles: {
            p: {
              medium: {
                model: 'test/primary',
                fallbacks: ['test/fallback'],
                ...(thinking ? { thinking } : {}),
              },
            },
          },
        }).config.profiles.p,
      );
      const pairs = availableRoutePairs(
        profile,
        'medium',
        (_provider, id) => model(id, { reasoning: false }),
        false,
      );
      expect(pairs.map((pair) => pair.thinking)).toEqual(
        thinking === 'medium' ? [] : ['off', 'off'],
      );
      const mixed = availableRoutePairs(
        profile,
        'medium',
        (_provider, id) => model(id, { reasoning: id === 'primary' }),
        false,
      );
      expect(mixed.map((pair) => pair.thinking)).toEqual(
        thinking === 'medium'
          ? ['medium']
          : thinking === 'off'
            ? ['off', 'off']
            : ['medium', 'off'],
      );
    },
  );

  it.each(['\r', '\n', '\u2028', '\u2029'])(
    'rejects executable code after source line terminator %j',
    (terminator) => {
      expect(
        isMechanicalTask(
          `replace the exact comment "// old" with "// new${terminator}process.exit()" in file.ts`,
        ),
      ).toBe(false);
      expect(
        isMechanicalTask(
          `replace the exact comment "// old${terminator}process.exit()" with "// new" in file.ts`,
        ),
      ).toBe(false);
    },
  );
});

describe('review route eligibility regressions', () => {
  it.each(['tier', 'alias'] as const)(
    'defaults %s reasoning:false to off but rejects explicit thinking',
    (source) => {
      for (const thinking of [undefined, 'medium'] as const) {
        const config = normalizeConfig({
          models: { disabled: { model: 'test/worker', reasoning: false } },
          profiles: {
            p: {
              medium: {
                model: source === 'alias' ? 'disabled' : 'test/worker',
                ...(source === 'tier' ? { reasoning: false } : {}),
                ...(thinking ? { thinking } : {}),
              },
            },
          },
        }).config;
        const profile = required(config.profiles.p);
        expect(profile.medium?.thinking).toBe(thinking ?? 'off');
        expect(
          availableRoutePairs(profile, 'medium', () => model(), false),
        ).toEqual(
          thinking
            ? []
            : [{ tier: 'medium', model: 'test/worker', thinking: 'off' }],
        );
      }
    },
  );

  it('excludes image-only models from text routes', () => {
    const profile = { high: { model: 'test/image', thinking: 'off' as const } };
    const find = () => model('image', { input: ['image'] });
    expect(availableRoutePairs(profile, 'high', find, false)).toEqual([]);
    expect(availableRoutePairs(profile, 'high', find, true)).toHaveLength(1);
  });

  it.each([
    'git branch -D feature',
    'git branch -df feature',
    'git branch --delete --force feature',
    'git branch --force feature main',
    'git branch -M feature main',
    'git branch -C main feature',
  ])('requires high safety for %s', (command) => {
    expect(
      localSafetyFloor({
        messages: [{ role: 'user', content: `run ${command}`, timestamp: 1 }],
      }),
    ).toBe('high');
  });

  it.each(
    [false, true].flatMap((reverse) =>
      [['backup'], ['restricted'], ['restricted', 'backup']].map(
        (fallbacks) => ({ reverse, fallbacks }),
      ),
    ),
  )(
    'uses exact fallback aliases $fallbacks with reversed order $reverse',
    ({ reverse, fallbacks }) => {
      const entries = [
        ['restricted', { model: 'test/fallback', thinkingLevels: ['high'] }],
        ['backup', { model: 'test/fallback', thinkingLevels: ['medium'] }],
      ];
      const config = normalizeConfig({
        models: Object.fromEntries(reverse ? entries.reverse() : entries),
        profiles: {
          p: {
            medium: {
              model: 'test/missing',
              fallbacks,
            },
          },
        },
      }).config;
      const pairs = availableRoutePairs(
        required(config.profiles.p),
        'medium',
        (_provider, id) => (id === 'fallback' ? model(id) : undefined),
        false,
        undefined,
        config.models,
      );
      expect(pairs).toEqual(
        fallbacks.includes('backup')
          ? [{ tier: 'medium', model: 'test/fallback', thinking: 'medium' }]
          : [],
      );
    },
  );
});
