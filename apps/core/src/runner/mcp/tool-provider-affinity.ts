export const TOOL_PROVIDER_AFFINITY_BY_JID_PREFIX = {
  'sl:': ['canvas_read', 'canvas_create', 'canvas_update'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const AFFINITY_TOOL_NAMES = new Set<string>(
  Object.values(TOOL_PROVIDER_AFFINITY_BY_JID_PREFIX).flat(),
);

// Provider affinity is a final projection constraint, not another source of
// tool authority. Apply it after explicit configuration so a configured tool
// remains unavailable when the conversation JID has no matching prefix.
export function applyProviderAffinity(
  names: Iterable<string>,
  chatJid: string | undefined,
): Set<string> {
  const filtered = new Set(names);
  const allowedAffinityTools = new Set<string>();

  for (const [jidPrefix, toolNames] of Object.entries(
    TOOL_PROVIDER_AFFINITY_BY_JID_PREFIX,
  )) {
    if (!chatJid?.startsWith(jidPrefix)) continue;
    for (const toolName of toolNames) allowedAffinityTools.add(toolName);
  }

  for (const projectedName of filtered) {
    const toolName = projectedName.startsWith('mcp__gantry__')
      ? projectedName.slice('mcp__gantry__'.length)
      : projectedName;
    if (
      AFFINITY_TOOL_NAMES.has(toolName) &&
      !allowedAffinityTools.has(toolName)
    ) {
      filtered.delete(projectedName);
    }
  }

  return filtered;
}
