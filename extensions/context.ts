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

export const hasImageAttachment = (context: Context): boolean =>
  context.messages.some(
    (message) =>
      message &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image'),
  );
