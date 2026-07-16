import { zodResolver } from '@hookform/resolvers/zod';
import { Send } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import type { PersonPreview } from '../people-preview';

const invitationSchema = z.object({
  provider: z.enum(['Slack', 'Telegram', 'Teams']),
  target: z
    .string()
    .trim()
    .min(3, 'Enter a provider delivery target.')
    .max(120),
  role: z.enum(['Member', 'Approver', 'Owner']),
  message: z
    .string()
    .trim()
    .min(12, 'Add a short invitation message.')
    .max(400),
});

type InvitationDraft = z.infer<typeof invitationSchema>;

export function InvitePersonForm({ person }: { person: PersonPreview }) {
  const { requestConnection } = useConnectionGate();
  const {
    formState: { errors, isDirty },
    handleSubmit,
    register,
  } = useForm<InvitationDraft>({
    defaultValues: {
      provider: person.aliases[0]?.provider ?? 'Slack',
      target: person.aliases[0]?.display ?? '',
      role: 'Member',
      message: `You're invited to collaborate with Gantry in the conversations where ${person.name} participates.`,
    },
    resolver: zodResolver(invitationSchema),
  });

  return (
    <form
      className="grid gap-5 p-5"
      onSubmit={(event) =>
        void handleSubmit(() => requestConnection(`Invite ${person.name}`))(
          event,
        )
      }
    >
      <div>
        <h2 className="m-0 text-sm font-semibold text-text">
          Invitation draft
        </h2>
        <p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
          This target is only a delivery address. It does not become a canonical
          person ID or browser account.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Provider
          <select
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
            {...register('provider')}
          >
            <option value="Slack">Slack</option>
            <option value="Telegram">Telegram</option>
            <option value="Teams">Teams</option>
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Role summary
          <select
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
            {...register('role')}
          >
            <option value="Member">Member</option>
            <option value="Approver">Approver</option>
            <option value="Owner">Owner</option>
          </select>
        </label>
      </div>
      <TextField
        id="invite-target"
        label="Provider delivery target"
        error={errors.target?.message}
        {...register('target')}
      />
      <label className="grid gap-1.5" htmlFor="invite-message">
        <span className="text-xs font-semibold text-text">Message</span>
        <textarea
          className={`min-h-28 rounded-md border bg-surface px-3 py-2 text-[13px] leading-5 text-text ${errors.message ? 'border-danger' : 'border-border-strong'}`}
          id="invite-message"
          {...register('message')}
        />
        {errors.message ? (
          <span className="text-xs text-danger">{errors.message.message}</span>
        ) : null}
      </label>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span className="text-xs text-text-muted">
          {isDirty ? 'Unsaved local changes' : 'Preview defaults'}
        </span>
        <Button type="submit">
          <Send size={16} aria-hidden="true" />
          Send invitation
        </Button>
      </div>
    </form>
  );
}
