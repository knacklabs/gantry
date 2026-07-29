import { describe, expect, it } from 'vitest';

import {
  RESPONSE_LATENCY_REGRESSION_ANCHORS,
  RESPONSE_LATENCY_SCENARIOS,
  runResponseLatencyScenario,
  type ResponseLatencyScenarioId,
} from '../../harness/response-latency-scenarios.js';

const scenarioNames = {
  S1: 'warm top/no thread/no skill/no MCP/new session',
  S2: 'sparse top provider history',
  S3: 'sparse thread root+tail',
  S4: 'resumed provider session+memory',
  S5: '10 enabled/3 selected/local store',
  S6: '10 enabled/3 selected/delayed S3-like store',
  S7: '3 MCP servers 100/200/300',
  S8: 'one message to 3 agents',
  S9: '10 conversations',
  S10: 'direct LLM streaming 1MiB',
  S11: '500 jobs',
  S12: 'IPC 5000 markers',
} as const satisfies Record<ResponseLatencyScenarioId, string>;

describe('response latency scenario contracts', () => {
  it('keeps the exact S1-S12 scenario IDs and names', () => {
    expect(
      Object.fromEntries(
        RESPONSE_LATENCY_SCENARIOS.map(({ id, name }) => [id, name]),
      ),
    ).toEqual(scenarioNames);
  });

  it.each([
    ['S1', { get_messages_since_calls: 1 }],
    ['S2', { provider_history_calls: 1 }],
    ['S3', { get_messages_since_calls: 2 }],
    [
      'S4',
      {
        provider_history_calls: 1,
        memory_hydrate_calls: 1,
      },
    ],
    [
      'S5',
      {
        enabled_skill_count: 10,
        selected_skill_count: 3,
        list_enabled_skills_calls: 1,
        get_skill_calls: 3,
        s3_list_calls: 0,
        s3_get_calls: 0,
      },
    ],
    [
      'S6',
      {
        enabled_skill_count: 10,
        selected_skill_count: 3,
        list_enabled_skills_calls: 1,
        get_skill_calls: 3,
        s3_list_calls: 1,
        s3_get_calls: 3,
      },
    ],
    [
      'S7',
      {
        mcp_server_count: 3,
        list_mcp_bindings_calls: 1,
        get_mcp_server_calls: 3,
        mcp_connect_calls: 3,
        mcp_list_tools_calls: 3,
      },
    ],
    [
      'S8',
      {
        input_message_count: 1,
        agent_route_count: 3,
        model_stream_calls: 3,
        channel_delivery_attempts: 3,
      },
    ],
    [
      'S9',
      {
        conversation_count: 10,
        get_messages_since_calls: 10,
        model_stream_calls: 10,
        channel_delivery_attempts: 10,
      },
    ],
    [
      'S10',
      {
        model_request_bytes: 1_048_576,
        model_stream_calls: 1,
        channel_delivery_attempts: 1,
      },
    ],
  ] as const)(
    '%s invokes fake seams and emits first-content evidence',
    async (scenarioId, expectedCounts) => {
      const result = await runResponseLatencyScenario(scenarioId);

      expect(result).toMatchObject({
        scenarioId,
        status: 'completed',
        counts: expectedCounts,
        booleans: {
          allArrived: true,
          noRealNetwork: true,
        },
      });
      expect(result.counts.barrier_arrivals).toBe(
        result.counts.model_stream_calls,
      );
      expect(result.counts.maximum_active_routes).toBe(
        result.counts.model_stream_calls,
      );
      expect(result.firstContentDurationMs).toBeTypeOf('number');
      expect(result.firstContentDurationMs).toBeGreaterThan(0);
      expect(result.durationsMs.total).toBeGreaterThanOrEqual(
        result.firstContentDurationMs!,
      );
    },
  );

  it('observes the controlled S3-like store and MCP boundary delays', async () => {
    const s6 = await runResponseLatencyScenario('S6');
    const s7 = await runResponseLatencyScenario('S7');

    expect(s6.durationsMs.skill_artifact_projection).toBe(3);
    expect(s7.durationsMs.mcp_connect).toBe(600);
  });

  it('binds S9 loads and model calls to ten distinct conversations', async () => {
    const result = await runResponseLatencyScenario('S9');

    expect(result.counts).toMatchObject({
      conversation_count: 10,
      get_messages_since_calls: 10,
      model_stream_calls: 10,
    });
    expect(result.booleans.independentConversations).toBe(true);
  });

  it('overlaps S8 and S9 route timing instead of summing fan-out delays', async () => {
    const s8 = await runResponseLatencyScenario('S8');
    const s9 = await runResponseLatencyScenario('S9');

    expect(s8.firstContentDurationMs).toBe(2);
    expect(s8.durationsMs.total).toBe(2);
    expect(s9.firstContentDurationMs).toBe(2);
    expect(s9.durationsMs.total).toBe(2);
  });

  it('anchors S11 to the existing 500-job regression contract', async () => {
    const result = await runResponseLatencyScenario('S11');

    expect(RESPONSE_LATENCY_REGRESSION_ANCHORS.S11).toEqual({
      sourceId:
        'job-lifecycle.postgres.integration:projects-one-latest-non-session-run-for-500-jobs',
      jobCount: 500,
      queryCount: 2,
      distinctOnQueryCount: 1,
    });
    expect(result).toEqual({
      scenarioId: 'S11',
      status: 'current_baseline',
      counts: {
        jobs: 500,
        postgres_statements: 2,
        distinct_on_queries: 1,
      },
      durationsMs: {},
      booleans: {
        regressionSourceReferenced: true,
      },
    });
  });

  it('anchors S12 to the existing 5,000-marker regression contract', async () => {
    const result = await runResponseLatencyScenario('S12');

    expect(RESPONSE_LATENCY_REGRESSION_ANCHORS.S12).toEqual({
      sourceId:
        'ipc-auth-boundary:performs-bounded-filesystem-work-with-5000-replay-markers',
      markerCount: 5_000,
      replayStoreOperationCount: 4,
      scanCount: 0,
      readCount: 0,
      removeCount: 0,
    });
    expect(result).toEqual({
      scenarioId: 'S12',
      status: 'current_baseline',
      counts: {
        replay_markers: 5_000,
        replay_store_operations: 4,
        replay_scans: 0,
        replay_reads: 0,
        replay_removes: 0,
      },
      durationsMs: {},
      booleans: {
        regressionSourceReferenced: true,
      },
    });
  });

  it('keeps emitted evidence to IDs, counts, durations, statuses, and booleans', async () => {
    for (const { id } of RESPONSE_LATENCY_SCENARIOS) {
      const result = await runResponseLatencyScenario(id);
      expect(Object.keys(result).sort()).toEqual(
        [
          'booleans',
          'counts',
          'durationsMs',
          ...(id === 'S11' || id === 'S12' ? [] : ['firstContentDurationMs']),
          'scenarioId',
          'status',
        ].sort(),
      );
      expect(
        Object.values(result.counts).every(
          (value) => typeof value === 'number',
        ),
      ).toBe(true);
      expect(
        Object.values(result.durationsMs).every(
          (value) => typeof value === 'number',
        ),
      ).toBe(true);
      expect(
        Object.values(result.booleans).every(
          (value) => typeof value === 'boolean',
        ),
      ).toBe(true);
    }
  });
});
