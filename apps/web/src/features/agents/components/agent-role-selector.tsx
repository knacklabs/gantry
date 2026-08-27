import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import { Input } from '../../../ui/primitives/input';
import { roleDirectoryQuery, type BrowserRole } from '../agents-queries';

export function AgentRoleSelector({
  value,
  onChange,
  onCreateCustom,
  error,
}: {
  value?: BrowserRole;
  onChange: (role: BrowserRole) => void;
  onCreateCustom: () => void;
  error?: string;
}) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [customPage, setCustomPage] = useState(1);
  const builtIns = useQuery(
    roleDirectoryQuery({ page: 1, search: '', kind: 'built-in' }),
  );
  const customRoles = useQuery(
    roleDirectoryQuery({
      page: customPage,
      search: debouncedSearch,
      kind: 'custom',
    }),
  );
  const builtInMatches = useMemo(
    () =>
      (builtIns.data?.data ?? []).filter((role) =>
        role.name.toLowerCase().includes(search.trim().toLowerCase()),
      ),
    [builtIns.data?.data, search],
  );

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      350,
    );
    return () => window.clearTimeout(timeout);
  }, [search]);
  useEffect(() => setCustomPage(1), [debouncedSearch]);

  return (
    <div className="grid gap-1.5">
      <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section className="grid min-h-0 overflow-hidden rounded-lg border border-border bg-surface">
          <div className="border-b border-border p-3">
            <label
              className="grid gap-1.5 text-xs font-semibold text-text"
              htmlFor="agent-role"
            >
              <span>
                Role{' '}
                <span className="text-danger" aria-hidden="true">
                  *
                </span>
              </span>
              <Input
                aria-invalid={error ? true : undefined}
                aria-required="true"
                className="h-9 rounded-md bg-surface px-3 text-[13px] text-text"
                id="agent-role"
                placeholder="Search roles…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          <div className="max-h-[250px] overflow-y-auto">
            <RoleGroup
              label="Built-in roles"
              roles={builtInMatches}
              value={value}
              onChange={onChange}
            />
            <RoleGroup
              label="Custom roles"
              roles={customRoles.data?.data ?? []}
              value={value}
              onChange={onChange}
            />
            {builtIns.isLoading || customRoles.isLoading ? (
              <p className="p-3 text-xs text-text-secondary">Loading roles…</p>
            ) : null}
            {builtIns.isError || customRoles.isError ? (
              <Button
                className="m-2"
                size="sm"
                variant="secondary"
                onClick={() => {
                  void builtIns.refetch();
                  void customRoles.refetch();
                }}
              >
                <RefreshCw size={14} aria-hidden="true" /> Retry
              </Button>
            ) : null}
          </div>
          <div className="border-t border-border p-2">
            <Button
              className="w-full"
              size="sm"
              variant="outline"
              onClick={onCreateCustom}
            >
              <Plus size={14} aria-hidden="true" /> Create custom role
            </Button>
          </div>
        </section>
        <section className="min-h-[300px] rounded-lg border border-border bg-surface-muted p-4">
          {value ? (
            <>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h3 className="m-0 text-lg font-semibold">{value.name}</h3>
                  <p className="mt-0.5 mb-0 text-xs text-text-secondary">
                    Complete role behavior layer
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={onCreateCustom}>
                  Duplicate and customize
                </Button>
              </div>
              <pre className="m-0 max-h-[190px] overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-[1.55] text-text-secondary">
                {value.prompt}
              </pre>
              <p className="mt-3 mb-0 rounded-lg border border-status-attention/40 bg-status-attention-soft p-3 text-xs leading-5 text-text">
                Gantry’s runtime, safety, capability, and session context remain
                separate from this visible role prompt.
              </p>
            </>
          ) : (
            <p className="m-0 text-sm text-text-secondary">
              Select a role to review its visible behavior prompt.
            </p>
          )}
        </section>
      </div>
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RoleGroup({
  label,
  roles,
  value,
  onChange,
}: {
  label: string;
  roles: BrowserRole[];
  value?: BrowserRole;
  onChange: (role: BrowserRole) => void;
}) {
  if (!roles.length) return null;
  return (
    <section>
      <p className="px-3 py-2 font-mono text-[10px] font-semibold tracking-wider text-text-secondary uppercase">
        {label}
      </p>
      {roles.map((role) => (
        <button
          className="flex w-full items-start justify-between gap-3 border-t border-border px-3 py-2.5 text-left hover:bg-status-attention-soft data-[selected=true]:bg-status-attention-soft"
          data-selected={value?.id === role.id}
          key={role.id}
          type="button"
          onClick={() => onChange(role)}
        >
          <span>
            <strong className="block text-[13px]">{role.name}</strong>
            <span className="mt-0.5 block text-xs text-text-secondary">
              {role.kind === 'built-in'
                ? 'Built-in Gantry role'
                : 'Custom prompt template'}
            </span>
          </span>
          <span
            className={
              role.kind === 'built-in'
                ? 'rounded-full border border-border bg-surface px-2 py-1 text-[10px] font-semibold text-text-secondary'
                : 'rounded-full border border-status-attention/40 bg-status-attention-soft px-2 py-1 text-[10px] font-semibold text-status-attention'
            }
          >
            {role.kind === 'built-in' ? 'Built-in' : 'Custom'}
          </span>
        </button>
      ))}
    </section>
  );
}
