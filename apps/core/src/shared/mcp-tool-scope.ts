export function reviewedMcpToolPatterns(input: {
  allowedToolPatterns?: readonly string[];
  autoApproveToolPatterns?: readonly string[];
}): string[] {
  const allowedToolPatterns = input.allowedToolPatterns ?? [];
  const autoApproveToolPatterns = input.autoApproveToolPatterns ?? [];
  return [
    ...(allowedToolPatterns.length > 0
      ? allowedToolPatterns
      : autoApproveToolPatterns),
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
  if (input.definitionPatterns.length === 0) {
    throw new Error(
      `MCP tool scope cannot be narrowed for ${input.serverName} because the server definition has no reviewed tools.`,
    );
  }
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

export function intersectMcpToolRulesWithSourceScopes(
  toolRules: readonly string[],
  sources: readonly {
    name: string;
    allowedToolPatterns: readonly string[];
  }[],
): string[] {
  const intersections = new Set<string>();
  for (const source of sources) {
    const prefix = `mcp__${source.name}__`;
    for (const rule of toolRules) {
      if (!rule.startsWith(prefix)) continue;
      const authorityPattern = rule.slice(prefix.length);
      if (!authorityPattern) continue;
      if (source.allowedToolPatterns.length === 0) {
        intersections.add(rule);
        continue;
      }
      for (const sourcePattern of source.allowedToolPatterns) {
        const intersection = intersectMcpToolPatterns(
          authorityPattern,
          sourcePattern,
        );
        if (intersection) intersections.add(`${prefix}${intersection}`);
      }
    }
  }
  return [...intersections];
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

function intersectMcpToolPatterns(
  left: string,
  right: string,
): string | undefined {
  if (mcpToolPatternCovers(left, right)) return right;
  if (mcpToolPatternCovers(right, left)) return left;
  return undefined;
}
