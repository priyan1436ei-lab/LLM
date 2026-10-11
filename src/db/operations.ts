import { withUser, type UserContext } from './tenant';
import { runInTransactionScope } from './emit';
import type { TransactionClient } from './client';

/**
 * The single wrapper every user-scoped write goes through (spec §75, §87, §89).
 *
 * It composes the two guarantees that must always hold together:
 *  1. `withUser` — the work runs inside a real transaction as the non-superuser role with
 *     row-level security keyed to the authenticated user.
 *  2. `runInTransactionScope` — realtime events are buffered and published only after the
 *     transaction commits, so a subscriber can never observe rolled-back state.
 *
 * Callers get one function so they cannot accidentally apply one guarantee without the
 * other.
 */
export async function withUserTransaction<T>(
  ctx: UserContext,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return runInTransactionScope(() => withUser(ctx, fn));
}

/** Machine-readable outcome codes for API responses. */
export type OperationErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'not_configured'
  | 'ai_failed'
  | 'unavailable';

export class OperationError extends Error {
  readonly code: OperationErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: OperationErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OperationError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Map an unknown thrown value onto a user-safe operation error. */
export function toOperationError(error: unknown): OperationError {
  if (error instanceof OperationError) return error;

  const message = error instanceof Error ? error.message : String(error);

  // A row-level security violation means the request tried to touch data it does not own.
  if (/row-level security/i.test(message)) {
    return new OperationError('forbidden', 'That action is not permitted for this account.', 403);
  }
  if (/does not exist/i.test(message)) {
    return new OperationError('not_found', message, 404);
  }
  return new OperationError('invalid_input', message, 400);
}
