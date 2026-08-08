export interface AutonomousToolDenial {
  toolName: string;
  grantable?: boolean;
  recoveryAction?: string;
}

const STRUCTURED_DENIAL_PREFIX = '\nAutonomousToolDenial: ';

export function isGrantableAutonomousToolRecovery(
  recoveryAction: string | null | undefined,
): boolean {
  if (!recoveryAction?.trim()) return true;
  return (
    recoveryAction.startsWith('request_access ') ||
    recoveryAction.startsWith('request_mcp_server ')
  );
}

export function isHiddenAuthorityAutonomousToolRecovery(
  recoveryAction: string | null | undefined,
): boolean {
  return (
    recoveryAction?.startsWith(
      'Capability request tools are not available in this run (locked or fixed-image agent).',
    ) === true
  );
}

export function formatAutonomousToolDenial(input: {
  toolName: string;
  reason: string;
  grantable: boolean;
  recoveryAction?: string;
}): string {
  const message = [
    `Tool not on autonomous run allowlist: ${input.toolName}.`,
    input.reason,
  ]
    .filter(Boolean)
    .join(' ');
  return `${message}${STRUCTURED_DENIAL_PREFIX}${JSON.stringify({
    grantable: input.grantable,
    ...(input.recoveryAction ? { recoveryAction: input.recoveryAction } : {}),
  })}`;
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
  const sentenceBoundary = findToolRuleSentenceBoundary(afterPrefix);
  const toolName = (
    sentenceBoundary >= 0 ? afterPrefix.slice(0, sentenceBoundary) : afterPrefix
  )
    .trim()
    .replace(/\.$/, '')
    .trim();
  if (!toolName) return null;
  const structuredDenial = parseStructuredDenial(value);
  if (structuredDenial) {
    return { toolName, ...structuredDenial };
  }
  const recoveryMatch = value.match(/Recovery:\s*([\s\S]+)$/i);
  const grantableMatch = value.match(/Grantable:\s*(true|false)\b/i);
  return {
    toolName,
    ...(grantableMatch
      ? { grantable: grantableMatch[1]?.toLowerCase() === 'true' }
      : {}),
    recoveryAction: recoveryMatch?.[1]?.trim(),
  };
}

function parseStructuredDenial(
  value: string,
): Pick<AutonomousToolDenial, 'grantable' | 'recoveryAction'> | null {
  const markerIndex = value.lastIndexOf(STRUCTURED_DENIAL_PREFIX);
  if (markerIndex < 0) return null;
  try {
    const parsed = JSON.parse(
      value.slice(markerIndex + STRUCTURED_DENIAL_PREFIX.length),
    ) as Record<string, unknown>;
    if (typeof parsed.grantable !== 'boolean') return null;
    return {
      grantable: parsed.grantable,
      ...(typeof parsed.recoveryAction === 'string'
        ? { recoveryAction: parsed.recoveryAction }
        : {}),
    };
  } catch {
    return null;
  }
}

function findToolRuleSentenceBoundary(value: string): number {
  let parenthesisDepth = 0;
  let quote: "'" | '"' | '`' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }
    if (
      character === '.' &&
      parenthesisDepth === 0 &&
      /\s/.test(value[index + 1]!)
    ) {
      return index;
    }
  }
  return -1;
}
