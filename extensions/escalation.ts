import { createHash } from 'node:crypto';
import type { Message } from '@earendil-works/pi-ai';
import type { RouterTier } from './types';
import { ROUTER_TIERS } from './types';

/**
 * Pi's built-in file mutation tools. Simplification: shell writes do not
 * count as edits; add them when replay data shows missed bash-edit loops.
 */
const EDIT_TOOLS = new Set(['edit', 'write']);
const SIGNATURE_TEXT_CHARS = 2000;

type ToolResult = Extract<Message, { role: 'toolResult' }>;

/** Only a hash leaves this module; tool output is never stored. */
const signatureOf = (message: ToolResult): string => {
  const text = message.content
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n')
    // Timings, counters and line numbers change between otherwise equal failures.
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SIGNATURE_TEXT_CHARS);
  return createHash('sha256')
    .update(`${message.toolName}\0${text}`)
    .digest('hex')
    .slice(0, 16);
};

/**
 * Signature of the latest failure in the current user turn that repeats an
 * earlier failure with a successful edit in between, and that no later
 * success of the same tool has cleared.
 */
export const repeatedFailure = (
  messages: readonly Message[],
): string | undefined => {
  const start = messages.findLastIndex((message) => message.role === 'user');
  const results = messages
    .slice(start + 1)
    .filter((message): message is ToolResult => message.role === 'toolResult');
  for (let last = results.length - 1; last >= 0; last--) {
    const failure = results[last];
    if (!failure?.isError) continue;
    if (
      results
        .slice(last + 1)
        .some((later) => !later.isError && later.toolName === failure.toolName)
    )
      continue;
    const signature = signatureOf(failure);
    let edited = false;
    for (let earlier = last - 1; earlier >= 0; earlier--) {
      const entry = results[earlier];
      if (!entry) continue;
      if (EDIT_TOOLS.has(entry.toolName) && !entry.isError) edited = true;
      else if (edited && entry.isError && signatureOf(entry) === signature)
        return signature;
    }
  }
  return undefined;
};

export interface EscalationState {
  readonly signature?: string;
  readonly floor?: RouterTier;
  readonly untilUserTurn?: number;
}

const tierAbove = (tier: RouterTier): RouterTier | undefined => {
  const index = ROUTER_TIERS.indexOf(tier);
  return index > 0 ? ROUTER_TIERS[index - 1] : undefined;
};

/**
 * Codex-router parity: a repeated failure moves one tier above the incumbent
 * and holds that floor for `holdTurns` further user turns. A signature
 * escalates once; at the top tier it stays unconsumed.
 */
export const updateEscalation = (
  state: EscalationState,
  input: {
    messages: readonly Message[];
    incumbent: RouterTier | undefined;
    holdTurns: number;
  },
): { state: EscalationState; floor: RouterTier | undefined } => {
  const userTurn = input.messages.filter(
    (message) => message.role === 'user',
  ).length;
  const signature = repeatedFailure(input.messages);
  const floor =
    signature && signature !== state.signature && input.incumbent
      ? tierAbove(input.incumbent)
      : undefined;
  const next =
    signature && floor
      ? { signature, floor, untilUserTurn: userTurn + input.holdTurns }
      : state;
  return {
    state: next,
    floor:
      next.untilUserTurn !== undefined && userTurn <= next.untilUserTurn
        ? next.floor
        : undefined,
  };
};
