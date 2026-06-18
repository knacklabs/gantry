import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../shared/model-catalog.js';

// Provider-neutral runner output frame contract shared by execution-adapter
// runners. Frames are written to stdout between OUTPUT_START_MARKER and
// OUTPUT_END_MARKER as a single JSON line; the host parses them in
// agent-spawn-process.ts (see AgentOutput in agent-spawn-types.ts). This module
// is the neutral mirror of that host type for runner authors so a new adapter
// runner does not import any provider-specific runner types.

export const OUTPUT_START_MARKER = '---GANTRY_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---GANTRY_OUTPUT_END---';

export interface RunnerRuntimeEventFrame {
  appId?: string;
  agentId?: string;
  runId?: string;
  jobId?: string;
  conversationId?: string;
  threadId?: string;
  eventType: string;
  actor?: string;
  responseMode?: 'sse' | 'webhook' | 'both' | 'none';
  payload: unknown;
}

export interface RunnerOutputFrame {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  // Marks the standalone up-front frame a runner may emit to persist the session
  // id BEFORE any content streams (launchd-restart safety). It is NOT a
  // turn-complete marker: the host's isAgentTurnCompleteMarker excludes it so an
  // interactive turn is not reported completed at its very start.
  sessionInit?: boolean;
  compactBoundary?: boolean;
  interactionBoundary?: 'user_interaction';
  continuedByFollowup?: boolean;
  usage?: NormalizedModelUsage;
  usageEventId?: string;
  contextUsage?: RuntimeContextUsageSnapshot;
  error?: string;
  runtimeEvents?: RunnerRuntimeEventFrame[];
}

export function writeRunnerFrame(frame: RunnerOutputFrame): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(frame));
  console.log(OUTPUT_END_MARKER);
}

export async function readRunnerStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}
