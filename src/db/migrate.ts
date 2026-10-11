import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { getDb, transaction } from './client';

/**
 * Migration runner (spec §103).
 *
 * Requirements it enforces:
 *  - Migrations are ordered, versioned files. The production schema is never changed
 *    by hand; the recorded history is the truth.
 *  - Each migration runs inside a real transaction, so a failure leaves no partial
 *    schema behind.
 *  - A checksum is stored per migration. If a previously-applied file is edited, the
 *    runner reports drift instead of silently applying a different schema.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
  readonly duration_ms: number;
}

const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations');

const MIGRATION_FILE = /^(\d{3,})_([a-z0-9_]+)\.sql$/i;

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = await readdir(dir);
  const files = entries.filter((f) => MIGRATION_FILE.test(f)).sort();

  const migrations: Migration[] = [];
  const seen = new Set<number>();

  for (const filename of files) {
    const match = MIGRATION_FILE.exec(filename);
    if (!match || match[1] === undefined || match[2] === undefined) {
      throw new Error(`Unparseable migration filename: ${filename}`);
    }
    const version = Number.parseInt(match[1], 10);
    if (seen.has(version)) {
      throw new Error(`Duplicate migration version ${version} (${filename}).`);
    }
    seen.add(version);

    const sql = await readFile(path.join(dir, filename), 'utf8');
    migrations.push({
      version,
      name: match[2],
      filename,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  return migrations;
}

async function ensureMigrationsTable(): Promise<void> {
  const db = await getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      integer PRIMARY KEY,
      name         text        NOT NULL,
      checksum     text        NOT NULL,
      applied_at   timestamptz NOT NULL DEFAULT now(),
      duration_ms  integer     NOT NULL DEFAULT 0
    );
  `);
}

export async function appliedMigrations(): Promise<AppliedMigration[]> {
  await ensureMigrationsTable();
  const db = await getDb();
  const result = await db.query<AppliedMigration>(
    `SELECT version, name, checksum, applied_at::text AS applied_at, duration_ms
       FROM schema_migrations ORDER BY version`,
  );
  return result.rows;
}

export interface MigrationPlan {
  readonly pending: Migration[];
  /** Applied migrations whose file content no longer matches the recorded checksum. */
  readonly drifted: { readonly version: number; readonly name: string }[];
}

/** Compute what would run, without changing anything. */
export async function planMigrations(dir?: string): Promise<MigrationPlan> {
  const all = await loadMigrations(dir);
  const applied = await appliedMigrations();
  const appliedByVersion = new Map(applied.map((a) => [a.version, a]));

  const drifted: { version: number; name: string }[] = [];
  const pending: Migration[] = [];

  for (const migration of all) {
    const record = appliedByVersion.get(migration.version);
    if (!record) {
      pending.push(migration);
      continue;
    }
    if (record.checksum !== migration.checksum) {
      drifted.push({ version: migration.version, name: migration.name });
    }
  }

  return { pending, drifted };
}

export interface MigrationReport {
  readonly applied: { version: number; name: string; durationMs: number }[];
  readonly skipped: number;
  readonly drifted: { version: number; name: string }[];
}

/**
 * Apply all pending migrations. Each runs in its own transaction and is recorded
 * with its checksum. Drift is reported but never auto-corrected.
 */
export async function migrate(dir?: string): Promise<MigrationReport> {
  await ensureMigrationsTable();
  const plan = await planMigrations(dir);

  const appliedNow: { version: number; name: string; durationMs: number }[] = [];

  for (const migration of plan.pending) {
    const started = Date.now();
    await transaction(async (tx) => {
      // Inside the transaction so schema + history commit atomically.
      await tx.exec(migration.sql);
      await tx.query(
        `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
         VALUES ($1, $2, $3, $4)`,
        [migration.version, migration.name, migration.checksum, Date.now() - started],
      );
    });
    appliedNow.push({
      version: migration.version,
      name: migration.name,
      durationMs: Date.now() - started,
    });
  }

  return {
    applied: appliedNow,
    skipped: plan.pending.length === 0 ? (await appliedMigrations()).length : 0,
    drifted: plan.drifted,
  };
}

/** Refuse to boot if any applied migration file has been edited after the fact. */
export async function assertNoMigrationDrift(dir?: string): Promise<void> {
  const plan = await planMigrations(dir);
  if (plan.drifted.length > 0) {
    const list = plan.drifted.map((d) => `${d.version}_${d.name}`).join(', ');
    throw new Error(
      `Migration drift detected: already-applied migration(s) changed on disk — ${list}. ` +
        'Add a new migration instead of editing an applied one.',
    );
  }
}
