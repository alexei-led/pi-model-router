import { readFileSync } from 'node:fs';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeConfig } from './config';
import { prepareRouterRequest } from './provider-request';
import { createProviderTurnCache } from './provider-turns';
import { buildRouteMatrix } from './routing';
import { message, model, required } from './test/fixtures';
import type {
  RawRouterConfig,
  RouterMode,
  RouterThinkingByTier,
  RouterTier,
  RoutingDecision,
} from './types';
import { ROUTER_ACTIVITIES, ROUTER_MODES, ROUTER_TIERS } from './types';

/** Pi 1.3.0 catalog prices and effort maps for the routed models. */
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
  model('claude-haiku-5-5', {
    provider: 'anthropic',
    cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
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
const findModel = (provider: string, id: string) =>
  catalog.find((entry) => entry.provider === provider && entry.id === id);

const JEV = 'typesafe/jev-1.14.0';
type ConfigFile = RawRouterConfig & { advisor?: Record<string, unknown> };
const reference: ConfigFile = JSON.parse(
  readFileSync(
    new URL('../model-router.example.json', import.meta.url),
    'utf8',
  ),
);
/** The reference configuration, plus the user's claude-* and openai-* profile shapes. */
const PROFILES = {
  'reference/personal': { config: reference, profile: 'personal' },
  'reference/work': { config: reference, profile: 'work' },
  'user/claude': {
    profile: 'claude',
    config: {
      profiles: {
        claude: {
          advisor: { models: [JEV] },
          high: { model: 'anthropic/claude-opus-5-5', thinking: 'high' },
          medium: { model: 'anthropic/claude-sonnet-5-5', thinking: 'medium' },
          low: { model: 'anthropic/claude-sonnet-5-5', thinking: 'low' },
          micro: { model: 'anthropic/claude-haiku-4-5', thinking: 'off' },
          activities: {
            code: {
              medium: {
                model: 'anthropic/claude-opus-5-5',
                thinking: 'medium',
              },
            },
          },
        },
      },
    },
  },
  'user/openai': {
    profile: 'openai',
    config: {
      profiles: {
        openai: {
          advisor: { models: [JEV] },
          high: { model: 'openai-codex/gpt-6.1-sol', thinking: 'xhigh' },
          medium: { model: 'openai-codex/gpt-6.1-sol', thinking: 'medium' },
          low: { model: 'openai-codex/gpt-6-luna', thinking: 'medium' },
          micro: { model: 'openai-codex/gpt-6-luna', thinking: 'off' },
          activities: {
            code: {
              medium: { model: 'openai-codex/gpt-6-luna', thinking: 'high' },
            },
          },
        },
      },
    },
  },
} satisfies Record<string, { config: ConfigFile; profile: string }>;
type ProfileKey = keyof typeof PROFILES;

const OUTCOMES = ['none', ...ROUTER_TIERS, 'uncertain', 'invalid'] as const;
type Outcome = (typeof OUTCOMES)[number];
const ACTIVITIES = [...ROUTER_ACTIVITIES, 'uncertain'] as const;
const MODIFIERS = [
  'plain',
  'pin-medium',
  'effort-low',
  'budget',
  'escalation',
] as const;
type Modifier = (typeof MODIFIERS)[number];

type Classify = ExtensionContext['modelRegistry']['classify'];
const registry = (outcome: Outcome, activity: string) =>
  ({
    find: findModel,
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

const configFor = (key: ProfileKey, outcome: Outcome, modifier: Modifier) => {
  const { config, profile }: { config: ConfigFile; profile: string } =
    PROFILES[key];
  const normalized = normalizeConfig({
    ...config,
    advisor: { ...config.advisor, enabled: outcome !== 'none', model: JEV },
    ...(modifier === 'budget' ? { maxSessionBudget: 1 } : {}),
  }).config;
  return {
    config: normalized,
    profileName: profile,
    profile: required(normalized.profiles[profile]),
  };
};
const thinkingOverridesFor = (
  modifier: Modifier,
): RouterThinkingByTier | undefined =>
  modifier === 'effort-low'
    ? Object.fromEntries(ROUTER_TIERS.map((tier) => [tier, 'low']))
    : undefined;

const decide = async (
  key: ProfileKey,
  outcome: Outcome,
  activity: string,
  mode: RouterMode,
  modifier: Modifier,
): Promise<RoutingDecision> => {
  const { config, profileName, profile } = configFor(key, outcome, modifier);
  const resolved = { mode, source: 'profile' as const };
  const thinkingOverrides = thinkingOverridesFor(modifier);
  const base = {
    profileName,
    profile,
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

interface Row {
  key: ProfileKey;
  modifier: Modifier;
  outcome: Outcome;
  activity: string;
  decisions: Record<RouterMode, RoutingDecision>;
}

const pair = (d: RoutingDecision) =>
  `${d.tier} ${d.targetModelId}/${d.thinking}`;
const lever = (d: RoutingDecision) =>
  d.modeLever === 'model'
    ? ` (model from ${d.modeSourceTier})`
    : d.modeLever === 'effort'
      ? ' (effort)'
      : '';
const reason = (d: RoutingDecision) =>
  `${d.reasonCode}${d.escalatedFrom ? ` from ${d.escalatedFrom}` : ''}`;
const EFFORT_ORDER = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
/** Input price first, then effort. */
const rank = (d: RoutingDecision): [number, number] => [
  required(findModel(d.targetProvider, d.targetModelId)).cost.input,
  EFFORT_ORDER.indexOf(d.thinking),
];
const atMost = (a: RoutingDecision, b: RoutingDecision) => {
  const [pa, ea] = rank(a);
  const [pb, eb] = rank(b);
  return pa < pb || (pa === pb && ea <= eb);
};

const rows: Row[] = [];
beforeAll(async () => {
  for (const key of Object.keys(PROFILES) as ProfileKey[])
    for (const modifier of MODIFIERS)
      for (const outcome of OUTCOMES)
        for (const activity of outcome === 'none' ? ['-'] : ACTIVITIES) {
          const decisions = {} as Record<RouterMode, RoutingDecision>;
          for (const mode of ROUTER_MODES)
            decisions[mode] = await decide(
              key,
              outcome,
              activity,
              mode,
              modifier,
            );
          rows.push({ key, modifier, outcome, activity, decisions });
        }
});

const markdown = (): string => {
  const lines = [
    '# Routing decision matrix',
    '',
    'Generated by `extensions/decision-matrix.test.ts`. Do not edit by hand:',
    'run `npx vitest run extensions/decision-matrix.test.ts -u` after a',
    'reviewed routing change.',
    '',
    'Each cell is `tier model/effort`, plus the mode lever that changed the',
    'configured pair. Prices and effort maps are the Pi 1.3.0 catalog.',
    'Classifier `none` is the no-classifier baseline path. Activities with',
    'the same result share one row.',
    '',
    'Modifiers: `pin-medium` pins medium; `effort-low` sets every tier effort',
    'to low; `budget` is above the soft budget; `escalation` follows a',
    'repeated tool failure with an edit between.',
  ];
  for (const key of Object.keys(PROFILES) as ProfileKey[]) {
    lines.push(
      '',
      `## ${key}`,
      '',
      '| Modifier | Classifier | Activity | cost | balanced | quality | Reason |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    const groups = new Map<string, { row: Row; activities: string[] }>();
    for (const row of rows.filter((entry) => entry.key === key)) {
      const cells = ROUTER_MODES.map((mode) => {
        const d = row.decisions[mode];
        return `${pair(d)}${lever(d)}`;
      });
      const reasons = [
        ...new Set(ROUTER_MODES.map((mode) => reason(row.decisions[mode]))),
      ].join(', ');
      const id = [row.modifier, row.outcome, ...cells, reasons].join('|');
      const group = groups.get(id);
      if (group) group.activities.push(row.activity);
      else groups.set(id, { row, activities: [row.activity] });
    }
    for (const { row, activities } of groups.values()) {
      const cells = ROUTER_MODES.map((mode) => {
        const d = row.decisions[mode];
        return `${pair(d)}${lever(d)}`;
      });
      const reasons = [
        ...new Set(ROUTER_MODES.map((mode) => reason(row.decisions[mode]))),
      ].join(', ');
      lines.push(
        `| ${row.modifier} | ${row.outcome} | ${activities.join(', ')} | ${cells.join(' | ')} | ${reasons} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
};

describe('golden routing decision matrix', () => {
  it('loads the reference configuration without warnings', () => {
    expect(normalizeConfig(reference).warnings).toEqual([]);
  });

  it('matches the reviewed decision table', async () => {
    await expect(markdown()).toMatchFileSnapshot('../docs/decision-matrix.md');
  });

  it('keeps micro identical in every mode', () => {
    const micro = rows.filter((row) => row.decisions.balanced.tier === 'micro');
    expect(micro.length).toBeGreaterThan(0);
    for (const { decisions } of micro)
      for (const mode of ROUTER_MODES)
        expect(pair(decisions[mode])).toBe(pair(decisions.balanced));
  });

  it('keeps balanced equal to routing without a mode', () => {
    for (const row of rows)
      expect(row.decisions.balanced.modeLever ?? 'none').toBe('none');
    for (const key of Object.keys(PROFILES) as ProfileKey[])
      for (const modifier of MODIFIERS) {
        const { config, profile } = configFor(key, 'medium', modifier);
        const pinned = modifier === 'pin-medium' ? 'medium' : undefined;
        const build = (mode?: RouterMode) =>
          buildRouteMatrix(
            profile,
            findModel,
            false,
            1_000,
            thinkingOverridesFor(modifier),
            config.activityRouting !== 'off',
            pinned,
            mode ? { mode, budgetExceeded: modifier === 'budget' } : undefined,
          ).plans.map(({ tier, cell, attempts }) => ({ tier, cell, attempts }));
        expect(build('balanced')).toEqual(build());
      }
  });

  it('never makes cost dearer or quality cheaper than balanced', () => {
    for (const { decisions } of rows) {
      expect(atMost(decisions.cost, decisions.balanced)).toBe(true);
      expect(atMost(decisions.balanced, decisions.quality)).toBe(true);
    }
  });

  it('never routes cost below low or turns thinking off above micro', () => {
    for (const { decisions } of rows.filter(
      (row) => row.decisions.balanced.tier !== 'micro',
    )) {
      expect(decisions.cost.tier).not.toBe('micro');
      expect(decisions.cost.modeSourceTier).not.toBe('micro');
      expect(['off', 'minimal']).not.toContain(decisions.cost.thinking);
    }
  });

  it('lets a pin bypass the mode', () => {
    for (const { decisions } of rows.filter(
      (row) => row.modifier === 'pin-medium',
    ))
      for (const mode of ROUTER_MODES) {
        expect(pair(decisions[mode])).toBe(pair(decisions.balanced));
        expect(decisions[mode].modeLever).toBeUndefined();
      }
  });

  it('changes the expected number of cells per mode', () => {
    const differing = Object.fromEntries(
      (Object.keys(PROFILES) as ProfileKey[]).map((key) => {
        const own = rows.filter((row) => row.key === key);
        const count = (mode: RouterMode) =>
          own.filter(
            (row) => pair(row.decisions[mode]) !== pair(row.decisions.balanced),
          ).length;
        return [
          key,
          { cells: own.length, cost: count('cost'), quality: count('quality') },
        ];
      }),
    );
    expect(differing).toEqual({
      'reference/personal': { cells: 245, cost: 130, quality: 139 },
      'reference/work': { cells: 245, cost: 147, quality: 147 },
      'user/claude': { cells: 245, cost: 131, quality: 139 },
      'user/openai': { cells: 245, cost: 139, quality: 139 },
    });
  });
});
