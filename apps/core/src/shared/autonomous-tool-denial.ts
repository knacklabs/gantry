export interface AutonomousToolDenial {
  toolName: string;
  recoveryAction?: string;
}

export function parseAutonomousToolDenial(
  value: string | null | undefined,
): AutonomousToolDenial | null {
  if (!value) return null;
  const prefixMatch = value.match(
    /Tool not on autonomous (?:run|job) allowlist:\s*/i,
  );
  if (!prefixMatch || prefixMatch.index === undefined) return null;
  const afterPrefix = value.slice(prefixMatch.index + prefixMatch[0].length);
  const recoveryBoundary = afterPrefix.search(/\.\s*Recovery:/i);
  const sentenceBoundary =
    recoveryBoundary >= 0 ? recoveryBoundary : afterPrefix.search(/\.\s/);
  const toolName = (
    sentenceBoundary >= 0 ? afterPrefix.slice(0, sentenceBoundary) : afterPrefix
  )
    .trim()
    .replace(/\.$/, '')
    .trim();
  if (!toolName) return null;
  const recoveryMatch = value.match(/Recovery:\s*([\s\S]+)$/i);
  return {
    toolName,
    recoveryAction: recoveryMatch?.[1]?.trim(),
  };
}
