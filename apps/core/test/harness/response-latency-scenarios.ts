import {
  createResponseLatencyHarness,
  createScriptedFakeStreamingModel,
  type OperationCounter,
  type ResponseLatencyBoundary,
} from './response-latency-harness.js';

export type ResponseLatencyScenarioId =
  | 'S1'
  | 'S2'
  | 'S3'
  | 'S4'
  | 'S5'
  | 'S6'
  | 'S7'
  | 'S8'
  | 'S9'
  | 'S10'
  | 'S11'
  | 'S12';

interface FakeScenario {
  readonly id: Exclude<ResponseLatencyScenarioId, 'S11' | 'S12'>;
  readonly name: string;
  readonly kind: 'fake';
  readonly routeCount: number;
  readonly replayLoads?: number;
  readonly threadMessageLoads?: number;
  readonly conversationCount?: number;
  readonly providerHistory?: boolean;
  readonly memory?: boolean;
  readonly provisionalSessionContext?: boolean;
  readonly finalSessionContext?: boolean;
  readonly adapterPrepare?: boolean;
  readonly inputMessageCount?: number;
  readonly skills?: {
    readonly enabledCount: number;
    readonly selectedCount: number;
    readonly store: 'local' | 's3-like';
  };
  readonly mcpConnectDelaysMs?: readonly number[];
  readonly modelRequestBytes?: number;
  readonly booleans?: Readonly<Record<string, boolean>>;
}

interface RegressionScenario {
  readonly id: 'S11' | 'S12';
  readonly name: string;
  readonly kind: 'regression';
}

type ScenarioDefinition = FakeScenario | RegressionScenario;

// ponytail: one data table and one runner are enough for this test-only matrix.
export const RESPONSE_LATENCY_SCENARIOS = [
  {
    id: 'S1',
    name: 'warm top/no thread/no skill/no MCP/new session',
    kind: 'fake',
    routeCount: 1,
    replayLoads: 1,
    provisionalSessionContext: true,
    finalSessionContext: true,
    booleans: {
      threaded: false,
      newSession: true,
      skillsEnabled: false,
      mcpEnabled: false,
    },
  },
  {
    id: 'S2',
    name: 'sparse top provider history',
    kind: 'fake',
    routeCount: 1,
    replayLoads: 1,
    providerHistory: true,
    booleans: { threaded: false, providerHistoryHydrated: true },
  },
  {
    id: 'S3',
    name: 'sparse thread root+tail',
    kind: 'fake',
    routeCount: 1,
    threadMessageLoads: 2,
    booleans: { threaded: true },
  },
  {
    id: 'S4',
    name: 'resumed provider session+memory',
    kind: 'fake',
    routeCount: 1,
    providerHistory: true,
    memory: true,
    finalSessionContext: true,
    booleans: { resumedSession: true, memoryHydrated: true },
  },
  {
    id: 'S5',
    name: '10 enabled/3 selected/local store',
    kind: 'fake',
    routeCount: 1,
    skills: { enabledCount: 10, selectedCount: 3, store: 'local' },
    booleans: { localSkillStore: true },
  },
  {
    id: 'S6',
    name: '10 enabled/3 selected/delayed S3-like store',
    kind: 'fake',
    routeCount: 1,
    skills: { enabledCount: 10, selectedCount: 3, store: 's3-like' },
    booleans: { s3LikeSkillStore: true },
  },
  {
    id: 'S7',
    name: '3 MCP servers 100/200/300',
    kind: 'fake',
    routeCount: 1,
    mcpConnectDelaysMs: [100, 200, 300],
    booleans: { remoteMcp: true },
  },
  {
    id: 'S8',
    name: 'one message to 3 agents',
    kind: 'fake',
    routeCount: 3,
    inputMessageCount: 1,
    booleans: { multiAgent: true },
  },
  {
    id: 'S9',
    name: '10 conversations',
    kind: 'fake',
    routeCount: 10,
    conversationCount: 10,
  },
  {
    id: 'S10',
    name: 'direct LLM streaming 1MiB',
    kind: 'fake',
    routeCount: 1,
    modelRequestBytes: 1_048_576,
    adapterPrepare: true,
    booleans: { directLlmStreaming: true },
  },
  { id: 'S11', name: '500 jobs', kind: 'regression' },
  { id: 'S12', name: 'IPC 5000 markers', kind: 'regression' },
] as const satisfies readonly ScenarioDefinition[];

export const RESPONSE_LATENCY_REGRESSION_ANCHORS = {
  S11: {
    sourceId:
      'job-lifecycle.postgres.integration:projects-one-latest-non-session-run-for-500-jobs',
    jobCount: 500,
    queryCount: 2,
    distinctOnQueryCount: 1,
  },
  S12: {
    sourceId:
      'ipc-auth-boundary:performs-bounded-filesystem-work-with-5000-replay-markers',
    markerCount: 5_000,
    replayStoreOperationCount: 4,
    scanCount: 0,
    readCount: 0,
    removeCount: 0,
  },
} as const;

export interface ResponseLatencyScenarioResult {
  readonly scenarioId: ResponseLatencyScenarioId;
  readonly status: 'completed' | 'current_baseline';
  readonly counts: Readonly<Record<string, number>>;
  readonly durationsMs: Readonly<Record<string, number>>;
  readonly booleans: Readonly<Record<string, boolean>>;
  readonly firstContentDurationMs?: number;
}

interface FakeScenarioObservations {
  readonly operations: OperationCounter;
  readonly loadedConversations: Set<string>;
  readonly modeledConversations: Set<string>;
}

function createFakeScenarioDependencies(
  harness: ReturnType<typeof createResponseLatencyHarness>,
  durationsMs: Record<string, number>,
  observations: FakeScenarioObservations,
) {
  const externalNetworkCalls = 0;
  const observe = async (
    boundary: ResponseLatencyBoundary,
    operation: string,
    delayMs = 0,
  ) => {
    observations.operations.increment(operation);
    harness.delays.setDelayMs(boundary, delayMs);
    await harness.delays.wait(boundary);
    durationsMs[boundary] = (durationsMs[boundary] ?? 0) + delayMs;
  };

  return {
    getMessagesSince: () => observe('replay_load', 'get_messages_since_calls'),
    async getThreadMessages(conversationId: string) {
      await observe('conversation_local_load', 'get_messages_since_calls');
      observations.loadedConversations.add(conversationId);
    },
    hydrateProviderHistory: () =>
      observe('provider_history_hydration', 'provider_history_calls'),
    hydrateMemory: () => observe('memory_hydration', 'memory_hydrate_calls'),
    loadProvisionalSessionContext: () =>
      observe(
        'provisional_session_context',
        'provisional_session_context_calls',
      ),
    loadFinalSessionContext: () =>
      observe('final_session_context', 'final_session_context_calls'),
    prepareAdapter: () => observe('adapter_prepare', 'adapter_prepare_calls'),
    recordInputMessages(messages: readonly number[]) {
      observations.operations.increment('input_message_count', messages.length);
    },
    async listEnabledSkills(count: number) {
      await observe('access_row_load', 'list_enabled_skills_calls');
      const skills = Array.from({ length: count }, (_, id) => id);
      observations.operations.increment('enabled_skill_count', skills.length);
      return skills;
    },
    listS3SkillObjects: () => observe('access_projection', 's3_list_calls'),
    async getSkill(skillId: number, store: 'local' | 's3-like') {
      await observe(
        'skill_artifact_projection',
        'get_skill_calls',
        store === 's3-like' ? 1 : 0,
      );
      observations.operations.increment(
        store === 's3-like' ? 's3_get_calls' : 'local_skill_reads',
      );
      return skillId;
    },
    async listMcpBindings(count: number) {
      await observe('mcp_materialization', 'list_mcp_bindings_calls');
      const bindings = Array.from({ length: count }, (_, id) => id);
      observations.operations.increment('mcp_server_count', bindings.length);
      return bindings;
    },
    async getMcpServer(bindingId: number) {
      await observe('mcp_materialization', 'get_mcp_server_calls');
      return bindingId;
    },
    async connectMcp(serverId: number, delayMs: number) {
      await observe('mcp_connect', 'mcp_connect_calls', delayMs);
      return serverId;
    },
    async listMcpTools(serverId: number) {
      await observe('mcp_discovery', 'mcp_list_tools_calls');
      return serverId;
    },
    notifyAdmission: () =>
      observe('admission_notification', 'admission_notification_calls'),
    async streamModel(input: {
      attemptId: string;
      request: Uint8Array<ArrayBuffer>;
      conversationId?: string;
    }) {
      observations.operations.increment('model_stream_calls');
      observations.operations.increment(
        'model_request_bytes',
        input.request.byteLength,
      );
      const attempt = harness.channel.beginAttempt(input.attemptId);
      observations.operations.increment('channel_delivery_attempts');
      const model = createScriptedFakeStreamingModel({
        preContentFrames: [{ kind: 'progress', status: 'working' }],
        contentFrame: { kind: 'content_chunk', text: 'content' },
        delay: () =>
          observe('provider_first_byte', 'provider_first_byte_calls', 1),
      });
      await model.stream(async (frame) => {
        if (frame.kind === 'content_chunk' || frame.kind === 'content_part') {
          await observe(
            'channel_first_visible_delivery',
            'channel_first_visible_calls',
            1,
          );
        }
        attempt.observe(frame, { delivered: true });
      });
      attempt.settle('completed');
      if (input.conversationId) {
        observations.modeledConversations.add(input.conversationId);
      }
    },
    externalNetworkCalls: () => externalNetworkCalls,
    conversationSnapshot: () => ({
      count: observations.modeledConversations.size,
      independent:
        observations.modeledConversations.size ===
          observations.loadedConversations.size &&
        [...observations.modeledConversations].every((id) =>
          observations.loadedConversations.has(id),
        ),
    }),
  };
}

export async function runResponseLatencyScenario(
  scenarioId: ResponseLatencyScenarioId,
): Promise<ResponseLatencyScenarioResult> {
  const scenario = RESPONSE_LATENCY_SCENARIOS.find(
    ({ id }) => id === scenarioId,
  );
  if (!scenario)
    throw new Error(`Unknown response latency scenario ${scenarioId}`);

  if (scenario.id === 'S11') {
    // Reference-only by contract: the Postgres regression owns the executable
    // 500-row fixture; duplicating it here would create a second source of truth.
    const anchor = RESPONSE_LATENCY_REGRESSION_ANCHORS.S11;
    return {
      scenarioId,
      status: 'current_baseline',
      counts: {
        jobs: anchor.jobCount,
        postgres_statements: anchor.queryCount,
        distinct_on_queries: anchor.distinctOnQueryCount,
      },
      durationsMs: {},
      booleans: { regressionSourceReferenced: true },
    };
  }
  if (scenario.id === 'S12') {
    // Reference-only by contract: the IPC regression owns the executable
    // 5,000-file fixture; duplicating it here would repeat expensive setup.
    const anchor = RESPONSE_LATENCY_REGRESSION_ANCHORS.S12;
    return {
      scenarioId,
      status: 'current_baseline',
      counts: {
        replay_markers: anchor.markerCount,
        replay_store_operations: anchor.replayStoreOperationCount,
        replay_scans: anchor.scanCount,
        replay_reads: anchor.readCount,
        replay_removes: anchor.removeCount,
      },
      durationsMs: {},
      booleans: { regressionSourceReferenced: true },
    };
  }

  const harness = createResponseLatencyHarness();
  const durationsMs: Record<string, number> = {};
  const observations: FakeScenarioObservations = {
    operations: harness.operations,
    loadedConversations: new Set(),
    modeledConversations: new Set(),
  };
  const fake = createFakeScenarioDependencies(
    harness,
    durationsMs,
    observations,
  );

  for (let call = 0; call < (scenario.replayLoads ?? 0); call += 1) {
    await fake.getMessagesSince();
  }
  for (let call = 0; call < (scenario.threadMessageLoads ?? 0); call += 1) {
    await fake.getThreadMessages(`${scenario.id}:thread`);
  }
  if (scenario.providerHistory) await fake.hydrateProviderHistory();
  if (scenario.memory) await fake.hydrateMemory();
  if (scenario.provisionalSessionContext) {
    await fake.loadProvisionalSessionContext();
  }
  if (scenario.finalSessionContext) await fake.loadFinalSessionContext();
  if (scenario.adapterPrepare) await fake.prepareAdapter();

  if (scenario.inputMessageCount !== undefined) {
    const messages = Array.from(
      { length: scenario.inputMessageCount },
      (_, id) => id,
    );
    fake.recordInputMessages(messages);
  }

  if (scenario.skills) {
    const enabledSkills = await fake.listEnabledSkills(
      scenario.skills.enabledCount,
    );
    const selectedSkills = enabledSkills.slice(
      0,
      scenario.skills.selectedCount,
    );
    harness.operations.increment('selected_skill_count', selectedSkills.length);

    if (scenario.skills.store === 's3-like') {
      await fake.listS3SkillObjects();
    }
    for (const skill of selectedSkills) {
      await fake.getSkill(skill, scenario.skills.store);
    }
  }

  if (scenario.mcpConnectDelaysMs) {
    const bindings = await fake.listMcpBindings(
      scenario.mcpConnectDelaysMs.length,
    );
    for (const [binding, delayMs] of scenario.mcpConnectDelaysMs.entries()) {
      const server = await fake.getMcpServer(bindings[binding]!);
      const connection = await fake.connectMcp(server, delayMs);
      await fake.listMcpTools(connection);
    }
  }

  const barrier = harness.createBarrier(scenario.routeCount);
  const routes = Array.from({ length: scenario.routeCount }, (_, route) => ({
    attemptId: `${scenario.id}:${route}`,
    ...(scenario.conversationCount === undefined
      ? {}
      : { conversationId: `${scenario.id}:conversation:${route}` }),
  }));
  harness.operations.increment('agent_route_count', routes.length);

  const request = new Uint8Array(scenario.modelRequestBytes ?? 0);
  const routeResults = await Promise.all(
    routes.map(async ({ attemptId, conversationId }) => {
      harness.operations.increment('barrier_arrivals');
      const participant = barrier.arrive();
      await barrier.waitForAll();
      const routeDurationsMs: Record<string, number> = {};
      const routeHarness = createResponseLatencyHarness({
        startMs: harness.clock.nowMs(),
      });
      const routeFake = createFakeScenarioDependencies(
        routeHarness,
        routeDurationsMs,
        observations,
      );
      try {
        if (conversationId) {
          await routeFake.getThreadMessages(conversationId);
        }
        if (scenario.id === 'S8') await routeFake.notifyAdmission();
        await routeFake.streamModel({ attemptId, request, conversationId });
        return {
          durationsMs: routeDurationsMs,
          firstContentAtMs: routeHarness.channel.firstContentAtMs(),
          completedAtMs: routeHarness.clock.nowMs(),
          externalNetworkCalls: routeFake.externalNetworkCalls(),
        };
      } finally {
        participant.release();
      }
    }),
  );
  const barrierSnapshot = barrier.snapshot();
  harness.operations.increment(
    'maximum_active_routes',
    barrierSnapshot.maximumActive,
  );
  for (const route of routeResults) {
    for (const [boundary, durationMs] of Object.entries(route.durationsMs)) {
      durationsMs[boundary] = Math.max(durationsMs[boundary] ?? 0, durationMs);
    }
  }
  const conversations = fake.conversationSnapshot();
  if (scenario.conversationCount !== undefined) {
    harness.operations.increment('conversation_count', conversations.count);
  }

  durationsMs.total = Math.max(
    harness.clock.nowMs(),
    ...routeResults.map(({ completedAtMs }) => completedAtMs),
  );
  const firstContentTimes = routeResults.flatMap(({ firstContentAtMs }) =>
    firstContentAtMs === undefined ? [] : [firstContentAtMs],
  );
  const firstContentDurationMs = Math.min(...firstContentTimes);
  if (!Number.isFinite(firstContentDurationMs)) {
    throw new Error(`Scenario ${scenarioId} did not deliver first content`);
  }

  return {
    scenarioId,
    status: 'completed',
    counts: harness.operations.snapshot(),
    durationsMs: Object.freeze({ ...durationsMs }),
    booleans: Object.freeze({
      ...scenario.booleans,
      allArrived: barrierSnapshot.allArrived,
      noRealNetwork:
        fake.externalNetworkCalls() === 0 &&
        routeResults.every(
          ({ externalNetworkCalls }) => externalNetworkCalls === 0,
        ),
      distinctRouteIds:
        new Set(routes.map(({ attemptId }) => attemptId)).size ===
        routes.length,
      ...(scenario.conversationCount === undefined
        ? {}
        : {
            independentConversations:
              conversations.independent &&
              conversations.count === scenario.conversationCount,
          }),
    }),
    firstContentDurationMs,
  };
}
