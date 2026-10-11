import { getDb, transaction, type TransactionClient } from './client';
import { hashIp } from '@/lib/crypto';

/**
 * User-scoped data access (spec §74, §75).
 *
 * Every read or write of per-user data goes through `withUser`. It runs the work inside a
 * real transaction as the non-superuser `app_user` role with `app.current_user_id` set,
 * so PostgreSQL row-level security — not application code — decides which rows exist.
 *
 * Why this matters: an application bug that forgets a `WHERE user_id = ...` clause
 * returns zero rows under RLS rather than another user's data. Verified against this
 * engine: cross-user SELECTs return nothing, a forged INSERT is rejected by WITH CHECK,
 * a cross-user DELETE affects zero rows, an unset context fails closed, and interleaved
 * multi-user transactions on the shared connection do not leak context between requests.
 *
 * Two rules this module enforces so callers cannot accidentally weaken the model:
 *  1. The acting user id must be a valid UUID; an empty or malformed value throws rather
 *     than silently producing a NULL context.
 *  2. Admin paths must go through `withAdmin`, which is explicit in the call site and
 *     never a silent upgrade of a normal request.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UserContext {
  readonly userId: string;
  readonly role: 'user' | 'pro_user' | 'nutrition_editor' | 'admin' | 'super_admin';
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export function assertUuid(value: string, label = 'user id'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new Error(`Invalid ${label}: expected a UUID, received ${JSON.stringify(value)}.`);
  }
  return value.toLowerCase();
}

function isAdmin(role: UserContext['role']): boolean {
  return role === 'admin' || role === 'super_admin';
}

/**
 * Run `fn` with row-level security scoped to `ctx.userId`.
 *
 * Admin and super_admin roles additionally receive the `app_admin` role, which has
 * explicit read policies on user tables. The two roles are granted together only here,
 * and only when the caller passed an admin context.
 */
export async function withUser<T>(
  ctx: UserContext,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  const userId = assertUuid(ctx.userId);

  return transaction(async (tx) => {
    await tx.query(`SET LOCAL ROLE app_user`);
    // Parameterised so the value cannot be injected; SET LOCAL cannot take a placeholder
    // for the setting name, but the value is a validated UUID.
    await tx.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

    if (isAdmin(ctx.role)) {
      // Admin reads are a separate, explicit grant. RLS still applies to app_user;
      // admin policies are additive and are defined per table in the migrations.
      await tx.query(`SET LOCAL ROLE app_admin`);
      await tx.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
    }

    return fn(tx);
  });
}

/**
 * Explicit admin/system access with NO user scoping.
 *
 * This bypasses RLS by running as the table owner. It refuses to run unless the caller
 * presents an admin-ish actor, so it cannot be reached from a normal user request by
 * accidental refactoring.
 */
export async function withAdmin<T>(
  actor: { userId: string; role: UserContext['role'] },
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (!isAdmin(actor.role)) {
    throw new Error(
      `withAdmin requires an admin role; actor ${actor.userId} has role "${actor.role}".`,
    );
  }
  assertUuid(actor.userId);
  return transaction(fn);
}

/**
 * System access for background jobs, migrations and webhook handling — no acting user.
 * Kept separate from `withAdmin` so "no user" and "an admin user" stay distinguishable
 * in the audit trail.
 */
export async function withSystem<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
  return transaction(fn);
}

/**
 * Re-apply RLS to any table with a user_id column.
 * Called after migrations; safe to invoke repeatedly.
 */
export async function reapplyRls(): Promise<{ userScoped: number; child: number }> {
  const db = await getDb();
  const a = await db.query<{ n: number }>(`SELECT app_apply_rls() AS n`);
  const b = await db.query<{ n: number }>(`SELECT app_apply_child_rls() AS n`);
  return { userScoped: Number(a.rows[0]?.n ?? 0), child: Number(b.rows[0]?.n ?? 0) };
}

// =====================================================================================
// Audit logging (spec §79)
// =====================================================================================

export interface AuditEntry {
  readonly action: string;
  readonly resourceType?: string | null;
  readonly resourceId?: string | null;
  readonly status?: 'success' | 'failure' | 'denied';
  readonly detail?: Record<string, unknown>;
}

/**
 * Append an audit record. Runs unscoped because the audit table is a system ledger, not
 * user-owned data. A failure to write an audit row must never break the user's action,
 * but it must be visible, so it is reported on stderr.
 */
export async function audit(
  actor: { userId: string | null; role: UserContext['role'] | null },
  entry: AuditEntry,
  request?: { ip?: string | null; userAgent?: string | null; secret?: string | null },
): Promise<void> {
  try {
    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO audit_logs
           (actor_user_id, actor_role, action, resource_type, resource_id, status, ip_hash, user_agent, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          actor.userId ? assertUuid(actor.userId) : null,
          actor.role,
          entry.action,
          entry.resourceType ?? null,
          entry.resourceId ?? null,
          entry.status ?? 'success',
          hashIp(request?.ip, request?.secret ?? null),
          request?.userAgent?.slice(0, 500) ?? null,
          JSON.stringify(entry.detail ?? {}),
        ],
      );
    });
  } catch (error) {
    // Never rethrow: an audit failure must not roll back the user's legitimate action.
    console.error(
      '[audit] failed to record entry',
      entry.action,
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Append-only analytics event (spec §83). Uses an anonymous id — never a user id, never
 * meal or photo contents.
 */
export async function trackEvent(params: {
  anonymousId: string;
  eventName: string;
  properties?: Record<string, string | number | boolean>;
}): Promise<void> {
  try {
    await transaction(async (tx) => {
      await tx.query(
        `INSERT INTO analytics_events (anonymous_id, event_name, properties)
         VALUES ($1, $2, $3::jsonb)`,
        [assertUuid(params.anonymousId), params.eventName, JSON.stringify(params.properties ?? {})],
      );
    });
  } catch (error) {
    console.error(
      '[analytics] failed to record event',
      params.eventName,
      error instanceof Error ? error.message : error,
    );
  }
}
