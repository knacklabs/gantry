import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import { Input } from '../../../ui/primitives/input';
import { roleDirectoryQuery, type BrowserRole } from '../agents-queries';

export function AgentRoleSelector({
  value,
  onChange,
  onCreateCustom,
}: {
  value?: BrowserRole;
  onChange: (role: BrowserRole) => void;
  onCreateCustom: () => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState(value?.name ?? '');
  const [search, setSearch] = useState('');
  const [customPage, setCustomPage] = useState(1);
  const [activeIndex, setActiveIndex] = useState(0);
  const builtIns = useQuery(
    roleDirectoryQuery({ page: 1, search: '', kind: 'built-in' }),
  );
  const customRoles = useQuery(
    roleDirectoryQuery({ page: customPage, search, kind: 'custom' }),
  );
  const builtInMatches = useMemo(
    () =>
      (builtIns.data?.data ?? []).filter((role) =>
        role.name.toLowerCase().includes(input.trim().toLowerCase()),
      ),
    [builtIns.data?.data, input],
  );
  const options = [...builtInMatches, ...(customRoles.data?.data ?? [])];

  useEffect(() => setInput(value?.name ?? ''), [value?.id, value?.name]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setSearch(input.trim()), 350);
    return () => window.clearTimeout(timeout);
  }, [input]);
  useEffect(() => {
    setActiveIndex(0);
    setCustomPage(1);
  }, [search]);

  function select(role: BrowserRole) {
    onChange(role);
    setInput(role.name);
    setOpen(false);
  }

  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-semibold text-text" htmlFor="agent-role">
        Role
      </label>
      <div className="relative">
        <Input
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={open}
          aria-label="Role"
          className="h-9 rounded-md bg-surface px-3 text-[13px] text-text"
          id="agent-role"
          placeholder="Search roles"
          role="combobox"
          value={input}
          onBlur={() => window.setTimeout(() => setOpen(false), 100)}
          onChange={(event) => {
            setInput(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) =>
                Math.min(index + 1, options.length - 1),
              );
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            }
            if (event.key === 'Enter' && open && options[activeIndex]) {
              event.preventDefault();
              select(options[activeIndex]);
            }
            if (event.key === 'Escape') setOpen(false);
          }}
        />
        {open ? (
          <div className="absolute z-20 mt-1 w-full rounded-md border border-border bg-surface shadow-lg">
            <div
              className="max-h-72 overflow-y-auto p-1"
              id={listId}
              role="listbox"
            >
              <RoleGroup
                label="Built-in roles"
                roles={builtInMatches}
                activeIndex={activeIndex}
                offset={0}
                onSelect={select}
              />
              <RoleGroup
                label="Custom roles"
                roles={customRoles.data?.data ?? []}
                activeIndex={activeIndex}
                offset={builtInMatches.length}
                onSelect={select}
              />
              {customRoles.isLoading || builtIns.isLoading ? (
                <p className="p-3 text-xs text-text-secondary">
                  Loading roles…
                </p>
              ) : null}
              {customRoles.isError || builtIns.isError ? (
                <Button
                  className="m-2"
                  size="sm"
                  variant="secondary"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    void builtIns.refetch();
                    void customRoles.refetch();
                  }}
                >
                  <RefreshCw size={14} aria-hidden="true" />
                  Retry
                </Button>
              ) : null}
              {!customRoles.isLoading &&
              !builtIns.isLoading &&
              !customRoles.isError &&
              !builtIns.isError &&
              !options.length ? (
                <p className="p-3 text-xs text-text-secondary">
                  No roles match this search.
                </p>
              ) : null}
              {customRoles.data?.hasNext ? (
                <Button
                  className="mx-2"
                  size="sm"
                  variant="secondary"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => setCustomPage((page) => page + 1)}
                >
                  More custom roles
                </Button>
              ) : null}
            </div>
            <div className="border-t border-border p-1">
              <Button
                className="w-full justify-start"
                size="sm"
                variant="ghost"
                onMouseDown={(event) => event.preventDefault()}
                onClick={onCreateCustom}
              >
                <Plus size={14} aria-hidden="true" />
                Create custom role
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-text-secondary">
        Role prompts exclude Gantry’s protected runtime and safety rules.
      </p>
    </div>
  );
}

function RoleGroup({
  label,
  roles,
  activeIndex,
  offset,
  onSelect,
}: {
  label: string;
  roles: BrowserRole[];
  activeIndex: number;
  offset: number;
  onSelect: (role: BrowserRole) => void;
}) {
  if (!roles.length) return null;
  return (
    <div className="grid gap-1 py-1">
      <p className="px-2 py-1 text-xs font-semibold text-text-secondary">
        {label}
      </p>
      {roles.map((role, index) => (
        <button
          aria-selected={activeIndex === offset + index}
          className="grid w-full gap-0.5 rounded px-2 py-2 text-left hover:bg-surface-muted aria-selected:bg-surface-muted"
          key={role.id}
          role="option"
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(role)}
        >
          <span className="text-sm font-medium text-text">{role.name}</span>
          <span className="text-xs text-text-secondary">
            {role.kind === 'built-in'
              ? 'Built-in Gantry role'
              : 'Custom prompt template'}
          </span>
        </button>
      ))}
    </div>
  );
}
