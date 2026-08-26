import { Button } from '../../../ui/primitives/button';
import { Checkbox } from '../../../ui/primitives/checkbox';
import { TextField } from '../../../ui/compositions/text-field';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../../ui/primitives/dialog';

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
}) {
  const noun =
    kind === 'sources'
      ? sourceTab === 'skills'
        ? 'skills'
        : 'MCP servers'
      : 'capabilities';
  return (
    <>
      {kind === 'sources' ? (
        <div className="flex gap-2" role="tablist" aria-label="Source type">
          <Button
            aria-selected={sourceTab === 'skills'}
            role="tab"
            size="sm"
            variant={sourceTab === 'skills' ? 'secondary' : 'ghost'}
            onClick={() => onSourceTabChange('skills')}
          >
            Skills ({selected.filter((id) => id.startsWith('skill:')).length})
          </Button>
          <Button
            aria-selected={sourceTab === 'mcp'}
            role="tab"
            size="sm"
            variant={sourceTab === 'mcp' ? 'secondary' : 'ghost'}
            onClick={() => onSourceTabChange('mcp')}
          >
            MCP servers ({selected.filter((id) => id.startsWith('mcp:')).length}
            )
          </Button>
        </div>
      ) : (
        <Dialog>
          <DialogTrigger asChild>
            <Button className="w-fit" size="sm" variant="secondary">
              How access works
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>How access works</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-text-secondary">
              Connected sources → Allowed capabilities → Runtime checks
            </p>
            <p className="text-sm text-text-secondary">
              Connected sources provide tools. Allowed capabilities authorize
              actions. Some risky actions may still require approval.
            </p>
          </DialogContent>
        </Dialog>
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
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : null}
      {items.length ? (
        <div className="grid max-h-80 gap-2 overflow-y-auto rounded-md border border-border p-3">
          {items.map((item) => (
            <label
              className="flex cursor-pointer items-start gap-3 rounded p-2 hover:bg-surface-muted"
              key={item.id}
            >
              <Checkbox
                checked={selected.includes(item.id)}
                disabled={disabled}
                onCheckedChange={() => onToggle(item.id)}
              />
              <span className="grid gap-0.5 text-sm">
                <strong>{item.label}</strong>
                <span className="text-xs text-text-secondary">
                  {item.description ?? item.group}
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : !loading && !failed ? (
        <p className="rounded-md bg-surface-muted p-4 text-sm text-text-secondary">
          No available {kind === 'sources' ? 'sources' : 'capabilities'} match
          this search.
        </p>
      ) : null}
      {page ? (
        <div className="flex justify-end gap-2">
          <Button
            disabled={page <= 1}
            size="sm"
            variant="secondary"
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
          <Button
            disabled={!hasNext}
            size="sm"
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
