import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type DatabaseHandle } from '../db.js';
import { IpChangeEventsRepo } from './ip_change_events.js';

describe('IpChangeEventsRepo (#250)', () => {
  let handle: DatabaseHandle;
  let repo: IpChangeEventsRepo;

  beforeEach(async () => {
    handle = await openDatabase({ path: ':memory:' });
    repo = new IpChangeEventsRepo(handle.db);
  });

  afterEach(async () => {
    await closeDatabase(handle);
  });

  it('starts empty: latest() is null and listSince() is []', async () => {
    expect(await repo.latest()).toBeNull();
    expect(await repo.listSince(0)).toEqual([]);
  });

  it('records and reads back a change, newest via latest()', async () => {
    await repo.insert({ occurred_at: 1_000, old_ip: '1.1.1.1', new_ip: '2.2.2.2' });
    await repo.insert({ occurred_at: 2_000, old_ip: '2.2.2.2', new_ip: '3.3.3.3' });

    const latest = await repo.latest();
    expect(latest?.occurred_at).toBe(2_000);
    expect(latest?.old_ip).toBe('2.2.2.2');
    expect(latest?.new_ip).toBe('3.3.3.3');
  });

  it('listSince returns chronological rows and honours the window', async () => {
    await repo.insert({ occurred_at: 1_000, old_ip: 'a', new_ip: 'b' });
    await repo.insert({ occurred_at: 2_000, old_ip: 'b', new_ip: 'c' });
    await repo.insert({ occurred_at: 3_000, old_ip: 'c', new_ip: 'd' });

    const all = await repo.listSince(0);
    expect(all.map((r) => r.occurred_at)).toEqual([1_000, 2_000, 3_000]);

    const windowed = await repo.listSince(1_500, 2_500);
    expect(windowed.map((r) => r.new_ip)).toEqual(['c']);
  });

  it('tolerates a null old_ip (first-ever observation edge)', async () => {
    await repo.insert({ occurred_at: 500, old_ip: null, new_ip: '9.9.9.9' });
    const latest = await repo.latest();
    expect(latest?.old_ip).toBeNull();
    expect(latest?.new_ip).toBe('9.9.9.9');
  });
});
