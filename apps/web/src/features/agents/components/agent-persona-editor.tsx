import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { Button } from '../../../ui/primitives/button';
import { Textarea } from '../../../ui/primitives/textarea';
import { agentPersonaQuery, agentQueryKeys } from '../agents-queries';

const MAX_PERSONA_CHARS = 3000;

export function AgentPersonaEditor({
  agentId,
  disabled,
}: {
  agentId: string;
  disabled: boolean;
}) {
  const queryClient = useQueryClient();
  const persona = useQuery(agentPersonaQuery(agentId));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!editing && persona.data) setDraft(persona.data.persona.content);
  }, [editing, persona.data]);

  const update = useMutation({
    mutationFn: async () => {
      const response = await browserFetch(
        `/ui/api/agents/${encodeURIComponent(agentId)}/persona`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/json',
            ...browserCsrfHeader(),
          },
          body: JSON.stringify({
            content: draft,
            expectedVersion: persona.data!.persona.version,
          }),
        },
      );
      if (response.status === 409)
        throw new Error(
          'This persona changed elsewhere. Refresh it before saving.',
        );
      if (!response.ok)
        throw new Error('Persona could not be saved. Try again.');
      return response.json() as Promise<{
        persona: { content: string; version: number; isDefault: boolean };
      }>;
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        [...agentQueryKeys.all, 'persona', agentId],
        result,
      );
      setEditing(false);
      setSaved(true);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.trim() && draft.length <= MAX_PERSONA_CHARS) update.mutate();
  }

  function cancel() {
    setDraft(persona.data?.persona.content ?? '');
    setEditing(false);
    update.reset();
  }

  async function reloadLatest() {
    const latest = await persona.refetch();
    if (latest.data) {
      setDraft(latest.data.persona.content);
      update.reset();
    }
  }

  return (
    <section className="rounded-lg border border-border bg-surface p-4 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-base font-semibold">Persona</h2>
          <p className="mt-1 mb-0 text-sm text-text-secondary">
            This AI employee’s SOUL.md sets its voice and personality. It does
            not change its tools, permissions, or safety rules. Changes apply to
            new work.
          </p>
        </div>
        {persona.data && !editing && !disabled ? (
          <Button
            variant="secondary"
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
          >
            Edit persona
          </Button>
        ) : null}
      </div>
      {persona.isLoading ? (
        <p className="mt-4 mb-0 text-sm text-text-secondary">
          Loading persona…
        </p>
      ) : persona.isError ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <p className="m-0 text-sm text-danger">{persona.error.message}</p>
          <Button variant="secondary" onClick={() => void persona.refetch()}>
            Retry
          </Button>
        </div>
      ) : persona.data ? (
        <>
          <p className="mt-4 mb-2 text-xs text-text-muted">
            {persona.data.persona.isDefault
              ? 'Default persona · Not yet customized'
              : `Saved persona · Version ${persona.data.persona.version}`}
          </p>
          {editing ? (
            <form className="grid gap-3" onSubmit={submit}>
              <label className="text-sm font-semibold" htmlFor="agent-persona">
                Persona instructions
              </label>
              <Textarea
                className="min-h-72 w-full resize-y font-mono text-sm leading-6"
                id="agent-persona"
                maxLength={MAX_PERSONA_CHARS + 1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span
                  className={`text-xs ${draft.length > MAX_PERSONA_CHARS ? 'text-danger' : 'text-text-muted'}`}
                >
                  {draft.length.toLocaleString()} /{' '}
                  {MAX_PERSONA_CHARS.toLocaleString()} characters
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" onClick={cancel}>
                    Cancel
                  </Button>
                  <Button
                    disabled={
                      update.isPending ||
                      !draft.trim() ||
                      draft.length > MAX_PERSONA_CHARS ||
                      draft === persona.data.persona.content
                    }
                    type="submit"
                  >
                    {update.isPending ? 'Saving…' : 'Save persona'}
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
              {persona.data.persona.content}
            </pre>
          )}
          {saved && !editing ? (
            <p className="mt-3 mb-0 text-sm text-status-success" role="status">
              Persona saved. New work will use this version.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
