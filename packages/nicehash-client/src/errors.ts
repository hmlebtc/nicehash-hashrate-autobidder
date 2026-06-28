/**
 * Error types for the NiceHash Hash-power API client.
 *
 * NiceHash reports API-level failures as a JSON body of the shape
 * `{ "error_id": "...", "errors": [{ "code": 5005, "message": "..." }] }`
 * alongside a non-2xx HTTP status. We surface both the HTTP status and the
 * decoded `errors[]` so callers (and the controller's gate) can branch on a
 * specific NiceHash error code - e.g. the price-decrease throttle.
 */

export interface NiceHashErrorDetail {
  readonly code?: number;
  readonly message?: string;
}

export class NiceHashApiError extends Error {
  public readonly status: number;
  public readonly endpoint: string;
  public readonly errorId: string | undefined;
  public readonly errors: readonly NiceHashErrorDetail[];
  public readonly body: unknown;

  constructor(args: {
    status: number;
    endpoint: string;
    errorId?: string | undefined;
    errors?: readonly NiceHashErrorDetail[];
    body?: unknown;
    message?: string;
  }) {
    const detail =
      args.errors && args.errors.length > 0
        ? ` - ${args.errors.map((e) => `${e.code ?? '?'}: ${e.message ?? ''}`).join('; ')}`
        : '';
    super(args.message ?? `NiceHash API ${args.endpoint} returned ${args.status}${detail}`);
    this.name = 'NiceHashApiError';
    this.status = args.status;
    this.endpoint = args.endpoint;
    this.errorId = args.errorId;
    this.errors = args.errors ?? [];
    this.body = args.body;
  }

  /** True if any returned error carries the given NiceHash numeric code. */
  hasCode(code: number): boolean {
    return this.errors.some((e) => e.code === code);
  }
}

/**
 * Pull the `error_id` + `errors[]` out of a parsed NiceHash error body,
 * tolerating shape drift (missing fields, non-array `errors`).
 */
export function parseNiceHashError(body: unknown): {
  errorId: string | undefined;
  errors: NiceHashErrorDetail[];
} {
  if (typeof body !== 'object' || body === null) {
    return { errorId: undefined, errors: [] };
  }
  const record = body as Record<string, unknown>;
  const errorId = typeof record.error_id === 'string' ? record.error_id : undefined;
  const rawErrors = Array.isArray(record.errors) ? record.errors : [];
  const errors: NiceHashErrorDetail[] = rawErrors.map((e) => {
    const item = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    // Build with conditional spreads so absent fields stay absent rather than
    // being set to an explicit `undefined` (rejected under
    // exactOptionalPropertyTypes).
    return {
      ...(typeof item.code === 'number' ? { code: item.code } : {}),
      ...(typeof item.message === 'string' ? { message: item.message } : {}),
    };
  });
  return { errorId, errors };
}

export class NiceHashAuthMissingError extends Error {
  constructor() {
    super(
      'NiceHash API call requires credentials (apiKey/apiSecret/orgId) but none were configured',
    );
    this.name = 'NiceHashAuthMissingError';
  }
}

export class NiceHashNetworkError extends Error {
  public readonly endpoint: string;

  constructor(endpoint: string, cause: unknown) {
    super(`NiceHash API network error on ${endpoint}: ${String(cause)}`, { cause });
    this.name = 'NiceHashNetworkError';
    this.endpoint = endpoint;
  }
}
