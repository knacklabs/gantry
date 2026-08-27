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
  sourceSummary,
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
  sourceSummary?: string;
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
            bodyClassName="grid min-h-0 flex-1 content-start gap-[18px] overflow-y-auto p-5"
            description="A connected source is not automatic permission."
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
            <div
              aria-label="Sources expose tools, capabilities authorize actions, and runtime gates remain in force"
              className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-[7px]"
            >
              <AccessStage
                description="Expose reviewed tools and information to the agent."
                title="1 · Sources"
              />
              <span className="self-center text-sm text-text-secondary">→</span>
              <AccessStage
                description="Authorize the durable actions this agent may request."
                title="2 · Capabilities"
              />
              <span className="self-center text-sm text-text-secondary">→</span>
              <AccessStage
                description="Apply session approval, credentials, and host safety."
                title="3 · Runtime gates"
              />
            </div>
            <section>
              <h3 className="mb-[13px] text-[12px] font-semibold text-text">
                The practical rules
              </h3>
              <div className="grid gap-[13px]">
                <AccessRule
                  mark="S"
                  description="A source can be available while all of its actions remain unavailable to this agent."
                  title="Connecting does not grant authority"
                />
                <AccessRule
                  mark="C"
                  description="The agent can request only the actions selected in this step. Raw IDs remain visible under each capability’s Details."
                  title="Capabilities are explicit"
                />
                <AccessRule
                  mark="!"
                  description="An allowed write action may still require approval. Missing credentials and runtime safety rules always win."
                  title="Risk controls still apply"
                />
                <AccessRule
                  mark="↻"
                  description="Saved source and capability changes become available on this agent’s next run."
                  title="Changes apply to future work"
                />
              </div>
            </section>
            <section>
              <h3 className="mb-2 text-[12px] font-semibold text-text">
                Current setup
              </h3>
              <div className="grid gap-2 rounded-md border border-border bg-surface-muted p-3">
                <AccessSummary
                  label="Connected sources"
                  value={sourceSummary ?? 'Loading saved sources'}
                />
                <AccessSummary
                  label="Allowed capabilities"
                  value={`${selected.length} selected`}
                />
                <AccessSummary
                  label="Unavailable"
                  muted
                  value="Checked at run time"
                />
              </div>
            </section>
            <div className="rounded-md border border-status-attention/50 bg-status-attention-soft px-[11px] py-[10px] text-[10.5px] leading-[1.5] text-text">
              <strong>No changes happen here.</strong>
              <br />
              This drawer only explains the access model. Close it to continue
              choosing capabilities.
            </div>
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

function AccessStage({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-surface-muted px-[9px] py-[11px]">
      <strong className="mb-[5px] block text-[11.5px] text-text">{title}</strong>
      <span className="block text-[10px] leading-[1.4] text-text-secondary">
        {description}
      </span>
    </div>
  );
}

function AccessRule({
  description,
  mark,
  title,
}: {
  description: string;
  mark: string;
  title: string;
}) {
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-[9px]">
      <span className="grid size-[22px] place-items-center rounded-full bg-surface-strong font-mono text-[10px] font-bold text-text-secondary">
        {mark}
      </span>
      <div>
        <strong className="mb-[3px] block text-[12px] text-text">{title}</strong>
        <p className="m-0 text-[11px] leading-[1.5] text-text-secondary">
          {description}
        </p>
      </div>
    </div>
  );
}

function AccessSummary({
  label,
  muted = false,
  value,
}: {
  label: string;
  muted?: boolean;
  value: string;
}) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3 border-t border-border py-1 text-[10.5px] first:border-t-0 first:pt-0 last:pb-0">
      <span>{label}</span>
      <strong className={muted ? 'text-text-secondary' : 'text-text'}>
        {value}
      </strong>
    </div>
  );
}
