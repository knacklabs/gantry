import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
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
  const [filtersOpen, setFiltersOpen] = useState(
    search.status !== 'all' || search.role !== 'all',
  );
  const activeFilterCount =
    Number(search.status !== 'all') + Number(search.role !== 'all');

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
    <div className="grid gap-2.5">
      <div className="grid items-end gap-2.5 md:grid-cols-[minmax(200px,1fr)_auto]">
        <TextField
          id="agent-search"
          label="Search directory"
          name="q"
          placeholder="Name, channel account, or template"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          aria-expanded={filtersOpen}
          variant="outline"
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <SlidersHorizontal size={15} aria-hidden="true" />
          Filters{activeFilterCount ? ` · ${activeFilterCount}` : ''}
        </Button>
      </div>
      {filtersOpen ? (
        <div className="grid gap-2.5 md:grid-cols-2">
          <SelectField
            label="Status"
            value={search.status}
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'active', label: 'Enabled' },
              { value: 'disabled', label: 'Disabled' },
            ]}
            onValueChange={(status) => onChange({ status, page: 1 })}
          />
          <SelectField
            label="Work template"
            value={search.role}
            options={[
              { value: 'all', label: 'All templates' },
              ...roleOptions.map((role) => ({
                value: role.name.toLowerCase(),
                label: role.name,
              })),
            ]}
            onValueChange={(role) => onChange({ role, page: 1 })}
          />
        </div>
      ) : null}
    </div>
  );
}
