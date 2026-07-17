import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import { IconButton } from '../../../ui/primitives/icon-button';
import type { JobView } from '../job-api';
import { useUpdateJob } from '../use-jobs';

export function EditJobDialog({
  job,
  open,
  onOpenChange,
}: {
  job: JobView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(job.name);
  const [prompt, setPrompt] = useState(job.prompt);
  const mutation = useUpdateJob(job.id);

  useEffect(() => {
    if (!open) return;
    setName(job.name);
    setPrompt(job.prompt);
    mutation.reset();
  }, [job.name, job.prompt, open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await mutation.mutateAsync({ name, prompt });
      onOpenChange(false);
    } catch {
      // TanStack Mutation exposes the sanitized server error in the form.
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-strong bg-surface p-5 shadow-popover">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="m-0 text-base font-semibold text-text">
                Edit job
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 mb-0 text-sm text-text-secondary">
                Update the job name and runtime prompt.
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
            <label className="grid gap-1.5 text-xs font-semibold text-text">
              Name
              <input
                className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-xs font-semibold text-text">
              Prompt
              <textarea
                className="min-h-36 resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] font-normal leading-5 text-text"
                required
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            {mutation.error ? (
              <p className="m-0 text-sm text-danger" role="alert">
                {mutation.error.message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button disabled={mutation.isPending}>Cancel</Button>
              </Dialog.Close>
              <Button
                disabled={mutation.isPending}
                type="submit"
                variant="primary"
              >
                {mutation.isPending ? 'Saving...' : 'Save changes'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
