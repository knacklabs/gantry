import { describe, expect, it } from 'vitest';

import { applyDirectLlmPromptCache } from '../../../src/control/server/routes/llm-prompt-cache.js';

describe('direct LLM prompt cache policy', () => {
  it('marks only the stable Anthropic system block', () => {
    const body: Record<string, unknown> = {
      system: 'Stable instructions',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Unique content',
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        },
      ],
    };

    const diagnostics = applyDirectLlmPromptCache('messages', body, {
      enabled: true,
      anthropic: { defaultTtl: '5m' },
    });

    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'Stable instructions',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ]);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Unique content' }],
      },
    ]);
    expect(diagnostics).toMatchObject({
      enabled: true,
      mode: 'anthropic_explicit',
      ttl: '5m',
      prefixChars: 'Stable instructions'.length,
      breakpointCount: 1,
    });
    expect(diagnostics.prefixHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('marks exactly the final stable system block with the configured 1h TTL', () => {
    const body: Record<string, unknown> = {
      system: [
        { type: 'text', text: 'Instructions' },
        { type: 'text', text: 'Schema' },
      ],
      messages: [{ role: 'user', content: 'Variable evidence' }],
    };

    const diagnostics = applyDirectLlmPromptCache('messages', body, {
      enabled: true,
      anthropic: { defaultTtl: '1h' },
    });

    expect(body.system).toEqual([
      { type: 'text', text: 'Instructions' },
      {
        type: 'text',
        text: 'Schema',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
    expect(diagnostics).toMatchObject({
      enabled: true,
      mode: 'anthropic_explicit',
      ttl: '1h',
      breakpointCount: 1,
    });
  });

  it('preserves a valid caller-requested system TTL', () => {
    const body: Record<string, unknown> = {
      system: [
        {
          type: 'text',
          text: 'Stable instructions',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: 'Variable evidence' }],
    };

    const diagnostics = applyDirectLlmPromptCache('messages', body, {
      enabled: true,
      anthropic: { defaultTtl: '5m' },
    });

    expect(body.system).toEqual([
      {
        type: 'text',
        text: 'Stable instructions',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
    expect(diagnostics).toMatchObject({
      enabled: true,
      mode: 'anthropic_explicit',
      ttl: '1h',
      breakpointCount: 1,
    });
  });

  it('strips every Anthropic cache control when disabled', () => {
    const body: Record<string, unknown> = {
      cache_control: { type: 'ephemeral' },
      system: [
        {
          type: 'text',
          text: 'Stable',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    };

    const diagnostics = applyDirectLlmPromptCache('messages', body, {
      enabled: false,
      anthropic: { defaultTtl: '5m' },
    });

    expect(body).toEqual({ system: [{ type: 'text', text: 'Stable' }] });
    expect(diagnostics).toMatchObject({
      enabled: false,
      mode: 'disabled',
      ttl: null,
      breakpointCount: 0,
    });
  });

  it('does not alter Gemini chat completion requests', () => {
    const body = {
      messages: [
        { role: 'system', content: 'Stable' },
        { role: 'user', content: 'Unique' },
      ],
    };
    const diagnostics = applyDirectLlmPromptCache(
      'chat_completions',
      body,
      {
        enabled: true,
        anthropic: { defaultTtl: '1h' },
      },
      { providerAutomatic: true },
    );
    expect(body).toEqual({
      messages: [
        { role: 'system', content: 'Stable' },
        { role: 'user', content: 'Unique' },
      ],
    });
    expect(diagnostics).toMatchObject({
      enabled: true,
      mode: 'provider_automatic_prefix',
      ttl: null,
      prefixChars: 'Stable'.length,
      breakpointCount: 0,
    });
  });
});
