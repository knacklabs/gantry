import {
  BookOpen,
  Box,
  CheckCircle2,
  FileText,
  Link2,
  Plus,
  ShieldCheck,
} from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageState } from '../../../ui/compositions/page-state';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import type { AgentPreview, SourcePreview } from '../agents-preview';
import { AgentIdentityForm } from './agent-identity-form';

export type AgentDetailTab =
  | 'identity'
  | 'profile'
  | 'sources'
  | 'capabilities'
  | 'skills'
  | 'mcp'
  | 'access'
  | 'conversations';

export function AgentDetailSection({
  agent,
  sources,
  tab,
}: {
  agent: AgentPreview;
  sources: SourcePreview[];
  tab: AgentDetailTab;
}) {
  const { requestConnection } = useConnectionGate();
  const attachedSources = sources.filter((source) =>
    agent.sources.includes(source.id),
  );

  if (tab === 'identity') return <AgentIdentityForm agent={agent} />;

  if (tab === 'profile') {
    return (
      <div className="grid gap-4 p-5">
        <ProfileFile
          name="SOUL.md"
          description="Durable values and behavioral character."
          content={agent.profile.soul}
        />
        <ProfileFile
          name="AGENTS.md"
          description="Operational instructions mounted for this agent."
          content={agent.profile.instructions}
        />
        <div>
          <Button
            onClick={() => requestConnection(`Edit profile for ${agent.name}`)}
          >
            <FileText size={16} aria-hidden="true" />
            Edit protected profile
          </Button>
        </div>
      </div>
    );
  }

  if (tab === 'sources') {
    return (
      <Collection
        title="Attached sources"
        description="Reviewed catalogs projected into this agent's runtime."
        action="Attach source"
        onAction={() => requestConnection(`Attach source to ${agent.name}`)}
      >
        {attachedSources.map((source) => (
          <div
            className="grid gap-2 rounded-md border border-border p-4"
            key={source.id}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <strong className="text-[13px] text-text">{source.name}</strong>
              <StatusBadge status={source.status} />
            </div>
            <span className="text-xs text-text-secondary">
              {source.kind} · {source.version}
            </span>
            <p className="m-0 text-xs leading-5 text-text-secondary">
              {source.description}
            </p>
          </div>
        ))}
      </Collection>
    );
  }

  if (tab === 'capabilities') {
    return (
      <Collection
        title="Selected capabilities"
        description="Durable reviewed authority represented by this preview."
        action="Review capabilities"
        onAction={() =>
          requestConnection(`Review capabilities for ${agent.name}`)
        }
      >
        {agent.capabilities.map((capability) => (
          <div
            className="flex min-h-14 items-center justify-between gap-3 rounded-md border border-border px-4"
            key={capability}
          >
            <span className="inline-flex items-center gap-2 text-[13px] font-medium text-text">
              <ShieldCheck
                className="text-status-success"
                size={16}
                aria-hidden="true"
              />
              {capability}
            </span>
            <Badge tone="success">Selected</Badge>
          </div>
        ))}
      </Collection>
    );
  }

  if (tab === 'skills') {
    return agent.skills.length ? (
      <Collection
        title="Skills"
        description="Reviewed skill versions active for this agent."
        action="Add skill"
        onAction={() => requestConnection(`Add skill to ${agent.name}`)}
      >
        {agent.skills.map((skill) => (
          <ResourceRow
            icon={<BookOpen size={16} aria-hidden="true" />}
            key={skill}
            name={skill}
            meta="Reviewed version"
          />
        ))}
      </Collection>
    ) : (
      <EmptyResource
        title="No skills selected"
        action="Add skill"
        onAction={() => requestConnection(`Add skill to ${agent.name}`)}
      />
    );
  }

  if (tab === 'mcp') {
    return agent.mcpServers.length ? (
      <Collection
        title="MCP servers"
        description="Approved server bindings available on the next run."
        action="Attach MCP server"
        onAction={() => requestConnection(`Attach MCP server to ${agent.name}`)}
      >
        {agent.mcpServers.map((server) => (
          <ResourceRow
            icon={<Box size={16} aria-hidden="true" />}
            key={server}
            name={server}
            meta="Approved · Ready"
          />
        ))}
      </Collection>
    ) : (
      <EmptyResource
        title="No MCP servers attached"
        action="Attach MCP server"
        onAction={() => requestConnection(`Attach MCP server to ${agent.name}`)}
      />
    );
  }

  if (tab === 'access') {
    return (
      <div className="grid gap-4 p-5">
        <div>
          <h2 className="m-0 text-sm font-semibold text-text">Access review</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
            Effective preview authority derived from selected sources and
            capabilities.
          </p>
        </div>
        {agent.capabilities.map((capability) => (
          <div
            className="grid gap-2 rounded-md border border-border p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
            key={capability}
          >
            <span>
              <strong className="block text-[13px] text-text">
                {capability}
              </strong>
              <span className="mt-1 block text-xs text-text-secondary">
                Selected durable capability
              </span>
            </span>
            <span className="inline-flex items-center gap-2 text-xs text-status-success">
              <CheckCircle2 size={15} aria-hidden="true" /> Effective
            </span>
          </div>
        ))}
        <Button
          variant="secondary"
          onClick={() => requestConnection(`Change access for ${agent.name}`)}
        >
          Review access
        </Button>
      </div>
    );
  }

  return agent.conversations.length ? (
    <Collection
      title="Conversation installations"
      description="Where this agent is currently assigned."
      action="Install in conversation"
      onAction={() =>
        requestConnection(`Install ${agent.name} in conversation`)
      }
    >
      {agent.conversations.map((conversation) => (
        <div
          className="flex min-h-14 items-center justify-between gap-3 rounded-md border border-border px-4"
          key={conversation}
        >
          <span className="inline-flex items-center gap-2 text-[13px] font-medium text-text">
            <Link2 size={16} aria-hidden="true" /> {conversation}
          </span>
          <Badge tone="success">Installed</Badge>
        </div>
      ))}
    </Collection>
  ) : (
    <EmptyResource
      title="Not installed in a conversation"
      action="Install agent"
      onAction={() => requestConnection(`Install ${agent.name}`)}
    />
  );
}

function Collection({
  title,
  description,
  action,
  onAction,
  children,
}: {
  title: string;
  description: string;
  action: string;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="m-0 text-sm font-semibold text-text">{title}</h2>
          <p className="mt-1 mb-0 text-xs leading-5 text-text-secondary">
            {description}
          </p>
        </div>
        <Button variant="secondary" onClick={onAction}>
          <Plus size={15} aria-hidden="true" />
          {action}
        </Button>
      </div>
      <div className="grid gap-2">{children}</div>
    </div>
  );
}

function ProfileFile({
  name,
  description,
  content,
}: {
  name: string;
  description: string;
  content: string;
}) {
  return (
    <article className="rounded-md border border-border">
      <header className="border-b border-border bg-surface-muted px-4 py-3">
        <strong className="font-mono text-xs text-text">{name}</strong>
        <p className="mt-1 mb-0 text-xs text-text-secondary">{description}</p>
      </header>
      <p className="m-0 whitespace-pre-wrap p-4 text-sm leading-6 text-text-secondary">
        {content}
      </p>
    </article>
  );
}

function ResourceRow({
  icon,
  name,
  meta,
}: {
  icon: React.ReactNode;
  name: string;
  meta: string;
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 rounded-md border border-border px-4">
      <span className="text-text-secondary">{icon}</span>
      <span>
        <strong className="block text-[13px] text-text">{name}</strong>
        <span className="text-xs text-text-muted">{meta}</span>
      </span>
    </div>
  );
}

function EmptyResource({
  title,
  action,
  onAction,
}: {
  title: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <PageState
      kind="empty"
      icon={<Box size={18} aria-hidden="true" />}
      title={title}
      description="This preview has no records for the selected agent."
      action={<Button onClick={onAction}>{action}</Button>}
    />
  );
}
