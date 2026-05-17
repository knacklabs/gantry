export interface AutonomousToolDenial {
  toolName: string;
  recoveryAction?: string;
}

export function parseAutonomousToolDenial(
  value: string | null | undefined,
): AutonomousToolDenial | null {
  if (!value) return null;
  const toolMatch = value.match(
    /Tool not on autonomous (?:run|job) allowlist:\s*([^.\s]+)/i,
  );
  if (!toolMatch?.[1]) return null;
  const recoveryMatch = value.match(/Recovery:\s*([\s\S]+)$/i);
  return {
    toolName: toolMatch[1],
    recoveryAction: recoveryMatch?.[1]?.trim(),
  };
}
