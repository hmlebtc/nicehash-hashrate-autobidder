/**
 * In-memory store bridging the NiceHash control loop and the HTTP API.
 *
 * The daemon updates `last` with each tick's result; the HTTP layer reads it to
 * serve `/api/nicehash/status` without touching the loop. The run mode lives
 * here too so the dashboard's DRY-RUN / LIVE / PAUSED toggle can flip it at
 * runtime - the controller reads it via `getRunMode()` every tick.
 *
 * Run mode is in-memory for now (seeded from config at boot); persisting it
 * across restarts is a follow-up.
 */

import type { NiceHashTickResult } from './tick.js';
import type { RunMode } from './types.js';

export class NiceHashStateStore {
  private last: NiceHashTickResult | null = null;
  private runMode: RunMode;

  constructor(initialRunMode: RunMode) {
    this.runMode = initialRunMode;
  }

  getRunMode(): RunMode {
    return this.runMode;
  }

  setRunMode(mode: RunMode): void {
    this.runMode = mode;
  }

  setLast(result: NiceHashTickResult): void {
    this.last = result;
  }

  getLast(): NiceHashTickResult | null {
    return this.last;
  }
}
