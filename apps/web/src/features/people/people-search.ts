import { z } from 'zod';

export const peopleSearchSchema = z.object({
  q: z.string().catch(''),
  provider: z.enum(['all', 'Slack', 'Telegram', 'Teams']).catch('all'),
  invitation: z
    .enum(['all', 'accepted', 'pending', 'not_invited'])
    .catch('all'),
  page: z.coerce.number().int().min(1).catch(1),
  sort: z.enum(['name', 'organization', 'invitation']).catch('name'),
  desc: z.coerce.boolean().catch(false),
});

export const personDetailSearchSchema = z.object({
  view: z.enum(['profile', 'invite', 'merge', 'history']).catch('profile'),
});
