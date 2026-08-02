import type { AgentRuntime } from '../shared/agent-runtime.js';
export declare const IPC_WORKSPACE_SUBDIRS: readonly ["messages", "tasks", "input", "memory-requests", "memory-responses", "browser-requests", "browser-responses", "permission-requests", "permission-cancellations", "permission-responses", "question-cancellations", "rich-interactions", "interaction-boundaries", "user-questions", "user-answers", "task-responses"];
export declare function getHostAgentRunnerDistDir(): string;
export declare function ensureWorkspaceIpcLayout(workspaceIpcDir: string, runtime?: AgentRuntime): void;
