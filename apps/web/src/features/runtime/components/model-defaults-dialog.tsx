import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import { IconButton } from '../../../ui/primitives/icon-button';
import type { ModelDefaults, ModelView } from '../model-api';
import { usePatchModelDefaults } from '../use-model-dashboard';

type DefaultValues = {
  chat: string;
  oneTime: string;
  recurring: string;
};

export function ModelDefaultsDialog({
  defaults,
  models,
  open,
  onOpenChange,
}: {
  defaults: ModelDefaults;
  models: ModelView[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = usePatchModelDefaults();
  const [values, setValues] = useState<DefaultValues>(() =>
    fromDefaults(defaults),
  );

  useEffect(() => {
    if (open) setValues(fromDefaults(defaults));
  }, [defaults, open]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        chat: values.chat || null,
        oneTime: values.oneTime || null,
        recurring: values.recurring || null,
      });
      onOpenChange(false);
    } catch {
      // TanStack Mutation exposes the sanitized server error in the form.
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-strong bg-surface p-5 shadow-popover">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="m-0 text-base font-semibold text-text">
                Model defaults
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 mb-0 text-sm text-text-secondary">
                Choose friendly aliases for interactive and scheduled work.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton aria-label="Close" title="Close">
                <X size={17} aria-hidden="true" />
              </IconButton>
            </Dialog.Close>
          </div>
          <form
            className="mt-5 grid gap-4"
            onSubmit={(event) => void submit(event)}
          >
            <ModelSelect
              label="Chat"
              models={models}
              value={values.chat}
              onChange={(chat) =>
                setValues((current) => ({ ...current, chat }))
              }
            />
            <ModelSelect
              label="One-time jobs"
              models={models}
              value={values.oneTime}
              onChange={(oneTime) =>
                setValues((current) => ({ ...current, oneTime }))
              }
            />
            <ModelSelect
              label="Recurring jobs"
              models={models}
              value={values.recurring}
              onChange={(recurring) =>
                setValues((current) => ({ ...current, recurring }))
              }
            />
            <p className="m-0 text-sm text-text-secondary">
              Memory processing models are managed separately. Saving Chat or
              Job defaults does not change or delete centralized memory.
            </p>
            {mutation.error ? (
              <p className="m-0 text-sm text-danger" role="alert">
                {mutation.error.message}
              </p>
            ) : null}
            <div className="mt-1 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button disabled={mutation.isPending}>Cancel</Button>
              </Dialog.Close>
              <Button
                disabled={mutation.isPending}
                type="submit"
                variant="primary"
              >
                {mutation.isPending ? 'Saving...' : 'Save defaults'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ModelSelect({
  label,
  models,
  value,
  onChange,
}: {
  label: string;
  models: ModelView[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      {label}
      <select
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Inherit Gantry default</option>
        {models.map((model) => (
          <option key={model.alias} value={model.alias}>
            {model.alias} - {model.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}

function fromDefaults(defaults: ModelDefaults): DefaultValues {
  return {
    chat: defaults.chat.configuredAlias ?? '',
    oneTime: defaults.jobs.oneTime.configuredAlias ?? '',
    recurring: defaults.jobs.recurring.configuredAlias ?? '',
  };
}
