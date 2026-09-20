import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';

export const required = <T>(value: T | undefined, label = 'value'): T => {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
};

export const model = (
  id = 'primary',
  overrides: Partial<Model<Api>> = {},
): Model<Api> => ({
  id,
  name: id,
  provider: 'test',
  api: 'openai-completions',
  baseUrl: 'https://example.invalid',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
  ...overrides,
});

export const message = (
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: 'assistant',
  api: 'openai-completions',
  provider: 'test',
  model: 'primary',
  content: [{ type: 'text', text: 'answer' }],
  stopReason: 'stop',
  timestamp: 1,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  },
  ...overrides,
});

export const events = (...items: AssistantMessageEvent[]) => {
  const stream = createAssistantMessageEventStream();
  for (const item of items) stream.push(item);
  stream.end();
  return stream;
};

export const done = (text = 'answer') =>
  events({
    type: 'done',
    reason: 'stop',
    message: message({ content: [{ type: 'text', text }] }),
  });

export const failure = (reason: 'error' | 'aborted' = 'error') =>
  events({
    type: 'error',
    reason,
    error: message({ stopReason: reason, errorMessage: 'request failed' }),
  });
