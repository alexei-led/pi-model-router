import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  ThinkingLevel as AiThinkingLevel,
  Context,
} from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isRouterTier, parseCanonicalModelRef } from './config';
import { extractTextFromContent, getRecentConversationText } from './context';
import type { ClassifierTier, RouterPhase } from './types';

const CLASSIFIER_TIMEOUT_MS = 10_000;
const CLASSIFIER_MAX_TOKENS = 256;

export const runClassifier = async (
  classifierModelRef: string,
  modelRegistry: ExtensionContext['modelRegistry'],
  context: Context,
  currentPhase?: RouterPhase,
  thinking?: ThinkingLevel,
  signal?: AbortSignal,
  routingDeadline = performance.now() + CLASSIFIER_TIMEOUT_MS,
): Promise<{ tier: ClassifierTier } | undefined> => {
  try {
    const remaining = routingDeadline - performance.now();
    if (signal?.aborted || !Number.isFinite(remaining) || remaining <= 0)
      return undefined;
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
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.ceil(Math.min(CLASSIFIER_TIMEOUT_MS, remaining))),
    );
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

    const readStream = async (): Promise<string | undefined> => {
      for await (const event of stream) {
        if (classifierSignal.aborted) return undefined;
        if (event.type === 'error') return undefined;
        if (event.type === 'done') {
          return extractTextFromContent(event.message.content);
        }
      }
      return undefined;
    };

    let abortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<undefined>((resolve) => {
        if (classifierSignal.aborted) {
          resolve(undefined);
          return;
        }
        abortListener = () => resolve(undefined);
        classifierSignal.addEventListener('abort', abortListener, {
          once: true,
        });
      });
      const fullText = await Promise.race([readStream(), aborted]);
      if (classifierSignal.aborted || fullText === undefined) return undefined;

      const lines = fullText.split(/\r?\n/);
      const tierLine = lines.find((line) =>
        line.toLowerCase().startsWith('tier:'),
      );
      const reasoningLine = lines.find((line) =>
        line.toLowerCase().startsWith('reasoning:'),
      );
      if (!tierLine || !reasoningLine) return undefined;

      const tierValue = tierLine
        .slice(tierLine.indexOf(':') + 1)
        .trim()
        .toLowerCase();
      if (!isRouterTier(tierValue) || tierValue === 'micro') return undefined;
      return { tier: tierValue };
    } finally {
      if (abortListener) {
        classifierSignal.removeEventListener('abort', abortListener);
      }
    }
  } catch {
    // Classifier advice is optional; model, stream, parsing, timeout, and abort
    // failures must fall through to local routing without failing generation.
    return undefined;
  }
};
