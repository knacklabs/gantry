import { queryOptions } from '@tanstack/react-query';

import { browserFetch } from '../../lib/auth/browser-auth';
export const peopleQueryKeys = {
  all: ['people'] as const,
  list: () => [...peopleQueryKeys.all, 'list'] as const,
};

export type BrowserPersonDirectoryItem = {
  id: string;
  kind: 'human' | 'service';
  displayName: string;
  status: 'active' | 'disabled' | 'archived';
  aliases: Array<{
    id: string;
    provider: string;
    displayName: string | null;
    verificationStatus: 'verified' | 'unverified' | 'retired';
  }>;
  aliasCounts: Partial<Record<'verified' | 'unverified' | 'retired', number>>;
  updatedAt: string;
};

export async function fetchPeopleDirectory(
  signal?: AbortSignal,
): Promise<BrowserPersonDirectoryItem[]> {
  const people: BrowserPersonDirectoryItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const path = cursor
      ? `/ui/api/people?cursor=${encodeURIComponent(cursor)}`
      : '/ui/api/people';
    const response = await browserFetch(path, {
      credentials: 'same-origin',
      signal,
    });
    if (!response.ok) throw new Error('People could not be loaded.');
    const page = (await response.json()) as {
      people: BrowserPersonDirectoryItem[];
      nextCursor: string | null;
    };
    people.push(...page.people);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor))
      throw new Error('People directory pagination did not advance.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return people;
}

export const peopleDirectoryQuery = queryOptions({
  queryKey: peopleQueryKeys.list(),
  queryFn: ({ signal }) => fetchPeopleDirectory(signal),
});
