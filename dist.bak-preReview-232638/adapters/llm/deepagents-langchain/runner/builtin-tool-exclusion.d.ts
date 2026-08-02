import type { AgentMiddleware } from 'langchain';
export declare const READONLY_SKILL_FILESYSTEM_DEEPAGENT_TOOL_NAMES: readonly ["ls", "read_file", "glob", "grep"];
export declare const WRITE_FILESYSTEM_DEEPAGENT_TOOL_NAMES: readonly ["write_file", "edit_file"];
export declare const EXCLUDED_FILESYSTEM_DEEPAGENT_TOOL_NAMES: readonly ["ls", "read_file", "glob", "grep", "write_file", "edit_file"];
export declare const EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES: readonly ["task", "write_todos", "ls", "read_file", "glob", "grep", "write_file", "edit_file"];
export declare const EXCLUDED_ASYNC_SUBAGENT_DEEPAGENT_TOOL_NAMES: readonly ["start_async_task", "check_async_task", "update_async_task", "cancel_async_task", "list_async_tasks"];
export declare const EXCLUDED_RAW_DEEPAGENT_TOOL_NAMES: readonly ["task", "write_todos", "ls", "read_file", "glob", "grep", "write_file", "edit_file", "start_async_task", "check_async_task", "update_async_task", "cancel_async_task", "list_async_tasks"];
export declare function createBuiltinToolExclusionMiddleware(input?: {
    exposeSkillReadTools?: boolean;
}): AgentMiddleware;
