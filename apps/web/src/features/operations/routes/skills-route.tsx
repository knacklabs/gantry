import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  FileBox,
  PackageCheck,
  PackageOpen,
  SearchX,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
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
  agent_created: 'Agent created',
  admin_uploaded: 'Admin uploaded',
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

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

export function resolveSkillSelection(
  visibleSkills: readonly BrowserSkill[],
  requestedId: string | undefined,
): BrowserSkill | undefined {
  return (
    visibleSkills.find((skill) => skill.id === requestedId) ?? visibleSkills[0]
  );
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
  useEffect(() => {
    if (!inventoryQuery.isSuccess || !search.skill) {
      return;
    }
    const selectedSkillId = selectedSkill?.id;
    if (
      selectedSkillId === search.skill ||
      (!selectedSkillId && skills.some((skill) => skill.id === search.skill))
    ) {
      return;
    }
    void navigate({
      replace: true,
      search: (previous) => ({ ...previous, skill: selectedSkillId }),
    });
  }, [inventoryQuery.isSuccess, navigate, search.skill, selectedSkill, skills]);
  const [requestedFilePath, setRequestedFilePath] = useState<string>();
  const installTriggerRef = useRef<HTMLButtonElement>(null);
  const attachmentReturnFocusRef = useRef<HTMLElement | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [attachmentSkill, setAttachmentSkill] = useState<BrowserSkill>();
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [receipt, setReceipt] = useState<string>();
  const filesQuery = useQuery(
    skillFilesQuery(selectedSkill?.id, search.tab === 'files'),
  );
  const selectedFile =
    filesQuery.data?.files.find((file) => file.path === requestedFilePath) ??
    filesQuery.data?.files[0];
  const fileQuery = useQuery(
    skillFileQuery(
      selectedSkill?.id,
      selectedFile?.path,
      search.tab === 'files',
    ),
  );

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

      {selectedSkill ? (
        <div
          className="grid items-start gap-4 lg:grid-cols-[minmax(240px,0.72fr)_minmax(0,1.6fr)]"
          data-layout="responsive-split"
        >
          <SkillInventory
            selectedId={selectedSkill.id}
            skills={visibleSkills}
            total={skills.length}
            onSelect={(skillId) =>
              void navigate({
                search: (previous) => ({ ...previous, skill: skillId }),
              })
            }
          />
          <SkillDetail
            canManage={canManage}
            file={fileQuery.data?.file}
            fileError={fileQuery.isError}
            fileLoading={fileQuery.isPending}
            files={filesQuery.data?.files}
            filesError={filesQuery.isError}
            filesLoading={filesQuery.isPending}
            onFileRetry={() => void fileQuery.refetch()}
            onFilesRetry={() => void filesQuery.refetch()}
            selectedFilePath={selectedFile?.path}
            skill={selectedSkill}
            tab={search.tab}
            onManageAttachments={(trigger) => {
              attachmentReturnFocusRef.current = trigger;
              setAttachmentSkill(selectedSkill);
              setAttachmentOpen(true);
            }}
            onFileSelect={setRequestedFilePath}
            onTabChange={(tab) =>
              void navigate({
                search: (previous) => ({ ...previous, tab }),
              })
            }
          />
        </div>
      ) : null}

      {canManage ? (
        <>
          <SkillInstallDialog
            onAttachAgents={(skill) => {
              attachmentReturnFocusRef.current = installTriggerRef.current;
              setAttachmentSkill(skill);
              setAttachmentOpen(true);
            }}
            onOpenChange={setInstallOpen}
            onViewSkill={(skill) =>
              void navigate({
                search: (previous) => ({
                  ...previous,
                  q: '',
                  skill: skill.id,
                  tab: 'overview',
                }),
              })
            }
            open={installOpen}
            returnFocusRef={installTriggerRef}
          />
          <SkillAttachmentsDialog
            onOpenChange={setAttachmentOpen}
            onSaved={() =>
              setReceipt(
                'Attachments saved. Changes apply on each agent’s next run.',
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

function SkillInventory({
  onSelect,
  selectedId,
  skills,
  total,
}: {
  onSelect: (skillId: string) => void;
  selectedId: string;
  skills: readonly BrowserSkill[];
  total: number;
}) {
  return (
    <Panel
      description={`${skills.length} of ${total} shown`}
      title="Installed inventory"
    >
      <ul className="m-0 grid max-h-[38rem] list-none divide-y divide-border overflow-y-auto p-0">
        {skills.map((skill) => (
          <li key={skill.id}>
            <button
              aria-current={selectedId === skill.id ? 'true' : undefined}
              className={`grid w-full gap-2 border-l-2 px-4 py-3.5 text-left focus-visible:relative ${
                selectedId === skill.id
                  ? 'border-l-status-success bg-surface-muted'
                  : 'border-l-transparent hover:bg-surface-muted'
              }`}
              onClick={() => onSelect(skill.id)}
              type="button"
            >
              <span className="flex min-w-0 items-center justify-between gap-3">
                <span className="truncate text-sm font-semibold text-text">
                  {skill.name}
                </span>
                <StatusBadge status={skill.status} />
              </span>
              <span className="line-clamp-2 text-xs leading-5 text-text-secondary">
                {skill.description ?? 'No description provided.'}
              </span>
              <span className="font-mono text-[10px] tracking-wide text-text-muted uppercase">
                {SOURCE_LABELS[skill.source]} · {skill.attachedAgents.length}{' '}
                agent
                {skill.attachedAgents.length === 1 ? '' : 's'}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function SkillDetail({
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
  onTabChange,
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
  onTabChange: (tab: SkillTab) => void;
  selectedFilePath?: string;
  skill: BrowserSkill;
  tab: SkillTab;
}) {
  return (
    <Panel
      action={
        <div className="flex items-center gap-2">
          {canManage && skill.status === 'installed' ? (
            <Button
              onClick={(event) => onManageAttachments(event.currentTarget)}
              size="sm"
              variant="secondary"
            >
              Manage attachments
            </Button>
          ) : null}
          <StatusBadge status={skill.status} />
        </div>
      }
      className="min-h-[32rem]"
      title={skill.name}
    >
      <div className="border-b border-border px-4 py-3" id="skill-details">
        <p className="m-0 max-w-3xl text-sm leading-6 text-text-secondary">
          {skill.description ?? 'No description provided.'}
        </p>
      </div>
      <RouteTabs
        label="Skill details"
        value={tab}
        onValueChange={onTabChange}
        tabs={[
          { label: 'Overview', value: 'overview' },
          { label: 'Files', value: 'files', count: files?.length },
          { label: 'Actions', value: 'actions', count: skill.actions.length },
          {
            label: 'Agents',
            value: 'agents',
            count: skill.attachedAgents.length,
          },
        ]}
      />
      <div className="p-4">
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
        {tab === 'agents' ? <AgentsTab skill={skill} /> : null}
      </div>
    </Panel>
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
          This inventory describes what the package contains. Agent attachment
          and action authority remain separate controls.
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

function AgentsTab({ skill }: { skill: BrowserSkill }) {
  if (!skill.attachedAgents.length) {
    return (
      <PageState
        description="This skill is not attached to an agent."
        icon={<PackageCheck aria-hidden="true" />}
        kind="empty"
        title="No attached agents"
      />
    );
  }
  return (
    <div className="grid gap-3">
      <p className="m-0 text-sm leading-6 text-text-secondary">
        Attachment makes the skill available to an agent. Agent Access remains
        the only place to review authorization.
      </p>
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
              Open Agent Access
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
