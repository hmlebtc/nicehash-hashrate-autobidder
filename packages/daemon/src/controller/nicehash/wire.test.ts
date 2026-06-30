import { describe, expect, it } from 'vitest';

import type { HashpowerOrder, OrderBookResponse } from '@hashrate-autopilot/nicehash-client';

import {
  availableBtcFromBalance,
  competingOrdersFromBook,
  marketAnchorFromBook,
  ownedOrderFromWire,
  ownOrderFillsFromBook,
  reconcileOrders,
} from './wire.js';

// Fixture modelled on the real SHA256ASICBOOST testnet order book: stats keyed
// by currency "BTC", an idle uncapped BUSINESS ceiling order, and a STANDARD
// wall, plus a dead order that must be ignored.
const BOOK: OrderBookResponse = {
  stats: {
    BTC: {
      updatedTs: '2026-06-28T23:25:48Z',
      totalSpeed: '537.08059803',
      marketFactor: '1000000000000000.00000000',
      displayMarketFactor: 'PH',
      priceFactor: '1000000000000000000.00000000',
      displayPriceFactor: 'EH',
      orders: [
        { id: 'biz', type: 'BUSINESS', price: '0.10000000', limit: '0.00000000', acceptedSpeed: '0', alive: true },
        { id: 'a', type: 'STANDARD', price: '0.01020000', limit: '15.5', acceptedSpeed: '0', alive: true },
        { id: 'b', type: 'STANDARD', price: '0.01020000', limit: '9.7', acceptedSpeed: '0', alive: true },
        { id: 'dead', type: 'STANDARD', price: '0.5', limit: '5', acceptedSpeed: '0', alive: false },
        { id: 'mine', type: 'STANDARD', price: '0.0102', limit: '4', acceptedSpeed: '0', alive: true },
      ],
    },
  },
};

describe('competingOrdersFromBook', () => {
  it('reads the BTC currency bucket, dropping dead and own orders', () => {
    const { competitors, totalSpeedUnits } = competingOrdersFromBook(BOOK, 'BTC', new Set(['mine']));
    expect(totalSpeedUnits).toBeCloseTo(537.08059803, 6);
    expect(competitors).toHaveLength(3); // biz + a + b (dead and mine excluded)
    expect(competitors.map((c) => c.price_btc)).toEqual([0.1, 0.0102, 0.0102]);
    expect(competitors[0]?.limit_units).toBe(0);
    expect(competitors[0]?.accepted_speed_units).toBe(0);
  });

  it('returns empty for an unknown currency bucket', () => {
    expect(competingOrdersFromBook(BOOK, 'EU').competitors).toHaveLength(0);
  });
});

describe('marketAnchorFromBook', () => {
  it('anchors at the STANDARD wall, ignoring the idle uncapped BUSINESS order', () => {
    const a = marketAnchorFromBook(BOOK, 4, new Set(['mine']));
    expect(a.anchor_price_btc).toBe(0.0102);
    expect(a.thin).toBe(false);
  });
});

describe('ownOrderFillsFromBook', () => {
  // Our order resting in the public book with a real draw + miner count, the
  // value NiceHash shows even though myOrders/detail report acceptedCurrentSpeed 0.
  const FILLED_BOOK: OrderBookResponse = {
    stats: {
      BTC: {
        orders: [
          { id: 'a', type: 'STANDARD', price: '0.5', limit: '5', acceptedSpeed: '2', rigsCount: 50, alive: true },
          { id: 'mine', type: 'STANDARD', price: '0.4528', limit: '4', acceptedSpeed: '0.0005', rigsCount: 137, alive: true },
        ],
      },
    },
  };

  it('recovers our order fill (speed + miners) from its own book row', () => {
    const fills = ownOrderFillsFromBook(FILLED_BOOK, new Set(['mine']), 'BTC');
    expect(fills.size).toBe(1);
    expect(fills.get('mine')).toEqual({ accepted_speed_units: 0.0005, rigs_count: 137 });
  });

  it('ignores ids we do not own and unknown currency buckets', () => {
    expect(ownOrderFillsFromBook(FILLED_BOOK, new Set(['nope']), 'BTC').size).toBe(0);
    expect(ownOrderFillsFromBook(FILLED_BOOK, new Set(['mine']), 'EU').size).toBe(0);
  });
});

describe('ownedOrderFromWire / reconcileOrders', () => {
  const orderA: HashpowerOrder = {
    id: 'mine',
    status: { code: 'ACTIVE' },
    price: '0.0102',
    limit: '4',
    amount: '0.01',
    availableAmount: '0.008',
    payedAmount: '0.002',
    acceptedCurrentSpeed: '3.5',
  };
  const orderB: HashpowerOrder = { id: 'stranger', status: 'ACTIVE', price: '0.02', limit: '1', amount: '0.01' };

  it('maps a wire order into the owned snapshot', () => {
    const s = ownedOrderFromWire(orderA, 1700000000000);
    expect(s).toMatchObject({
      order_id: 'mine',
      price_btc: 0.0102,
      limit_units: 4,
      available_amount_btc: 0.008,
      payed_amount_btc: 0.002,
      accepted_speed_units: 3.5,
      status: 'ACTIVE',
      pool_username: null,
      last_price_decrease_at: 1700000000000,
    });
  });

  it('carries the pool worker (stratum username) into the snapshot', () => {
    const withPool: HashpowerOrder = { ...orderA, pool: { username: 'bc1qabc.autobidder' } };
    expect(ownedOrderFromWire(withPool).pool_username).toBe('bc1qabc.autobidder');
  });

  it('owns ledger orders and ignores foreign orders (no PAUSE)', () => {
    const { owned, unknown } = reconcileOrders([orderA, orderB], new Set(['mine']));
    expect(owned.map((o) => o.order_id)).toEqual(['mine']);
    // Foreign orders are ignored entirely now - never classified as unknown.
    expect(unknown).toEqual([]);
  });

  it('adopts a live order by matching pool worker, even when not in the ledger', () => {
    const minePool: HashpowerOrder = {
      id: 'readopt',
      status: 'ACTIVE',
      price: '0.0102',
      limit: '4',
      amount: '0.01',
      pool: { username: 'bc1qme.autobidder' },
    };
    // A foreign live order on a different worker must stay ignored.
    const foreign: HashpowerOrder = {
      id: 'other',
      status: 'ACTIVE',
      price: '0.02',
      limit: '1',
      amount: '0.01',
      pool: { username: 'bc1qsomeoneelse' },
    };
    const { owned, unknown } = reconcileOrders(
      [minePool, foreign],
      new Set(), // empty ledger - relies purely on the pool-worker match
      'bc1qme.autobidder',
    );
    expect(owned.map((o) => o.order_id)).toEqual(['readopt']);
    expect(unknown).toEqual([]);
  });

  it('does not adopt stopped/completed orders on our worker (only live ones)', () => {
    const cancelledMine: HashpowerOrder = {
      id: 'old',
      status: { code: 'CANCELLED' },
      price: '0.0102',
      limit: '4',
      amount: '0.01',
      pool: { username: 'bc1qme.autobidder' },
    };
    const { owned } = reconcileOrders([cancelledMine], new Set(), 'bc1qme.autobidder');
    expect(owned).toEqual([]); // historical orders on our worker are not re-adopted
  });
});

describe('availableBtcFromBalance', () => {
  it('parses the available field', () => {
    expect(availableBtcFromBalance({ currency: 'TBTC', totalBalance: '1', available: '0.5' })).toBe(0.5);
  });
});
