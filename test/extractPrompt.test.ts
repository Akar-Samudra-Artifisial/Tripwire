import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/llm', () => ({ chat: vi.fn(), ForgeLlmError: class extends Error {} }));

const { extractSystemPrompt } = await import('../src/llm/extract');

describe('extractSystemPrompt', () => {
  const prompt = extractSystemPrompt({ pageId: '1', title: 'Defer CSV export', projectKeys: ['SUP'], today: '2026-11-02' });

  // Regression: "If CSV requests reach 10 or more" was extracted as op ">" 10 (the only example used ">").
  it('maps inclusive thresholds ("N or more") to >= and keeps the boundary', () => {
    expect(prompt).toContain('"N or more", "at least N", "reaches N" → op ">=" value N');
    expect(prompt).toContain('"more than N", "over N", "exceeds N" → op ">" value N');
    expect(prompt).toContain('"fewer than 10 requests a month" → it stops holding at 10 → op ">=", value 10');
  });
});
