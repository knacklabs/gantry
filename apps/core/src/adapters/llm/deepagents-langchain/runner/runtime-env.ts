import path from 'path';

import { getPermissionTimeoutMs } from '../../../../shared/permission-timeout.js';
import type { PermissionIpcRuntimeEnv } from '../../../../runner/permission-ipc-client.js';

// Neutral runtime-env reader for the DeepAgents runner. Reads the GANTRY_* env
// the host sets in agent-spawn.ts (common to every execution adapter) and builds
// the PermissionIpcRuntimeEnv config the neutral permission-IPC client needs.
// Kept adapter-local (no import of the anthropic runner's env module) so the two
// lanes do not couple.

function readEnv(name: string): string {
  return process.env[name]?.trim() || '';
}

export function resolveWorkspaceIpcDir(agentFolder: string): string {
  const base = readEnv('GANTRY_IPC_DIR');
  if (!base) {
    throw new Error('Missing required environment variable: GANTRY_IPC_DIR');
  }
  return path.join(base, agentFolder);
}

export function buildPermissionIpcRuntimeEnv(): PermissionIpcRuntimeEnv {
  const jobId = readEnv('GANTRY_JOB_ID');
  return {
    appId: readEnv('GANTRY_APP_ID') || 'default',
    agentId: readEnv('GANTRY_AGENT_ID'),
    chatJid: readEnv('GANTRY_CHAT_JID'),
    jobId,
    jobName: readEnv('GANTRY_JOB_NAME'),
    jobRunId: readEnv('GANTRY_JOB_RUN_ID'),
    jobRunLeaseToken: readEnv('GANTRY_JOB_RUN_LEASE_TOKEN'),
    jobRunLeaseFencingVersion: readEnv('GANTRY_JOB_RUN_LEASE_FENCING_VERSION'),
    ipcAuthToken: readEnv('GANTRY_IPC_AUTH_TOKEN'),
    ipcResponseVerifyKey: readEnv('GANTRY_IPC_RESPONSE_VERIFY_KEY'),
    ipcResponseKeyId: readEnv('GANTRY_IPC_RESPONSE_KEY_ID'),
    agentRunHandle: readEnv('GANTRY_AGENT_RUN_HANDLE') || undefined,
    permissionRequestTimeoutMs: getPermissionTimeoutMs(
      jobId ? 'autonomous' : 'interactive',
    ),
    resolveWorkspaceIpcDir,
  };
}
