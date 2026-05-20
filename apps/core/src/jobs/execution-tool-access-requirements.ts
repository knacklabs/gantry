import {
  evaluateToolAccessRequirements,
  missingToolAccessRequirementError,
  type ToolAccessRequirementPreflightResult,
} from '../application/jobs/job-tool-access-requirements.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';

export async function assertToolAccessRequirementsReadyForRun(input: {
  toolAccessRequirements?: readonly string[];
  effectiveAllowedTools: readonly string[];
  emitJobEvent: (
    eventType: RuntimeEventType,
    payload: Record<string, unknown>,
  ) => Promise<void>;
}): Promise<ToolAccessRequirementPreflightResult> {
  const preflight = evaluateToolAccessRequirements({
    toolAccessRequirements: input.toolAccessRequirements ?? [],
    effectiveAllowedTools: input.effectiveAllowedTools,
  });
  await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, {
    phase: 'tool_access_preflight',
    tool_access_requirements: preflight.toolAccessRequirements,
    missing_tool_access_requirements: preflight.missingTools,
    ok: preflight.missingTools.length === 0,
  });
  if (preflight.missingTools.length > 0) {
    const missingTool = preflight.missingTools[0]!;
    await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, {
      phase: 'tool_access_missing',
      tool: missingTool,
      tool_access_requirements: preflight.toolAccessRequirements,
      missing_tool_access_requirements: preflight.missingTools,
      ok: false,
    });
    throw new Error(missingToolAccessRequirementError(missingTool));
  }
  return preflight;
}
