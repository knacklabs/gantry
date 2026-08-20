import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import type { Job } from '../domain/types.js';
import { skillActionSource } from '../domain/skills/skill-action-permissions.js';
import { setupStateForBrowserPrelaunchFailure } from '../application/jobs/job-readiness-service.js';
import { splitAccessRequirements } from '../application/jobs/job-access-requirements.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import { nowMs } from '../shared/time/datetime.js';
import {
  type JobRunDiagnostics,
  toolAccessRequirementsIncludeBrowser,
  updateDiagnosticsFromRuntimeEvent,
} from './execution-diagnostics.js';
import type { SchedulerDependencies } from './types.js';
import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';

export async function prelaunchBrowserForJobRun(input: {
  currentJob: Job;
  semanticCapabilities?: readonly SemanticCapabilityDefinition[];
  executionGroupFolder?: string;
  executionJid?: string;
  executionProviderAccountId?: string;
  diagnostics: JobRunDiagnostics;
  deps: SchedulerDependencies;
  emitJobEvent: (
    eventType: RuntimeEventType,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  logger: { warn: (context: Record<string, unknown>, message: string) => void };
}): Promise<{
  error: string;
  setupState: NonNullable<Job['setup_state']>;
} | null> {
  if (!input.executionGroupFolder || !input.executionJid) return null;
  if (!jobRequiresManagedBrowser(input.currentJob, input.semanticCapabilities))
    return null;
  if (!input.deps.openBrowserSession) return null;

  const profileName = resolveConversationBrowserProfile({
    agentId: input.executionGroupFolder,
    workspaceKey: input.executionGroupFolder,
    conversationId: input.executionJid,
    // Same resolver as the live-turn path: a job MUST land on the same profile
    // as the chat it belongs to, or it loses the login established there.
    // The route CAPTURED at execution start, not a fresh lookup: routes are
    // mutable, so re-resolving here would let a mid-run reassignment send
    // cleanup to a different profile than prelaunch opened — closing the wrong
    // browser and leaking the one the job actually launched.
    providerAccountId: input.executionProviderAccountId ?? null,
  });
  const startedAt = nowMs();

  try {
    const status = await input.deps.openBrowserSession(profileName);
    const payload = {
      phase: 'browser_prelaunch',
      tool: 'Browser',
      public_tool: 'browser_open',
      action: 'open',
      profile_name: profileName,
      ok: status.running === true && status.cdpReady === true,
      pid: status.pid ?? null,
      port: status.port ?? null,
      elapsed_ms: Math.max(0, nowMs() - startedAt),
    };
    updateDiagnosticsFromRuntimeEvent(
      input.diagnostics,
      RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      payload,
    );
    await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, payload);
    return payload.ok
      ? null
      : {
          error: 'Setup required: Browser did not become ready.',
          setupState: setupStateForBrowserPrelaunchFailure({
            previous: input.currentJob.setup_state,
          }),
        };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    input.logger.warn(
      { err, jobId: input.currentJob.id, profileName },
      'Failed to prelaunch scheduled job browser profile',
    );
    const payload = {
      phase: 'browser_prelaunch',
      tool: 'Browser',
      public_tool: 'browser_open',
      action: 'open',
      profile_name: profileName,
      ok: false,
      error,
      elapsed_ms: Math.max(0, nowMs() - startedAt),
    };
    await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, payload);
    return {
      error: `Setup required: Browser launch failed: ${error}`,
      setupState: setupStateForBrowserPrelaunchFailure({
        previous: input.currentJob.setup_state,
      }),
    };
  }
}

/**
 * A reviewed skill action can need a managed browser profile without granting
 * the model the interactive Browser capability. This lets deterministic
 * Playwright actions own page control while Gantry still launches the scoped,
 * persisted profile for them.
 */
export function jobRequiresManagedBrowser(
  job: Job,
  semanticCapabilities: readonly SemanticCapabilityDefinition[] = [],
): boolean {
  const requirements = splitAccessRequirements(job.access_requirements);
  if (
    toolAccessRequirementsIncludeBrowser(requirements.toolAccessRequirements)
  ) {
    return true;
  }
  return requirements.capabilityRequirements.some((requirement) => {
    const capability = semanticCapabilities.find(
      (candidate) => candidate.capabilityId === requirement.capabilityId,
    );
    return (
      capability !== undefined &&
      skillActionSource(capability)?.browserAccess === 'managed_browser'
    );
  });
}
