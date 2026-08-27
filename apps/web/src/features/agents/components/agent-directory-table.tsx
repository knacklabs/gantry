import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../ui/primitives/select';
import type { AgentDirectoryItem } from '../agents-queries';

export function AgentDirectoryTable({
  agents,
  emptyMessage,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  onRowClick,
}: {
  agents: AgentDirectoryItem[];
  emptyMessage: string;
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onRowClick: (agent: AgentDirectoryItem) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  return (
    <section className="hidden overflow-hidden rounded-lg border border-border bg-surface shadow-panel md:block">
      <header className="flex min-h-[var(--table-panel-header-height)] items-center justify-between gap-4 border-b border-border px-[var(--table-panel-padding-inline)] py-[13px]">
        <div>
          <h2 className="m-0 text-[13px] font-semibold text-text">
            Agent directory
          </h2>
          <p className="mt-[3px] mb-0 text-[length:var(--table-meta-font-size)] text-text-secondary">
            {total ? `${first}–${last} of ${total}` : '0'} agents · sorted by
            name
          </p>
        </div>
        <Badge
          className="h-[var(--table-status-height)] border-border bg-surface px-2 font-mono text-[length:var(--table-status-font-size)] text-text-secondary"
          variant="outline"
        >
          Page {page}
        </Badge>
      </header>
      <div className="max-h-[calc(100dvh-330px)] min-h-[330px] overflow-auto">
        <table className="w-full min-w-[820px] border-collapse text-left text-[length:var(--table-font-size)]">
          <thead className="sticky top-0 z-10 bg-surface-muted">
            <tr className="border-b border-border">
              <th className="h-[var(--table-header-height)] px-[var(--table-cell-padding-inline)] font-semibold text-text-secondary">
                Agent
              </th>
              <th className="h-[var(--table-header-height)] px-[var(--table-cell-padding-inline)] font-semibold text-text-secondary">
                Status
              </th>
              <th className="h-[var(--table-header-height)] px-[var(--table-cell-padding-inline)] font-semibold text-text-secondary">
                Role
              </th>
              <th className="h-[var(--table-header-height)] px-[var(--table-cell-padding-inline)] font-semibold text-text-secondary">
                Model
              </th>
              <th className="h-[var(--table-header-height)] px-[var(--table-cell-padding-inline)] font-semibold text-text-secondary">
                Connections
              </th>
            </tr>
          </thead>
          <tbody>
            {agents.length ? (
              agents.map((agent) => (
                <tr
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-muted"
                  key={agent.id}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest('a')) return;
                    onRowClick(agent);
                  }}
                >
                  <td className="h-[var(--table-row-height)] px-[var(--table-cell-padding-inline)] py-[var(--table-cell-padding-block)] align-middle">
                    <Link
                      className="block font-semibold text-text no-underline hover:underline"
                      params={{ agentId: agent.id }}
                      search={{ tab: 'overview' }}
                      to="/agents/$agentId"
                    >
                      {agent.name}
                    </Link>
                    <p className="mt-[3px] mb-0 max-w-xl truncate text-[10.5px] text-text-secondary">
                      {agent.rolePrompt ?? 'No saved role instructions'}
                    </p>
                  </td>
                  <td className="h-[var(--table-row-height)] px-[var(--table-cell-padding-inline)] py-[var(--table-cell-padding-block)] align-middle">
                    <DirectoryStatus status={agent.status} />
                  </td>
                  <td className="h-[var(--table-row-height)] px-[var(--table-cell-padding-inline)] py-[var(--table-cell-padding-block)] align-middle text-text-secondary">
                    {agent.roleName ?? 'No role selected'}
                  </td>
                  <td className="h-[var(--table-row-height)] px-[var(--table-cell-padding-inline)] py-[var(--table-cell-padding-block)] align-middle text-text-secondary">
                    {agent.modelAlias ?? 'Deployment default'}
                  </td>
                  <td className="h-[var(--table-row-height)] px-[var(--table-cell-padding-inline)] py-[var(--table-cell-padding-block)] align-middle text-text-secondary">
                    {agent.conversationCount
                      ? `${agent.conversationCount} conversation${agent.conversationCount === 1 ? '' : 's'}`
                      : 'Not connected'}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td
                  className="h-[330px] px-[var(--table-cell-padding-inline)] text-center text-text-secondary"
                  colSpan={5}
                >
                  {emptyMessage}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="flex min-h-[var(--table-pager-height)] items-center justify-between border-t border-border px-[var(--table-cell-padding-inline)] text-[length:var(--table-meta-font-size)] text-text-secondary">
        <span>{total ? `${first}–${last} of ${total}` : '0'} agents</span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2">
            Rows
            <Select
              value={String(pageSize)}
              onValueChange={(value) => onPageSizeChange(Number(value))}
            >
              <SelectTrigger
                aria-label="Rows per page"
                className="h-[var(--table-control-size)] w-16 text-[length:var(--table-font-size)]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="25">25</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <Button
            aria-label="Previous page"
            className="size-[var(--table-control-size)]"
            disabled={page <= 1}
            size="icon"
            variant="outline"
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </Button>
          <Button
            aria-label="Next page"
            className="size-[var(--table-control-size)]"
            disabled={page >= pageCount}
            size="icon"
            variant="outline"
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </Button>
        </div>
      </footer>
    </section>
  );
}

function DirectoryStatus({ status }: { status: AgentDirectoryItem['status'] }) {
  const active = status === 'active';
  return (
    <Badge
      className="h-[var(--table-status-height)] px-2 font-mono text-[length:var(--table-status-font-size)]"
      variant={active ? 'success' : 'danger'}
    >
      {active ? (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      ) : null}
      {active ? 'Active' : 'Disabled'}
    </Badge>
  );
}
