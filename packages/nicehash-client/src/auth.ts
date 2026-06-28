/**
 * NiceHash request signing (HMAC-SHA256).
 *
 * Every private endpoint is authenticated by a per-request signature carried
 * in the `X-Auth: <apiKey>:<hexDigest>` header. The signed message is a
 * NUL-delimited (0x00) concatenation of request metadata. The exact field
 * order is fixed by NiceHash and replicated here byte-for-byte:
 *
 *   apiKey ∅ time ∅ nonce ∅ "" ∅ orgId ∅ "" ∅ method ∅ path ∅ query [∅ body]
 *
 * where ∅ is NUL. Two of the slots are intentionally empty. `query` is always
 * present (empty string when there are no query params); `body` is appended
 * only for requests that carry one.
 *
 * Two correctness rules the rest of the client depends on:
 *   1. The `query` string signed here must be byte-identical to the query
 *      string appended to the request URL.
 *   2. The `body` string signed here must be byte-identical to the request
 *      body actually sent (so callers must JSON.stringify once and reuse it).
 */

import { createHmac, randomUUID } from 'node:crypto';

const NUL = '\u0000';

export interface NiceHashCredentials {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly orgId: string;
}

export interface SignatureInput {
  readonly method: string;
  /** Request path WITHOUT the query string, e.g. `/main/api/v2/hashpower/order/`. */
  readonly path: string;
  /** Query string WITHOUT the leading `?`, e.g. `algorithm=SHA256&market=EU`. */
  readonly query: string;
  /** Exact request body string, or undefined for bodyless requests. */
  readonly body?: string | undefined;
  /** Epoch milliseconds. Injectable for deterministic tests. */
  readonly time: number;
  /** Per-request nonce (UUID). Injectable for deterministic tests. */
  readonly nonce: string;
}

/**
 * Build the exact NUL-delimited message NiceHash expects for `input`.
 * Exposed (and tested) on its own so the signing contract is pinned
 * independently of HMAC/transport concerns.
 */
export function buildSignatureMessage(
  credentials: Pick<NiceHashCredentials, 'apiKey' | 'orgId'>,
  input: SignatureInput,
): string {
  const fields = [
    credentials.apiKey,
    String(input.time),
    input.nonce,
    '',
    credentials.orgId,
    '',
    input.method,
    input.path,
    input.query,
  ];
  let message = fields.join(NUL);
  if (input.body !== undefined && input.body !== '') {
    message += NUL + input.body;
  }
  return message;
}

/**
 * Compute the `X-Auth` header value: `<apiKey>:<hmacSha256Hex>`.
 */
export function signRequest(credentials: NiceHashCredentials, input: SignatureInput): string {
  const message = buildSignatureMessage(credentials, input);
  const digest = createHmac('sha256', credentials.apiSecret).update(message, 'utf8').digest('hex');
  return `${credentials.apiKey}:${digest}`;
}

export interface SignedHeaders {
  readonly 'X-Time': string;
  readonly 'X-Nonce': string;
  readonly 'X-Auth': string;
  readonly 'X-Organization-Id': string;
  readonly 'X-Request-Id': string;
  readonly 'Content-Type': string;
}

/**
 * Produce the full signed header set for a request. `time`, `nonce` and
 * `requestId` default to live values but are injectable for tests.
 */
export function createSignedHeaders(
  credentials: NiceHashCredentials,
  req: {
    method: string;
    path: string;
    query: string;
    body?: string | undefined;
    time?: number;
    nonce?: string;
    requestId?: string;
  },
): SignedHeaders {
  const time = req.time ?? Date.now();
  const nonce = req.nonce ?? randomUUID();
  const requestId = req.requestId ?? randomUUID();
  const xAuth = signRequest(credentials, {
    method: req.method,
    path: req.path,
    query: req.query,
    body: req.body,
    time,
    nonce,
  });
  return {
    'X-Time': String(time),
    'X-Nonce': nonce,
    'X-Auth': xAuth,
    'X-Organization-Id': credentials.orgId,
    'X-Request-Id': requestId,
    'Content-Type': 'application/json',
  };
}

/**
 * Serialise query params into a stable `k=v&k=v` string (insertion order,
 * URI-encoded, `undefined`/`null` skipped). The returned string is what must
 * be both signed and appended to the URL - never re-serialise separately.
 */
export function toQueryString(
  params: Readonly<Record<string, string | number | boolean | undefined | null>>,
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}
