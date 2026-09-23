import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';

const browserAuth = vi.hoisted(() => ({ browserFetch: vi.fn() }));
vi.mock('../../lib/auth/browser-auth', () => browserAuth);

import { fetchPeopleDirectory } from './people-queries';
import { peopleSearchSchema } from './people-search';

beforeEach(() => browserAuth.browserFetch.mockReset());

it('loads every page of app-scoped people from the browser API', async () => {
  browserAuth.browserFetch
    .mockResolvedValueOnce(
      Response.json({
        people: [{ id: 'person:real-one', displayName: 'Real One' }],
        nextCursor: 'next/page',
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        people: [{ id: 'person:real-two', displayName: 'Real Two' }],
        nextCursor: null,
      }),
    );

  const people = await fetchPeopleDirectory();

  expect(people.map((person) => person.id)).toEqual([
    'person:real-one',
    'person:real-two',
  ]);
  expect(browserAuth.browserFetch.mock.calls.map(([path]) => path)).toEqual([
    '/ui/api/people',
    '/ui/api/people?cursor=next%2Fpage',
  ]);
});

it('shows only fields backed by real identity data', () => {
  const directory = readFileSync(
    'src/features/people/routes/people-route.tsx',
    'utf8',
  );
  const detail = readFileSync(
    'src/features/people/routes/person-detail-route.tsx',
    'utf8',
  );
  expect(directory).toContain('peopleDirectoryQuery');
  expect(detail).toContain('peopleDirectoryQuery');
  expect(directory).not.toContain('peoplePreviewQuery');
  expect(detail).not.toContain('mergeHistoryPreviewQuery');
  expect(peopleSearchSchema.parse({ invitation: 'pending' }).status).toBe(
    'all',
  );
});
