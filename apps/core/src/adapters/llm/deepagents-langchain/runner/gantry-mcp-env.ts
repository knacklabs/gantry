import {
  GATED_GANTRY_MCP_TOOL_NAMES,
  selectedGantryMcpToolNames,
  selectedMemoryIpcActions,
} from '../../../../runner/gantry-mcp-tool-surface.js';
import { isCanonicalBrowserCapabilityRule } from '../../../../shared/agent-tool-references.js';

const BROWSER_GATEWAY_TOOL_NAME_SET = new Set<string>(
  GATED_GANTRY_MCP_TOOL_NAMES,
);

// Builds the environment block the DeepAgents runner passes to the Gantry facade
// MCP stdio server (apps/core/src/runner/mcp/stdio.js) when it spawns it through
// MultiServerMCPClient. This mirrors the Anthropic lane's `gantryMcpProvider`
// env block, but the runner is the one spawning the server here, so the values
// come from the runner's own process.env (set by the host in agent-spawn.ts)
// plus the per-run configured tool selection from the agent input. Reuses the
// shared gantry-mcp-tool-surface selection helpers so both lanes project the
// identical tool/memory-action surface.

export interface GantryMcpEnvInput {
  configuredAllowedTools: readonly string[];
  hideAuthorityTools: boolean;
  memoryBlock?: string;
  processEnv: NodeJS.ProcessEnv;
}

export interface GantryMcpProjection {
  // Env block for the spawned Gantry MCP stdio server.
  env: Record<string, string>;
  // Bare gantry tool names selected for this run (e.g. send_message,
  // browser_open). Used to filter the LangChain tools the model can reach.
  selectedToolNames: string[];
  // True only when the host enabled browser IPC for this run (browser gateway
  // tools must not be reachable otherwise).
  browserIpcEnabled: boolean;
  asyncTaskToolsEnabled: boolean;
}

export function buildGantryMcpProjection(
  input: GantryMcpEnvInput,
): GantryMcpProjection {
  const env = input.processEnv;
  const memoryReviewerIsControlApprover =
    env.GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER === '1';
  const browserIpcEnabled =
    Boolean(env.GANTRY_BROWSER_IPC_AUTH_TOKEN?.trim()) &&
    input.configuredAllowedTools.some(isCanonicalBrowserCapabilityRule);
  const asyncTaskToolsEnabled = env.GANTRY_ASYNC_TASK_TOOLS_ENABLED === '1';

  const selectedToolNamesBase = selectedGantryMcpToolNames(
    input.configuredAllowedTools,
    {
      excludeAuthorityTools: input.hideAuthorityTools,
      memoryReviewerIsControlApprover,
      asyncTaskToolsEnabled,
    },
  );
  // Browser gateway tools (browser_*) are reachable only when the host enabled
  // browser IPC AND the agent selected the canonical Browser capability. The
  // tool-surface selection adds them whenever Browser is selected, so strip them
  // back out here when the host did not provide the browser IPC token — this
  // mirrors the anthropic lane, which only mounts those tools under that token.
  const selectedToolNames = browserIpcEnabled
    ? selectedToolNamesBase
    : selectedToolNamesBase.filter(
        (toolName) => !BROWSER_GATEWAY_TOOL_NAME_SET.has(toolName),
      );

  const memoryIpcActions = selectedMemoryIpcActions(
    input.configuredAllowedTools,
    { memoryReviewerIsControlApprover },
  );

  const serverEnv: Record<string, string> = {
    ...passthrough(env, 'GANTRY_IPC_DIR'),
    ...passthrough(env, 'GANTRY_IPC_AUTH_TOKEN'),
    ...passthrough(env, 'GANTRY_IPC_RESPONSE_VERIFY_KEY'),
    ...passthrough(env, 'GANTRY_IPC_RESPONSE_KEY_ID'),
    ...passthrough(env, 'GANTRY_APP_ID'),
    ...passthrough(env, 'GANTRY_AGENT_ID'),
    ...passthrough(env, 'GANTRY_AGENT_RUN_HANDLE'),
    ...passthrough(env, 'GANTRY_CHAT_JID'),
    ...passthrough(env, 'GANTRY_WORKSPACE_KEY'),
    ...passthrough(env, 'GANTRY_THREAD_ID'),
    ...passthrough(env, 'GANTRY_JOB_ID'),
    ...passthrough(env, 'GANTRY_JOB_NAME'),
    ...passthrough(env, 'GANTRY_JOB_RUN_ID'),
    ...passthrough(env, 'GANTRY_PARENT_TASK_ID'),
    ...passthrough(env, 'GANTRY_JOB_RUN_LEASE_TOKEN'),
    ...passthrough(env, 'GANTRY_JOB_RUN_LEASE_FENCING_VERSION'),
    ...passthrough(env, 'GANTRY_LIVE_STOP_ACTION_TOKEN'),
    ...passthrough(env, 'GANTRY_MEMORY_USER_ID'),
    ...passthrough(env, 'GANTRY_MEMORY_DEFAULT_SCOPE'),
    ...passthrough(env, 'GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER'),
    ...(env.GANTRY_ASYNC_TASK_TOOLS_ENABLED === '1' && input.memoryBlock
      ? { GANTRY_MEMORY_CONTEXT_BLOCK: input.memoryBlock }
      : {}),
    ...passthrough(env, 'GANTRY_MEMORY_IPC_AUTH_TOKEN'),
    ...passthrough(env, 'GANTRY_BROWSER_PROFILE_NAME'),
    ...passthrough(env, 'GANTRY_AGENT_ACCESS_PRESET'),
    ...passthrough(env, 'GANTRY_DEPLOYMENT_MODE'),
    ...passthrough(env, 'GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS'),
    ...passthrough(env, 'GANTRY_PERMISSION_TIMEOUT_MS'),
    ...passthrough(env, 'GANTRY_ASYNC_TASK_TOOLS_ENABLED'),
    GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON: JSON.stringify(
      input.configuredAllowedTools,
    ),
    GANTRY_MCP_TOOL_NAMES_JSON: JSON.stringify(selectedToolNames),
    GANTRY_MEMORY_IPC_ACTIONS_JSON: JSON.stringify(memoryIpcActions),
    GANTRY_SELECTED_SKILLS_JSON: env.GANTRY_SELECTED_SKILLS_JSON ?? '[]',
    GANTRY_SELECTED_SKILL_DISPLAYS_JSON:
      env.GANTRY_SELECTED_SKILL_DISPLAYS_JSON ?? '[]',
    GANTRY_SELECTED_MCP_SERVERS_JSON:
      env.GANTRY_SELECTED_MCP_SERVERS_JSON ?? '[]',
    GANTRY_SEMANTIC_CAPABILITIES_JSON:
      env.GANTRY_SEMANTIC_CAPABILITIES_JSON ?? '[]',
    GANTRY_ADMIN_MCP_TOOLS_JSON: env.GANTRY_ADMIN_MCP_TOOLS_JSON ?? '[]',
  };

  // Browser gateway tools are reachable only when the host enabled browser IPC
  // AND the agent selected the canonical Browser capability — mirror the
  // anthropic lane, which only passes GANTRY_BROWSER_IPC_AUTH_TOKEN under the
  // same condition.
  if (browserIpcEnabled && env.GANTRY_BROWSER_IPC_AUTH_TOKEN) {
    serverEnv.GANTRY_BROWSER_IPC_AUTH_TOKEN = env.GANTRY_BROWSER_IPC_AUTH_TOKEN;
  }

  return {
    env: serverEnv,
    selectedToolNames,
    browserIpcEnabled,
    asyncTaskToolsEnabled,
  };
}

function passthrough(
  env: NodeJS.ProcessEnv,
  key: string,
): Record<string, string> {
  const value = env[key];
  return typeof value === 'string' ? { [key]: value } : {};
}
