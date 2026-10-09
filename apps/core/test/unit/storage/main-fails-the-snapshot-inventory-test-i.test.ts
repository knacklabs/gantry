import fs from 'node:fs';
import path from 'node:path';

import { expect, it } from 'vitest';

it('keeps the latest Drizzle migration snapshot available', () => {
  const metaDir = path.resolve(
    'apps/core/src/adapters/storage/postgres/schema/migrations/meta',
  );
  const journal = JSON.parse(
    fs.readFileSync(path.join(metaDir, '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  const latestTag = journal.entries.at(-1)?.tag;

  expect(latestTag).toBeDefined();
  expect(
    fs.existsSync(
      path.join(metaDir, `${latestTag?.slice(0, 14)}_snapshot.json`),
    ),
  ).toBe(true);
});
