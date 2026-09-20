import type { Context, Message } from '@earendil-works/pi-ai';

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

export const getLastUserText = (context: Context): string => {
  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const message = context.messages[i];
    if (message?.role === 'user') {
      return extractTextFromContent(message.content).trim();
    }
  }
  return '';
};

export const getRecentConversationText = (
  context: Context,
  limit = 6,
): string =>
  context.messages
    .slice(-limit)
    .map((message) =>
      message ? extractTextFromContent(message.content).trim() : '',
    )
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

export const countToolResults = (context: Context): number =>
  context.messages.filter((message) => message?.role === 'toolResult').length;

export const countWords = (text: string): number =>
  text.split(/\s+/).filter(Boolean).length;

export const hasImageAttachment = (context: Context): boolean =>
  context.messages.some(
    (message) =>
      message &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  );

export const containsAny = (text: string, keywords: string[]): boolean =>
  keywords.some((keyword) => text.includes(keyword));
