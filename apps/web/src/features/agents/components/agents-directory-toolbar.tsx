import { useEffect, useState } from 'react';

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

  return (
    <div className="grid items-end gap-4 md:grid-cols-[minmax(0,1fr)_236px_260px]">
      <TextField
        id="agent-search"
        label="Search agents"
        name="q"
        placeholder="Name or purpose…"
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
    </div>
  );
}
