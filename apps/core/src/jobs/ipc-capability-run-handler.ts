import {
  closeEgressGateway,
  ensureEgressGateway,
} from '../runtime/egress-gateway.js';
import { permissionRunRestriction } from '../runtime/permission-decision-coordinator.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import { buildAsyncCommandEnv } from './async-command-sandbox-runner.js';
import {
  runStructuredLocalCliCapability,
  StructuredLocalCliInvocationError,
} from './structured-local-cli-invocation.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';

const capabilityRunHandler: TaskHandler = async (context) => {
  const { data } = context;
  // Anchor the end-to-end host deadline at handler ENTRY, so gateway/policy/
  // executable setup all count against the budget against the MCP caller's
  // 125s response timeout (capability-run.ts). Held as an absolute time; the
  // sandbox abort timer below is armed with whatever budget remains after
  // setup, and the pre-spawn abort check refuses to launch once it is spent.
  const deadlineAt = Date.now() + 118_000;
  const { acceptData, reject } = createTaskResponder(
    context.sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const payload = data.payload;
  const capabilityId = toTrimmedString(payload?.capabilityId, { maxLen: 255 });
  const rawArgs = payload?.args;
  const args = Array.isArray(rawArgs)
    ? rawArgs.filter((arg): arg is string => typeof arg === 'string')
    : null;
  if (
    !capabilityId ||
    !args ||
    !Array.isArray(rawArgs) ||
    args.length !== rawArgs.length
  ) {
    reject(
      'capability_run requires capabilityId and a string args array.',
      'invalid_args',
    );
    return;
  }
  if (!data.appId || !data.agentId || !data.responseKeyId) {
    reject(
      'Capability invocation authority is incomplete.',
      'permission_denied',
    );
    return;
  }
  const restriction = permissionRunRestriction({
    sourceAgentFolder: context.sourceAgentFolder,
    responseKeyId: data.responseKeyId,
  });
  if (
    !restriction ||
    data.sourceRunKind !== restriction.runKind ||
    data.sourceJobId !== restriction.jobId ||
    data.sourceRunId !== restriction.runId
  ) {
    reject(
      'Capability invocation source could not be verified.',
      'permission_denied',
    );
    return;
  }
  if (!data.chatJid || !context.sourceAgentFolderJids.includes(data.chatJid)) {
    reject(
      'Capability invocation conversation is outside this run.',
      'permission_denied',
    );
    return;
  }
  const repository = context.deps.getToolRepository?.();
  const runnerSandboxProvider = context.deps.runnerSandboxProvider;
  if (!repository || !runnerSandboxProvider) {
    reject(
      'Capability execution is not available on this host.',
      'executor_unavailable',
    );
    return;
  }

  const gateway = await ensureEgressGateway({
    key: `capability-run:${context.sourceAgentFolder}:${data.taskId ?? 'unknown'}`,
    settings: context.deps.getEgressSettings?.() ?? { denylist: [] },
    principal: {
      appId: data.appId,
      agentId: data.agentId,
      conversationId: data.chatJid,
      threadId: data.authThreadId,
      runId: restriction.runId,
      jobId: restriction.jobId,
    },
    ...(context.deps.publishRuntimeEvent
      ? { publishRuntimeEvent: context.deps.publishRuntimeEvent }
      : {}),
  });
  // Arm the sandbox-abort timer with the budget remaining after setup. If
  // setup already consumed it (0), the pre-spawn abort check refuses to launch.
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(),
    Math.max(0, deadlineAt - Date.now()),
  );
  try {
    const result = await runStructuredLocalCliCapability({
      repository,
      appId: data.appId,
      agentId: data.agentId,
      personId: restriction.memoryUserId,
      capabilityId,
      args,
      cwd: resolveWorkspaceFolderPath(context.sourceAgentFolder),
      env: buildAsyncCommandEnv(),
      runnerSandboxProvider,
      egressProxyUrl: gateway.proxyUrl,
      signal: deadline.signal,
      conversationId: data.chatJid,
      threadId: data.authThreadId,
      runId: restriction.runId,
      jobId: restriction.jobId,
    });
    acceptData('Capability command completed.', result);
  } catch (error) {
    if (error instanceof StructuredLocalCliInvocationError) {
      reject(error.message, error.code);
      return;
    }
    reject(
      error instanceof Error ? error.message : 'Capability execution failed.',
      'execution_failed',
    );
  } finally {
    clearTimeout(deadlineTimer);
    await closeEgressGateway(gateway);
  }
};

export const capabilityRunTaskHandlers: Record<string, TaskHandler> = {
  capability_run: capabilityRunHandler,
};
