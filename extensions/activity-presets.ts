import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { parseCanonicalModelRef } from './domain';
import type {
  RouterActivity,
  RouterMode,
  RouterProfile,
  RouterTier,
} from './types';
import { ROUTER_ACTIVITIES, ROUTER_TIERS } from './types';

type PresetRow = readonly [
  readonly [string, ThinkingLevel],
  readonly [string, ThinkingLevel],
  readonly [string, ThinkingLevel],
  readonly [string, ThinkingLevel],
];
export type ActivityPresetFamily = 'openai' | 'anthropic';
const LUNA = 'gpt-6-luna';
const SOL = 'gpt-6.1-sol';
const TERRA = 'gpt-6.1-terra';
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';

// Derived starting policies, not measured equivalence. Sources and limits:
// docs/activity-routing.md. Keep transport and effort support owned by Pi.
export const ACTIVITY_PRESETS = {
  openai: {
    code: [
      [LUNA, 'low'],
      [LUNA, 'high'],
      [TERRA, 'xhigh'],
      [SOL, 'high'],
    ],
    debug: [
      [LUNA, 'medium'],
      [LUNA, 'high'],
      [TERRA, 'xhigh'],
      [SOL, 'xhigh'],
    ],
    explore: [
      [LUNA, 'low'],
      [LUNA, 'high'],
      [TERRA, 'medium'],
      [SOL, 'high'],
    ],
    plan: [
      [LUNA, 'medium'],
      [LUNA, 'high'],
      [TERRA, 'medium'],
      [SOL, 'xhigh'],
    ],
    review: [
      [LUNA, 'medium'],
      [LUNA, 'high'],
      [TERRA, 'medium'],
      [SOL, 'xhigh'],
    ],
    ops: [
      [LUNA, 'low'],
      [LUNA, 'high'],
      [TERRA, 'medium'],
      [SOL, 'high'],
    ],
    docs: [
      [LUNA, 'low'],
      [LUNA, 'high'],
      [TERRA, 'medium'],
      [SOL, 'high'],
    ],
  },
  anthropic: {
    code: [
      [HAIKU, 'medium'],
      [SONNET, 'high'],
      [SONNET, 'high'],
      [OPUS, 'high'],
    ],
    debug: [
      [HAIKU, 'high'],
      [SONNET, 'high'],
      [OPUS, 'medium'],
      [OPUS, 'xhigh'],
    ],
    explore: [
      [HAIKU, 'medium'],
      [HAIKU, 'high'],
      [SONNET, 'medium'],
      [OPUS, 'medium'],
    ],
    plan: [
      [HAIKU, 'high'],
      [SONNET, 'high'],
      [OPUS, 'medium'],
      [OPUS, 'xhigh'],
    ],
    review: [
      [HAIKU, 'high'],
      [SONNET, 'high'],
      [OPUS, 'medium'],
      [OPUS, 'xhigh'],
    ],
    ops: [
      [HAIKU, 'medium'],
      [HAIKU, 'high'],
      [HAIKU, 'high'],
      [OPUS, 'high'],
    ],
    docs: [
      [HAIKU, 'medium'],
      [HAIKU, 'high'],
      [SONNET, 'medium'],
      [OPUS, 'medium'],
    ],
  },
} as const satisfies Record<
  ActivityPresetFamily,
  Record<RouterActivity, PresetRow>
>;

/** The new example ladder; matching does not rewrite generic declarations. */
const OPENAI_DEFAULT_LADDER = {
  micro: [LUNA, 'off'],
  low: [LUNA, 'high'],
  medium: [TERRA, 'medium'],
  high: [SOL, 'high'],
} as const;

/** Model-first defaults only. Custom cells retain the generic mode transform. */
export const openaiModePreference = (
  tier: RouterTier,
  mode: RouterMode,
  activity?: RouterActivity,
): readonly [string, ThinkingLevel] | undefined => {
  if (tier === 'micro' || mode === 'balanced') return undefined;
  if (mode === 'cost') {
    if (tier === 'low') return [LUNA, 'medium'];
    if (tier === 'medium') return [LUNA, 'high'];
    return [
      TERRA,
      activity === 'code' || activity === 'debug' ? 'xhigh' : 'medium',
    ];
  }
  if (tier === 'low') return [TERRA, 'medium'];
  if (tier === 'high') return [SOL, 'xhigh'];
  return [
    SOL,
    activity && ['code', 'debug', 'plan', 'review'].includes(activity)
      ? 'high'
      : 'medium',
  ];
};

export const isOpenAIDefaultLadder = (profile: RouterProfile): boolean =>
  ROUTER_TIERS.every((tier) => {
    const route = profile[tier];
    const [id, thinking] = OPENAI_DEFAULT_LADDER[tier];
    return (
      !route ||
      (parseCanonicalModelRef(route.model).modelId === id &&
        route.thinking === thinking)
    );
  });

const RECOGNIZED_IDS: Record<ActivityPresetFamily, readonly string[]> = {
  openai: [LUNA, TERRA, SOL, 'gpt-6-sol'],
  // Recognize existing 4.5 fast tiers for migration; never assign 4.5 as a 5.5 equivalent.
  anthropic: [HAIKU, SONNET, OPUS, 'claude-haiku-4-5'],
};

export const activityPresetFor = (
  profile: RouterProfile,
): { family: ActivityPresetFamily; provider: string } | undefined => {
  const refs = ROUTER_TIERS.flatMap((tier) => {
    const route = profile[tier];
    return route ? [parseCanonicalModelRef(route.model)] : [];
  });
  const first = refs[0];
  if (
    !first ||
    first.provider === 'router' ||
    refs.some((ref) => ref.provider !== first.provider)
  )
    return undefined;
  const family = (['openai', 'anthropic'] as const).find((name) =>
    refs.every((ref) => RECOGNIZED_IDS[name].includes(ref.modelId)),
  );
  return family ? { family, provider: first.provider } : undefined;
};

export const presetActivityDeclarations = (
  profile: RouterProfile,
  family: ActivityPresetFamily,
  provider: string,
): Record<
  RouterActivity,
  Partial<Record<RouterTier, { model: string; thinking: ThinkingLevel }>>
> =>
  Object.fromEntries(
    ROUTER_ACTIVITIES.map((activity) => [
      activity,
      Object.fromEntries(
        (['micro', 'low', 'medium', 'high'] as const).flatMap((tier, index) => {
          const entry = ACTIVITY_PRESETS[family][activity][index];
          return profile[tier] && entry
            ? [[tier, { model: `${provider}/${entry[0]}`, thinking: entry[1] }]]
            : [];
        }),
      ),
    ]),
  ) as Record<
    RouterActivity,
    Partial<Record<RouterTier, { model: string; thinking: ThinkingLevel }>>
  >;
