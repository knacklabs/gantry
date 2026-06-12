import type { AgentPersona } from '../../../../shared/agent-persona.js';

// Subset of the host AgentInput JSON that the DeepAgents (LangChain) runner
// consumes. v1 is tool-less: no tool projection, MCP, HITL, or skills (those are
// later packets), so only the fields needed for a tool-free chat/job turn are
// read. The runner deliberately reads model credential env from
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
  isScheduledJob?: boolean;
  jobId?: string;
  runId?: string;
  assistantName?: string;
  compiledSystemPrompt?: string;
  memoryContextBlock?: string;
  modelCredentialEnv?: Record<string, string>;
}
