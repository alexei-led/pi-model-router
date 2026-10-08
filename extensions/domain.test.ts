import { describe, expect, it } from 'vitest';
import {
  isObjectRecord,
  isRouterPinValue,
  isRouterTier,
  isThinkingLevel,
  parseCanonicalModelRef,
} from './domain';

describe('router domain guards', () => {
  it('recognizes object records without accepting arrays or primitives', () => {
    expect(isObjectRecord({})).toBe(true);
    expect(isObjectRecord({ a: 1 })).toBe(true);
    expect(isObjectRecord(null)).toBe(false);
    expect(isObjectRecord('string')).toBe(false);
    expect(isObjectRecord([])).toBe(false);
  });

  it('recognizes supported thinking levels', () => {
    expect(isThinkingLevel('off')).toBe(true);
    expect(isThinkingLevel('high')).toBe(true);
    expect(isThinkingLevel('xhigh')).toBe(true);
    expect(isThinkingLevel('max')).toBe(true);
    expect(isThinkingLevel('invalid')).toBe(false);
    expect(isThinkingLevel(123)).toBe(false);
  });

  it('recognizes router tiers and pin values', () => {
    expect(isRouterTier('high')).toBe(true);
    expect(isRouterTier('medium')).toBe(true);
    expect(isRouterTier('low')).toBe(true);
    expect(isRouterTier('micro')).toBe(true);
    expect(isRouterTier('auto')).toBe(false);
    expect(isRouterTier('invalid')).toBe(false);
    expect(isRouterPinValue('auto')).toBe(true);
    expect(isRouterPinValue('micro')).toBe(true);
    expect(isRouterPinValue('invalid')).toBe(false);
  });
});

describe('canonical model references', () => {
  it('parses provider and model IDs with surrounding whitespace', () => {
    expect(parseCanonicalModelRef('openai / gpt-4o')).toEqual({
      provider: 'openai',
      modelId: 'gpt-4o',
    });
  });

  it.each(['gpt-4o', '/gpt-4o', 'openai/', '   /gpt-4o'])(
    'rejects invalid reference %s',
    (value) => {
      expect(() => parseCanonicalModelRef(value)).toThrow(
        'Invalid model reference',
      );
    },
  );
});
