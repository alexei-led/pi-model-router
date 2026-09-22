import type { Context, Message } from '@earendil-works/pi-ai';
import { DEFAULT_JEV_CONTEXT } from './constants';
import type {
  JevContextConfig,
  JevContextMetrics,
  JevContextState,
  JevTextExcerpt,
} from './types';

export const extractTextFromContent = (
  content: string | Message['content'],
): string => {
  if (typeof content === 'string') return content;
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'thinking') return part.thinking;
      if (part.type === 'toolCall') {
        return `${part.name} ${JSON.stringify(part.arguments)}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

/** Text blocks only: never include system/config, thinking, tool arguments or binary data. */
export const getBoundedRecentContext = (
  context: Context,
  maxChars: number,
): string => {
  if (!Number.isFinite(maxChars) || maxChars < 1) return '';
  const budget = Math.floor(maxChars);
  const latestUser = context.messages.findLastIndex(
    (message) => message.role === 'user',
  );
  const selected = new Map<number, string>();
  const render = (message: Message, limit: number): string => {
    const label = `${message.role === 'toolResult' ? 'tool' : message.role}:\n`;
    // For tiny budgets prioritize request text over a partial role label.
    const prefix = limit > label.length ? label : '';
    let text = '';
    const remaining = limit - prefix.length;
    if (typeof message.content === 'string') {
      text = message.content.slice(0, remaining);
    } else {
      for (const part of message.content) {
        if (part.type !== 'text' || !part.text) continue;
        text +=
          `${text ? '\n' : ''}${part.text.slice(0, remaining - text.length)}`.slice(
            0,
            remaining - text.length,
          );
        if (text.length >= remaining) break;
      }
    }
    return text ? prefix + text : '';
  };
  const request = context.messages[latestUser];
  const latest = request ? render(request, budget) : '';
  if (latest) selected.set(latestUser, latest);
  let remaining = budget - latest.length;
  const recent = context.messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message, index }) =>
        index !== latestUser &&
        (message.role === 'user' ||
          message.role === 'assistant' ||
          message.role === 'toolResult'),
    )
    .slice(-5)
    .reverse();
  for (const [position, { message, index }] of recent.entries()) {
    const separator = selected.size ? 2 : 0;
    // Share the remainder so one oversized tool result cannot erase all history.
    const allowance = Math.floor(
      (remaining - separator) / (recent.length - position),
    );
    if (allowance <= 0) break;
    const text = render(message, allowance);
    if (!text) continue;
    selected.set(index, text);
    remaining -= text.length + separator;
  }
  return [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join('\n\n');
};

const textOnly = (message: Message): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');

const utf8 = new TextEncoder();

/** Conservative Jev preflight estimate; TypeSafe does not publish its tokenizer. */
export const estimateJevTextTokens = (text: string): number => {
  let ascii = 0;
  let nonAsciiBytes = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii += 1;
    else nonAsciiBytes += utf8.encode(character).length;
  }
  return Math.ceil((ascii / 4 + nonAsciiBytes / 2) * 1.1);
};

/** Includes measured fixed headroom for the current four-choice request envelope. */
export const estimateJevRequestTokens = (serializedRequest: string): number =>
  200 + estimateJevTextTokens(serializedRequest);

const safePrefix = (text: string, units: number): string =>
  text.slice(0, units).replace(/[\uD800-\uDBFF]$/u, '');
const safeSuffix = (text: string, units: number): string =>
  units <= 0 ? '' : text.slice(-units).replace(/^[\uDC00-\uDFFF]/u, '');

const largestFitting = (
  text: string,
  tokenLimit: number,
  render: (units: number) => string,
): string => {
  let low = 0;
  let high = text.length;
  let selected = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(middle);
    if (estimateJevTextTokens(candidate) <= tokenLimit) {
      selected = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return selected;
};

const excerpt = (text: string, tokenLimit: number): JevTextExcerpt => {
  if (estimateJevTextTokens(text) <= tokenLimit)
    return { text, truncated: false };
  if (tokenLimit < estimateJevTextTokens('…'))
    return {
      text: largestFitting(text, tokenLimit, (units) =>
        safePrefix(text, units),
      ),
      truncated: true,
    };
  return {
    text: largestFitting(text, tokenLimit, (units) => {
      const content = Math.max(0, units - 1);
      const head = Math.ceil(content / 2);
      return `${safePrefix(text, head)}…${safeSuffix(text, content - head)}`;
    }),
    truncated: true,
  };
};

/** Fixed structural selection, not intent scoring. Only selected text reaches Jev. */
export const buildJevContext = (
  context: Context,
  maxTokens: number,
  options: JevContextConfig = DEFAULT_JEV_CONTEXT,
): { state: JevContextState; metrics: JevContextMetrics } => {
  const budget = Number.isFinite(maxTokens)
    ? Math.max(0, Math.floor(maxTokens))
    : 0;
  const latest = context.messages.findLastIndex(
    (message) => message.role === 'user',
  );
  const current = context.messages[latest];
  const state: JevContextState = {
    currentRequest: excerpt(current ? textOnly(current) : '', budget),
    recentDialogue: [],
    recentToolEvidence: [],
  };
  let remaining = budget - estimateJevTextTokens(state.currentRequest.text);
  const turns: { start: number; end: number }[] = [];
  let end = latest;
  for (
    let index = latest - 1;
    index >= 0 && turns.length < Math.max(1, options.previousTurns);
    index--
  ) {
    if (context.messages[index]?.role !== 'user') continue;
    turns.push({ start: index, end });
    end = index;
  }
  const dialogue: { role: 'user' | 'assistant'; text: string; turn: number }[] =
    [];
  for (const [turn, bounds] of turns
    .slice(0, options.previousTurns)
    .entries()) {
    const messages = context.messages.slice(bounds.start, bounds.end);
    const user = messages[0];
    const answer = messages.findLast(
      (message) =>
        message.role === 'assistant' && textOnly(message).trim().length > 0,
    );
    // Newest turn first for allocation; render the final payload chronologically.
    if (answer)
      dialogue.push({ role: 'assistant', text: textOnly(answer), turn });
    if (user && textOnly(user).trim())
      dialogue.push({ role: 'user', text: textOnly(user), turn });
  }
  let historyBudget = Math.min(remaining, options.maxHistoryTokens);
  const includedTurns = new Set<number>();
  for (const [index, entry] of dialogue.entries()) {
    const limit = Math.floor(historyBudget / (dialogue.length - index));
    if (limit < 1) break;
    const selected = excerpt(entry.text, limit);
    state.recentDialogue.unshift({ role: entry.role, ...selected });
    includedTurns.add(entry.turn);
    const selectedTokens = estimateJevTextTokens(selected.text);
    historyBudget -= selectedTokens;
    remaining -= selectedTokens;
  }
  const previous = turns[0];
  if (
    options.toolResults !== 'none' &&
    previous &&
    remaining > 0 &&
    options.maxToolTokens > 0
  ) {
    const tool = context.messages
      .slice(previous.start, previous.end)
      .findLast((message) => message.role === 'toolResult');
    if (
      tool?.role === 'toolResult' &&
      (options.toolResults === 'last' || tool.isError === true)
    ) {
      const text = textOnly(tool);
      if (text.trim())
        state.recentToolEvidence.push({
          ...excerpt(text, Math.min(remaining, options.maxToolTokens)),
          isError: tool.isError === true,
        });
    }
  }
  const all = [
    state.currentRequest,
    ...state.recentDialogue,
    ...state.recentToolEvidence,
  ];
  return {
    state,
    metrics: {
      currentRequestTokens: estimateJevTextTokens(state.currentRequest.text),
      historyTokens: state.recentDialogue.reduce(
        (sum, entry) => sum + estimateJevTextTokens(entry.text),
        0,
      ),
      toolTokens: state.recentToolEvidence.reduce(
        (sum, entry) => sum + estimateJevTextTokens(entry.text),
        0,
      ),
      historyTurns: includedTurns.size,
      toolResults: state.recentToolEvidence.length,
      truncatedBlocks: all.filter((entry) => entry.truncated).length,
    },
  };
};

export const hasImageAttachment = (context: Context): boolean =>
  context.messages.some(
    (message) =>
      message &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  );
