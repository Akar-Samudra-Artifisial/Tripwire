import { chat as forgeChat, type Message } from '@forge/llm';

/** Cheap model for extraction, topic tagging and classification. */
export const FAST_MODEL = 'claude-haiku-4-5-20251001';
/** Stronger model for assumption → tripwire translation and contradiction scoring, when Haiku falls short. */
export const STRONG_MODEL = 'claude-sonnet-4-6';

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Thin wrapper around Forge LLM. Only call from queue consumers (900 s timeout), never from UI resolvers.
 * Returns the text of the first choice.
 */
export async function chat(messages: Message[], options: ChatOptions = {}): Promise<string> {
  const response = await forgeChat({
    model: options.model ?? FAST_MODEL,
    messages,
    temperature: options.temperature ?? 0,
    max_completion_tokens: options.maxTokens ?? 2048,
  });
  const content = response.choices[0]?.message.content;
  if (content === undefined) throw new Error('Forge LLM returned no choices');
  if (typeof content === 'string') return content;
  return content.map((part) => part.text).join('');
}
