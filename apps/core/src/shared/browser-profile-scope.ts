import { createHash } from 'node:crypto';

const DEFAULT_BROWSER_PROFILE_NAME = 'gantry';

function compactSegment(value: string): string {
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  return compact || 'agent';
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function resolveConversationBrowserProfile(input: {
  agentId?: string;
  workspaceKey?: string;
  conversationId?: string;
  /**
   * Provider account this browser belongs to. REQUIRED, so `tsc` forces every
   * derivation site to decide — a Chrome profile carries logged-in sessions, and
   * two accounts sharing one profile means one account inherits the other's
   * logins.
   *
   * `null` means "no account established" and hashes as the empty string, which
   * no real account id can equal, so unresolved turns are isolated from every
   * resolved account without needing a sentinel value.
   *
   * Supplying `null` to satisfy the type is NOT a safe shortcut: it silently
   * moves that caller onto a different profile. Job paths in particular must
   * resolve the same account as the live turn, or a scheduled job loses the
   * login established in chat.
   */
  providerAccountId: string | null;
}): string {
  const agent = compactSegment(input.agentId || input.workspaceKey || 'agent');
  const conversation = (input.conversationId || '').trim();
  // The default profile is deliberately shared across accounts: it is the
  // no-conversation workspace CLI and manual use expect to be one stable
  // browser (decision 0092).
  if (!conversation) return DEFAULT_BROWSER_PROFILE_NAME;
  // Verbatim, not trimmed: trimming would collapse two distinct account ids
  // that differ only by surrounding whitespace onto one profile, which is the
  // isolation this exists to provide. Absent stays the empty string, which no
  // real account id can be.
  const account = input.providerAccountId || '';
  const prefix = `c-${agent}`.slice(0, 48).replace(/[^a-z0-9]+$/, '');
  return `${prefix}-${shortHash(`${agent}\n${conversation}\n${account}`)}`;
}

export function formatBrowserProfileLabel(input: {
  agentName?: string;
  conversationKind?: 'dm' | 'channel';
}): string {
  const agent = (input.agentName || 'Agent').trim() || 'Agent';
  if (input.conversationKind === 'dm') return `${agent} DM browser`;
  return `${agent} conversation browser`;
}
