import Database from 'better-sqlite3';

import { MEMORY_SQLITE_PATH } from '../../apps/core/src/core/config.js';

const FRAGMENT_TITLE_PATTERN =
  /^(Found it|Findings|Critical|End-to-end|No answer|Three full|On it|##|\*\*)/i;

function run(): void {
  const db = new Database(MEMORY_SQLITE_PATH);
  try {
    const rows = db
      .prepare(
        `SELECT id, title
         FROM memory_procedures
         WHERE is_deleted = 0`,
      )
      .all() as Array<{ id: string; title: string }>;

    const now = new Date().toISOString();
    const idsToDelete = rows
      .filter((row) => FRAGMENT_TITLE_PATTERN.test(row.title))
      .map((row) => row.id);

    const update = db.prepare(
      `UPDATE memory_procedures
       SET is_deleted = 1,
           deleted_at = ?,
           updated_at = ?
       WHERE id = ?`,
    );
    const tx = db.transaction((ids: string[]) => {
      for (const id of ids) {
        update.run(now, now, id);
      }
    });
    tx(idsToDelete);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          dbPath: MEMORY_SQLITE_PATH,
          scanned: rows.length,
          softDeleted: idsToDelete.length,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

run();

