import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  ThinkingLevel as AiThinkingLevel,
  Context,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isRouterTier, parseCanonicalModelRef } from './config';
import { extractTextFromContent, getRecentConversationText } from './context';
import type { RouterPhase, RouterTier } from './types';

const CLASSIFIER_TIMEOUT_MS = 10_000;
const CLASSIFIER_MAX_TOKENS = 256;

export const runClassifier = async (
  classifierModelRef: string,
  modelRegistry: ExtensionContext['modelRegistry'],
  context: Context,
  currentPhase?: RouterPhase,
  thinking?: ThinkingLevel,
  signal?: AbortSignal,
): Promise<{ tier: RouterTier; reasoning: string } | undefined> => {
  if (signal?.aborted) return undefined;
  const { provider, modelId } = parseCanonicalModelRef(classifierModelRef);
  if (provider === 'router') return undefined;
  const model = modelRegistry.find(provider, modelId);
  if (!model) return undefined;

  const latestMessage = context.messages.at(-1);
  const classifierContext: Context = {
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'Classify the coding task into exactly one tier: high, medium, or low.',
              'Return exactly two lines:',
              'Tier: <high|medium|low>',
              'Reasoning: <short reason>',
              `Current phase: ${currentPhase ?? 'unknown'}`,
              `Recent conversation:\n${getRecentConversationText(context)}`,
              `Latest request:\n${latestMessage ? extractTextFromContent(latestMessage.content) : ''}`,
            ].join('\n'),
          },
        ],
        timestamp: Date.now(),
      },
    ],
  };
  const timeout = AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS);
  const classifierSignal = signal
    ? AbortSignal.any([signal, timeout])
    : timeout;
  const reasoning: AiThinkingLevel | undefined =
    thinking && thinking !== 'off' ? thinking : undefined;
  const stream = modelRegistry.streamSimple(model, classifierContext, {
    signal: classifierSignal,
    maxTokens: CLASSIFIER_MAX_TOKENS,
    ...(reasoning ? { reasoning } : {}),
  });

  let fullText = '';
  let completed = false;
  for await (const event of stream) {
    if (event.type === 'error') return undefined;
    if (event.type === 'text_delta') fullText += event.delta;
    if (event.type === 'done') {
      completed = true;
      fullText = extractTextFromContent(event.message.content);
      break;
    }
  }
  if (!completed) return undefined;

  const tierLine = fullText
    .split('\n')
    .find((line) => line.toLowerCase().startsWith('tier:'));
  const reasoningLine = fullText
    .split('\n')
    .find((line) => line.toLowerCase().startsWith('reasoning:'));
  if (!tierLine || !reasoningLine) return undefined;

  const tierValue = tierLine
    .slice(tierLine.indexOf(':') + 1)
    .trim()
    .toLowerCase();
  if (!isRouterTier(tierValue)) return undefined;
  return {
    tier: tierValue,
    reasoning: reasoningLine.slice(reasoningLine.indexOf(':') + 1).trim(),
  };
};
