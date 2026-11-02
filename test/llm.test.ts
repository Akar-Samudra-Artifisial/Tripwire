import { beforeEach, describe, expect, it, vi } from 'vitest';

const llm = vi.hoisted(() => {
  class ForgeLlmError extends Error {}
  class ForgeLlmAPIError extends ForgeLlmError {
    constructor(public status: number) {
      super(`status ${status}`);
    }
  }
  return { chat: vi.fn(), ForgeLlmError, ForgeLlmAPIError };
});

vi.mock('@forge/llm', () => ({ chat: llm.chat, ForgeLlmError: llm.ForgeLlmError }));

const { chatTool, isLlmRateLimited, LlmOutputError } = await import('../src/llm');

const ECHO = { name: 'echo', description: 'echo', parameters: { type: 'object' } };
const usage = { input_tokens: 12, output_tokens: 3, total_tokens: 15 };

function reply(toolCalls: unknown[] | undefined) {
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: toolCalls } }], usage };
}

const call = (args: unknown) => ({ id: 'c1', type: 'function', index: 0, function: { name: 'echo', arguments: args } });

beforeEach(() => {
  llm.chat.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('chatTool', () => {
  it('forces the named tool and returns object arguments as-is', async () => {
    llm.chat.mockResolvedValue(reply([call({ ok: true })]));
    const result = await chatTool<{ ok: boolean }>([{ role: 'user', content: 'hi' }], ECHO);
    expect(result).toEqual({ args: { ok: true }, usage });
    expect(llm.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0,
        max_completion_tokens: 4096,
        tools: [{ type: 'function', function: ECHO }],
        tool_choice: { type: 'function', function: { name: 'echo' } },
      }),
    );
  });

  it('parses string JSON arguments', async () => {
    llm.chat.mockResolvedValue(reply([call('{"ok":true}')]));
    await expect(chatTool([{ role: 'user', content: 'hi' }], ECHO)).resolves.toMatchObject({ args: { ok: true } });
  });

  it('throws LlmOutputError when there is no tool call', async () => {
    llm.chat.mockResolvedValue(reply([]));
    await expect(chatTool([{ role: 'user', content: 'hi' }], ECHO)).rejects.toBeInstanceOf(LlmOutputError);
    llm.chat.mockResolvedValue(reply(undefined));
    await expect(chatTool([{ role: 'user', content: 'hi' }], ECHO)).rejects.toBeInstanceOf(LlmOutputError);
  });

  it('throws LlmOutputError on malformed JSON arguments', async () => {
    llm.chat.mockResolvedValue(reply([call('{"ok":')]));
    await expect(chatTool([{ role: 'user', content: 'hi' }], ECHO)).rejects.toBeInstanceOf(LlmOutputError);
  });
});

describe('isLlmRateLimited', () => {
  it('is true only for a Forge LLM 429', () => {
    expect(isLlmRateLimited(new llm.ForgeLlmAPIError(429))).toBe(true);
    expect(isLlmRateLimited(new llm.ForgeLlmAPIError(500))).toBe(false);
    expect(isLlmRateLimited(Object.assign(new Error('x'), { status: 429 }))).toBe(false);
  });
});
