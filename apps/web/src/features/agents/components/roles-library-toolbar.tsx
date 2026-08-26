import { type FormEvent, useEffect, useState } from 'react';

import { TextField } from '../../../ui/compositions/text-field';

export function RolesLibraryToolbar({
  search,
  onChange,
}: {
  search: string;
  onChange: (search: string) => void;
}) {
  const [query, setQuery] = useState(search);

  useEffect(() => setQuery(search), [search]);
  useEffect(() => {
    if (query === search) return;
    const timeout = window.setTimeout(() => onChange(query), 350);
    return () => window.clearTimeout(timeout);
  }, [onChange, query, search]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onChange(query);
  }

  return (
    <form className="max-w-xl" onSubmit={submit}>
      <TextField
        id="role-search"
        label="Search custom roles"
        placeholder="Role name"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </form>
  );
}
