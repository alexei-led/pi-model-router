import type { Context, Message } from '@earendil-works/pi-ai';
import { DEFAULT_CLASSIFIER_CONTEXT } from './constants';
import type {
  ClassifierContextConfig,
  ClassifierContextMetrics,
  ClassifierContextState,
  ClassifierTextExcerpt,
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

const textOnly = (message: Message): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');

const utf8 = new TextEncoder();

/** Conservative text preflight estimate, not a provider tokenizer or exact context guarantee. */
export const estimateClassifierTextTokens = (text: string): number => {
  let ascii = 0;
  let nonAsciiBytes = 0;
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) <= 0x7f) ascii += 1;
    else nonAsciiBytes += utf8.encode(character).length;
  }
  return Math.ceil((ascii / 4 + nonAsciiBytes / 2) * 1.1);
};

/**
 * Includes fixed headroom for the structured four-choice request envelope. Live
 * `usage.input_tokens` exceeded the text estimate by 110-135 tokens on ten
 * structured requests, so the headroom is set well above that gap.
 */
export const estimateClassifierRequestTokens = (
  serializedRequest: string,
): number => 400 + estimateClassifierTextTokens(serializedRequest);

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
    if (estimateClassifierTextTokens(candidate) <= tokenLimit) {
      selected = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return selected;
};

const excerpt = (text: string, tokenLimit: number): ClassifierTextExcerpt => {
  if (estimateClassifierTextTokens(text) <= tokenLimit)
    return { text, truncated: false };
  if (tokenLimit < estimateClassifierTextTokens('…'))
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

/** Fixed structural selection, not intent scoring. Only selected text reaches the configured classifier. */
export const buildClassifierContext = (
  context: Context,
  maxTokens: number,
  options: ClassifierContextConfig = DEFAULT_CLASSIFIER_CONTEXT,
): { state: ClassifierContextState; metrics: ClassifierContextMetrics } => {
  const budget = Number.isFinite(maxTokens)
    ? Math.max(0, Math.floor(maxTokens))
    : 0;
  const latest = context.messages.findLastIndex(
    (message) => message.role === 'user',
  );
  const current = context.messages[latest];
  const loopMessages = context.messages.slice(latest + 1);
  const currentLoop =
    options.currentLoopMessages > 0
      ? loopMessages.slice(-options.currentLoopMessages)
      : [];
  const goalBudget = currentLoop.length ? Math.floor(budget / 2) : budget;
  const state: ClassifierContextState = {
    currentRequest: excerpt(current ? textOnly(current) : '', goalBudget),
    recentDialogue: [],
    recentToolEvidence: [],
  };
  let remaining =
    budget - estimateClassifierTextTokens(state.currentRequest.text);
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
  const loopDialogue = currentLoop.flatMap((message, index) => {
    if (message.role !== 'assistant') return [];
    const text = textOnly(message).trim();
    return text ? [{ role: 'assistant' as const, text, turn: -1 - index }] : [];
  });
  // Current task progress receives the history budget before older completed turns.
  for (const entry of loopDialogue.reverse()) dialogue.push(entry);
  for (const [turn, bounds] of turns
    .slice(0, options.previousTurns)
    .entries()) {
    const messages = context.messages.slice(bounds.start, bounds.end);
    const user = messages[0];
    const answer = messages.findLast(
      (message) =>
        message.role === 'assistant' && textOnly(message).trim().length > 0,
    );
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
    if (entry.turn >= 0) includedTurns.add(entry.turn);
    const selectedTokens = estimateClassifierTextTokens(selected.text);
    historyBudget -= selectedTokens;
    remaining -= selectedTokens;
  }
  const currentToolResults = currentLoop.filter(
    (message) => message.role === 'toolResult',
  );
  const loopToolSelection =
    options.toolResults === 'recent'
      ? currentToolResults
      : options.toolResults === 'last'
        ? currentToolResults.slice(-1)
        : options.toolResults === 'last-error'
          ? currentToolResults
              .slice(-1)
              .filter((message) => message.isError === true)
          : [];
  const loopTools = loopToolSelection.flatMap((message) => {
    const text = textOnly(message).trim();
    return text ? [{ text, isError: message.isError === true }] : [];
  });
  const priorTool = turns[0]
    ? context.messages
        .slice(turns[0].start, turns[0].end)
        .findLast((message) => message.role === 'toolResult')
    : undefined;
  const toolCandidates = loopTools.length
    ? loopTools
    : !loopMessages.some((message) => message.role === 'toolResult') &&
        priorTool?.role === 'toolResult' &&
        (options.toolResults === 'last' ||
          options.toolResults === 'recent' ||
          (options.toolResults === 'last-error' && priorTool.isError === true))
      ? [
          {
            text: textOnly(priorTool).trim(),
            isError: priorTool.isError === true,
          },
        ]
      : [];
  let toolBudget = Math.min(remaining, options.maxToolTokens);
  const newestTools = [...toolCandidates].reverse();
  for (const [index, entry] of newestTools.entries()) {
    const limit = Math.floor(toolBudget / (newestTools.length - index));
    if (limit < 1) break;
    const selected = excerpt(entry.text, limit);
    state.recentToolEvidence.unshift({ ...selected, isError: entry.isError });
    const selectedTokens = estimateClassifierTextTokens(selected.text);
    toolBudget -= selectedTokens;
    remaining -= selectedTokens;
  }
  const all = [
    state.currentRequest,
    ...state.recentDialogue,
    ...state.recentToolEvidence,
  ];
  return {
    state,
    metrics: {
      currentRequestTokens: estimateClassifierTextTokens(
        state.currentRequest.text,
      ),
      historyTokens: state.recentDialogue.reduce(
        (sum, entry) => sum + estimateClassifierTextTokens(entry.text),
        0,
      ),
      toolTokens: state.recentToolEvidence.reduce(
        (sum, entry) => sum + estimateClassifierTextTokens(entry.text),
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
