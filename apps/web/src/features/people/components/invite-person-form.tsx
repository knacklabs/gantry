import { zodResolver } from '@hookform/resolvers/zod';
import { Send } from 'lucide-react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { TextField } from '../../../ui/compositions/text-field';
import { SelectField } from '../../../ui/compositions/select-field';
import { Button } from '../../../ui/primitives/button';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '../../../ui/primitives/field';
import { Textarea } from '../../../ui/primitives/textarea';
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
    control,
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
        <Controller
          control={control}
          name="provider"
          render={({ field }) => (
            <SelectField
              label="Provider"
              value={field.value}
              onValueChange={field.onChange}
              options={[
                { value: 'Slack', label: 'Slack' },
                { value: 'Telegram', label: 'Telegram' },
                { value: 'Teams', label: 'Teams' },
              ]}
            />
          )}
        />
        <Controller
          control={control}
          name="role"
          render={({ field }) => (
            <SelectField
              label="Role summary"
              value={field.value}
              onValueChange={field.onChange}
              options={[
                { value: 'Member', label: 'Member' },
                { value: 'Approver', label: 'Approver' },
                { value: 'Owner', label: 'Owner' },
              ]}
            />
          )}
        />
      </div>
      <TextField
        id="invite-target"
        label="Provider delivery target"
        error={errors.target?.message}
        {...register('target')}
      />
      <Field
        data-invalid={errors.message ? true : undefined}
        className="gap-1.5"
      >
        <FieldLabel
          className="text-xs font-semibold text-text"
          htmlFor="invite-message"
        >
          Message
        </FieldLabel>
        <Textarea
          className="min-h-28 bg-surface text-[13px] leading-5 text-text"
          id="invite-message"
          {...register('message')}
        />
        {errors.message ? (
          <FieldDescription className="text-xs text-danger">
            {errors.message.message}
          </FieldDescription>
        ) : null}
      </Field>
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
