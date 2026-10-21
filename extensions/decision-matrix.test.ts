import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { normalizeConfig } from './config';
import { prepareRouterRequest } from './provider-request';
import { createProviderTurnCache } from './provider-turns';
import { message, model, required } from './test/fixtures';
import type {
  RouterMode,
  RouterThinkingByTier,
  RouterTier,
  RoutingDecision,
} from './types';
import { ROUTER_MODES, ROUTER_TIERS } from './types';

/** Pi 1.3.0 catalog prices and effort maps for the user's routed models. */
const unsupported = { off: null, minimal: null } as const;
const extended = { xhigh: 'xhigh', max: 'max' } as const;
const catalog: Model<Api>[] = [
  model('claude-opus-5-5', {
    provider: 'anthropic',
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    thinkingLevelMap: { ...unsupported, ...extended },
    contextWindow: 1_000_000,
  }),
  model('claude-sonnet-5-5', {
    provider: 'anthropic',
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    thinkingLevelMap: { ...unsupported, ...extended },
    contextWindow: 1_000_000,
  }),
  model('claude-haiku-4-5', {
    provider: 'anthropic',
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
  }),
  model('gpt-6.1-sol', {
    provider: 'openai-codex',
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    thinkingLevelMap: { off: null, ...extended },
    contextWindow: 500_000,
  }),
  model('gpt-6-luna', {
    provider: 'openai-codex',
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    thinkingLevelMap: extended,
    contextWindow: 272_000,
  }),
];

const JEV = 'typesafe/jev-1.14.0';
type Classify = ExtensionContext['modelRegistry']['classify'];
/** The user's claude-* and openai-* profile shapes, plus one code cell each. */
const profiles = {
  claude: {
    advisor: { models: [JEV] },
    high: { model: 'anthropic/claude-opus-5-5', thinking: 'high' },
    medium: { model: 'anthropic/claude-sonnet-5-5', thinking: 'medium' },
    low: { model: 'anthropic/claude-sonnet-5-5', thinking: 'low' },
    micro: { model: 'anthropic/claude-haiku-4-5', thinking: 'off' },
    activities: {
      code: {
        medium: { model: 'anthropic/claude-opus-5-5', thinking: 'medium' },
      },
    },
  },
  openai: {
    advisor: { models: [JEV] },
    high: { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' },
    medium: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
    low: { model: 'openai-codex/gpt-6-luna', thinking: 'medium' },
    micro: { model: 'openai-codex/gpt-6-luna', thinking: 'off' },
    activities: {
      code: { medium: { model: 'openai-codex/gpt-6-luna', thinking: 'high' } },
    },
  },
} as const;

const OUTCOMES = [
  'none',
  ...[...ROUTER_TIERS].reverse(),
  'uncertain',
  'invalid',
] as const;
type Outcome = (typeof OUTCOMES)[number];
const MODIFIERS = [
  'plain',
  'pin-medium',
  'effort-low',
  'budget',
  'escalation',
] as const;
type Modifier = (typeof MODIFIERS)[number];

const registry = (outcome: Outcome, activity: string) =>
  ({
    find: (provider: string, id: string) =>
      catalog.find((entry) => entry.provider === provider && entry.id === id),
    findOfType: () => ({
      type: 'classifier',
      provider: 'typesafe',
      id: 'jev-1.14.0',
      name: 'Jev',
      api: 'typesafe-system-one',
      baseUrl: 'https://fixture.invalid',
      input: ['text'],
      contextWindow: 64_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    classify: async (
      target: Parameters<Classify>[0],
      context: Parameters<Classify>[1],
    ) => {
      const route = context.questions.route;
      const ids = route?.type === 'choice' ? Object.keys(route.criteria) : [];
      const choice =
        outcome === 'invalid'
          ? 'not-a-candidate'
          : outcome === 'uncertain'
            ? 'uncertain'
            : (ids.find((id) => id.startsWith(`${outcome}|`)) ?? 'uncertain');
      return {
        api: target.api,
        provider: target.provider,
        model: target.id,
        timestamp: 1,
        stopReason: 'stop',
        answers: {
          ...(route
            ? {
                route: {
                  type: 'choice',
                  choice,
                  confidence: 0.95,
                  probabilities: { [choice]: 1 },
                },
              }
            : {}),
          ...(context.questions.activity
            ? {
                activity: {
                  type: 'choice',
                  choice: activity,
                  confidence: 0.95,
                  probabilities: { [activity]: 1 },
                },
              }
            : {}),
        },
      };
    },
  }) as unknown as Pick<
    ExtensionContext['modelRegistry'],
    'find' | 'findOfType' | 'classify'
  >;

const toolLoop: Context['messages'] = [
  { role: 'user', content: 'Fix the failing parser test.', timestamp: 1 },
  ...(['bash', 'edit', 'bash'] as const).flatMap((toolName, index) => [
    message({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      stopReason: 'toolUse',
      content: [
        { type: 'toolCall', id: `c${index}`, name: toolName, arguments: {} },
      ],
    }),
    {
      role: 'toolResult' as const,
      toolCallId: `c${index}`,
      toolName,
      content: [
        {
          type: 'text' as const,
          text: toolName === 'edit' ? 'Applied' : 'FAIL parser.test.ts:12',
        },
      ],
      isError: toolName !== 'edit',
      timestamp: 2 + index,
    },
  ]),
];

const decide = async (
  name: keyof typeof profiles,
  outcome: Outcome,
  activity: string,
  mode: RouterMode,
  modifier: Modifier,
): Promise<RoutingDecision> => {
  const config = normalizeConfig({
    ...(outcome === 'none' ? {} : { advisor: { enabled: true, model: JEV } }),
    ...(modifier === 'budget' ? { maxSessionBudget: 1 } : {}),
    profiles: { [name]: profiles[name] },
  }).config;
  const resolved = { mode, source: 'profile' as const };
  const thinkingOverrides: RouterThinkingByTier | undefined =
    modifier === 'effort-low'
      ? Object.fromEntries(ROUTER_TIERS.map((tier) => [tier, 'low']))
      : undefined;
  const base = {
    profileName: name,
    profile: required(config.profiles[name]),
    config,
    getCurrentConfig: () => config,
    registry: registry(outcome, activity),
    ...(modifier === 'pin-medium'
      ? { pinnedTier: 'medium' as RouterTier }
      : {}),
    ...(thinkingOverrides ? { thinkingOverrides } : {}),
    mode: resolved,
    getCurrentMode: () => resolved,
    accumulatedCost: modifier === 'budget' ? 5 : 0,
    lastDecision: undefined,
    cache: createProviderTurnCache(),
  };
  if (modifier === 'escalation')
    await prepareRouterRequest({
      ...base,
      context: { messages: toolLoop },
      identity: { turn: 'failing-turn', branch: ['b'] },
    });
  const messages: Context['messages'] = [
    ...(modifier === 'escalation' ? toolLoop : []),
    { role: 'user', content: 'Continue with the next change.', timestamp: 10 },
  ];
  return (
    await prepareRouterRequest({
      ...base,
      context: { messages },
      identity: { turn: 'next-turn', branch: ['b'] },
    })
  ).decision;
};

const row = (decision: RoutingDecision): string =>
  [
    decision.tier.padEnd(6),
    `${decision.targetLabel}/${decision.thinking}`.padEnd(37),
    `cell=${decision.routeCell ?? 'generic'}`.padEnd(12),
    `lever=${decision.modeLever ?? 'bypass'}${decision.modeSourceTier && decision.modeLever !== 'none' ? `<${decision.modeSourceTier}` : ''}`.padEnd(
      19,
    ),
    `reason=${decision.reasonCode}${decision.escalatedFrom ? `<${decision.escalatedFrom}` : ''}`,
  ].join(' ');

describe('golden routing decision matrix', () => {
  it('matches the reviewed decision table for every classifier outcome, mode and modifier', async () => {
    const lines: string[] = [];
    for (const name of Object.keys(profiles) as (keyof typeof profiles)[])
      for (const modifier of MODIFIERS)
        for (const outcome of OUTCOMES)
          for (const activity of outcome === 'none'
            ? ['-']
            : ['explore', 'code'])
            for (const mode of ROUTER_MODES) {
              const decision = await decide(
                name,
                outcome,
                activity,
                mode,
                modifier,
              );
              lines.push(
                `${name.padEnd(6)} ${modifier.padEnd(10)} ${outcome.padEnd(9)} ${activity.padEnd(7)} ${mode.padEnd(8)} -> ${row(decision)}`,
              );
            }
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(
      './test/golden/decision-matrix.txt',
    );
  });

  it('never moves a lever in balanced mode', async () => {
    for (const name of Object.keys(profiles) as (keyof typeof profiles)[])
      for (const outcome of OUTCOMES) {
        const decision = await decide(
          name,
          outcome,
          'code',
          'balanced',
          'plain',
        );
        expect(decision.modeLever ?? 'none').toBe('none');
      }
  });
});
