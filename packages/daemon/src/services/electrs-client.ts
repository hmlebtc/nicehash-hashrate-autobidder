/**
 * Electrum TCP JSON-RPC client for Electrs.
 *
 * Connects to a standard Electrs instance (port 50001, no SSL) and
 * queries address balance via `blockchain.scripthash.get_balance`.
 * Instant indexed lookups - no full-UTXO-set scan like scantxoutset.
 *
 * The `scripthash` that Electrum protocol requires is:
 *   SHA256(scriptPubKey) with bytes reversed → hex string.
 *
 * We compute that from the operator's bech32/bech32m BTC address
 * using the `bech32` package + Node crypto.
 */

import { createHash } from 'node:crypto';
import { Socket } from 'node:net';

import { bech32, bech32m } from 'bech32';

export interface ElectrsConfig {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs?: number;
}

export interface ElectrsBalance {
  readonly confirmed: number;
  readonly unconfirmed: number;
}

export interface ElectrsUnspent {
  readonly tx_hash: string;
  readonly tx_pos: number;
  readonly height: number;
  readonly value: number;
}

export interface ElectrsHistoryItem {
  readonly tx_hash: string;
  /** Block height. 0 = unconfirmed (mempool). -1 = unconfirmed with unconfirmed parents. */
  readonly height: number;
}

/**
 * Subset of fields we care about from `blockchain.transaction.get`
 * with verbose=true. Electrs (Romanz fork) passes through bitcoind's
 * `decoderawtransaction` shape plus block metadata. We only need the
 * coinbase indicator on vin[0] and the per-vout value + address.
 */
export interface ElectrsTransaction {
  readonly txid: string;
  readonly vin: ReadonlyArray<{ readonly coinbase?: string }>;
  readonly vout: ReadonlyArray<{
    readonly n: number;
    /** Value in BTC (per bitcoind convention). */
    readonly value: number;
    readonly scriptPubKey: {
      readonly hex: string;
      readonly address?: string;
      readonly addresses?: ReadonlyArray<string>;
    };
  }>;
  readonly blockhash?: string;
  readonly blocktime?: number;
  readonly confirmations?: number;
}

export interface ElectrsClient {
  getBalance(address: string): Promise<ElectrsBalance>;
  /**
   * Per-UTXO list at the given address. Used by the payout-observer
   * to populate `reward_events` for the chart's `paid_total_sat`
   * series on electrs-only setups (no bitcoind RPC available, e.g.
   * Umbrel installs that didn't declare bitcoind as a dependency).
   * `listunspent` doesn't expose a coinbase flag - we treat all
   * outputs at the configured payout address as reward events,
   * which is the right call for an Ocean-paying address.
   */
  listUnspent(address: string): Promise<ElectrsUnspent[]>;
  /**
   * Full address history (#170): every confirmed or mempool tx
   * touching the given address. Returns the same shape as
   * `blockchain.scripthash.get_history`. Used by the historical
   * backfill loop to discover Ocean coinbase payouts that have
   * already been swept off-address - those don't appear in
   * `listUnspent` but they did exist on-chain at some point and
   * count toward lifetime mining income.
   */
  getHistory(address: string): Promise<ElectrsHistoryItem[]>;
  /**
   * Verbose tx fetch via `blockchain.transaction.get`. Used by the
   * backfill loop to (a) confirm a candidate history item is a
   * coinbase tx and (b) enumerate the vouts that paid to the
   * payout address.
   */
  getTransaction(txid: string): Promise<ElectrsTransaction>;
  /**
   * Fetch the 4-byte version field from the block header at the
   * given height. Returns the parsed signed-int. Used to detect
   * BIP-110 signaling for the chart's crown marker (#94). Electrs's
   * `blockchain.block.header(height)` returns the raw 80-byte header
   * as hex; the version sits in the first 4 bytes, little-endian.
   */
  getBlockVersionByHeight(height: number): Promise<number>;
  /**
   * Fetch the 4-byte unix timestamp from the block header at the
   * given height (offset 68, little-endian uint32). Used by the
   * payout-observer to stamp `reward_events.detected_at` with the
   * actual on-chain time rather than wall-clock-of-scan, so the
   * chart's lifetime-earnings line plots payouts at their real
   * historical positions on first backfill.
   */
  getBlockTimeByHeight(height: number): Promise<number>;
  close(): void;
}

export async function createElectrsClient(config: ElectrsConfig): Promise<ElectrsClient> {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const socket = new Socket();
  let buffer = '';
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let nextId = 1;

  await new Promise<void>((resolve, reject) => {
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      socket.removeAllListeners('timeout');
      resolve();
    });
    socket.once('error', (err) => reject(new Error(`Electrs connect failed: ${err.message}`)));
    socket.once('timeout', () => reject(new Error('Electrs connect timeout')));
    socket.connect(config.port, config.host);
  });

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(`Electrs RPC error: ${JSON.stringify(msg.error)}`));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // malformed line; ignore
      }
    }
  });

  function call<T>(method: string, params: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Electrs RPC ${method}: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      socket.write(msg);
    });
  }

  // Handshake: server.version is required by most Electrum servers.
  await call<[string, string]>('server.version', ['braiins-autopilot', '1.4']);

  return {
    async getBalance(address: string): Promise<ElectrsBalance> {
      const scripthash = addressToScripthash(address);
      const result = await call<{ confirmed: number; unconfirmed: number }>(
        'blockchain.scripthash.get_balance',
        [scripthash],
      );
      return { confirmed: result.confirmed, unconfirmed: result.unconfirmed };
    },
    async getBlockVersionByHeight(height: number): Promise<number> {
      const headerHex = await call<string>('blockchain.block.header', [height]);
      // The header is at least 80 bytes (160 hex chars). First 4
      // bytes are the version field, little-endian.
      if (typeof headerHex !== 'string' || headerHex.length < 8) {
        throw new Error(`Electrs RPC blockchain.block.header(${height}): malformed header`);
      }
      const buf = Buffer.from(headerHex.slice(0, 8), 'hex');
      return buf.readInt32LE(0);
    },
    async getBlockTimeByHeight(height: number): Promise<number> {
      const headerHex = await call<string>('blockchain.block.header', [height]);
      // 80-byte block header layout: version(4) + prev_hash(32)
      // + merkle_root(32) + time(4) + bits(4) + nonce(4). Time field
      // sits at byte offset 68, little-endian uint32 (unix epoch).
      if (typeof headerHex !== 'string' || headerHex.length < 160) {
        throw new Error(`Electrs RPC blockchain.block.header(${height}): malformed header`);
      }
      const buf = Buffer.from(headerHex.slice(0, 160), 'hex');
      return buf.readUInt32LE(68);
    },
    async listUnspent(address: string): Promise<ElectrsUnspent[]> {
      const scripthash = addressToScripthash(address);
      const rows = await call<Array<{ tx_hash: string; tx_pos: number; height: number; value: number }>>(
        'blockchain.scripthash.listunspent',
        [scripthash],
      );
      return rows.map((r) => ({
        tx_hash: String(r.tx_hash),
        tx_pos: Number(r.tx_pos),
        height: Number(r.height),
        value: Number(r.value),
      }));
    },
    async getHistory(address: string): Promise<ElectrsHistoryItem[]> {
      const scripthash = addressToScripthash(address);
      const rows = await call<Array<{ tx_hash: string; height: number }>>(
        'blockchain.scripthash.get_history',
        [scripthash],
      );
      return rows.map((r) => ({
        tx_hash: String(r.tx_hash),
        height: Number(r.height),
      }));
    },
    async getTransaction(txid: string): Promise<ElectrsTransaction> {
      // Some Electrum servers reject the `verbose=true` flag and only
      // return raw hex. Romanz electrs (the de-facto Bitcoin Electrum
      // server) supports verbose since 0.9.x, which matches what
      // Umbrel ships. If the call ever surfaces "verbose transactions
      // are currently unsupported", the caller falls back gracefully
      // - the backfill is best-effort, not a daemon-killing failure.
      const tx = await call<ElectrsTransaction>('blockchain.transaction.get', [txid, true]);
      return tx;
    },
    close() {
      socket.destroy();
    },
  };
}

/**
 * Public helper used by the payout-observer's backfill loop to match
 * vout.scriptPubKey.hex against the configured payout address without
 * relying on each electrs build's choice of `address` vs `addresses`
 * vs nothing-at-all in the verbose-tx response. Comparing hex on both
 * sides is the one shape that's invariant across implementations.
 */
export function addressToScriptPubKeyHex(address: string): string {
  return addressToScriptPubKey(address).toString('hex');
}

// ---------------------------------------------------------------------------
// Address → Electrum scripthash
// ---------------------------------------------------------------------------

export function addressToScripthash(address: string): string {
  const scriptPubKey = addressToScriptPubKey(address);
  const hash = createHash('sha256').update(scriptPubKey).digest();
  return Buffer.from(hash).reverse().toString('hex');
}

function addressToScriptPubKey(address: string): Buffer {
  if (address.startsWith('bc1p') || address.startsWith('tb1p')) {
    // Bech32m - P2TR (witness v1, 32-byte key)
    const decoded = bech32m.decode(address);
    const version = decoded.words[0]!;
    const program = Buffer.from(bech32m.fromWords(decoded.words.slice(1)));
    return witnessScript(version, program);
  }
  if (address.startsWith('bc1') || address.startsWith('tb1')) {
    // Bech32 - P2WPKH (v0, 20 bytes) or P2WSH (v0, 32 bytes)
    const decoded = bech32.decode(address);
    const version = decoded.words[0]!;
    const program = Buffer.from(bech32.fromWords(decoded.words.slice(1)));
    return witnessScript(version, program);
  }
  throw new Error(
    `Only bech32/bech32m (bc1…) addresses are supported. Got: ${address.slice(0, 8)}…`,
  );
}

function witnessScript(version: number, program: Buffer): Buffer {
  // OP_<version> <push_length> <program>
  const versionOpcode = version === 0 ? 0x00 : 0x50 + version;
  return Buffer.concat([Buffer.from([versionOpcode, program.length]), program]);
}
