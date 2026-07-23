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
  const sentenceBoundary = findToolRuleSentenceBoundary(afterPrefix);
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
