// Canonical native (agent-SDK built-in) tool-name vocabulary, in the `shared`
// layer so config (settings validation) and adapters (capability composition)
// share one source of truth — mirroring `shared/gantry-mcp-tool-catalog`. Names
// and pure predicates only; the SDK tool wiring stays in the adapter.

export const SAFE_NATIVE_SDK_TOOLS = [
  'Agent',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'Skill',
] as const;

export const DEVELOPER_NATIVE_SDK_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export const PERMISSION_GATED_NATIVE_SDK_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'LS',
  'MultiEdit',
  'NotebookEdit',
] as const;

export const AVAILABLE_NATIVE_SDK_TOOLS = [
  ...DEVELOPER_NATIVE_SDK_TOOLS,
  ...PERMISSION_GATED_NATIVE_SDK_TOOLS,
  ...SAFE_NATIVE_SDK_TOOLS,
] as const;

const AVAILABLE_NATIVE_SDK_TOOL_SET = new Set<string>(
  AVAILABLE_NATIVE_SDK_TOOLS,
);

/**
 * A native tool name a per-agent `tool_surface.native` keep-list may reference.
 * (The unsupported-builtins denylist is adapter-internal and not restrictable.)
 */
export function isAvailableNativeSdkTool(name: string): boolean {
  return AVAILABLE_NATIVE_SDK_TOOL_SET.has(name);
}
