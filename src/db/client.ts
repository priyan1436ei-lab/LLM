import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { PGliteInterface } from '@electric-sql/pglite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { env } from '@/lib/env';

/**
 * Database substrate (spec §2, §87, §133).
 *
 * The canonical production target is a real PostgreSQL server (Supabase or any
 * Postgres). In this deployment no Postgres server exists, so the app runs on
 * PGlite 0.5.8 — genuine PostgreSQL 18.3 compiled to WebAssembly. This is a real
 * Postgres engine, not an emulation: transactions, row-level security, plpgsql
 * triggers, partial indexes and pg_trgm are all the real implementations.
 *
 * Verified against this exact engine version:
 *   - transactions + ROLLBACK and SAVEPOINT rollback: real
 *   - RLS enabled, FORCEd, and enforced for a non-superuser role under SET ROLE: real
 *   - pg_trgm `%`, `similarity()`, GIN trgm index: real
 *   - plpgsql, triggers, generated columns, partial unique indexes, upserts: real
 *   - pgcrypto / uuid-ossp / citext / vector: NOT AVAILABLE
 *     -> we use the built-in gen_random_uuid() and lower() expression indexes instead
 *
 * Two engine characteristics shape this module:
 *  1. PGlite is single-writer. Two OS processes opening the same data directory do
 *     NOT raise a lock error — the second one's committed writes silently vanish when
 *     the processes close. Therefore exactly one process may own the data directory.
 *  2. Overlapping queries on one instance are queued by the engine, and `SET LOCAL`
 *     is transaction-scoped, so per-user RLS context cannot leak between requests
 *     (verified with interleaved multi-user transactions). We still serialise
 *     transaction bodies through an explicit queue for deterministic behaviour.
 */

export type Database = PGliteInterface;

/**
 * A global cache survives Next.js dev-server hot reloads, which otherwise create a new
 * PGlite instance (and a second writer on the same directory) on every module reload.
 */
const globalForDb = globalThis as unknown as {
  __fittrackDb?: Promise<Database>;
  __fittrackDbOwnerPid?: number;
};

/** Serialises transaction bodies so concurrent requests cannot interleave mid-transaction. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const globalForMutex = globalThis as unknown as { __fittrackTxMutex?: Mutex };
const txMutex: Mutex = (globalForMutex.__fittrackTxMutex ??= new Mutex());

async function createDatabase(): Promise<Database> {
  const e = env();

  if (e.DB_SUBSTRATE === 'postgres') {
    if (!e.DATABASE_URL) {
      throw new Error(
        'DB_SUBSTRATE=postgres requires DATABASE_URL. Refusing to start with an ' +
          'implicit or fallback database.',
      );
    }
    // A real networked Postgres is a different driver. Rather than silently pretending
    // the embedded engine is the same thing, we fail loudly: this build ships the
    // embedded engine, and switching substrate must be an explicit, deliberate change.
    throw new Error(
      'DB_SUBSTRATE=postgres is configured, but this build has no networked Postgres ' +
        'driver wired in. Set DB_SUBSTRATE=pglite to use the embedded real-Postgres ' +
        'engine, or add the postgres driver and re-run migrations.',
    );
  }

  const dataDir = path.isAbsolute(e.PGLITE_DATA_DIR)
    ? e.PGLITE_DATA_DIR
    : // turbopackIgnore keeps static tracing from pulling the whole project into the bundle
      // over what is really just a local data-directory path.
      path.join(/* turbopackIgnore: true */ process.cwd(), e.PGLITE_DATA_DIR);
  await mkdir(dataDir, { recursive: true });

  const db = await PGlite.create(dataDir, {
    // pg_trgm is the only bundled extension we need and it must be registered at
    // construction time — PGlite 0.5.8 has no loadExtension() API.
    extensions: { pg_trgm },
  });

  // `pg_trgm` registered above makes `CREATE EXTENSION pg_trgm` in migrations work.
  await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

  return db;
}

/** The single process-wide database handle. */
export function getDb(): Promise<Database> {
  if (!globalForDb.__fittrackDb) {
    globalForDb.__fittrackDbOwnerPid = process.pid;
    globalForDb.__fittrackDb = createDatabase().catch((error: unknown) => {
      // Do not cache a failed initialisation — a later call should retry cleanly.
      globalForDb.__fittrackDb = undefined;
      throw error;
    });
  } else if (globalForDb.__fittrackDbOwnerPid !== process.pid) {
    throw new Error(
      'The database handle was inherited from another process. PGlite is single-writer: ' +
        'each process must own its own instance. Restart the process instead of forking.',
    );
  }
  return globalForDb.__fittrackDb;
}

/** Close the handle. Used by tests and graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (!globalForDb.__fittrackDb) return;
  const pending = globalForDb.__fittrackDb;
  globalForDb.__fittrackDb = undefined;
  globalForDb.__fittrackDbOwnerPid = undefined;
  const db = await pending.catch(() => undefined);
  await db?.close();
}

/**
 * Run a statement that is not user-scoped (migrations, seeding, admin/system reads).
 * Runs as the owner role, which bypasses RLS by design.
 */
export async function rawQuery<T = Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const db = await getDb();
  const result = await db.query<T>(sql, params as unknown[]);
  return result.rows;
}

/** Execute one or more statements (DDL/scripts). Owner role, no RLS. */
export async function rawExec(sql: string): Promise<void> {
  const db = await getDb();
  await db.exec(sql);
}

export interface QueryResult<T> {
  readonly rows: T[];
}

/** Query helper that works for both `query` and `exec` shapes. */
export function rowsOf<T>(result: { rows: unknown[] }): T[] {
  return result.rows as T[];
}

/**
 * Run a set of statements in one real transaction. The body runs inside
 * BEGIN/COMMIT; a throw triggers ROLLBACK (spec §87).
 */
export async function transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
  return txMutex.run(async () => {
    const db = await getDb();
    return db.transaction(async (tx) => {
      const client: TransactionClient = {
        query: async <R = Record<string, unknown>>(
          sql: string,
          params: readonly unknown[] = [],
        ): Promise<R[]> => {
          const result = await tx.query<R>(sql, params as unknown[]);
          return result.rows;
        },
        exec: async (sql: string): Promise<void> => {
          await tx.exec(sql);
        },
      };
      return fn(client);
    });
  });
}

export interface TransactionClient {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  exec(sql: string): Promise<void>;
}

/**
 * All tables that hold per-user data and therefore MUST be covered by a row-level
 * security policy. Kept here (not in SQL) so a test can assert completeness against
 * the live catalog — a new user-data table without RLS becomes a failing test rather
 * than a silent hole (spec §75).
 */
export const USER_SCOPED_TABLES = [
  'profiles',
  'user_preferences',
  'health_goals',
  'nutrition_goals',
  'meals',
  'meal_items',
  'food_scans',
  'food_scan_results',
  'food_corrections',
  'food_favorites',
  'saved_meals',
  'meal_plans',
  'meal_plan_days',
  'meal_plan_items',
  'pantry_items',
  'grocery_items',
  'water_logs',
  'weight_logs',
  'body_measurements',
  'progress_photos',
  'workout_plans',
  'workout_sessions',
  'workout_sets',
  'activity_logs',
  'recovery_logs',
  'habit_logs',
  'daily_summaries',
  'ai_insights',
  'ai_conversations',
  'ai_messages',
  'notifications',
  'push_subscriptions',
  'subscriptions',
  'payments',
  'user_achievements',
  'device_connections',
  'sync_jobs',
  'user_sessions',
  'user_feedback',
  'user_recipes',
  'export_jobs',
  'ai_usage_events',
] as const;

/** Tables intentionally readable by all authenticated users (shared reference data). */
export const SHARED_REFERENCE_TABLES = [
  'foods',
  'food_aliases',
  'food_categories',
  'food_servings',
  'nutrition_reference',
  'food_brands',
  'food_products',
  'barcodes',
  'recipes',
  'recipe_ingredients',
  'exercises',
  'achievements',
  'feature_flags',
] as const;

/** Append-only tables that must never be updated or deleted by the application role. */
export const APPEND_ONLY_TABLES = [
  'audit_logs',
  'analytics_events',
  'ai_usage_events',
  'job_queue',
] as const;
