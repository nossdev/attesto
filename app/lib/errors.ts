export const ErrorCodes = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  // Returned by the Apple webhook route (and the post-OIDC check on the
  // Google route) when the path-encoded tenantId doesn't resolve to an
  // active tenant. Note the asymmetry: Google non-existent tenants surface
  // as UNAUTHENTICATED (401), not TENANT_NOT_FOUND (404), because the
  // OIDC verifier runs FIRST on that route to prevent a tenant-existence
  // enumeration oracle. See routes/webhooks.ts for rationale.
  TENANT_NOT_FOUND: "TENANT_NOT_FOUND",
  CREDENTIALS_MISSING: "CREDENTIALS_MISSING",
  INVALID_REQUEST: "INVALID_REQUEST",
  TRANSACTION_NOT_FOUND: "TRANSACTION_NOT_FOUND",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  APPLE_API_ERROR: "APPLE_API_ERROR",
  GOOGLE_API_ERROR: "GOOGLE_API_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  TENANT_NOT_FOUND: 404,
  CREDENTIALS_MISSING: 400,
  INVALID_REQUEST: 400,
  TRANSACTION_NOT_FOUND: 404,
  SIGNATURE_INVALID: 401,
  APPLE_API_ERROR: 502,
  GOOGLE_API_ERROR: 502,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      status?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.status = opts.status ?? DEFAULT_STATUS[code];
    this.details = opts.details;
  }

  toResponseBody(): {
    valid: false;
    error: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  } {
    return {
      valid: false,
      error: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
