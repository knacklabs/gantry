import type { AgentPersona } from '../../../../shared/agent-persona.js';
import type { YoloModeSettings } from '../../../../shared/yolo-mode-policy.js';

// Subset of the host AgentInput JSON that the DeepAgents (LangChain) runner
// consumes. The runner projects Gantry-owned authority (facade tools, selected
// third-party MCP servers, canonical Browser) into the graph via the Gantry MCP
// stdio server and the neutral permission gate; raw DeepAgents authority stays
// disabled. The runner deliberately reads model credential env from
// modelCredentialEnv (gateway-projected) rather than process.env.
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
  // facade tool selection and the third-party MCP permission gate.
  allowedTools?: string[];
  // Fixed-image worker mode: hide authority-changing/admin request tools.
  hideAuthorityTools?: boolean;
  isScheduledJob?: boolean;
  jobId?: string;
  runId?: string;
  assistantName?: string;
  compiledSystemPrompt?: string;
  memoryContextBlock?: string;
  modelCredentialEnv?: Record<string, string>;
  // Auto-approve safety valve settings; the neutral gate's denylist backstop
  // runs even though the deepagents lane has no auto-approve surface in v1.
  yoloMode?: YoloModeSettings;
}
