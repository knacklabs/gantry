import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

// DeepAgents 1.10.2 always bakes the `write_todos` (todo list) middleware, the
// `task` (subagent spawner) middleware, and the filesystem tools
// (ls/read_file/write_file/edit_file/glob/grep) into the graph at
// createDeepAgent time (see node_modules/deepagents/dist/index.cjs
// `createDeepAgent`, lines ~8188-8208). There is NO config switch to omit them.
// createDeepAgent itself uses exactly this pattern to drop tools it wants
// excluded (its private `_ToolExclusionMiddleware`): a wrapModelCall middleware
// that filters `request.tools` before the model sees them. We append our own via
// the public `middleware` param so the model can never call them:
//   - `task` would otherwise spawn a sub-run; excluding it from the reachable
//     tool list is the v1 SAFEST option (the sub-run would inherit the same
//     restricted toolset anyway, but Gantry has not policy-reviewed sub-run
//     spawning, so it must not be reachable).
//   - DeepAgents async-subagent middleware exposes start/check/update/cancel/list
//     tools when async subagents are configured. Those are not part of the
//     always-baked default stack, but they are raw provider delegation authority
//     and must stay hidden until Gantry owns the durable task lifecycle wrapper.
//   - `write_todos` mutates DeepAgents in-state todos, which are non-durable
//     scratch state Gantry does not own; hiding it keeps the surface minimal.
//   - the filesystem write tools (write_file/edit_file) are always hidden.
//     Read-only filesystem tools (ls/read_file/glob/grep) are hidden unless the
//     host projected reviewed selected skills into the DeepAgents StateBackend
//     under virtual `/skills/**`; in that case deep-agent-runner.ts switches to
//     read-only skill permissions so progressive disclosure can read SKILL.md.
// This only removes the tools from the model-visible tool list; it does not
// remove the baked-in middleware, so no DeepAgents internal invariant breaks.

export const READONLY_SKILL_FILESYSTEM_DEEPAGENT_TOOL_NAMES = [
  'ls',
  'read_file',
  'glob',
  'grep',
] as const;

export const WRITE_FILESYSTEM_DEEPAGENT_TOOL_NAMES = [
  'write_file',
  'edit_file',
] as const;

// The DeepAgents built-in filesystem tool names.
export const EXCLUDED_FILESYSTEM_DEEPAGENT_TOOL_NAMES = [
  ...READONLY_SKILL_FILESYSTEM_DEEPAGENT_TOOL_NAMES,
  ...WRITE_FILESYSTEM_DEEPAGENT_TOOL_NAMES,
] as const;

export const EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES = [
  'task',
  'write_todos',
  ...EXCLUDED_FILESYSTEM_DEEPAGENT_TOOL_NAMES,
] as const;

export const EXCLUDED_ASYNC_SUBAGENT_DEEPAGENT_TOOL_NAMES = [
  'start_async_task',
  'check_async_task',
  'update_async_task',
  'cancel_async_task',
  'list_async_tasks',
] as const;

export const EXCLUDED_RAW_DEEPAGENT_TOOL_NAMES = [
  ...EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES,
  ...EXCLUDED_ASYNC_SUBAGENT_DEEPAGENT_TOOL_NAMES,
] as const;

const EXCLUDED_SET = new Set<string>(EXCLUDED_RAW_DEEPAGENT_TOOL_NAMES);
const SKILL_READ_TOOL_SET = new Set<string>(
  READONLY_SKILL_FILESYSTEM_DEEPAGENT_TOOL_NAMES,
);

export function createBuiltinToolExclusionMiddleware(input?: {
  exposeSkillReadTools?: boolean;
}): AgentMiddleware {
  const excluded = input?.exposeSkillReadTools
    ? new Set(
        [...EXCLUDED_SET].filter((name) => !SKILL_READ_TOOL_SET.has(name)),
      )
    : EXCLUDED_SET;
  return createMiddleware({
    name: 'GantryBuiltinToolExclusionMiddleware',
    wrapModelCall: async (request, handler) => {
      const tools = (request as { tools?: Array<{ name?: unknown }> }).tools;
      if (!Array.isArray(tools)) return handler(request);
      return handler({
        ...request,
        tools: tools.filter(
          (tool) => typeof tool?.name !== 'string' || !excluded.has(tool.name),
        ),
      });
    },
  }) as AgentMiddleware;
}
