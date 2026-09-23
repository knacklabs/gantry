import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { Button } from '../../../ui/primitives/button';
import { Textarea } from '../../../ui/primitives/textarea';
import {
  agentProfileQuery,
  agentQueryKeys,
  type AgentProfileSection,
} from '../agents-queries';

const profileCopy = {
  persona: {
    title: 'Persona · SOUL.md',
    description:
      'Sets this AI employee’s voice and personality. It does not change tools, permissions, or safety rules. Changes apply to new work.',
    edit: 'Edit persona',
    save: 'Save persona',
    label: 'Persona instructions',
    maxChars: 3000,
  },
  instructions: {
    title: 'Working instructions · AGENTS.md',
    description:
      'Tells this AI employee how to approach work. These instructions are advisory; they do not grant tools or guarantee that every step runs. Changes apply to new work.',
    edit: 'Edit AGENTS.md',
    save: 'Save AGENTS.md',
    label: 'Working instructions',
    maxChars: 4500,
  },
} as const;

export function AgentProfileEditor({
  agentId,
  disabled,
  section,
}: {
  agentId: string;
  disabled: boolean;
  section: AgentProfileSection;
}) {
  const copy = profileCopy[section];
  const queryClient = useQueryClient();
  const profile = useQuery(agentProfileQuery(agentId, section));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!editing && profile.data) setDraft(profile.data[section].content);
  }, [editing, profile.data, section]);

  const update = useMutation({
    mutationFn: async () => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/${section}`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({
            content: draft,
            expectedVersion: profile.data![section].version,
          }),
        },
      );
      if (response.status === 409)
        throw new Error(
          'This profile changed elsewhere. Refresh it before saving.',
        );
      if (!response.ok)
        throw new Error('Profile could not be saved. Try again.');
      return response.json() as Promise<{
        [key: string]: { content: string; version: number; isDefault: boolean };
      }>;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        [...agentQueryKeys.all, section, agentId],
        result,
      );
      setEditing(false);
      setSaved(true);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim() && draft.length <= copy.maxChars) update.mutate();
  }

  function cancel() {
    setDraft(profile.data?.[section].content ?? '');
    setEditing(false);
    update.reset();
  }

  async function reloadLatest() {
    const latest = await profile.refetch();
    if (latest.data) {
      setDraft(latest.data[section].content);
      update.reset();
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-base font-semibold">{copy.title}</h2>
          <p className="mt-1 mb-0 text-sm text-text-secondary">
            {copy.description}
          </p>
        </div>
        {profile.data && !editing && !disabled ? (
          <Button
            variant="secondary"
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
          >
            {copy.edit}
          </Button>
        ) : null}
      </div>
      {profile.isLoading ? (
        <p className="mt-4 mb-0 text-sm text-text-secondary">
          Loading {section}…
        </p>
      ) : profile.isError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="m-0 text-sm text-danger">{profile.error.message}</p>
          <Button variant="secondary" onClick={() => void profile.refetch()}>
            Retry
          </Button>
        </div>
      ) : profile.data ? (
        <>
          <p className="mt-4 mb-2 text-xs text-text-muted">
            {profile.data[section].isDefault
              ? 'Default · Not yet customized'
              : `Saved · Version ${profile.data[section].version}`}
          </p>
          {editing ? (
            <form className="grid gap-3" onSubmit={submit}>
              <label
                className="text-sm font-semibold"
                htmlFor={`agent-${section}`}
              >
                {copy.label}
              </label>
              <Textarea
                className="min-h-72 w-full resize-y font-mono text-sm leading-6"
                id={`agent-${section}`}
                maxLength={copy.maxChars + 1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span
                  className={`text-xs ${draft.length > copy.maxChars ? 'text-danger' : 'text-text-muted'}`}
                >
                  {draft.length.toLocaleString()} /{' '}
                  {copy.maxChars.toLocaleString()} characters
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" onClick={cancel}>
                    Cancel
                  </Button>
                  <Button
                    disabled={
                      update.isPending ||
                      !draft.trim() ||
                      draft.length > copy.maxChars ||
                      draft === profile.data[section].content
                    }
                    type="submit"
                  >
                    {update.isPending ? 'Saving…' : copy.save}
                  </Button>
                </div>
              </div>
              {update.isError ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="m-0 text-sm text-danger" role="alert">
                    {update.error.message}
                  </p>
                  {update.error.message.includes('changed elsewhere') ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => void reloadLatest()}
                    >
                      Reload latest
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </form>
          ) : (
            <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-muted p-3 text-xs leading-5 text-text-secondary">
              {profile.data[section].content}
            </pre>
          )}
          {saved && !editing ? (
            <p className="mt-3 mb-0 text-sm text-status-success" role="status">
              {copy.title} saved. New work will use this version.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
