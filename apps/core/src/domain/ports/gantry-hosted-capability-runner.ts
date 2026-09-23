export interface GantryHostedCapabilityRunInput {
  readonly appId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly threadId: string | null;
  readonly jobId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly operation: string;
  readonly arguments: Record<string, unknown>;
  readonly runtimeContext: Record<string, unknown>;
  readonly deadlineMs?: number;
  /** Host-only parent authority; never forwarded to the executable module. */
  readonly parentRunLease?: {
    readonly leaseToken: string;
    readonly fencingVersion: number;
  };
}

export interface GantryHostedCapabilityRunner {
  execute(
    input: GantryHostedCapabilityRunInput,
    commitResult?: (
      operation: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>,
  ): Promise<unknown>;
}
