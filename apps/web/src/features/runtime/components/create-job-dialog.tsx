import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import { IconButton } from '../../../ui/primitives/icon-button';
import { useCreateJob } from '../use-jobs';

type JobDraft = {
  name: string;
  prompt: string;
  kind: 'manual' | 'once' | 'recurring';
  scheduleType: 'cron' | 'interval';
  scheduleValue: string;
  conversationJid: string;
  threadId: string;
  workspaceKey: string;
  sessionId: string;
};

const emptyDraft: JobDraft = {
  name: '',
  prompt: '',
  kind: 'manual',
  scheduleType: 'cron',
  scheduleValue: '',
  conversationJid: '',
  threadId: '',
  workspaceKey: '',
  sessionId: '',
};

export function CreateJobDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState(emptyDraft);
  const mutation = useCreateJob();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await mutation.mutateAsync({
        name: draft.name,
        prompt: draft.prompt,
        kind: draft.kind,
        ...(draft.kind === 'once'
          ? { runAt: new Date(draft.scheduleValue).toISOString() }
          : {}),
        ...(draft.kind === 'recurring'
          ? {
              schedule: {
                type: draft.scheduleType,
                value: draft.scheduleValue,
              },
            }
          : {}),
        executionContext: {
          conversationJid: draft.conversationJid,
          threadId: draft.threadId || null,
          workspaceKey: draft.workspaceKey,
          sessionId: draft.sessionId,
        },
      });
      setDraft(emptyDraft);
      onOpenChange(false);
    } catch {
      // TanStack Mutation exposes the sanitized server error in the form.
    }
  }

  function set<K extends keyof JobDraft>(key: K, value: JobDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) mutation.reset();
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[min(640px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border-strong bg-surface p-5 shadow-popover">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="m-0 text-base font-semibold text-text">
                Create job
              </Dialog.Title>
              <Dialog.Description className="mt-1.5 mb-0 text-sm text-text-secondary">
                Create a runtime-owned job against an existing session.
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
            <Field
              label="Name"
              required
              value={draft.name}
              onChange={(value) => set('name', value)}
            />
            <label className="grid gap-1.5 text-xs font-semibold text-text">
              Prompt
              <textarea
                className="min-h-28 resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] font-normal leading-5 text-text"
                required
                value={draft.prompt}
                onChange={(event) => set('prompt', event.target.value)}
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-semibold text-text">
                Schedule kind
                <select
                  className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
                  value={draft.kind}
                  onChange={(event) =>
                    set('kind', event.target.value as JobDraft['kind'])
                  }
                >
                  <option value="manual">Manual</option>
                  <option value="once">One time</option>
                  <option value="recurring">Recurring</option>
                </select>
              </label>
              {draft.kind === 'once' ? (
                <Field
                  label="Run at"
                  required
                  type="datetime-local"
                  value={draft.scheduleValue}
                  onChange={(value) => set('scheduleValue', value)}
                />
              ) : draft.kind === 'recurring' ? (
                <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-2">
                  <label className="grid gap-1.5 text-xs font-semibold text-text">
                    Type
                    <select
                      className="h-9 rounded-md border border-border-strong bg-surface px-2 text-[13px] font-normal text-text"
                      value={draft.scheduleType}
                      onChange={(event) =>
                        set(
                          'scheduleType',
                          event.target.value as JobDraft['scheduleType'],
                        )
                      }
                    >
                      <option value="cron">Cron</option>
                      <option value="interval">Interval</option>
                    </select>
                  </label>
                  <Field
                    label="Value"
                    required
                    value={draft.scheduleValue}
                    onChange={(value) => set('scheduleValue', value)}
                  />
                </div>
              ) : null}
            </div>
            <div className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
              <Field
                label="Session ID"
                required
                value={draft.sessionId}
                onChange={(value) => set('sessionId', value)}
              />
              <Field
                label="Agent workspace"
                required
                value={draft.workspaceKey}
                onChange={(value) => set('workspaceKey', value)}
              />
              <Field
                label="Conversation ID"
                required
                value={draft.conversationJid}
                onChange={(value) => set('conversationJid', value)}
              />
              <Field
                label="Thread ID"
                value={draft.threadId}
                onChange={(value) => set('threadId', value)}
              />
            </div>
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
                {mutation.isPending ? 'Creating...' : 'Create job'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({
  label,
  value,
  onChange,
  required = false,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      {label}
      <input
        className="h-9 min-w-0 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
