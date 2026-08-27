import { useState } from 'react';

import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { Checkbox } from '../../../ui/primitives/checkbox';
import { AgentDrawer } from './agent-drawer';

export type SetupCatalogItem = {
  id: string;
  label: string;
  description?: string;
  group: string;
};

export function AgentSetupCatalog({
  kind,
  sourceTab,
  selected,
  items,
  search,
  page,
  hasNext,
  loading,
  failed,
  disabled,
  onSearchChange,
  onPageChange,
  onRetry,
  onSourceTabChange,
  onToggle,
  onClearSelections,
}: {
  kind: 'sources' | 'capabilities';
  sourceTab: 'skills' | 'mcp';
  selected: string[];
  items: SetupCatalogItem[];
  search: string;
  page?: number;
  hasNext?: boolean;
  loading: boolean;
  failed: boolean;
  disabled: boolean;
  onSearchChange: (value: string) => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  onSourceTabChange: (tab: 'skills' | 'mcp') => void;
  onToggle: (id: string) => void;
  onClearSelections?: () => void;
}) {
  const [accessOpen, setAccessOpen] = useState(false);
  const noun =
    kind === 'sources'
      ? sourceTab === 'skills'
        ? 'skills'
        : 'MCP servers'
      : 'capabilities';
  return (
    <>
      {kind === 'sources' ? (
        <div className="flex gap-[5px]" role="tablist" aria-label="Source type">
          <Button
            aria-selected={sourceTab === 'skills'}
            role="tab"
            className={`h-[34px] min-w-[140px] justify-between gap-[7px] rounded-md px-3 text-[12.5px] ${
              sourceTab === 'skills'
                ? '!border !border-text bg-surface-strong text-text hover:bg-surface-strong'
                : ''
            }`}
            variant="outline"
            type="button"
            onClick={() => onSourceTabChange('skills')}
          >
            <span>Skills</span>
            <Badge className="h-[22px] border-border-strong bg-surface-muted px-2 font-mono text-[9.5px] font-semibold text-text-secondary">
              {selected.filter((id) => id.startsWith('skill:')).length} selected
            </Badge>
          </Button>
          <Button
            aria-selected={sourceTab === 'mcp'}
            role="tab"
            className={`h-[34px] min-w-[140px] justify-between gap-[7px] rounded-md px-3 text-[12.5px] ${
              sourceTab === 'mcp'
                ? '!border !border-text bg-surface-strong text-text hover:bg-surface-strong'
                : ''
            }`}
            variant="outline"
            type="button"
            onClick={() => onSourceTabChange('mcp')}
          >
            <span>MCP servers</span>
            <Badge className="h-[22px] border-border-strong bg-surface-muted px-2 font-mono text-[9.5px] font-semibold text-text-secondary">
              {selected.filter((id) => id.startsWith('mcp:')).length} selected
            </Badge>
          </Button>
        </div>
      ) : (
        <>
          <AgentDrawer
            description="Connected sources → Allowed capabilities → Runtime checks"
            eyebrow="Step 3 help"
            footer={
              <Button type="button" onClick={() => setAccessOpen(false)}>
                Done
              </Button>
            }
            open={accessOpen}
            title="How agent access works"
            onOpenChange={setAccessOpen}
          >
            <div className="grid gap-2 rounded-md bg-surface-muted p-3 text-sm text-text-secondary">
              <strong className="text-text">1 · Sources</strong>
              <span>Expose reviewed tools and information to the agent.</span>
              <strong className="text-text">2 · Capabilities</strong>
              <span>Authorize the durable actions this agent may request.</span>
              <strong className="text-text">3 · Runtime checks</strong>
              <span>Apply session approval, credentials, and host safety.</span>
            </div>
            <p className="m-0 text-sm text-text-secondary">
              Connecting a source does not grant authority. An allowed write
              action can still require approval.
            </p>
            <p className="m-0 rounded-md bg-surface-muted p-3 text-xs text-text-secondary">
              No changes happen here. Close this drawer to continue choosing
              capabilities.
            </p>
          </AgentDrawer>
        </>
      )}
      <TextField
        id={`${kind}-catalog-search`}
        label={`Search ${noun}`}
        placeholder="Name"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      {loading ? (
        <p className="text-sm text-text-secondary">
          Loading available options…
        </p>
      ) : null}
      {failed ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          Available options could not be loaded.
          <Button size="sm" type="button" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      {items.length ? (
        <div
          className={
            kind === 'sources'
              ? 'max-h-[360px] overflow-y-auto rounded-lg border border-border'
              : 'grid gap-3 md:grid-cols-2'
          }
        >
          {kind === 'sources' ? (
            <div className="sticky top-0 z-10 grid grid-cols-[32px_1.2fr_1.4fr_.8fr] gap-3 border-b border-border bg-surface-muted px-3 py-2 font-mono text-[10px] font-semibold tracking-wide text-text-secondary uppercase">
              <span />
              <span>{sourceTab === 'skills' ? 'Skill' : 'MCP server'}</span>
              <span>
                {sourceTab === 'skills' ? 'Purpose' : 'Visible operations'}
              </span>
              <span>Status</span>
            </div>
          ) : null}
          {items.map((item) => (
            <label
              className={
                kind === 'sources'
                  ? 'grid min-h-[54px] cursor-pointer grid-cols-[32px_1.2fr_1.4fr_.8fr] items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surface-muted'
                  : 'grid min-h-28 cursor-pointer grid-cols-[20px_minmax(0,1fr)] content-start gap-3 rounded-lg border border-border p-4 hover:bg-surface-muted'
              }
              key={item.id}
            >
              <Checkbox
                checked={selected.includes(item.id)}
                disabled={disabled}
                onCheckedChange={() => onToggle(item.id)}
              />
              <span
                className={kind === 'sources' ? 'grid gap-0.5' : 'grid gap-1'}
              >
                <strong className="text-sm">{item.label}</strong>
                <span className="text-xs text-text-secondary">
                  {item.group.toLowerCase()} · reviewed inventory
                </span>
              </span>
              {kind === 'sources' ? (
                <span className="text-sm text-text-secondary">
                  {item.description ?? item.group}
                </span>
              ) : null}
              {kind === 'sources' ? (
                <span className="rounded-full border border-status-success/40 bg-status-success-soft px-2 py-1 text-center text-[11px] font-semibold text-status-success">
                  Ready
                </span>
              ) : null}
            </label>
          ))}
        </div>
      ) : !loading && !failed ? (
        <p className="rounded-md bg-surface-muted p-4 text-sm text-text-secondary">
          No available {kind === 'sources' ? 'sources' : 'capabilities'} match
          this search.
        </p>
      ) : null}
      {kind === 'sources' ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-status-attention/40 bg-status-attention-soft p-3 text-sm">
          <span>
            <strong>
              {selected.filter((id) => id.startsWith('skill:')).length} skills ·{' '}
              {selected.filter((id) => id.startsWith('mcp:')).length} MCP
              servers selected
            </strong>
            <span className="mt-0.5 block text-text-secondary">
              Selections are saved independently and become available next run.
            </span>
          </span>
          {onClearSelections ? (
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={onClearSelections}
            >
              Clear selections
            </Button>
          ) : null}
        </div>
      ) : null}
      {kind === 'capabilities' ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-status-attention/40 bg-status-attention-soft p-3 text-sm">
          <span>
            <strong>{selected.length} capabilities selected</strong>
            <span className="mt-0.5 block text-text-secondary">
              Connected sources provide tools. Allowed capabilities authorize
              actions.
            </span>
          </span>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setAccessOpen(true)}
          >
            How access works
          </Button>
        </div>
      ) : null}
      {page ? (
        <div className="flex justify-end gap-2">
          <Button
            disabled={page <= 1}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          <Button
            disabled={!hasNext}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </>
  );
}
