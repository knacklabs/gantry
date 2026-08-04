export function formatAvailableNowMessage(input: {
  action: string;
  noun: string;
  name: string;
  requiredEnvVars?: readonly string[];
}): string {
  const ready = `${input.action} ${input.noun} ${input.name}. It is available now.`;
  const secretLines = formatDeclaredGantrySecretLines(
    input.requiredEnvVars ?? [],
    `This ${input.noun}`,
  );
  return secretLines.length > 0 ? [ready, ...secretLines].join('\n') : ready;
}

export function formatDeclaredGantrySecretLines(
  names: readonly string[],
  subject = 'This capability',
): string[] {
  const unique = uniqueNames(names);
  if (unique.length === 0) return [];
  return [
    `${subject} needs ${unique.length === 1 ? 'a credential' : 'credentials'} before it can be used. Add ${unique.length === 1 ? 'it' : 'them'} in Credential Center.`,
  ];
}

export function formatMissingGantrySecretsMessage(
  names: readonly string[],
): string {
  const unique = uniqueNames(names);
  return unique.length > 1
    ? 'Gantry credentials are required before this can run. Add them in Credential Center, then try again.'
    : 'A Gantry credential is required before this can run. Add it in Credential Center, then try again.';
}

export function formatApprovalRequestedMessage(displayName: string): string {
  return `Approval requested for ${displayName}. An approver can allow it from this conversation.`;
}

export function formatNotApprovedMessage(input: {
  action: string;
  noun: string;
  name: string;
  reason?: string | null;
}): string {
  const reason = input.reason?.trim() || 'not approved';
  return `Did not ${input.action} ${input.noun} ${input.name}: ${reason}.`;
}

export function humanizeTechnicalIdentifier(value: string | undefined): string {
  return (value ?? 'required access')
    .replace(/^capability:/, '')
    .replace(/^mcp__gantry__browser_[A-Za-z0-9_-]+$/, 'Browser')
    .replace(/^mcp__gantry__/, 'Gantry ')
    .replace(/^mcp__([^_]+)__.*/, '$1 MCP')
    .replace(/^mcp:/, '')
    .replaceAll(/[._:-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function uniqueNames(names: readonly string[]): string[] {
  return [
    ...new Set(
      names.map((name) => name.trim()).filter((name) => name.length > 0),
    ),
  ];
}
