import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import type { Job } from '../domain/types.js';
import { splitAccessRequirements } from '../application/jobs/job-access-requirements.js';
import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import { nowMs } from '../shared/time/datetime.js';
import { getProfile } from '../runtime/browser-profiles.js';
import {
  isBrowserProfileSyncEnabled,
  snapshotBrowserProfile,
} from '../runtime/browser-profile-sync.js';
import {
  type JobRunDiagnostics,
  toolAccessRequirementsIncludeBrowser,
} from './execution-diagnostics.js';
import type { SchedulerDependencies } from './types.js';

export async function closeBrowserAfterJobRun(input: {
  currentJob: Job;
  executionGroupFolder?: string;
  executionJid?: string;
  diagnostics: JobRunDiagnostics;
  deps: SchedulerDependencies;
  snapshotRunId?: string | null;
  snapshotFencingVersion?: number;
  emitJobEvent: (
    eventType: RuntimeEventType,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  logger: { warn: (context: Record<string, unknown>, message: string) => void };
}): Promise<void> {
  if (!input.executionGroupFolder || !input.executionJid) return;
  const usedBrowser =
    input.diagnostics.browserActivityCount > 0 ||
    toolAccessRequirementsIncludeBrowser(
      splitAccessRequirements(input.currentJob.access_requirements)
        .toolAccessRequirements,
    );
  if (!usedBrowser) return;
  if (!input.deps.closeBrowserSession && !input.deps.closeBrowserToolBackends)
    return;

  const profileName = resolveConversationBrowserProfile({
    agentId: input.executionGroupFolder,
    workspaceKey: input.executionGroupFolder,
    conversationId: input.executionJid,
  });
  const startedAt = nowMs();

  try {
    await input.deps.closeBrowserToolBackends?.(profileName);
    const closed = await input.deps.closeBrowserSession?.(profileName);
    await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, {
      phase: 'browser_cleanup',
      tool: 'Browser',
      profile_name: profileName,
      ok: closed ? closed.closed : true,
      reason: closed?.reason ?? null,
      elapsed_ms: closed?.elapsedMs ?? Math.max(0, nowMs() - startedAt),
    });
    // Snapshot AFTER close so the bytes are quiescent. Only the job actually
    // used the browser this turn (guarded above). Cheap no-op when sync is
    // disabled (workstation) or the profile state is unchanged.
    if (
      input.diagnostics.browserActivityCount > 0 &&
      isBrowserProfileSyncEnabled()
    ) {
      const profile = getProfile(profileName);
      if (profile) {
        await snapshotBrowserProfile({
          profileName,
          profileDir: profile.dir,
          userDataDir: profile.userDataDir,
          snapshotRunId: input.snapshotRunId ?? null,
          snapshotFencingVersion: input.snapshotFencingVersion ?? 0,
        });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    input.logger.warn(
      { err, jobId: input.currentJob.id, profileName },
      'Failed to close scheduled job browser profile after run',
    );
    await input.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY, {
      phase: 'browser_cleanup',
      tool: 'Browser',
      profile_name: profileName,
      ok: false,
      error,
      elapsed_ms: Math.max(0, nowMs() - startedAt),
    });
  }
}
