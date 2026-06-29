/**
 * Single-row persistence for operator-editable NiceHash settings (the
 * dashboard config screen). Stores the settings object as a JSON blob in
 * `nicehash_settings` (id = 1).
 */

import type { Kysely } from 'kysely';

import type { NiceHashSettings } from '../../controller/nicehash/settings.js';
import type { Database } from '../types.js';

export class NiceHashSettingsRepo {
  constructor(private readonly db: Kysely<Database>) {}

  /** Current settings, or null if none have been persisted yet. */
  async get(): Promise<NiceHashSettings | null> {
    const row = await this.db
      .selectFrom('nicehash_settings')
      .select('config_json')
      .where('id', '=', 1)
      .executeTakeFirst();
    if (!row) return null;
    try {
      return JSON.parse(row.config_json) as NiceHashSettings;
    } catch {
      return null;
    }
  }

  /** Upsert the settings row. */
  async put(settings: NiceHashSettings): Promise<void> {
    const config_json = JSON.stringify(settings);
    const updated_at = Date.now();
    await this.db
      .insertInto('nicehash_settings')
      .values({ id: 1, config_json, updated_at })
      .onConflict((oc) => oc.column('id').doUpdateSet({ config_json, updated_at }))
      .execute();
  }
}
