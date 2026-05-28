export const CUSTOMER_IDENTITY_MISMATCH_MESSAGE =
  'I can only check details linked to the phone number you are messaging from. The phone number, email, or order you asked about does not match that number.';

// Neutral decline used as a last-resort backstop when an outbound customer
// reply is found to contain internal implementation detail. Unlike the
// identity-mismatch message, it makes no claim about why — it just keeps the
// customer moving without exposing internals.
export const CUSTOMER_VISIBLE_DECLINE_MESSAGE =
  "Sorry, I can't share that here. Is there something about your order, delivery, or products I can help with?";

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
    `${subject} uses Gantry Secret${unique.length === 1 ? '' : 's'}: ${unique.join(', ')}.`,
    'If not set yet, run:',
    ...unique.map((name) => `gantry secrets set ${name}`),
  ];
}

export function formatMissingGantrySecretsMessage(
  names: readonly string[],
): string {
  const unique = uniqueNames(names);
  if (unique.length === 0) return 'A required Gantry Secret is missing.';
  return [
    `Gantry Secret${unique.length === 1 ? '' : 's'} required before this can run: ${unique.join(', ')}.`,
    ...unique.map((name) => `Run: gantry secrets set ${name}`),
  ].join('\n');
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
