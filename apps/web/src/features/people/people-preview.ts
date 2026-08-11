export type ProviderAliasPreview = {
  id: string;
  provider: 'Slack' | 'Telegram' | 'Teams';
  providerConnection: string;
  display: string;
  providerIdentity: string;
  provenance: string;
  verified: boolean;
};

export type PersonPreview = {
  id: string;
  name: string;
  title: string;
  organization: string;
  aliases: ProviderAliasPreview[];
  conversations: string[];
  invitation: 'accepted' | 'pending' | 'not_invited';
  activity: { time: string; summary: string; resource: string }[];
};

export type MergeHistoryPreview = {
  id: string;
  sourceName: string;
  targetName: string;
  time: string;
  actor: string;
  result: string;
};

export const people: PersonPreview[] = [
  {
    id: 'person-maya-chen',
    name: 'Maya Chen',
    title: 'Support operations lead',
    organization: 'Acme',
    aliases: [
      {
        id: 'alias-slack-maya',
        provider: 'Slack',
        providerConnection: 'Acme Slack',
        display: 'Maya Chen · maya@acme.example',
        providerIdentity: 'U04MAYA',
        provenance: 'Verified Slack workspace membership',
        verified: true,
      },
      {
        id: 'alias-teams-maya',
        provider: 'Teams',
        providerConnection: 'Company Teams',
        display: 'Maya Chen · maya.chen@acme.example',
        providerIdentity: 'teams-user-7a21',
        provenance: 'Verified Teams tenant membership',
        verified: true,
      },
    ],
    conversations: ['#product-support', '#ops-alerts', 'Finance review'],
    invitation: 'accepted',
    activity: [
      {
        time: '3 min ago',
        summary: 'Reviewed a pending report export',
        resource: 'Weekly support review',
      },
      {
        time: 'Yesterday',
        summary: 'Answered an agent question',
        resource: '#product-support',
      },
    ],
  },
  {
    id: 'person-jon-bell',
    name: 'Jon Bell',
    title: 'Support engineering manager',
    organization: 'Acme',
    aliases: [
      {
        id: 'alias-slack-jon',
        provider: 'Slack',
        providerConnection: 'Acme Slack',
        display: 'Jon Bell',
        providerIdentity: 'U04JBELL',
        provenance: 'Verified Slack workspace membership',
        verified: true,
      },
    ],
    conversations: ['#product-support'],
    invitation: 'accepted',
    activity: [
      {
        time: 'Yesterday',
        summary: 'Approved a one-time file write',
        resource: 'Incident 284',
      },
      {
        time: '4 days ago',
        summary: 'Joined a discovered conversation',
        resource: '#product-support',
      },
    ],
  },
  {
    id: 'person-aria-kapoor',
    name: 'Aria Kapoor',
    title: 'Research program manager',
    organization: 'Northstar Labs',
    aliases: [
      {
        id: 'alias-telegram-aria',
        provider: 'Telegram',
        providerConnection: 'Personal Telegram',
        display: '@aria_research',
        providerIdentity: 'telegram-user-284991',
        provenance: 'Observed sender identity in Research room',
        verified: true,
      },
    ],
    conversations: ['Research room'],
    invitation: 'pending',
    activity: [
      {
        time: '2 days ago',
        summary: 'Received an owner invitation',
        resource: 'Research room',
      },
    ],
  },
  {
    id: 'person-m-chen-unverified',
    name: 'M. Chen',
    title: 'Unknown role',
    organization: 'Unknown organization',
    aliases: [
      {
        id: 'alias-telegram-mchen',
        provider: 'Telegram',
        providerConnection: 'Personal Telegram',
        display: '@mchen_ops',
        providerIdentity: 'telegram-user-91042',
        provenance: 'Observed sender identity in Personal notes',
        verified: false,
      },
    ],
    conversations: ['Personal notes'],
    invitation: 'not_invited',
    activity: [
      {
        time: '3 weeks ago',
        summary: 'Identity observed in conversation',
        resource: 'Personal notes',
      },
    ],
  },
];

export const mergeHistory: MergeHistoryPreview[] = [
  {
    id: 'merge-14',
    sourceName: 'Maya C.',
    targetName: 'Maya Chen',
    time: '2 months ago',
    actor: 'Local owner',
    result: 'One verified Slack alias moved after review.',
  },
  {
    id: 'merge-13',
    sourceName: 'Jonathan Bell',
    targetName: 'Jon Bell',
    time: '3 months ago',
    actor: 'Local owner',
    result: 'Duplicate invitation record consolidated.',
  },
];

export function buildMergePreview(
  source: PersonPreview,
  target: PersonPreview,
) {
  const providerConflicts = source.aliases
    .filter((alias) =>
      target.aliases.some(
        (targetAlias) => targetAlias.provider === alias.provider,
      ),
    )
    .map(
      (alias) =>
        `${alias.provider} aliases exist on both people and require provenance review.`,
    );
  const conversationConflicts = source.conversations.filter((conversation) =>
    target.conversations.includes(conversation),
  );

  return {
    aliasCount: source.aliases.length,
    conversationCount: new Set([
      ...source.conversations,
      ...target.conversations,
    ]).size,
    conflicts: [
      ...providerConflicts,
      ...conversationConflicts.map(
        (conversation) =>
          `Both people appear in ${conversation}; membership provenance must remain separate.`,
      ),
    ],
  };
}
