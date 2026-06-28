/**
 * Migration-runner idempotency tests. Origin: 2026-06-02, Clarent
 * crash-looped on duplicate-column when migration 0106's ALTER
 * TABLE columns were already on the DB (via a half-applied test
 * run) but `_migrations` didn't track them. The runner now catches
 * "already applied" errors, stamps `_migrations`, and continues.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import SQLite from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations } from './index.js';

describe('applyMigrations - idempotency against half-applied state', () => {
  let migDir: string;
  let db: SQLite.Database;

  beforeEach(async () => {
    migDir = await mkdtemp(join(tmpdir(), 'mig-test-'));
    db = new SQLite(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(migDir, { recursive: true, force: true });
  });

  it('reconciles a migration whose columns already exist (no _migrations row)', async () => {
    // Simulate the half-applied state: schema has the column, but
    // `_migrations` doesn't track the migration. This is the exact
    // shape Clarent ended up in after the build-571 deploy.
    db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec('ALTER TABLE thing ADD COLUMN extra TEXT');
    // Migration file that says "add the column" - already there.
    await writeFile(
      join(migDir, '0001_add_extra.sql'),
      'ALTER TABLE thing ADD COLUMN extra TEXT;',
    );

    const result = await applyMigrations(db, migDir);

    expect(result.applied).toEqual([]);
    expect(result.reconciled).toEqual(['0001_add_extra.sql']);
    expect(result.skipped).toEqual([]);
    // _migrations should now have the row so subsequent runs skip it.
    const tracked = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
    expect(tracked.map((r) => r.name)).toEqual(['0001_add_extra.sql']);
  });

  it('reconciles a migration that creates an already-existing table', async () => {
    db.exec('CREATE TABLE preexisting (id INTEGER PRIMARY KEY)');
    await writeFile(
      join(migDir, '0001_create_preexisting.sql'),
      'CREATE TABLE preexisting (id INTEGER PRIMARY KEY);',
    );

    const result = await applyMigrations(db, migDir);

    expect(result.reconciled).toEqual(['0001_create_preexisting.sql']);
  });

  it('a clean DB applies migrations normally (no reconcile)', async () => {
    db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY)');
    await writeFile(
      join(migDir, '0001_add_col.sql'),
      'ALTER TABLE thing ADD COLUMN new_col TEXT;',
    );

    const result = await applyMigrations(db, migDir);

    expect(result.applied).toEqual(['0001_add_col.sql']);
    expect(result.reconciled).toEqual([]);
    // Column should be actually added.
    const cols = db.prepare("PRAGMA table_info(thing)").all() as { name: string }[];
    expect(cols.some((c) => c.name === 'new_col')).toBe(true);
  });

  it('rerunning after a reconcile is a clean skip (idempotent end-state)', async () => {
    db.exec('CREATE TABLE thing (id INTEGER PRIMARY KEY, extra TEXT)');
    await writeFile(
      join(migDir, '0001_add_extra.sql'),
      'ALTER TABLE thing ADD COLUMN extra TEXT;',
    );

    const first = await applyMigrations(db, migDir);
    expect(first.reconciled).toEqual(['0001_add_extra.sql']);

    const second = await applyMigrations(db, migDir);
    expect(second.applied).toEqual([]);
    expect(second.reconciled).toEqual([]);
    expect(second.skipped).toEqual(['0001_add_extra.sql']);
  });

  it('a real syntax error in a migration propagates - not silently swallowed', async () => {
    await writeFile(
      join(migDir, '0001_busted.sql'),
      'THIS IS NOT VALID SQL;',
    );

    await expect(applyMigrations(db, migDir)).rejects.toThrow(/syntax error|near "this"/i);

    // _migrations stays empty - we did NOT stamp a broken migration.
    const tracked = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
    expect(tracked).toEqual([]);
  });

  it('a migration referencing a nonexistent table propagates the error', async () => {
    await writeFile(
      join(migDir, '0001_bad_ref.sql'),
      'ALTER TABLE nonexistent ADD COLUMN x TEXT;',
    );

    await expect(applyMigrations(db, migDir)).rejects.toThrow(/no such table/i);
  });
});
