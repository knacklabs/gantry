import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import type { ExecutionProviderId } from '@core/domain/sessions/sessions.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const EXECUTION_PROVIDER_ID =
  'anthropic:claude-agent-sdk' as ExecutionProviderId;

maybeDescribe('provider session context high-water mark', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'provider_session_mark',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  async function sessionContext(name: string) {
    const workspaceFolder = `provider-session-mark-${name}`;
    const chatJid = `tg:provider-session-mark:${name}`;
    const sessionId = `provider-session:mark:${name}`;
    await runtime.sessionOps.setSession(workspaceFolder, sessionId, null, {
      executionProviderId: EXECUTION_PROVIDER_ID,
      chatJid,
    });
    const context = await runtime.sessionOps.getAgentTurnContext({
      workspaceFolder,
      executionProviderId: EXECUTION_PROVIDER_ID,
      chatJid,
      threadId: null,
    });
    return { workspaceFolder, chatJid, sessionId, context };
  }

  function measurementInput(input: {
    sessionId: string;
    context: Awaited<ReturnType<typeof sessionContext>>['context'];
    contextHighWaterMark: number;
  }) {
    return {
      providerSessionId: input.sessionId,
      agentSessionId: input.context.agentSessionId,
      provider: EXECUTION_PROVIDER_ID,
      externalSessionId: input.sessionId,
      expectedAgentSessionResetAt: input.context.agentSessionResetAt ?? null,
      contextHighWaterMark: input.contextHighWaterMark,
    };
  }

  it('raise keeps the larger value and leaves metadata_json untouched', async () => {
    const session = await sessionContext('larger');
    const [before] = await runtime.service.db
      .select({ metadataJson: pgSchema.providerSessionsPostgres.metadataJson })
      .from(pgSchema.providerSessionsPostgres)
      .where(eq(pgSchema.providerSessionsPostgres.id, session.sessionId));

    await expect(
      runtime.sessionOps.raiseProviderSessionContextHighWaterMark(
        measurementInput({
          sessionId: session.sessionId,
          context: session.context,
          contextHighWaterMark: 100,
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      runtime.sessionOps.raiseProviderSessionContextHighWaterMark(
        measurementInput({
          sessionId: session.sessionId,
          context: session.context,
          contextHighWaterMark: 99,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      runtime.sessionOps.raiseProviderSessionContextHighWaterMark(
        measurementInput({
          sessionId: session.sessionId,
          context: session.context,
          contextHighWaterMark: 100,
        }),
      ),
    ).resolves.toBe(false);

    const [after] = await runtime.service.db
      .select({
        metadataJson: pgSchema.providerSessionsPostgres.metadataJson,
        contextHighWaterMark:
          pgSchema.providerSessionsPostgres.contextHighWaterMark,
      })
      .from(pgSchema.providerSessionsPostgres)
      .where(eq(pgSchema.providerSessionsPostgres.id, session.sessionId));
    expect(after).toEqual({
      metadataJson: before?.metadataJson,
      contextHighWaterMark: 100,
    });
    await expect(
      runtime.sessionOps.getAgentTurnContext({
        workspaceFolder: session.workspaceFolder,
        executionProviderId: EXECUTION_PROVIDER_ID,
        chatJid: session.chatJid,
        threadId: null,
      }),
    ).resolves.toMatchObject({ contextHighWaterMark: 100 });
  });

  it('raise rejects a stale owner and ignores non-resumable rows', async () => {
    const session = await sessionContext('stale-and-expired');
    const owned = measurementInput({
      sessionId: session.sessionId,
      context: session.context,
      contextHighWaterMark: 100,
    });
    // One mismatch per ownership predicate: if raise dropped any one of them it
    // would update a different session's row, and a single combined case would
    // still pass with two of the three missing. The generation stays valid so
    // only ownership is under test; reset_at is the next test's subject.
    for (const staleOwner of [
      { agentSessionId: `${owned.agentSessionId}-other` },
      { provider: 'openai:deepagents-langchain' as ExecutionProviderId },
      { externalSessionId: `${owned.externalSessionId}-other` },
    ]) {
      await expect(
        runtime.sessionOps.raiseProviderSessionContextHighWaterMark({
          ...owned,
          ...staleOwner,
        }),
      ).resolves.toBe(false);
    }
    await runtime.service.db
      .update(pgSchema.agentSessionsPostgres)
      .set({ resetAt: '2026-09-09T00:00:00.000Z' })
      .where(
        eq(pgSchema.agentSessionsPostgres.id, session.context.agentSessionId),
      );
    await runtime.service.db
      .update(pgSchema.providerSessionsPostgres)
      .set({ status: 'expired' })
      .where(eq(pgSchema.providerSessionsPostgres.id, session.sessionId));
    await expect(
      runtime.sessionOps.raiseProviderSessionContextHighWaterMark({
        ...measurementInput({
          sessionId: session.sessionId,
          context: session.context,
          contextHighWaterMark: 100,
        }),
        expectedAgentSessionResetAt: '2026-09-09T00:00:00.000Z',
      }),
    ).resolves.toBe(false);
  });

  it('raise and retire fence null-safely on the agent session generation', async () => {
    const nullGeneration = await sessionContext('generation-null');
    const nullInput = measurementInput({
      sessionId: nullGeneration.sessionId,
      context: nullGeneration.context,
      contextHighWaterMark: 100,
    });
    const resetAt = '2026-09-09T00:00:00.000Z';
    const { contextHighWaterMark: _, ...nullRetireInput } = nullInput;
    await expect(
      runtime.sessionOps.raiseProviderSessionContextHighWaterMark({
        ...nullInput,
        expectedAgentSessionResetAt: resetAt,
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.sessionOps.retireProviderSession({
        ...nullRetireInput,
        expectedAgentSessionResetAt: resetAt,
      }),
    ).resolves.toBeUndefined();
    await expect(
      runtime.sessionOps.raiseProviderSessionContextHighWaterMark(nullInput),
    ).resolves.toBe(true);
    await expect(
      runtime.sessionOps.retireProviderSession(nullRetireInput),
    ).resolves.toMatchObject({ providerSessionId: nullGeneration.sessionId });

    const session = await sessionContext('generation-fence');
    const input = measurementInput({
      sessionId: session.sessionId,
      context: session.context,
      contextHighWaterMark: 100,
    });
    await expect(
      runtime.sessionOps.raiseProviderSessionContextHighWaterMark(input),
    ).resolves.toBe(true);
    await runtime.service.db
      .update(pgSchema.agentSessionsPostgres)
      .set({ resetAt })
      .where(
        eq(pgSchema.agentSessionsPostgres.id, session.context.agentSessionId),
      );
    await expect(
      runtime.sessionOps.raiseProviderSessionContextHighWaterMark({
        ...input,
        contextHighWaterMark: 101,
      }),
    ).resolves.toBe(false);
    await expect(
      runtime.sessionOps.retireProviderSession({
        ...input,
      }),
    ).resolves.toBeUndefined();
    await expect(
      runtime.sessionOps.raiseProviderSessionContextHighWaterMark({
        ...input,
        expectedAgentSessionResetAt: resetAt,
        contextHighWaterMark: 101,
      }),
    ).resolves.toBe(true);
    await expect(
      runtime.sessionOps.retireProviderSession({
        ...input,
        expectedAgentSessionResetAt: resetAt,
      }),
    ).resolves.toMatchObject({ providerSessionId: session.sessionId });
  });

  it('retire returns the retired reference only for a won active transition', async () => {
    const session = await sessionContext('retire');
    const input = measurementInput({
      sessionId: session.sessionId,
      context: session.context,
      contextHighWaterMark: 100,
    });
    const { contextHighWaterMark: _, ...retireInput } = input;
    await expect(
      runtime.sessionOps.retireProviderSession(retireInput),
    ).resolves.toEqual({
      providerSessionId: session.sessionId,
      externalSessionId: session.sessionId,
      executionProviderId: EXECUTION_PROVIDER_ID,
    });
    await expect(
      runtime.sessionOps.retireProviderSession(retireInput),
    ).resolves.toBeUndefined();
  });

  it('resetScope returns the retired references after commit and an empty list when nothing matched', async () => {
    const session = await sessionContext('reset');
    const retired = await runtime.sessionOps.deleteSession(
      session.workspaceFolder,
      null,
      { chatJid: session.chatJid },
    );
    expect(retired).toEqual([
      {
        providerSessionId: session.sessionId,
        externalSessionId: session.sessionId,
        executionProviderId: EXECUTION_PROVIDER_ID,
      },
    ]);
    expect(Object.isFrozen(retired)).toBe(true);
    await expect(
      runtime.service.db
        .select({ id: pgSchema.providerSessionsPostgres.id })
        .from(pgSchema.providerSessionsPostgres)
        .where(eq(pgSchema.providerSessionsPostgres.id, session.sessionId)),
    ).resolves.toEqual([]);
    await expect(
      runtime.sessionOps.deleteSession(session.workspaceFolder, null, {
        chatJid: session.chatJid,
      }),
    ).resolves.toEqual([]);
  });
});
