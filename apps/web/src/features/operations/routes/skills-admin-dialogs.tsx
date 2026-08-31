import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';

import { agentQueryKeys } from '../../agents/agents-queries';
import { navigationSummaryQuery } from '../../navigation/navigation-summary-query';
import { Button } from '../../../ui/primitives/button';
import { Checkbox } from '../../../ui/primitives/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import { Input } from '../../../ui/primitives/input';
import {
  installSkillZip,
  replaceSkillAttachments,
  skillAttachmentsQuery,
  skillInventoryQuery,
  type BrowserSkill,
  type BrowserSkillAttachments,
} from '../skills-queries';

export const MAX_SELECTED_AGENTS = 100;

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function attachedIds(data: BrowserSkillAttachments): Set<string> {
  return new Set(
    data.agents.filter((agent) => agent.attached).map((agent) => agent.id),
  );
}

function returnFocus(ref: RefObject<HTMLElement | null>) {
  if (ref.current?.isConnected) ref.current.focus();
}

export function toggleAgentSelection(
  current: ReadonlySet<string>,
  agentId: string,
): Set<string> {
  const next = new Set(current);
  if (!next.delete(agentId) && next.size < MAX_SELECTED_AGENTS)
    next.add(agentId);
  return next;
}

export function SkillInstallDialog({
  onAttachAgents,
  onOpenChange,
  onViewSkill,
  open,
  returnFocusRef,
}: {
  onAttachAgents: (skill: BrowserSkill) => void;
  onOpenChange: (open: boolean) => void;
  onViewSkill: (skill: BrowserSkill) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const successActionRef = useRef<HTMLButtonElement>(null);
  const [file, setFile] = useState<File>();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();
  const [installed, setInstalled] = useState<BrowserSkill>();

  useEffect(() => {
    if (open) return;
    setFile(undefined);
    setError(undefined);
    setInstalled(undefined);
  }, [open]);

  useEffect(() => {
    if (installed) successActionRef.current?.focus();
  }, [installed]);

  function changeOpen(next: boolean) {
    if (!next && installing) return;
    onOpenChange(next);
  }

  async function install() {
    if (!file) return;
    setInstalling(true);
    setError(undefined);
    try {
      const skill = await installSkillZip(file);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: skillInventoryQuery.queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: navigationSummaryQuery.queryKey,
        }),
        ...skill.attachedAgents.map((agent) =>
          queryClient.invalidateQueries({
            queryKey: [...agentQueryKeys.all, 'sources', agent.id],
          }),
        ),
      ]);
      setInstalled(skill);
    } catch (caught) {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: skillInventoryQuery.queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: navigationSummaryQuery.queryKey,
        }),
        queryClient.invalidateQueries({ queryKey: agentQueryKeys.all }),
      ]);
      setError(
        messageFor(caught, 'The skill ZIP could not be installed. Try again.'),
      );
    } finally {
      setInstalling(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="max-h-[calc(100dvh-32px)] w-[min(560px,calc(100vw-32px))] max-w-none overflow-y-auto sm:max-w-none"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus(returnFocusRef);
        }}
        onEscapeKeyDown={(event) => {
          if (installing) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (installing) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          fileInputRef.current?.focus();
        }}
        showCloseButton={!installing}
      >
        <div className="grid gap-1">
          <DialogTitle className="text-lg font-semibold">
            Install skill
          </DialogTitle>
          <DialogDescription>
            Add a ZIP package to Gantry’s skill inventory. Agent attachment is
            managed separately after installation.
          </DialogDescription>
        </div>

        <p
          aria-atomic="true"
          aria-live="polite"
          className={
            installed
              ? 'm-0 rounded-lg border border-status-success/40 bg-status-success-soft p-3 text-sm text-status-success'
              : 'sr-only'
          }
        >
          {installed ? 'Skill installed.' : ''}
        </p>

        {installed ? (
          <div className="grid gap-4">
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                onClick={() => {
                  onViewSkill(installed);
                  changeOpen(false);
                }}
                ref={successActionRef}
                variant="secondary"
              >
                View skill
              </Button>
              <Button
                onClick={() => {
                  onAttachAgents(installed);
                  changeOpen(false);
                }}
              >
                Attach agents
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void install();
            }}
          >
            <div className="grid gap-1.5">
              <label
                className="text-xs font-semibold text-text"
                htmlFor="skill-zip"
              >
                Choose a skill ZIP
              </label>
              <Input
                accept=".zip,application/zip"
                aria-describedby="skill-zip-hint skill-update-warning"
                disabled={installing}
                id="skill-zip"
                onChange={(event) => {
                  setFile(event.target.files?.[0]);
                  setError(undefined);
                }}
                ref={fileInputRef}
                required
                type="file"
              />
              <p
                className="m-0 text-xs text-text-secondary"
                id="skill-zip-hint"
              >
                ZIP only · Maximum 5 MB
              </p>
            </div>
            <p
              className="m-0 flex gap-2 rounded-lg border border-status-attention/40 bg-status-attention-soft p-3 text-xs leading-5 text-status-attention"
              id="skill-update-warning"
            >
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              <span>
                Installing a package with the same skill name updates it in
                place. Attached agents receive the updated instructions on their
                next run.
              </span>
            </p>
            {error ? (
              <p
                aria-live="assertive"
                className="m-0 text-sm text-danger"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                disabled={installing}
                onClick={() => changeOpen(false)}
                type="button"
                variant="secondary"
              >
                Cancel
              </Button>
              <Button disabled={!file || installing} type="submit">
                {installing ? 'Installing…' : 'Install skill'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function SkillAttachmentsDialog({
  onOpenChange,
  onSaved,
  open,
  returnFocusRef,
  skill,
}: {
  onOpenChange: (open: boolean) => void;
  onSaved: (skill: BrowserSkill, attachedCount: number) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  skill: BrowserSkill | undefined;
}) {
  const queryClient = useQueryClient();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const initializedSkillId = useRef<string | undefined>(undefined);
  const query = useQuery(skillAttachmentsQuery(skill?.id, open));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [hydratedSkillId, setHydratedSkillId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [reconciliationRequired, setReconciliationRequired] = useState(false);
  const [success, setSuccess] = useState<string>();

  useEffect(() => {
    if (!open) {
      initializedSkillId.current = undefined;
      setSelected(new Set());
      setConfirmed(new Set());
      setHydratedSkillId(undefined);
      setError(undefined);
      setReconciliationRequired(false);
      setSuccess(undefined);
      return;
    }
    if (
      !query.data ||
      query.isFetching ||
      query.isError ||
      initializedSkillId.current === query.data.skillId
    )
      return;
    const ids = attachedIds(query.data);
    initializedSkillId.current = query.data.skillId;
    setSelected(ids);
    setConfirmed(new Set(ids));
    setHydratedSkillId(query.data.skillId);
  }, [open, query.data, query.isError, query.isFetching]);

  useEffect(() => {
    if (success) doneRef.current?.focus();
  }, [success]);

  function changeOpen(next: boolean) {
    if (!next && saving) return;
    if (!next) {
      initializedSkillId.current = undefined;
      setSelected(new Set());
      setConfirmed(new Set());
      setHydratedSkillId(undefined);
      setError(undefined);
      setReconciliationRequired(false);
      setSuccess(undefined);
    }
    onOpenChange(next);
  }

  function toggle(agentId: string) {
    setSelected((current) => toggleAgentSelection(current, agentId));
  }

  async function save() {
    if (!skill || !query.data || hydratedSkillId !== skill.id) return;
    setSaving(true);
    setError(undefined);
    const desiredIds = [...selected];
    const affectedAgentIds = new Set([...confirmed, ...desiredIds]);
    try {
      const result = await replaceSkillAttachments(skill.id, desiredIds);
      queryClient.setQueryData(
        skillAttachmentsQuery(skill.id, true).queryKey,
        result,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: skillInventoryQuery.queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: navigationSummaryQuery.queryKey,
        }),
        ...[...affectedAgentIds].map((agentId) =>
          queryClient.invalidateQueries({
            queryKey: [...agentQueryKeys.all, 'sources', agentId],
          }),
        ),
      ]);
      setSaving(false);
      const savedAgents = attachedIds(result);
      setSelected(savedAgents);
      setConfirmed(new Set(savedAgents));
      setSuccess('Attachments saved. Changes apply on each agent’s next run.');
      onSaved(skill, result.agents.filter((agent) => agent.attached).length);
    } catch (caught) {
      const refreshed = await query.refetch();
      if (refreshed.isSuccess && refreshed.data) {
        const ids = attachedIds(refreshed.data);
        setSelected(ids);
        setConfirmed(new Set(ids));
      } else {
        setReconciliationRequired(true);
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: skillInventoryQuery.queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: navigationSummaryQuery.queryKey,
        }),
        ...[...affectedAgentIds].map((agentId) =>
          queryClient.invalidateQueries({
            queryKey: [...agentQueryKeys.all, 'sources', agentId],
          }),
        ),
      ]);
      setError(messageFor(caught, 'Attachments could not be saved.'));
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        className="grid max-h-[calc(100dvh-32px)] w-[min(680px,calc(100vw-32px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0 sm:max-w-none"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus(returnFocusRef);
        }}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
        showCloseButton={!saving}
      >
        <div className="grid gap-1 border-b border-border px-5 py-4">
          <DialogTitle className="text-lg font-semibold">
            Attach agents
          </DialogTitle>
          <DialogDescription>
            Choose which agents receive this skill’s instructions on their next
            run.
          </DialogDescription>
        </div>

        <div className="min-h-0 overflow-y-auto p-5">
          <p className="mt-0 mb-4 rounded-lg border border-border bg-surface-muted p-3 text-xs leading-5 text-text-secondary">
            Attachment is not authorization. Declared actions must still be
            enabled from each agent’s Access tab.
          </p>
          {query.isPending ? (
            <p aria-live="polite" className="m-0 text-sm text-text-secondary">
              Loading confirmed attachments…
            </p>
          ) : null}
          {query.isError ? (
            <div className="grid gap-3">
              <p className="m-0 text-sm text-danger" role="alert">
                Confirmed attachments could not be loaded.
              </p>
              <Button
                onClick={() =>
                  void query.refetch().then((refreshed) => {
                    if (!refreshed.isSuccess || !refreshed.data) return;
                    const ids = attachedIds(refreshed.data);
                    setSelected(ids);
                    setConfirmed(new Set(ids));
                    setReconciliationRequired(false);
                    setError(undefined);
                  })
                }
                size="sm"
                variant="secondary"
              >
                Try again
              </Button>
            </div>
          ) : null}
          {query.data && !query.isError ? (
            <fieldset className="m-0 grid gap-2 border-0 p-0" disabled={saving}>
              <legend className="mb-2 text-xs font-semibold text-text">
                Agents
              </legend>
              {query.data.agents.map((agent) => (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface-muted p-3 has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
                  key={agent.id}
                >
                  <Checkbox
                    aria-label={`Attach ${skill?.name ?? 'skill'} to ${agent.name}`}
                    checked={selected.has(agent.id)}
                    disabled={
                      !selected.has(agent.id) &&
                      selected.size >= MAX_SELECTED_AGENTS
                    }
                    onCheckedChange={() => toggle(agent.id)}
                  />
                  <span className="grid gap-0.5">
                    <span className="text-sm font-semibold text-text">
                      {agent.name}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {agent.status === 'disabled'
                        ? 'Disabled · available when the agent is enabled.'
                        : 'Active'}
                    </span>
                  </span>
                </label>
              ))}
              {!query.data.agents.length ? (
                <p className="m-0 text-sm text-text-secondary">
                  No agents are available in this app.
                </p>
              ) : null}
            </fieldset>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t border-border bg-surface-muted px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div aria-live="polite" className="min-w-0 text-xs">
            {success ? (
              <p className="m-0 text-status-success">{success}</p>
            ) : error ? (
              <p className="m-0 text-danger" role="alert">
                {error}
              </p>
            ) : (
              <p className="m-0 text-text-secondary">
                {saving
                  ? 'Saving the complete attachment set…'
                  : `${selected.size} agent${selected.size === 1 ? '' : 's'} selected${
                      selected.size >= MAX_SELECTED_AGENTS
                        ? ` · Maximum ${MAX_SELECTED_AGENTS}`
                        : ''
                    }`}
              </p>
            )}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {!success ? (
              <Button
                disabled={saving}
                onClick={() => changeOpen(false)}
                ref={cancelRef}
                variant="secondary"
              >
                Cancel
              </Button>
            ) : null}
            {success ? (
              <Button onClick={() => changeOpen(false)} ref={doneRef}>
                Done
              </Button>
            ) : (
              <Button
                disabled={
                  !skill ||
                  hydratedSkillId !== skill.id ||
                  saving ||
                  query.isError ||
                  reconciliationRequired
                }
                onClick={() => void save()}
              >
                {saving ? 'Saving…' : 'Save attachments'}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
