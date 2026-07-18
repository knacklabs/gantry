export const CALLABLE_AGENT_TOOL_PREFIX = 'delegate_to_';
export const CALLABLE_AGENT_SYNC_WAIT_TIMEOUT_MS = 60_000;
export const CALLABLE_AGENT_SYNC_WAIT_MAX_MS = 60_000;
export const CALLABLE_AGENT_RESPONSE_TIMEOUT_MS =
  CALLABLE_AGENT_SYNC_WAIT_MAX_MS + 15_000;

export const CALLABLE_AGENT_PERSONAS = [
  'developer',
  'generalist',
  'sales',
  'marketing',
  'operations',
  'research',
] as const;

export type CallableAgentPersona = (typeof CALLABLE_AGENT_PERSONAS)[number];

export interface CallableAgentToolManifestEntry {
  toolName: string;
  targetAgentId: string;
  displayName: string;
  persona: CallableAgentPersona;
}

export interface CallableAgentToolInput extends Record<string, unknown> {
  objective: string;
  context?: string;
  expectedOutput?: string;
  timeoutMs?: number;
  syncWaitTimeoutMs?: number;
}

interface CallableAgentZodFactory {
  object(shape: Record<string, unknown>): any;
  string(): any;
  number(): any;
}

export interface CallableAgentToolInputSchema {
  safeParse(
    input: unknown,
  ):
    | { success: true; data: CallableAgentToolInput }
    | { success: false; error: { issues: Array<{ message: string }> } };
}

export function callableAgentToolName(
  entry: CallableAgentToolManifestEntry,
): string {
  return `${CALLABLE_AGENT_TOOL_PREFIX}${entry.toolName}`;
}

export function callableAgentToolDescription(
  entry: CallableAgentToolManifestEntry,
): string {
  return `Delegate to ${entry.displayName} (${entry.persona}).`;
}

export function createCallableAgentToolSchema(
  z: CallableAgentZodFactory,
): CallableAgentToolInputSchema {
  return z
    .object({
      objective: z.string().min(1).max(10_000),
      context: z.string().max(20_000).optional(),
      expectedOutput: z.string().max(2_000).optional(),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(30 * 60_000)
        .optional(),
      syncWaitTimeoutMs: z
        .number()
        .int()
        .positive()
        .max(CALLABLE_AGENT_SYNC_WAIT_MAX_MS)
        .optional(),
    })
    .strict();
}

export function parseCallableAgentManifest(
  raw: string | undefined,
  options: {
    parentTaskId?: string;
    lockedPreset?: boolean;
    hideAuthorityTools?: boolean;
    asyncTaskToolsEnabled?: boolean;
    agentDelegationConfigured?: boolean;
  } = {},
): CallableAgentToolManifestEntry[] {
  if (
    !raw?.trim() ||
    options.parentTaskId ||
    options.lockedPreset ||
    options.hideAuthorityTools ||
    options.asyncTaskToolsEnabled !== true ||
    options.agentDelegationConfigured !== true
  ) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const manifest: CallableAgentToolManifestEntry[] = [];
    for (const value of parsed) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const toolName = typeof entry.toolName === 'string' ? entry.toolName : '';
      const targetAgentId =
        typeof entry.targetAgentId === 'string' ? entry.targetAgentId : '';
      const displayName =
        typeof entry.displayName === 'string' ? entry.displayName : '';
      const persona = entry.persona;
      if (
        !/^[A-Za-z0-9_-]{1,80}$/.test(toolName) ||
        !targetAgentId ||
        targetAgentId.length > 160 ||
        !displayName ||
        displayName.length > 200 ||
        !CALLABLE_AGENT_PERSONAS.includes(persona as CallableAgentPersona) ||
        seen.has(toolName)
      ) {
        continue;
      }
      seen.add(toolName);
      manifest.push({
        toolName,
        targetAgentId,
        displayName,
        persona: persona as CallableAgentPersona,
      });
    }
    return manifest;
  } catch {
    return [];
  }
}
