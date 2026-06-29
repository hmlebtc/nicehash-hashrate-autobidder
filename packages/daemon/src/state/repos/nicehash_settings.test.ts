import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settingsFromEnv } from '../../controller/nicehash/settings.js';
import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { NiceHashSettingsRepo } from './nicehash_settings.js';

describe('NiceHashSettingsRepo', () => {
  let handle: DatabaseHandle;
  let repo: NiceHashSettingsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new NiceHashSettingsRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('returns null before anything is persisted', async () => {
    expect(await repo.get()).toBeNull();
  });

  it('round-trips a settings blob', async () => {
    const settings = { ...settingsFromEnv({}), apiKey: 'k', apiSecret: 'shh', orgId: 'o', tickSeconds: 30 };
    await repo.put(settings);
    expect(await repo.get()).toEqual(settings);
  });

  it('upserts the single row in place (id stays 1)', async () => {
    await repo.put({ ...settingsFromEnv({}), tickSeconds: 10 });
    await repo.put({ ...settingsFromEnv({}), tickSeconds: 99 });
    const got = await repo.get();
    expect(got?.tickSeconds).toBe(99);
    const rows = await handle.db.selectFrom('nicehash_settings').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(1);
  });

  it('returns null on a corrupt JSON blob rather than throwing', async () => {
    await handle.db
      .insertInto('nicehash_settings')
      .values({ id: 1, config_json: '{not json', updated_at: Date.now() })
      .execute();
    expect(await repo.get()).toBeNull();
  });
});
