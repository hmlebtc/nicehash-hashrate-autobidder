export {
  createNiceHashClient,
  NICEHASH_PROD_BASE_URL,
  NICEHASH_TEST_BASE_URL,
  type NiceHashClient,
  type NiceHashClientConfig,
} from './client.js';

export {
  buildSignatureMessage,
  createSignedHeaders,
  signRequest,
  toQueryString,
  type NiceHashCredentials,
  type SignatureInput,
  type SignedHeaders,
} from './auth.js';

export {
  NiceHashApiError,
  NiceHashAuthMissingError,
  NiceHashNetworkError,
  parseNiceHashError,
  type NiceHashErrorDetail,
} from './errors.js';

export {
  btcToSats,
  orderRunwayDays,
  parseDecimal,
  priceBtcToSatPerUnitDay,
  priceSatToBtcPerUnitDay,
  roundPrice,
  SAT_PER_BTC,
  satsToBtc,
  spendRateBtcPerDay,
  toBtcString,
} from './units.js';

export type {
  AccountBalance,
  CodeDescription,
  CreateOrderParams,
  CreateOrderResponse,
  CreatePoolRequest,
  HashpowerOrder,
  MiningAlgorithmSetting,
  MiningAlgorithmsResponse,
  MyOrdersResponse,
  NiceHashMarket,
  NiceHashOrderType,
  OrderBookCurrencyStats,
  OrderBookEntry,
  OrderBookResponse,
  Pool,
  PoolsResponse,
  ServerTimeResponse,
  UpdatePriceAndLimitParams,
} from './types.js';
