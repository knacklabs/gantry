import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowRight,
  FileBox,
  PackageCheck,
  PackageOpen,
  SearchX,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';

import { titleCaseLabel } from '../../../lib/utils';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { RouteTabs } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../../ui/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import type { SkillTab } from '../operations-search';
import {
  skillFileQuery,
  skillFilesQuery,
  skillInventoryQuery,
  type BrowserSkill,
  type BrowserSkillFileMetadata,
} from '../skills-queries';
import {
  SkillAttachmentsDialog,
  SkillInstallDialog,
} from './skills-admin-dialogs';

const SOURCE_LABELS: Record<BrowserSkill['source'], string> = {
  bundled: 'Bundled',
  agent_created: 'Created by an AI employee',
  admin_uploaded: 'Admin uploaded',
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

// How many cards are revealed at once. Skill inventory metadata is cheap to
// fetch in full (no file contents), but rendering hundreds of cards at once
// is still wasted DOM work — this windows the RENDER, not the network fetch.
const CARD_PAGE_SIZE = 24;

export function filterSkills(
  skills: readonly BrowserSkill[],
  query: string,
): BrowserSkill[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...skills];
  return skills.filter((skill) =>
    `${skill.name} ${skill.description ?? ''} ${skill.id} ${SOURCE_LABELS[skill.source]} ${skill.status}`
      .toLowerCase()
      .includes(normalized),
  );
}

// Unlike the old split-panel layout, there is no default "first skill"
// selection: the detail modal only opens for a skill explicitly requested by
// id (via clicking a card's Manage button, or a deep link).
export function resolveSkillSelection(
  visibleSkills: readonly BrowserSkill[],
  requestedId: string | undefined,
): BrowserSkill | undefined {
  if (!requestedId) return undefined;
  return visibleSkills.find((skill) => skill.id === requestedId);
}

export function SkillsRoute() {
  const search = useSearch({ from: '/skills' });
  const navigate = useNavigate({ from: '/skills' });
  const inventoryQuery = useQuery(skillInventoryQuery);
  const canManage = inventoryQuery.data?.role === 'administrator';
  const skills = inventoryQuery.data?.skills ?? [];
  const visibleSkills = useMemo(
    () => filterSkills(skills, search.q),
    [search.q, skills],
  );
  const selectedSkill = resolveSkillSelection(visibleSkills, search.skill);

  const [visibleCount, setVisibleCount] = useState(CARD_PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(CARD_PAGE_SIZE);
  }, [search.q]);
  const cards = visibleSkills.slice(0, visibleCount);
  const hasMoreCards = visibleCount < visibleSkills.length;
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hasMoreCards) return;
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((current) => current + CARD_PAGE_SIZE);
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreCards]);

  const installTriggerRef = useRef<HTMLButtonElement>(null);
  const attachmentReturnFocusRef = useRef<HTMLElement | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [attachmentSkill, setAttachmentSkill] = useState<BrowserSkill>();
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [receipt, setReceipt] = useState<string>();
  const [requestedFilePath, setRequestedFilePath] = useState<string>();
  const detailOpen = Boolean(selectedSkill);
  const filesQuery = useQuery(
    skillFilesQuery(selectedSkill?.id, detailOpen && search.tab === 'files'),
  );
  const selectedFile =
    filesQuery.data?.files.find((file) => file.path === requestedFilePath) ??
    filesQuery.data?.files[0];
  const fileQuery = useQuery(
    skillFileQuery(
      selectedSkill?.id,
      selectedFile?.path,
      detailOpen && search.tab === 'files',
    ),
  );

  function closeDetail() {
    setRequestedFilePath(undefined);
    void navigate({
      search: (previous) => ({ ...previous, skill: undefined }),
    });
  }

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        action={
          canManage ? (
            <Button
              onClick={() => setInstallOpen(true)}
              ref={installTriggerRef}
            >
              Install skill
            </Button>
          ) : null
        }
        eyebrow="Configure"
        title="Skills"
        description="Inspect installed skill packages, their declared actions, and where they are attached."
      />

      <p
        aria-atomic="true"
        aria-live="polite"
        className={
          receipt
            ? 'm-0 rounded-lg border border-status-success/40 bg-status-success-soft px-4 py-3 text-sm text-status-success'
            : 'sr-only'
        }
      >
        {receipt ?? ''}
      </p>

      <div className="max-w-md">
        <TextField
          disabled={inventoryQuery.isLoading || inventoryQuery.isError}
          id="skills-search"
          label="Search skills"
          name="q"
          onChange={(event) =>
            void navigate({
              replace: true,
              search: (previous) => ({
                ...previous,
                q: event.target.value,
              }),
            })
          }
          placeholder="Name, description, ID, source, or status"
          value={search.q}
        />
      </div>

      {inventoryQuery.isLoading ? (
        <PageState
          description="Reading the installed skill inventory."
          icon={<PackageCheck aria-hidden="true" />}
          kind="loading"
          title="Loading skills"
        />
      ) : null}
      {inventoryQuery.isError ? (
        <PageState
          action={
            <Button onClick={() => void inventoryQuery.refetch()}>Retry</Button>
          }
          description="Refresh the page to try loading the inventory again."
          icon={<AlertTriangle aria-hidden="true" />}
          kind="error"
          title="Skills could not be loaded"
        />
      ) : null}
      {!inventoryQuery.isLoading &&
      !inventoryQuery.isError &&
      !skills.length ? (
        <PageState
          description="Installed skills will appear here when an administrator adds them."
          icon={<PackageOpen aria-hidden="true" />}
          kind="empty"
          title="No skills installed"
        />
      ) : null}
      {!inventoryQuery.isLoading &&
      !inventoryQuery.isError &&
      skills.length > 0 &&
      !visibleSkills.length ? (
        <PageState
          description="Try a different name, description, ID, source, or status."
          icon={<SearchX aria-hidden="true" />}
          kind="empty"
          title="No skills match this search"
        />
      ) : null}

      {cards.length ? (
        <div
          className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4"
          data-layout="skill-card-grid"
        >
          {cards.map((skill) => (
            <SkillCard
              key={skill.id}
              onManage={() =>
                void navigate({
                  search: (previous) => ({
                    ...previous,
                    skill: skill.id,
                    tab: 'overview',
                  }),
                })
              }
              skill={skill}
            />
          ))}
        </div>
      ) : null}
      {hasMoreCards ? <div aria-hidden="true" ref={loadMoreRef} /> : null}

      <SkillDetailDialog
        canManage={canManage}
        file={fileQuery.data?.file}
        fileError={fileQuery.isError}
        fileLoading={fileQuery.isPending}
        files={filesQuery.data?.files}
        filesError={filesQuery.isError}
        filesLoading={filesQuery.isPending}
        onFileRetry={() => void fileQuery.refetch()}
        onFilesRetry={() => void filesQuery.refetch()}
        onManageAttachments={(trigger) => {
          attachmentReturnFocusRef.current = trigger;
          setAttachmentSkill(selectedSkill);
          setAttachmentOpen(true);
        }}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
        onFileSelect={setRequestedFilePath}
        onTabChange={(tab) =>
          void navigate({
            search: (previous) => ({ ...previous, tab }),
          })
        }
        open={detailOpen}
        selectedFilePath={selectedFile?.path}
        skill={selectedSkill}
        tab={search.tab}
      />

      {canManage ? (
        <>
          <SkillInstallDialog
            onOpenChange={setInstallOpen}
            open={installOpen}
            returnFocusRef={installTriggerRef}
          />
          <SkillAttachmentsDialog
            onOpenChange={setAttachmentOpen}
            onSaved={() =>
              setReceipt(
                'Attachments saved. Changes apply on each AI employee’s next run.',
              )
            }
            open={attachmentOpen}
            returnFocusRef={attachmentReturnFocusRef}
            skill={attachmentSkill}
          />
        </>
      ) : null}
    </div>
  );
}

function SkillCard({
  onManage,
  skill,
}: {
  onManage: (event: MouseEvent<HTMLButtonElement>) => void;
  skill: BrowserSkill;
}) {
  return (
    <Card className="h-full gap-3 bg-[linear-gradient(180deg,rgb(127_127_127_/_10%),rgb(127_127_127_/_4%))] shadow-[inset_-1px_0_0_rgb(255_255_255_/_4%)] ring-white/20 backdrop-blur-[22px] backdrop-saturate-150">
      <CardHeader>
        <CardTitle className="truncate text-sm">
          {titleCaseLabel(skill.name)}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <p className="m-0 line-clamp-3 min-h-[3.9rem] text-ui text-text-secondary">
          {skill.description ?? 'No description provided.'}
        </p>
        <div className="mt-auto flex items-center justify-between gap-3">
          <span className="text-xs text-text-secondary">
            {SOURCE_LABELS[skill.source]}
          </span>
          <Button
            className="h-auto w-fit gap-1 p-0 text-status-success hover:text-status-success"
            onClick={onManage}
            type="button"
            variant="link"
          >
            Manage
            <ArrowRight aria-hidden="true" size={14} />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SkillDetailDialog({
  canManage,
  file,
  fileError,
  fileLoading,
  files,
  filesError,
  filesLoading,
  onManageAttachments,
  onFileSelect,
  onFileRetry,
  onFilesRetry,
  onOpenChange,
  onTabChange,
  open,
  selectedFilePath,
  skill,
  tab,
}: {
  canManage: boolean;
  file?: BrowserSkillFileMetadata & { content: string | null };
  fileError: boolean;
  fileLoading: boolean;
  files?: BrowserSkillFileMetadata[];
  filesError: boolean;
  filesLoading: boolean;
  onManageAttachments: (trigger: HTMLButtonElement) => void;
  onFileSelect: (path: string) => void;
  onFileRetry: () => void;
  onFilesRetry: () => void;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: SkillTab) => void;
  open: boolean;
  selectedFilePath?: string;
  skill: BrowserSkill | undefined;
  tab: SkillTab;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="grid max-h-[calc(100dvh-32px)] w-[min(760px,calc(100vw-32px))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-none">
        {skill ? (
          <>
            <div className="grid gap-1 border-b border-border px-5 py-4">
              <div className="flex min-w-0 items-center gap-2">
                <DialogTitle className="truncate text-sm font-semibold">
                  {titleCaseLabel(skill.name)}
                </DialogTitle>
                <StatusBadge status={skill.status} />
              </div>
              <DialogDescription className="line-clamp-2 text-ui text-text-secondary">
                {skill.description ?? 'No description provided.'}
              </DialogDescription>
            </div>
            <RouteTabs
              label="Skill details"
              value={tab}
              onValueChange={onTabChange}
              tabs={[
                { label: 'Overview', value: 'overview' },
                { label: 'Files', value: 'files', count: files?.length },
                {
                  label: 'Actions',
                  value: 'actions',
                  count: skill.actions.length,
                },
                {
                  label: 'AI employees',
                  value: 'agents',
                  count: skill.attachedAgents.length,
                },
              ]}
            />
            <div className="min-h-0 overflow-y-auto p-5">
              {tab === 'overview' ? <OverviewTab skill={skill} /> : null}
              {tab === 'files' ? (
                <FilesTab
                  file={file}
                  fileError={fileError}
                  fileLoading={fileLoading}
                  files={files}
                  filesError={filesError}
                  filesLoading={filesLoading}
                  onFileRetry={onFileRetry}
                  onFilesRetry={onFilesRetry}
                  selectedFilePath={selectedFilePath}
                  onFileSelect={onFileSelect}
                />
              ) : null}
              {tab === 'actions' ? <ActionsTab skill={skill} /> : null}
              {tab === 'agents' ? (
                <AgentsTab
                  canManage={canManage}
                  onManageAttachments={onManageAttachments}
                  skill={skill}
                />
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function OverviewTab({ skill }: { skill: BrowserSkill }) {
  const facts = [
    ['Source', SOURCE_LABELS[skill.source]],
    ['Package size', `${skill.sizeBytes.toLocaleString()} bytes`],
    ['Installed', dateTimeFormatter.format(new Date(skill.createdAt))],
    ['Last updated', dateTimeFormatter.format(new Date(skill.updatedAt))],
  ];
  return (
    <div className="grid gap-5">
      <div>
        <h3 className="m-0 text-sm font-semibold text-text">
          Package overview
        </h3>
        <p className="mt-1 mb-0 text-sm leading-6 text-text-secondary">
          This inventory describes what the package contains. AI employee
          attachment and action authority remain separate controls.
        </p>
      </div>
      <dl className="m-0 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div className="bg-surface-muted p-3" key={label}>
            <dt className="font-mono text-[10px] font-semibold tracking-wide text-text-muted uppercase">
              {label}
            </dt>
            <dd className="mt-1 mb-0 text-sm text-text">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function FilesTab({
  file,
  fileError,
  fileLoading,
  files,
  filesError,
  filesLoading,
  onFileSelect,
  onFileRetry,
  onFilesRetry,
  selectedFilePath,
}: {
  file?: BrowserSkillFileMetadata & { content: string | null };
  fileError: boolean;
  fileLoading: boolean;
  files?: BrowserSkillFileMetadata[];
  filesError: boolean;
  filesLoading: boolean;
  onFileSelect: (path: string) => void;
  onFileRetry: () => void;
  onFilesRetry: () => void;
  selectedFilePath?: string;
}) {
  if (filesLoading) {
    return (
      <PageState
        description="Reading package file metadata."
        icon={<FileBox aria-hidden="true" />}
        kind="loading"
        title="Loading files"
      />
    );
  }
  if (filesError) {
    return (
      <PageState
        action={<Button onClick={onFilesRetry}>Retry</Button>}
        description="The package file list is unavailable."
        icon={<AlertTriangle aria-hidden="true" />}
        kind="error"
        title="Files could not be loaded"
      />
    );
  }
  if (!files?.length) {
    return (
      <PageState
        description="This package has no inspectable files."
        icon={<FileBox aria-hidden="true" />}
        kind="empty"
        title="No files"
      />
    );
  }
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(180px,0.68fr)_minmax(0,1.4fr)]">
      <div className="overflow-hidden rounded-lg border border-border">
        <ul className="m-0 grid max-h-[28rem] list-none divide-y divide-border overflow-y-auto p-0">
          {files.map((item) => (
            <li key={item.path}>
              <button
                aria-current={
                  selectedFilePath === item.path ? 'true' : undefined
                }
                className={`grid w-full gap-1 px-3 py-2.5 text-left ${
                  selectedFilePath === item.path
                    ? 'bg-surface-strong'
                    : 'hover:bg-surface-muted'
                }`}
                onClick={() => onFileSelect(item.path)}
                type="button"
              >
                <span className="break-all font-mono text-xs text-text">
                  {item.path}
                </span>
                <span className="text-[11px] text-text-muted">
                  {item.isText ? 'Text' : 'Binary'} ·{' '}
                  {item.sizeBytes.toLocaleString()} bytes
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <FilePreview
        error={fileError}
        file={file}
        loading={fileLoading}
        onRetry={onFileRetry}
      />
    </div>
  );
}

function FilePreview({
  error,
  file,
  loading,
  onRetry,
}: {
  error: boolean;
  file?: BrowserSkillFileMetadata & { content: string | null };
  loading: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <div
        aria-busy="true"
        className="min-h-48 rounded-lg border border-border bg-surface-muted p-4 text-sm text-text-secondary"
      >
        Loading preview…
      </div>
    );
  }
  if (error || !file) {
    return (
      <div className="min-h-48 rounded-lg border border-danger/40 bg-danger-soft p-4 text-sm text-danger">
        <p className="m-0">This file preview could not be loaded.</p>
        <Button
          className="mt-3"
          onClick={onRetry}
          size="sm"
          variant="secondary"
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!file.isText) {
    return (
      <div className="min-h-48 rounded-lg border border-border bg-surface-muted p-4">
        <p className="m-0 text-sm font-semibold text-text">Binary file</p>
        <p className="mt-1 mb-4 text-sm text-text-secondary">
          Binary contents are not displayed.
        </p>
        <dl className="m-0 grid gap-2 text-xs">
          <div>
            <dt className="text-text-muted">Content type</dt>
            <dd className="m-0 text-text">{file.contentType ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Size</dt>
            <dd className="m-0 text-text">
              {file.sizeBytes.toLocaleString()} bytes
            </dd>
          </div>
        </dl>
      </div>
    );
  }
  return (
    <pre
      aria-label={`${file.path} text preview`}
      className="m-0 max-h-[28rem] min-h-48 overflow-auto rounded-lg border border-border bg-surface-muted p-4 font-mono text-xs leading-5 whitespace-pre-wrap text-text"
    >
      {file.content}
    </pre>
  );
}

function ActionsTab({ skill }: { skill: BrowserSkill }) {
  if (!skill.actions.length) {
    return (
      <PageState
        description="This skill does not declare any actions."
        icon={<PackageCheck aria-hidden="true" />}
        kind="empty"
        title="No declared actions"
      />
    );
  }
  return (
    <div className="grid gap-3">
      <p className="m-0 rounded-md border border-status-attention/40 bg-status-attention-soft px-3 py-2.5 text-xs leading-5 text-status-attention">
        Declared actions are read-only inventory metadata. Attachment does not
        grant authority to run them.
      </p>
      {skill.actions.map((action) => (
        <article
          className="grid gap-4 rounded-lg border border-border bg-surface-muted p-4"
          key={action.id}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="m-0 text-sm font-semibold text-text">
                {action.displayName}
              </h3>
              <p className="mt-1 mb-0 font-mono text-[11px] text-text-muted">
                {action.capabilityId}
              </p>
            </div>
            <Badge
              variant={
                action.risk === 'admin'
                  ? 'danger'
                  : action.risk === 'write'
                    ? 'attention'
                    : 'neutral'
              }
            >
              {action.risk} risk
            </Badge>
          </div>
          <dl className="m-0 grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold text-text">Can</dt>
              <dd className="mt-1 mb-0 text-sm leading-6 text-text-secondary">
                {action.can}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold text-text">Cannot</dt>
              <dd className="mt-1 mb-0 text-sm leading-6 text-text-secondary">
                {action.cannot}
              </dd>
            </div>
          </dl>
          <MetadataList
            empty="No credentials required"
            items={action.requiredCredentialNames}
            label="Required credentials"
          />
          <MetadataList
            empty="No network hosts declared"
            items={action.networkHosts}
            label="Network hosts"
          />
        </article>
      ))}
    </div>
  );
}

function MetadataList({
  empty,
  items,
  label,
}: {
  empty: string;
  items: readonly string[];
  label: string;
}) {
  return (
    <div>
      <h4 className="m-0 text-xs font-semibold text-text">{label}</h4>
      {items.length ? (
        <ul className="mt-2 mb-0 flex list-none flex-wrap gap-1.5 p-0">
          {items.map((item) => (
            <li key={item}>
              <Badge className="font-mono" variant="outline">
                {item}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 mb-0 text-xs text-text-muted">{empty}</p>
      )}
    </div>
  );
}

function AgentsTab({
  canManage,
  onManageAttachments,
  skill,
}: {
  canManage: boolean;
  onManageAttachments: (trigger: HTMLButtonElement) => void;
  skill: BrowserSkill;
}) {
  const manageButton =
    canManage && skill.status === 'installed' ? (
      <Button onClick={(event) => onManageAttachments(event.currentTarget)}>
        Manage attachments
      </Button>
    ) : null;

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 min-w-0 flex-1 text-sm leading-6 text-text-secondary">
          Attachment makes the skill available to an AI employee. AI employee
          Access remains the only place to review authorization.
        </p>
        {manageButton ? <div className="shrink-0">{manageButton}</div> : null}
      </div>
      {!skill.attachedAgents.length ? (
        <PageState
          description="This skill is not attached to an AI employee."
          icon={<PackageCheck aria-hidden="true" />}
          kind="empty"
          title="No attached AI employees"
        />
      ) : (
        <ul className="m-0 grid list-none divide-y divide-border overflow-hidden rounded-lg border border-border p-0">
          {skill.attachedAgents.map((agent) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 bg-surface-muted px-4 py-3"
              key={agent.id}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold text-text">
                  {agent.name}
                </span>
                <StatusBadge status={agent.status} />
              </div>
              <Link
                className="text-xs font-semibold text-text underline-offset-4 hover:underline"
                params={{ agentId: agent.id }}
                search={{ tab: 'access' }}
                to="/agents/$agentId"
              >
                Open AI employee access
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
