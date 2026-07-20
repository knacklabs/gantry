// Test-internal types for the agent E2E merge gate
// (docs/architecture/agent-e2e-ci-merge-gate-goal-prompt.md, "Packaged-runtime
// E2E proofs"). Never exported from any package.

/** Gate lanes map 1:1 to the test:e2e:agent:<lane> scripts. */
export type AgentE2ELane = 'policy' | 'hermetic' | 'live';

export interface AgentE2EScenario {
  /** Stable id; keys the scenario's evidence record. */
  id: string;
  description: string;
  lane: AgentE2ELane;
}

/** One recorded MCP tool invocation (fixture-side truth for assertions). */
export interface McpCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface CapabilityDecisionRecord {
  capability: string;
  decision: string;
  auditId?: string;
}

/** Redacted JSON evidence uploaded on success AND failure. */
export interface AgentE2EEvidence {
  scenario: string;
  imageDigest: string;
  modelAlias: string;
  modelRoute: string;
  provider: string;
  harness: string;
  runId?: string;
  sessionId?: string;
  selectedSkills: string[];
  mcpCalls: McpCallRecord[];
  capabilityDecisions: CapabilityDecisionRecord[];
  auditIds: string[];
  /** Named phase -> wall-clock milliseconds. */
  timings: Record<string, number>;
  /** Present only on failure; must be credential-scrubbed before writing. */
  redactedFailure?: string;
}
