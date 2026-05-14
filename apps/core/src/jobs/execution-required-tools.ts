import {
  evaluateRequiredTools,
  missingRequiredToolError,
  type RequiredToolPreflightResult,
} from '../application/jobs/job-required-tools.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';

export async function assertRequiredToolsReadyForRun(input: {
  requiredTools?: readonly string[];
  effectiveAllowedTools: readonly string[];
  emitJobEvent: (
    eventType: RuntimeEventType,
    payload: Record<string, unknown>,
  ) => Promise<void>;
}): Promise<RequiredToolPreflightResult> {
  const preflight = evaluateRequiredTools({
    requiredTools: input.requiredTools ?? [],
    effectiveAllowedTools: input.effectiveAllowedTools,
  });
  await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, {
    phase: 'required_tool_preflight',
    required_tools: preflight.requiredTools,
    missing_required_tools: preflight.missingTools,
    ok: preflight.missingTools.length === 0,
  });
  if (preflight.missingTools.length > 0) {
    const missingTool = preflight.missingTools[0]!;
    await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, {
      phase: 'required_tool_missing',
      tool: missingTool,
      required_tools: preflight.requiredTools,
      missing_required_tools: preflight.missingTools,
      ok: false,
    });
    throw new Error(missingRequiredToolError(missingTool));
  }
  return preflight;
}
