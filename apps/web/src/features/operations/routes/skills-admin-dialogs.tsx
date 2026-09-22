import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UploadCloud } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from 'react';

import { cn } from '../../../lib/utils';
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
import { toast } from '../../../ui/primitives/toast';
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

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function normalizedSkillFileName(fileName: string): string {
  return fileName
    .replace(/\.zip$/i, '')
    .trim()
    .toLowerCase();
}

function findMatchingSkill(
  file: File | undefined,
  skills: readonly BrowserSkill[] | undefined,
): BrowserSkill | undefined {
  if (!file || !skills) return undefined;
  const candidate = normalizedSkillFileName(file.name);
  return skills.find(
    (skill) =>
      skill.name.trim().toLowerCase() === candidate ||
      skill.id.trim().toLowerCase() === candidate,
  );
}

function SkillDropzone({
  containerRef,
  disabled,
  file,
  inputRef,
  onFileSelected,
}: {
  containerRef?: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  file: File | undefined;
  inputRef: RefObject<HTMLInputElement | null>;
  onFileSelected: (file: File | undefined) => void;
}) {
  const [dragActive, setDragActive] = useState(false);

  function open() {
    if (!disabled) inputRef.current?.click();
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (disabled) return;
    onFileSelected(event.dataTransfer.files[0]);
  }

  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-semibold text-text" htmlFor="skill-zip">
        Choose a skill ZIP
      </label>
      <div
        aria-disabled={disabled}
        className={cn(
          'grid cursor-pointer gap-3 rounded-xl border-2 border-dashed p-6 text-center transition-colors',
          dragActive
            ? 'border-ring bg-ring/5'
            : 'border-border-strong bg-surface-muted',
          disabled && 'pointer-events-none opacity-60',
        )}
        onClick={open}
        ref={containerRef}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setDragActive(true);
        }}
        onDrop={handleDrop}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        }}
        role="button"
        tabIndex={disabled ? -1 : 0}
      >
        <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-surface text-text-secondary">
          <UploadCloud aria-hidden="true" size={20} />
        </div>
        <div className="grid gap-1">
          <p className="m-0 text-sm font-semibold text-text">
            {file ? file.name : 'Drag and drop your file here'}
          </p>
          <p className="m-0 text-xs text-text-secondary" id="skill-zip-hint">
            {file ? formatFileSize(file.size) : 'ZIP only · Maximum 5 MB'}
          </p>
        </div>
        <div>
          <Button
            disabled={disabled}
            onClick={(event) => {
              event.stopPropagation();
              open();
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            {file ? 'Choose a different file' : 'Browse files'}
          </Button>
        </div>
        <input
          accept=".zip,application/zip"
          aria-describedby="skill-zip-hint skill-update-warning"
          className="sr-only"
          disabled={disabled}
          id="skill-zip"
          onChange={(event) => onFileSelected(event.target.files?.[0])}
          ref={inputRef}
          type="file"
        />
      </div>
    </div>
  );
}

export function SkillInstallDialog({
  onOpenChange,
  open,
  returnFocusRef,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropzoneRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<'upload' | 'attach'>('upload');
  const [file, setFile] = useState<File>();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string>();
  const [installed, setInstalled] = useState<BrowserSkill>();
  const inventoryQuery = useQuery(skillInventoryQuery);
  const matchingSkill = findMatchingSkill(file, inventoryQuery.data?.skills);

  const attachQuery = useQuery(
    skillAttachmentsQuery(installed?.id, step === 'attach'),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hydratedSkillId, setHydratedSkillId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [attachError, setAttachError] = useState<string>();

  useEffect(() => {
    if (open) return;
    setStep('upload');
    setFile(undefined);
    setError(undefined);
    setInstalled(undefined);
    setSelected(new Set());
    setHydratedSkillId(undefined);
    setSaving(false);
    setAttachError(undefined);
  }, [open]);

  useEffect(() => {
    if (step === 'attach') skipRef.current?.focus();
  }, [step]);

  useEffect(() => {
    if (
      step !== 'attach' ||
      !attachQuery.data ||
      attachQuery.isFetching ||
      attachQuery.isError ||
      hydratedSkillId === attachQuery.data.skillId
    )
      return;
    setSelected(attachedIds(attachQuery.data));
    setHydratedSkillId(attachQuery.data.skillId);
  }, [
    step,
    attachQuery.data,
    attachQuery.isFetching,
    attachQuery.isError,
    hydratedSkillId,
  ]);

  function changeOpen(next: boolean) {
    if (!next && (installing || saving)) return;
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
      setStep('attach');
      toast.success(`${skill.name} installed.`);
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

  function toggle(agentId: string) {
    setSelected((current) => toggleAgentSelection(current, agentId));
  }

  async function saveAttachmentsAndClose() {
    if (!installed || !attachQuery.data || hydratedSkillId !== installed.id) {
      changeOpen(false);
      return;
    }
    setSaving(true);
    setAttachError(undefined);
    const desiredIds = [...selected];
    try {
      const result = await replaceSkillAttachments(installed.id, desiredIds);
      queryClient.setQueryData(
        skillAttachmentsQuery(installed.id, true).queryKey,
        result,
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: skillInventoryQuery.queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: navigationSummaryQuery.queryKey,
        }),
        ...desiredIds.map((agentId) =>
          queryClient.invalidateQueries({
            queryKey: [...agentQueryKeys.all, 'sources', agentId],
          }),
        ),
      ]);
      setSaving(false);
      toast.success('Attachments saved.');
      changeOpen(false);
    } catch (caught) {
      setAttachError(messageFor(caught, 'Attachments could not be saved.'));
      setSaving(false);
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
          if (installing || saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (installing || saving) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dropzoneRef.current?.focus();
        }}
        showCloseButton={!installing && !saving}
      >
        {step === 'upload' ? (
          <>
            <div className="grid gap-1">
              <DialogTitle className="text-lg font-semibold">
                Install skill
              </DialogTitle>
              <DialogDescription>
                Add a ZIP package to Gantry’s skill inventory, then choose which
                AI employees receive it.
              </DialogDescription>
            </div>

            <div className="grid gap-4">
              <SkillDropzone
                containerRef={dropzoneRef}
                disabled={installing}
                file={file}
                inputRef={fileInputRef}
                onFileSelected={(next) => {
                  setFile(next);
                  setError(undefined);
                }}
              />
              {matchingSkill ? (
                <p
                  className="m-0 text-xs leading-5 text-status-attention"
                  id="skill-update-warning"
                >
                  This will replace the existing skill “{matchingSkill.name}”
                  since the name matches. Click Install to replace it.
                </p>
              ) : (
                <p
                  className="m-0 text-xs leading-5 text-text-secondary"
                  id="skill-update-warning"
                >
                  Installing a package with the same skill name updates it in
                  place. Attached AI employees receive the updated instructions
                  on their next run.
                </p>
              )}
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
                <Button
                  disabled={!file || installing}
                  onClick={() => void install()}
                  type="button"
                >
                  {installing ? 'Installing…' : 'Install skill'}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-1">
              <DialogTitle className="text-lg font-semibold">
                Attach AI employees
              </DialogTitle>
              <DialogDescription>
                Choose which AI employees receive this skill’s instructions on
                their next run. You can skip this and attach it later.
              </DialogDescription>
            </div>

            <div className="grid gap-4">
              {attachQuery.isPending ? (
                <p
                  aria-live="polite"
                  className="m-0 text-sm text-text-secondary"
                >
                  Loading AI employees…
                </p>
              ) : null}
              {attachQuery.isError ? (
                <p className="m-0 text-sm text-danger" role="alert">
                  AI employees could not be loaded.
                </p>
              ) : null}
              {attachQuery.data && !attachQuery.isError ? (
                <fieldset
                  className="m-0 grid gap-2 border-0 p-0"
                  disabled={saving}
                >
                  <legend className="mb-2 text-xs font-semibold text-text">
                    AI employees
                  </legend>
                  {attachQuery.data.agents.map((agent) => (
                    <label
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface-muted p-3 has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
                      key={agent.id}
                    >
                      <Checkbox
                        aria-label={`Attach ${installed?.name ?? 'skill'} to ${agent.name}`}
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
                            ? 'Disabled · available when the AI employee is enabled.'
                            : 'Active'}
                        </span>
                      </span>
                    </label>
                  ))}
                  {!attachQuery.data.agents.length ? (
                    <p className="m-0 text-sm text-text-secondary">
                      No AI employees are available in this app.
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
              {attachError ? (
                <p
                  aria-live="assertive"
                  className="m-0 text-sm text-danger"
                  role="alert"
                >
                  {attachError}
                </p>
              ) : null}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  disabled={saving}
                  onClick={() => changeOpen(false)}
                  ref={skipRef}
                  type="button"
                  variant="secondary"
                >
                  Skip
                </Button>
                <Button
                  disabled={saving}
                  onClick={() => void saveAttachmentsAndClose()}
                  type="button"
                >
                  {saving ? 'Saving…' : 'Done'}
                </Button>
              </div>
            </div>
          </>
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
    if (!query.data || query.isFetching || query.isError) return;
    const ids = attachedIds(query.data);
    if (initializedSkillId.current === query.data.skillId) {
      if (reconciliationRequired) {
        setSelected(ids);
        setConfirmed(new Set(ids));
        setReconciliationRequired(false);
      }
      return;
    }
    initializedSkillId.current = query.data.skillId;
    setSelected(ids);
    setConfirmed(new Set(ids));
    setHydratedSkillId(query.data.skillId);
  }, [
    open,
    query.data,
    query.isError,
    query.isFetching,
    reconciliationRequired,
  ]);

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
      setSuccess(
        'Attachments saved. Changes apply on each AI employee’s next run.',
      );
      onSaved(skill, result.agents.filter((agent) => agent.attached).length);
    } catch (caught) {
      const code = errorCode(caught);
      if (code === 'SETTINGS_PROJECTION_FAILED' || !code) {
        const refreshed = await query.refetch();
        if (refreshed.isSuccess && refreshed.data) {
          const ids = attachedIds(refreshed.data);
          setSelected(ids);
          setConfirmed(new Set(ids));
        } else {
          setReconciliationRequired(true);
        }
      } else {
        setSelected(new Set(confirmed));
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
            Attach AI employees
          </DialogTitle>
          <DialogDescription>
            Choose which AI employees receive this skill’s instructions on their
            next run.
          </DialogDescription>
        </div>

        <div className="min-h-0 overflow-y-auto p-5">
          <p className="mt-0 mb-4 rounded-lg border border-border bg-surface-muted p-3 text-xs leading-5 text-text-secondary">
            Attachment is not authorization. Declared actions must still be
            enabled from each AI employee’s Access tab.
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
                    initializedSkillId.current = refreshed.data.skillId;
                    setHydratedSkillId(refreshed.data.skillId);
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
                AI employees
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
                        ? 'Disabled · available when the AI employee is enabled.'
                        : 'Active'}
                    </span>
                  </span>
                </label>
              ))}
              {!query.data.agents.length ? (
                <p className="m-0 text-sm text-text-secondary">
                  No AI employees are available in this app.
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
                  : `${selected.size} AI employee${selected.size === 1 ? '' : 's'} selected${
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
