/**
 * Minimal forward-only migration runner.
 *
 * - Reads `*.sql` files from a directory, applies them in filename order.
 * - Records applied migrations in `_migrations` so re-runs are no-ops.
 * - Each migration runs inside a transaction; a clean failure leaves
 *   the DB exactly as it was before the migration started.
 *
 * Idempotency against half-applied state
 * --------------------------------------
 *
 * A migration's schema effect can be present on a DB without the
 * corresponding `_migrations` row, in two failure shapes I've seen:
 *
 *   1. A test (or any other consumer) opened the DB, ran migrations,
 *      and crashed mid-transaction before the INSERT INTO `_migrations`
 *      row committed - leaving the ALTER TABLE / CREATE TABLE effect
 *      but no tracking row. Origin: 2026-06-02, Clarent crash-looped
 *      on duplicate-column after #243's `gap-backfill-against-real-db`
 *      test ran against production state.db during deploy and the
 *      transaction's INSERT didn't survive.
 *
 *   2. An operator manually applied schema for any reason (recovery
 *      from a bad deploy, hand-DDL during debugging) without
 *      stamping `_migrations`.
 *
 * In both shapes, the next run sees the migration "not applied" in
 * `_migrations`, re-runs the SQL, and crashes on "duplicate column /
 * table already exists / index already exists". The whole daemon
 * then refuses to boot.
 *
 * The runner catches that specific class of error, stamps
 * `_migrations`, and treats the migration as applied. Any error
 * NOT matching the "already applied" pattern (real syntax errors,
 * missing tables in a referencing migration, etc.) propagates
 * untouched so genuine bugs still surface loudly.
 *
 * Limitation: SQLite executes a multi-statement SQL block until the
 * first error and then aborts. If a migration adds two columns and
 * exactly one of them already exists, the second ALTER TABLE never
 * runs and the DB ends up partial. The recovery path then catches
 * the error AT the migration level and stamps - leaving the second
 * column unapplied forever. For migrations that need this level of
 * robustness, write the SQL defensively (one statement per migration
 * file, or use guarded patterns) instead of relying on the runner.
 */

import type Database from 'better-sqlite3';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface MigrationRunResult {
  readonly applied: string[];
  readonly skipped: string[];
  /**
   * Migrations whose SQL effect was already present on the DB (per
   * the SQLite error message) and whose `_migrations` row this run
   * stamped retroactively. Surfaces in the daemon log so the operator
   * can see "I detected this DB was half-applied and fixed it" rather
   * than just a silent skip.
   */
  readonly reconciled: string[];
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `);
}

function listAppliedMigrations(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Detect SQLite errors that mean "this DDL has already been applied."
 * The messages are stable across SQLite versions; matching by
 * lowercased substring keeps the check simple and version-tolerant.
 */
function isAlreadyAppliedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes('duplicate column name') ||
    m.includes('already exists')
  );
}

export async function applyMigrations(
  db: Database.Database,
  dir: string,
): Promise<MigrationRunResult> {
  ensureMigrationsTable(db);

  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  const already = listAppliedMigrations(db);

  const applied: string[] = [];
  const skipped: string[] = [];
  const reconciled: string[] = [];

  for (const file of files) {
    if (already.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    const insertRecord = db.prepare(
      'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
    );
    const tx = db.transaction(() => {
      db.exec(sql);
      insertRecord.run(file, Date.now());
    });
    try {
      tx();
      applied.push(file);
    } catch (err) {
      if (isAlreadyAppliedError(err)) {
        // Schema effect already present but `_migrations` is missing
        // the tracking row. Stamp it now and move on.
        insertRecord.run(file, Date.now());
        reconciled.push(file);
        continue;
      }
      throw err;
    }
  }

  return { applied, skipped, reconciled };
}
