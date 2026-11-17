import { mappedEgressTarget } from '@core/runtime/egress-gateway-access-policy.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildSandboxRuntimeNetworkProjection } from '@core/runtime/agent-spawn-helpers.js';
import {
  ensureEgressGateway,
  closeEgressGateway,
} from '@core/runtime/egress-gateway.js';
import { DeepAgentSessionStore } from '@core/adapters/llm/deepagents-langchain/runner/session-store.js';
const run = process.env.GANTRY_DATABASE_URL ? describe : describe.skip;
run('trusted checkpoint tunnel', () => {
  it('reads official checkpoints through exact configured private DB mapping without model access', async () => {
    const original = {
      databaseUrl: process.env.GANTRY_DATABASE_URL!,
      schema: 'gantry_deepagents',
    };
    const projection = buildSandboxRuntimeNetworkProjection(
      'sandbox_runtime',
      [],
      undefined,
      original,
    );
    expect(projection.checkpointer?.databaseUrl === original.databaseUrl).toBe(
      true,
    );
    expect(projection.checkpointer?.proxyTargetAuthority).toMatch(
      /^gantry-runtime-checkpoint\.internal:\d+$/,
    );
    const gateway = await ensureEgressGateway({
      key: `checkpoint-regression:${randomUUID()}`,
      settings: { denylist: [] },
      principal: { appId: 'checkpoint-regression' },
      privateNetworkHostMappings:
        projection.networkProjection.privateNetworkHostMappings,
    });
    let saver;
    try {
      saver = await new DeepAgentSessionStore({
        ...projection.checkpointer!,
        proxyUrl: gateway.proxyUrl,
      }).create(randomUUID());
      expect(
        await saver.getTuple({ configurable: { thread_id: randomUUID() } }),
      ).toBeUndefined();
    } finally {
      await saver?.end();
      await closeEgressGateway(gateway);
    }
  });
});
it('keeps direct execution checkpoint config unchanged', () => {
  const config = {
    databaseUrl: 'postgres://dbuser:fake@private-db:5432/runtime',
    schema: 'gantry_deepagents',
  };
  const projection = buildSandboxRuntimeNetworkProjection(
    'direct',
    [],
    undefined,
    config,
  );
  expect(projection.checkpointer).toBe(config);
  expect(
    projection.networkProjection.privateNetworkHostMappings,
  ).toBeUndefined();
});

it('rejects an arbitrary checkpoint CONNECT authority', async () => {
  await expect(
    new DeepAgentSessionStore({
      databaseUrl: 'postgres://dbuser:fake@private-db:5432/runtime',
      schema: 'gantry_deepagents',
      proxyTargetAuthority: '169.254.169.254:80',
    }).create(randomUUID()),
  ).rejects.toThrow('Invalid trusted checkpoint proxy authority');
});

it('limits a private checkpoint mapping to its exact internal host and port', () => {
  const projection = buildSandboxRuntimeNetworkProjection(
    'sandbox_runtime',
    [],
    undefined,
    {
      databaseUrl: 'postgres://dbuser:fake@private-db:5432/runtime',
      schema: 'gantry_deepagents',
    },
  );
  const state = {
    connectHostMappings: new Map(
      projection.networkProjection.privateNetworkHostMappings!.map((m) => [
        m.authority,
        m.connectHost,
      ]),
    ),
  };
  expect(
    mappedEgressTarget(state, {
      host: 'gantry-runtime-checkpoint.internal',
      port: 5432,
      authority: 'gantry-runtime-checkpoint.internal:5432',
    })?.connectHost,
  ).toBe('private-db');
  expect(
    mappedEgressTarget(state, {
      host: 'gantry-runtime-checkpoint.internal',
      port: 5433,
      authority: 'gantry-runtime-checkpoint.internal:5433',
    }),
  ).toBeUndefined();
  expect(
    mappedEgressTarget(state, {
      host: 'other.internal',
      port: 5432,
      authority: 'other.internal:5432',
    }),
  ).toBeUndefined();
});
