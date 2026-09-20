import type { Context, Message, UserMessage } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
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
  buildRoutingDecision,
  decideRouting,
  phaseForTier,
  resolveAvailableTier,
} from './routing';
import type { RouterProfile, RoutingRule } from './types';

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
        'Reasoning string',
      );
      expect(decision.profile).toBe('balanced');
      expect(decision.tier).toBe('high');
      expect(decision.phase).toBe('planning');
      expect(decision.targetProvider).toBe('openai');
      expect(decision.targetModelId).toBe('gpt-4o-pro');
      expect(decision.targetLabel).toBe('openai/gpt-4o-pro');
      expect(decision.thinking).toBe('high');
      expect(decision.reasoning).toBe('Reasoning string');
    });

    it('throw if tier is not in profile', () => {
      expect(() =>
        buildRoutingDecision(
          'balanced',
          profile,
          'medium',
          'implementation',
          'Reason',
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
        messages: [{ role: 'user', content: 'deep design', timestamp: 1 }],
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
      expect(decision.reasoning).toContain('Pinned to high tier');
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
      expect(decision.reasoning).toBe('High rule');
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
      expect(decision.reasoning).toBe('High rule');
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
      expect(decision.reasoning).toBe('High rule');
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
        'Initial plan',
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
        'Previous planning',
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
      expect(decision.reasoning).toContain('planning-phase bias');
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
        'Previous impl',
      );
      const decision = decideRouting(context, 'p', profile, previous);
      expect(decision.tier).toBe('medium');
      expect(decision.phase).toBe('implementation');
      expect(decision.reasoning).toContain('implementation');
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
      expect(decision.reasoning).toContain('implementation');
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
      expect(decision.reasoning).toContain('implementation');
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
      expect(decision.reasoning).toContain('Defaulted to medium');
    });
  });
});
