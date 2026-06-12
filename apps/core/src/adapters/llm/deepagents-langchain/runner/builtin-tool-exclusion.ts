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
//   - `write_todos` mutates DeepAgents in-state todos, which are non-durable
//     scratch state Gantry does not own; hiding it keeps the surface minimal.
//   - the six filesystem tools (ls/read_file/write_file/edit_file/glob/grep) are
//     already hard-denied at runtime by the deny-all `permissions` block in
//     deep-agent-runner.ts (DENY_ALL_FILESYSTEM). Leaving them model-VISIBLE
//     means every call burns a turn on a guaranteed deny, so we also strip them
//     from the tool list. The deny-all block stays as a defense-in-depth
//     backstop in case the model-visible surface ever regains one of them.
// This only removes the tools from the model-visible tool list; it does not
// remove the baked-in middleware, so no DeepAgents internal invariant breaks.

// The DeepAgents built-in filesystem tool names (deny-all'd at runtime; also
// excluded from the model-visible surface so they never burn a turn).
export const EXCLUDED_FILESYSTEM_DEEPAGENT_TOOL_NAMES = [
  'ls',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
] as const;

export const EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES = [
  'task',
  'write_todos',
  ...EXCLUDED_FILESYSTEM_DEEPAGENT_TOOL_NAMES,
] as const;

const EXCLUDED_SET = new Set<string>(EXCLUDED_BUILTIN_DEEPAGENT_TOOL_NAMES);

export function createBuiltinToolExclusionMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: 'GantryBuiltinToolExclusionMiddleware',
    wrapModelCall: async (request, handler) => {
      const tools = (request as { tools?: Array<{ name?: unknown }> }).tools;
      if (!Array.isArray(tools)) return handler(request);
      return handler({
        ...request,
        tools: tools.filter(
          (tool) =>
            typeof tool?.name !== 'string' || !EXCLUDED_SET.has(tool.name),
        ),
      });
    },
  }) as AgentMiddleware;
}
