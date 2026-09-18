import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import type { AgentDirectoryItem } from '../agents-queries';

export function AgentDetailHeader({ agent }: { agent: AgentDirectoryItem }) {
  const label =
    agent.status === 'active'
      ? 'on shift'
      : agent.status === 'disabled'
        ? 'paused'
        : 'offboarded';
  return (
    <header className="flex min-h-[30px] items-center gap-3">
      <Link
        className="inline-flex h-[30px] items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-caption font-medium text-text-secondary no-underline shadow-control transition-colors hover:bg-surface-muted hover:text-text"
        to="/agents"
        search={{
          tab: 'agents',
          page: 1,
          pageSize: 25,
          q: '',
          status: 'all',
          role: 'all',
          sort: 'name',
          desc: false,
          kind: 'employees',
        }}
      >
        <ArrowLeft size={13} aria-hidden="true" /> Roster
      </Link>
      <span className="inline-flex items-center gap-2 font-mono text-caption tracking-[0.08em] text-text-secondary">
        <span
          className={`size-2 rounded-full ${agent.status === 'active' ? 'animate-status-pulse bg-status-success' : agent.status === 'disabled' ? 'bg-status-idle' : 'bg-danger'}`}
          aria-hidden="true"
        />
        {label}
      </span>
    </header>
  );
}
