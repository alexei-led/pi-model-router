import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { parseCanonicalModelRef } from './domain';
import type { RouterActivity, RouterProfile, RouterTier } from './types';
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
      [SOL, 'medium'],
      [SOL, 'high'],
    ],
    debug: [
      [LUNA, 'medium'],
      [LUNA, 'high'],
      [SOL, 'high'],
      [SOL, 'xhigh'],
    ],
    explore: [
      [LUNA, 'low'],
      [LUNA, 'medium'],
      [LUNA, 'high'],
      [SOL, 'high'],
    ],
    plan: [
      [LUNA, 'medium'],
      [LUNA, 'high'],
      [SOL, 'high'],
      [SOL, 'xhigh'],
    ],
    review: [
      [LUNA, 'medium'],
      [LUNA, 'high'],
      [SOL, 'high'],
      [SOL, 'xhigh'],
    ],
    ops: [
      [LUNA, 'low'],
      [LUNA, 'medium'],
      [LUNA, 'high'],
      [SOL, 'high'],
    ],
    docs: [
      [LUNA, 'low'],
      [LUNA, 'medium'],
      [SOL, 'medium'],
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

const RECOGNIZED_IDS: Record<ActivityPresetFamily, readonly string[]> = {
  openai: [LUNA, SOL, 'gpt-6-sol'],
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
