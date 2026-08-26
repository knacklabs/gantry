import { type FormEvent, useEffect, useState } from 'react';

import { SelectField } from '../../../ui/compositions/select-field';
import { TextField } from '../../../ui/compositions/text-field';
import type { BrowserRole } from '../agents-queries';
import type { agentListSearchSchema } from '../agents-search';

type DirectorySearch = typeof agentListSearchSchema._output;

export function AgentsDirectoryToolbar({
  roleOptions,
  search,
  onChange,
}: {
  roleOptions: BrowserRole[];
  search: DirectorySearch;
  onChange: (next: Partial<DirectorySearch>) => void;
}) {
  const [query, setQuery] = useState(search.q);

  useEffect(() => setQuery(search.q), [search.q]);
  useEffect(() => {
    if (query === search.q) return;
    const timeout = window.setTimeout(
      () => onChange({ q: query, page: 1 }),
      350,
    );
    return () => window.clearTimeout(timeout);
  }, [onChange, query, search.q]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onChange({ q: query, page: 1 });
  }

  return (
    <form
      className="grid items-end gap-3 md:grid-cols-[minmax(0,1fr)_170px_200px_120px]"
      onSubmit={submit}
    >
      <TextField
        id="agent-search"
        label="Search agents"
        name="q"
        placeholder="Name"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <SelectField
        label="Status"
        value={search.status}
        options={[
          { value: 'all', label: 'All statuses' },
          { value: 'active', label: 'Active' },
          { value: 'disabled', label: 'Disabled' },
        ]}
        onValueChange={(status) => onChange({ status, page: 1 })}
      />
      <SelectField
        label="Role"
        value={search.role}
        options={[
          { value: 'all', label: 'All roles' },
          ...roleOptions.map((role) => ({
            value: role.name.toLowerCase(),
            label: role.name,
          })),
        ]}
        onValueChange={(role) => onChange({ role, page: 1 })}
      />
      <SelectField
        label="Rows per page"
        value={String(search.pageSize)}
        options={[
          { value: '25', label: '25 rows' },
          { value: '50', label: '50 rows' },
          { value: '100', label: '100 rows' },
        ]}
        onValueChange={(pageSize) =>
          onChange({
            pageSize: Number(pageSize) as DirectorySearch['pageSize'],
            page: 1,
          })
        }
      />
    </form>
  );
}
