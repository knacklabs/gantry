export function reviewedMcpToolPatterns(input: {
  allowedToolPatterns: readonly string[];
  autoApproveToolPatterns: readonly string[];
}): string[] {
  return [
    ...(input.allowedToolPatterns.length > 0
      ? input.allowedToolPatterns
      : input.autoApproveToolPatterns),
  ];
}

export function normalizeMcpToolScope(input: {
  serverName: string;
  requested: readonly string[] | undefined;
  definitionPatterns: readonly string[];
}): string[] {
  const requested = [
    ...new Set((input.requested ?? []).map((p) => p.trim()).filter(Boolean)),
  ];
  if (requested.length === 0) return [];
  for (const pattern of requested) {
    const covered = input.definitionPatterns.some(
      (allowed) =>
        allowed === pattern ||
        (allowed.endsWith('*') && pattern.startsWith(allowed.slice(0, -1))),
    );
    if (!covered) {
      throw new Error(
        `MCP tool scope ${pattern} is not within the reviewed tools for ${input.serverName}.`,
      );
    }
  }
  return requested;
}

export function filterMcpToolNamesBySourceScopes(
  toolNames: readonly string[],
  sources: readonly {
    name: string;
    allowedToolPatterns: readonly string[];
  }[],
): string[] {
  return toolNames.filter((toolName) =>
    sources.some((source) =>
      mcpToolNameAllowedBySourceScope({
        serverName: source.name,
        fullToolName: toolName,
        allowedToolPatterns: source.allowedToolPatterns,
      }),
    ),
  );
}

export function mcpToolNameAllowedBySourceScope(input: {
  serverName: string;
  fullToolName: string;
  allowedToolPatterns: readonly string[];
}): boolean {
  const prefix = `mcp__${input.serverName}__`;
  if (!input.fullToolName.startsWith(prefix)) return false;
  if (input.allowedToolPatterns.length === 0) return true;
  const toolName = input.fullToolName.slice(prefix.length);
  return input.allowedToolPatterns.some((pattern) =>
    mcpToolPatternCovers(pattern, toolName),
  );
}

export function mcpToolPatternCovers(
  pattern: string,
  candidate: string,
): boolean {
  return (
    pattern === candidate ||
    pattern === '*' ||
    (pattern.endsWith('*') && candidate.startsWith(pattern.slice(0, -1)))
  );
}
