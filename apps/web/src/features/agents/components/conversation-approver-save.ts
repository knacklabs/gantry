export function normalizeApproverIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

export function sameApprovers(left: string[], right: string[]): boolean {
  return (
    JSON.stringify(normalizeApproverIds(left)) ===
    JSON.stringify(normalizeApproverIds(right))
  );
}

export async function saveConversationApprovers(input: {
  selected: string[];
  initial: string[];
  current: () => Promise<string[]>;
  verify: (ids: string[]) => Promise<{ invalidUserIds: string[] }>;
  replace: (ids: string[]) => Promise<unknown>;
}): Promise<void> {
  const ids = normalizeApproverIds(input.selected);
  if (!ids.length) throw new Error('Choose at least one approver.');
  const latest = await input.current();
  if (!sameApprovers(latest, input.initial)) {
    throw new Error(
      'Approvers changed elsewhere. Close and reopen this editor to review the latest list.',
    );
  }
  const verification = await input.verify(ids);
  if (verification.invalidUserIds.length) {
    throw new Error(
      `Not eligible for this conversation: ${verification.invalidUserIds.join(', ')}`,
    );
  }
  await input.replace(ids);
}
