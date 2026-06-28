/**
 * Typed shapes for the subset of the NiceHash Hash-power API the autobidder
 * uses. NiceHash returns numeric quantities (price, limit, amounts) as
 * decimal *strings*; we keep them as strings here and parse at the edges via
 * `./units` so no precision is lost in transit.
 *
 * Shapes are intentionally permissive: only the fields the controller reads
 * are declared. Unknown fields pass through untyped rather than breaking on
 * NiceHash schema drift.
 */

/** Common NiceHash market codes for SHA256. Other algos expose their own. */
export type NiceHashMarket = 'EU' | 'USA' | 'EU_N' | 'USA_E' | (string & {});

/** Order types. Only STANDARD is creatable via the API (FIXED was removed). */
export type NiceHashOrderType = 'STANDARD' | 'FIXED' | (string & {});

/**
 * A single mining algorithm's marketplace settings. `marketFactor` and
 * `displayMarketFactor` are opaque scaling values that MUST be echoed back
 * verbatim on create / updatePriceAndLimit requests (see the official
 * rest-clients-demo). The speed/price display unit is derived from
 * `displayMarketFactor`.
 */
export interface MiningAlgorithmSetting {
  readonly algorithm: string;
  readonly title?: string;
  readonly enabled?: boolean;
  readonly order?: number;
  /** Opaque scaling factor - echo verbatim on order mutations. */
  readonly marketFactor: string;
  /** Opaque display scaling factor - echo verbatim on order mutations. */
  readonly displayMarketFactor: string;
  /** Minimum order amount in BTC (e.g. "0.001"). */
  readonly minimalOrderAmount?: string;
  /** Minimum / maximum speed limit in the display unit. */
  readonly minSpeedLimit?: string;
  readonly maxSpeedLimit?: string;
  /**
   * Maximum single price-decrease step (negative decimal string, e.g.
   * "-0.0001"). The controller's lowering gate clamps to this.
   */
  readonly priceDownStep?: string;
  readonly minimalPoolDifficulty?: string;
}

export interface MiningAlgorithmsResponse {
  readonly miningAlgorithms: readonly MiningAlgorithmSetting[];
}

/** `GET /api/v2/time` */
export interface ServerTimeResponse {
  readonly serverTime: number;
}

/** `GET /main/api/v2/accounting/account2/{currency}` */
export interface AccountBalance {
  readonly currency: string;
  readonly totalBalance: string;
  readonly available: string;
  readonly pending?: string;
  readonly debt?: string;
  readonly active?: boolean;
}

/** A code/description pair NiceHash uses for enums (status, type, ...). */
export interface CodeDescription {
  readonly code: string;
  readonly description?: string;
}

/** A hash-power order (own order, from create / get / myOrders). */
export interface HashpowerOrder {
  readonly id: string;
  readonly type?: CodeDescription | string;
  readonly market?: NiceHashMarket;
  readonly algorithm?: { readonly algorithm: string; readonly title?: string } | string;
  readonly status?: CodeDescription | string;
  /** Price in BTC per (display unit) per day, as a decimal string. */
  readonly price: string;
  /** Speed limit in the display unit (e.g. PH/s for SHA256), decimal string. */
  readonly limit: string;
  /** Total funds committed to the order, BTC decimal string. */
  readonly amount: string;
  /** Unspent funds still escrowed in the order, BTC decimal string. */
  readonly availableAmount?: string;
  /** Funds already spent by the order, BTC decimal string. */
  readonly payedAmount?: string;
  /** Currently delivered speed in the display unit, decimal string. */
  readonly acceptedCurrentSpeed?: string;
  readonly poolId?: string;
  readonly marketFactor?: string;
  readonly displayMarketFactor?: string;
  readonly startTs?: number;
  readonly endTs?: number;
  readonly rigsCount?: number;
}

/** `POST /main/api/v2/hashpower/order/` response (the created order). */
export type CreateOrderResponse = HashpowerOrder;

/** `GET /main/api/v2/hashpower/myOrders` */
export interface MyOrdersResponse {
  readonly list: readonly HashpowerOrder[];
  readonly pagination?: {
    readonly size?: number;
    readonly page?: number;
    readonly totalPageCount?: number;
  };
}

/**
 * One resting competing BUY order in the hash-power order book. NiceHash is a
 * buyer-competition market: sellers deliver to the highest-priced live orders
 * first, so `price` here is what a competitor is willing to pay, not ask-side
 * supply.
 *
 * Confirmed against the live API (SHA256ASICBOOST): `price` is in the
 * currency-bucket's `displayPriceFactor` units (BTC per EH per day for this
 * algo), `limit`/`acceptedSpeed` are in `displayMarketFactor` units (PH/s).
 * `limit` "0" means uncapped; an uncapped order's real draw is `acceptedSpeed`
 * (an uncapped order with `acceptedSpeed` 0 is not actually consuming supply).
 */
export interface OrderBookEntry {
  readonly id?: string;
  /** "STANDARD" | "BUSINESS". */
  readonly type?: string;
  /** Competitor's price, BTC per displayPriceFactor per day, decimal string. */
  readonly price: string;
  /** Competitor's speed cap in displayMarketFactor units ("0" = uncapped). */
  readonly limit: string;
  /** Speed currently delivered to this order (displayMarketFactor units). */
  readonly acceptedSpeed?: string;
  readonly payingSpeed?: string;
  readonly rigsCount?: number;
  readonly alive?: boolean;
  /** Paying currency of this order, e.g. "BTC". */
  readonly currencyMarket?: string;
}

/**
 * Order-book stats for one paying currency. The order book is keyed by
 * currency ("BTC"), NOT by EU/USA market - confirmed against the live API.
 */
export interface OrderBookCurrencyStats {
  readonly updatedTs?: string;
  /** Total live deliverable speed, displayMarketFactor units, decimal string. */
  readonly totalSpeed?: string;
  /** Speed scale factor (e.g. "1000000000000000" = PH). */
  readonly marketFactor?: string;
  /** Speed display unit label (e.g. "PH"). */
  readonly displayMarketFactor?: string;
  /** Price scale factor (e.g. "1000000000000000000" = EH). */
  readonly priceFactor?: string;
  /** Price display unit label (e.g. "EH"). */
  readonly displayPriceFactor?: string;
  readonly orders: readonly OrderBookEntry[];
  readonly pagination?: {
    readonly size?: number;
    readonly page?: number;
    readonly totalPageCount?: number;
  };
}

/** `GET /main/api/v2/hashpower/orderBook?algorithm=...` */
export interface OrderBookResponse {
  /** Keyed by paying currency (e.g. "BTC"), NOT by EU/USA market. */
  readonly stats: Readonly<Record<string, OrderBookCurrencyStats>>;
}

/** A registered stratum pool. */
export interface Pool {
  readonly id: string;
  readonly name: string;
  readonly algorithm?: string;
  readonly stratumHostname?: string;
  readonly stratumPort?: number;
  readonly username?: string;
  readonly password?: string;
}

/** `GET /main/api/v2/pools/` */
export interface PoolsResponse {
  readonly list: readonly Pool[];
  readonly pagination?: {
    readonly size?: number;
    readonly page?: number;
    readonly totalPageCount?: number;
  };
}

export interface CreatePoolRequest {
  readonly name: string;
  readonly algorithm: string;
  readonly stratumHostname: string;
  readonly stratumPort: number;
  readonly username: string;
  readonly password: string;
}

/**
 * Parameters for creating a STANDARD hash-power order. `marketFactor` /
 * `displayMarketFactor` come straight off the matching `MiningAlgorithmSetting`
 * and are echoed verbatim.
 */
export interface CreateOrderParams {
  readonly market: NiceHashMarket;
  readonly algorithm: string;
  readonly type: NiceHashOrderType;
  /** Total BTC to escrow (>= algorithm `minimalOrderAmount`), decimal string. */
  readonly amount: string;
  /** Price in BTC per display unit per day, decimal string. */
  readonly price: string;
  /** Speed limit in the display unit, decimal string. */
  readonly limit: string;
  readonly poolId: string;
  readonly marketFactor: string;
  readonly displayMarketFactor: string;
}

/**
 * Price and/or limit change for a live order. At least one of `price` /
 * `limit` must be set; `marketFactor` / `displayMarketFactor` are required
 * by NiceHash on every update.
 */
export interface UpdatePriceAndLimitParams {
  readonly price?: string;
  readonly limit?: string;
  readonly marketFactor: string;
  readonly displayMarketFactor: string;
}
