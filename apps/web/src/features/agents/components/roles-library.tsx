import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageState } from '../../../ui/compositions/page-state';
import { Button } from '../../../ui/primitives/button';
import { Input } from '../../../ui/primitives/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../ui/primitives/select';
import type { BrowserPage, BrowserRole } from '../agents-queries';
import { BuiltInRoles } from './built-in-roles';
import { CustomRolesTable } from './custom-roles-table';
import { RoleEditorDialog, type RoleEditorTarget } from './role-editor-dialog';

export function RolesLibrary({
  data,
  builtIns,
  error,
  loading,
  search,
  onPageChange,
  onPageSizeChange,
  onRetry,
  onSearchChange,
}: {
  data: BrowserPage<BrowserRole> | undefined;
  builtIns?: BrowserPage<BrowserRole>;
  error: boolean;
  loading: boolean;
  search: string;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  onRetry: () => void;
  onSearchChange: (search: string) => void;
}) {
  const [editor, setEditor] = useState<RoleEditorTarget>();
  const [query, setQuery] = useState(search);
  useEffect(() => setQuery(search), [search]);
  useEffect(() => {
    if (query === search) return;
    const timeout = window.setTimeout(() => onSearchChange(query), 350);
    return () => window.clearTimeout(timeout);
  }, [onSearchChange, query, search]);
  const duplicate = (role: BrowserRole) =>
    setEditor({
      mode: 'create',
      seed: {
        ...role,
        name: `${role.name} copy`,
        sourceRoleId: role.id,
      },
    });

  if (error) {
    return (
      <PageState
        action={
          <Button onClick={onRetry}>
            <RefreshCw size={15} aria-hidden="true" />
            Retry
          </Button>
        }
        description="Try loading the role library again."
        icon={<BookOpen size={18} aria-hidden="true" />}
        kind="error"
        title="Roles could not be loaded"
      />
    );
  }

  return (
    <div className="grid gap-3">
      <section className="grid gap-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="m-0 text-sm font-semibold">Built-in roles</h2>
            <p className="mt-1 mb-0 text-xs text-text-secondary">
              Canonical Gantry role prompts. Visible, stable, and read-only.
            </p>
          </div>
          <Button size="sm" onClick={() => setEditor({ mode: 'create' })}>
            <Plus size={14} aria-hidden="true" />
            New custom role
          </Button>
        </div>
        <BuiltInRoles
          roles={builtIns?.data ?? []}
          onView={(role) => setEditor({ mode: 'view', role })}
        />
      </section>
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-panel">
        <header className="flex min-h-[var(--table-panel-header-height)] items-center justify-between gap-4 border-b border-border px-[var(--table-panel-padding-inline)] py-[13px]">
          <div>
            <h2 className="m-0 text-[13px] font-semibold text-text">
              Custom roles
            </h2>
            <p className="mt-[3px] mb-0 text-[length:var(--table-meta-font-size)] text-text-secondary">
              Reusable templates · edits affect future agents only
            </p>
          </div>
          <div className="w-56">
            <label className="sr-only" htmlFor="role-search">
              Search custom roles
            </label>
            <Input
              id="role-search"
              className="h-9 bg-surface px-3 text-[13px]"
              placeholder="Search custom roles…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </header>
        <CustomRolesTable
          data={data}
          loading={loading}
          onView={(role) => setEditor({ mode: 'view', role })}
          onEdit={(role) => setEditor({ mode: 'edit', role })}
          onDuplicate={duplicate}
        />
        <footer className="flex min-h-[var(--table-pager-height)] items-center justify-between border-t border-border px-[var(--table-cell-padding-inline)] text-[length:var(--table-meta-font-size)] text-text-secondary">
          <span>
            {data?.total
              ? `${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} of ${data.total}`
              : '0'}{' '}
            custom roles
          </span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2">
              Rows
              <Select
                value={String(data?.pageSize ?? 25)}
                onValueChange={(value) => onPageSizeChange(Number(value))}
              >
                <SelectTrigger className="h-[var(--table-control-size)] w-16 text-[length:var(--table-font-size)]">
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
              disabled={(data?.page ?? 1) <= 1}
              size="icon"
              variant="outline"
              onClick={() => onPageChange((data?.page ?? 1) - 1)}
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </Button>
            <Button
              aria-label="Next page"
              className="size-[var(--table-control-size)]"
              disabled={!data?.hasNext}
              size="icon"
              variant="outline"
              onClick={() => onPageChange((data?.page ?? 1) + 1)}
            >
              <ChevronRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </footer>
      </section>
      <RoleEditorDialog
        target={editor}
        onOpenChange={(open) => !open && setEditor(undefined)}
      />
    </div>
  );
}
