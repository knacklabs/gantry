import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { createFilesystemMiddleware, StateBackend } from 'deepagents';
import { expect, it } from 'vitest';
import { InlineCallerEvidenceBackend } from '../../../src/adapters/llm/deepagents-langchain/runner/inline-caller-evidence-backend.js';

it('keeps large caller evidence and tool responses inline without granting filesystem tools', async () => {
  const backend = new InlineCallerEvidenceBackend({ state: { files: {} } });
  const middleware = createFilesystemMiddleware({ backend }) as unknown as {
    beforeAgent: (state: unknown) => Promise<unknown>;
    wrapToolCall: (
      request: unknown,
      handler: () => Promise<ToolMessage>,
    ) => Promise<ToolMessage>;
  };
  const text =
    'a'.repeat(130_000) + 'MIDDLE_FACT_PAYMENT_30_DAYS' + 'b'.repeat(130_000);
  const message = new HumanMessage(text);
  expect(await middleware.beforeAgent({ messages: [message] })).toBeUndefined();
  expect(message.content).toBe(text);
  expect(message.additional_kwargs.lc_evicted_to).toBeUndefined();
  const response = new ToolMessage({ content: text, tool_call_id: 'call-1' });
  const returned = await middleware.wrapToolCall(
    { toolCall: { id: 'call-1', name: 'caller_result' }, state: {} },
    async () => response,
  );
  expect(returned).toBe(response);
  expect(returned.content).toContain('MIDDLE_FACT_PAYMENT_30_DAYS');
  expect(returned.content).not.toContain('Message content too large');
});

it('retains inherited reads for explicitly seeded skills', () => {
  const backend = new InlineCallerEvidenceBackend({
    state: {
      files: {
        '/skills/review/SKILL.md': {
          content: ['Read only supplied evidence.'],
          created_at: '2026-11-03',
          modified_at: '2026-11-03',
        },
      },
    },
  });
  expect(backend.read('/skills/review/SKILL.md')).toMatchObject({
    content: expect.stringContaining('Read only supplied evidence.'),
  });
});

it('reproduces the inaccessible-preview behavior of the default backend', async () => {
  const middleware = createFilesystemMiddleware({
    backend: new StateBackend({ state: { files: {} } }),
  }) as unknown as {
    beforeAgent: (state: unknown) => Promise<{ messages: HumanMessage[] }>;
  };
  const result = await middleware.beforeAgent({
    messages: [new HumanMessage('a'.repeat(260_000))],
  });
  expect(result.messages[0]?.additional_kwargs.lc_evicted_to).toMatch(
    /^\/conversation_history\//,
  );
});
