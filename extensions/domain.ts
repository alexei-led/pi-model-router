import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { RouterTier } from './types';
import { ROUTER_TIERS } from './types';

export const MAX_THINKING_LEVEL: ThinkingLevel = 'max';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  MAX_THINKING_LEVEL,
];

export const ROUTER_PIN_VALUES = ['auto', ...ROUTER_TIERS] as const;
export type RouterPinValue = (typeof ROUTER_PIN_VALUES)[number];

export const isRouterPinValue = (value: unknown): value is RouterPinValue =>
  ROUTER_PIN_VALUES.some((candidate) => candidate === value);

export const isObjectRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && THINKING_LEVELS.some((level) => level === value);

export const isRouterTier = (value: unknown): value is RouterTier =>
  ROUTER_TIERS.some((tier) => tier === value);

export const parseCanonicalModelRef = (
  value: string,
): { provider: string; modelId: string } => {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    throw new Error('Invalid model reference. Expected "provider/model".');
  }
  const provider = value.slice(0, slashIndex).trim();
  const modelId = value.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    throw new Error('Invalid model reference. Expected "provider/model".');
  }
  return { provider, modelId };
};
