import type { AgentPersona } from '../../../../shared/agent-persona.js';
import type { YoloModeSettings } from '../../../../shared/yolo-mode-policy.js';
import type { PermissionMode } from '../../../../shared/permission-mode.js';
import type { DeepAgentSkillProjection } from '../../../../application/agent-execution/agent-execution-adapter.js';
import type { GantryAgentPromptMode } from '../../../../runner/gantry-agent-system-prompt.js';
import type {
  AgentControlEffort,
  AgentControlThinking,
} from '../../../../domain/types.js';
import type { DeepAgentCheckpointerConfig } from './session-store.js';
import type { DeclarativeToolRule } from '../../../../runner/tool-gate-core.js';

// Subset of the host AgentInput JSON that the DeepAgents (LangChain) runner
// consumes. The runner projects Gantry-owned authority (facade tools and
// canonical Browser) into the graph via the Gantry MCP stdio server; direct
// third-party MCP config stays rejected until Gantry owns a DNS-pinned
// dispatcher/proxy path. Raw DeepAgents authority stays disabled. The runner
// deliberately reads model credential env from modelCredentialEnv
// (gateway-projected) rather than process.env.
export interface DeepAgentRunnerInput {
  prompt: string;
  appId?: string;
  agentId?: string;
  sessionId?: string;
  workspaceFolder: string;
  chatJid: string;
  threadId?: string;
  persona?: AgentPersona;
  // Selected capability tool rules (= host toolPolicyRules). Drives the Gantry
  // facade tool selection and Gantry-owned tool gates.
  allowedTools?: string[];
  toolRules?: DeclarativeToolRule[];
  // Fixed-image worker mode: hide authority-changing/admin request tools.
  hideAuthorityTools?: boolean;
  isScheduledJob?: boolean;
  jobId?: string;
  runId?: string;
  assistantName?: string;
  promptMode?: GantryAgentPromptMode;
  compiledSystemPrompt?: string;
  memoryContextBlock?: string;
  effort?: AgentControlEffort;
  configuredThinking?: AgentControlThinking;
  maxOutputTokens?: number;
  deepAgentCheckpointer?: DeepAgentCheckpointerConfig;
  deepAgentSkills?: DeepAgentSkillProjection;
  modelCredentialEnv?: Record<string, string>;
  toolNetworkEnv?: Record<string, string>;
  // Auto-approve safety valve settings; the neutral gate's denylist backstop
  // runs even though the deepagents lane has no auto-approve surface in v1.
  yoloMode?: YoloModeSettings;
  permissionMode: PermissionMode;
}
