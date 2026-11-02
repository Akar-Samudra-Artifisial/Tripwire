import { chat as forgeChat, ForgeLlmError, type Message, type Usage } from '@forge/llm';

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

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. Forge LLM does not enforce it, so callers must validate `args`. */
  parameters: Record<string, unknown>;
}

/** The model answered, but not with a usable tool call. */
export class LlmOutputError extends Error {}

export interface ToolResult<T> {
  args: T;
  usage?: Usage;
}

/**
 * Forces the model to call `tool` and returns its (unvalidated) arguments. Same caller rules as `chat`.
 * Throws `LlmOutputError` when there is no tool call or the arguments are not JSON.
 */
export async function chatTool<T = unknown>(messages: Message[], tool: ToolSpec, options: ChatOptions = {}): Promise<ToolResult<T>> {
  const model = options.model ?? FAST_MODEL;
  const response = await forgeChat({
    model,
    messages,
    temperature: options.temperature ?? 0,
    max_completion_tokens: options.maxTokens ?? 4096,
    tools: [{ type: 'function', function: tool }],
    tool_choice: { type: 'function', function: { name: tool.name } },
  });
  console.info('llm usage', { model, tool: tool.name, usage: response.usage });
  const call = response.choices[0]?.message.tool_calls?.[0];
  if (!call) throw new LlmOutputError(`LLM did not call ${tool.name} (no tool call)`);
  // Typed as object, but the REST API returns a JSON string.
  const raw: unknown = call.function.arguments;
  let args: unknown = raw;
  if (typeof raw === 'string') {
    try {
      args = JSON.parse(raw);
    } catch {
      throw new LlmOutputError(`LLM returned malformed JSON arguments for ${tool.name}`);
    }
  }
  if (args === null || typeof args !== 'object') throw new LlmOutputError(`LLM returned non-object arguments for ${tool.name}`);
  return { args: args as T, usage: response.usage };
}

/** True for a Forge LLM 429. `ForgeLlmAPIError` (which carries `status`) is not exported, so read the field directly. */
export function isLlmRateLimited(err: unknown): boolean {
  return err instanceof ForgeLlmError && (err as { status?: number }).status === 429;
}
